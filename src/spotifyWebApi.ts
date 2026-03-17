import { mkdir,readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Env } from './env';

type SpotifyToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
};

type SpotifyWebApiResult =
  | { ok: true; status: number; data?: unknown }
  | { ok: false; status?: number; error: string; details?: unknown };

type SpotifyWebApiErrorResult = Extract<SpotifyWebApiResult, { ok: false }>;

type PersistedToken = {
  token: string;
  expiresAtMs: number;
  refreshToken?: string;
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

function basicAuth(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  return Buffer.from(raw, 'utf-8').toString('base64');
}

function withTimeout(timeoutMs: number): AbortController {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  // Avoid keeping Node alive just for timeout.
  t.unref?.();
  return controller;
}

function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v ?? '');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

const DEVICE_ACTIVATION_CHECK_ATTEMPTS = 8;
const DEVICE_ACTIVATION_CHECK_DELAY_MS = 350;

type RefreshBlackoutWindow = {
  inWindow: boolean;
  currentStartMs?: number;
  currentEndMs?: number;
  nextStartMs: number;
  nextEndMs: number;
};

function normalizeForMatch(input: string): string {
  return String(input ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(input: string): string[] {
  const base = normalizeForMatch(input);
  if (!base) return [];
  return base.split(/\s+/).filter((x) => x.length >= 2);
}

function playlistMatchScore(candidateName: string, requestedName: string): number {
  const candidate = normalizeForMatch(candidateName);
  const requested = normalizeForMatch(requestedName);
  if (!candidate || !requested) return 0;
  if (candidate === requested) return 1000;
  if (candidate.startsWith(requested)) return 900;
  if (candidate.includes(requested)) return 800;

  const reqTokens = tokenize(requested);
  if (!reqTokens.length) return 0;
  const candSet = new Set(tokenize(candidate));
  let overlap = 0;
  for (const t of reqTokens) {
    if (candSet.has(t)) overlap += 1;
  }
  if (!overlap) return 0;

  const ratio = overlap / reqTokens.length;
  if (ratio < 0.5) return 0;
  return Math.round(ratio * 700);
}

function trackMatchScore(
  candidateTitle: string,
  candidateArtists: string[],
  requestedTitle: string,
  requestedArtist?: string,
): number {
  const titleScore = playlistMatchScore(candidateTitle, requestedTitle);
  if (titleScore <= 0) return 0;

  if (!requestedArtist) return titleScore;

  const artistNeedle = normalizeForMatch(requestedArtist);
  if (!artistNeedle) return titleScore;

  const artistBoost = candidateArtists
    .map((artist) => normalizeForMatch(artist))
    .reduce((best, normalizedArtist) => {
      if (!normalizedArtist) return best;
      if (normalizedArtist === artistNeedle) return Math.max(best, 250);
      if (normalizedArtist.includes(artistNeedle) || artistNeedle.includes(normalizedArtist)) return Math.max(best, 180);

      const overlap = tokenize(artistNeedle).filter((token) => tokenize(normalizedArtist).includes(token)).length;
      return Math.max(best, overlap > 0 ? 120 : 0);
    }, 0);

  return titleScore + artistBoost;
}

function deviceNameMatchScore(candidateName: string, requestedName: string): number {
  const candidate = normalizeForMatch(candidateName);
  const requested = normalizeForMatch(requestedName);
  if (!candidate || !requested) return 0;
  if (candidate === requested) return 1000;
  if (candidate.startsWith(requested)) return 900;
  if (requested.startsWith(candidate)) return 850;
  if (candidate.includes(requested) || requested.includes(candidate)) return 780;

  const reqTokens = tokenize(requested);
  const candTokens = tokenize(candidate);
  if (!reqTokens.length || !candTokens.length) return 0;
  const candSet = new Set(candTokens);
  const overlap = reqTokens.filter((token) => candSet.has(token)).length;
  if (!overlap) return 0;

  return Math.round((overlap / reqTokens.length) * 700);
}

function parseSpotifyUri(uri: string): { type: string; id: string } | undefined {
  const normalized = String(uri ?? '').trim();
  const match = normalized.match(/^spotify:(track|album|artist|playlist|show|episode):([a-zA-Z0-9]+)$/i);
  if (!match) return undefined;
  return {
    type: String(match[1]).toLowerCase(),
    id: String(match[2]),
  };
}

type SpotifyDevice = {
  id: string;
  name: string;
  type?: string;
  isActive: boolean;
};

type SpotifyPlaylist = {
  id: string;
  name: string;
  uri: string;
};

const MISSING_TARGET_DEVICE_SENTINEL = '__missing_target_device__';

export class SpotifyWebApiClient {
  private env: Env;
  private cached?: { token: string; expiresAtMs: number };
  private discoveredPreferredDevice?: { id: string; name: string; discoveredAtMs: number };
  private readonly discoveredPreferredDeviceTtlMs = 5 * 60_000;
  private tokenFilePath: string;
  private refreshTokenOverride?: string;
  private refreshInFlight?: Promise<{ ok: true; token: string } | { ok: false; error: string; status?: number; details?: unknown }>;
  private readonly refreshSkewMs = 120_000;
  private cachedDeviceList?: { result: Awaited<ReturnType<SpotifyWebApiClient['listDevices']>>; fetchedAtMs: number };
  private cachedNowPlaying?: { result: Awaited<ReturnType<SpotifyWebApiClient['getNowPlaying']>>; fetchedAtMs: number };
  private readonly shortCacheTtlMs = 65_000;
  private prefetchTimer?: ReturnType<typeof setInterval>;

  constructor(env: Env) {
    this.env = env;
    this.tokenFilePath = '/app/data/spotify-token.json';
    // Load persisted token on startup (non-blocking)
    this.loadTokenFromDisk().catch(() => {
      // Ignore errors (file may not exist on first run)
    });
  }

  private log(level: 'info' | 'warn', message: string, details?: Record<string, unknown>): void {
    const payload = details ? ` ${JSON.stringify(details)}` : '';
    const line = `[spotify-webapi] ${message}${payload}`;
    if (level === 'warn') {
      console.warn(line);
      return;
    }
    console.info(line);
  }

  private async loadTokenFromDisk(): Promise<void> {
    try {
      const content = await readFile(this.tokenFilePath, 'utf-8');
      const parsed: PersistedToken = JSON.parse(content);
      if (typeof parsed.token === 'string' && typeof parsed.expiresAtMs === 'number') {
        // Only use if not expired (with 60s safety margin)
        if (parsed.expiresAtMs > Date.now() + 60_000) {
          this.cached = { token: parsed.token, expiresAtMs: parsed.expiresAtMs };
        }
      }
      if (typeof parsed.refreshToken === 'string' && parsed.refreshToken.trim()) {
        this.refreshTokenOverride = parsed.refreshToken.trim();
      }
    } catch {
      // Ignore errors (file may not exist or be invalid)
    }
  }

  private async saveTokenToDisk(token: string, expiresAtMs: number, refreshToken?: string): Promise<void> {
    try {
      const data: PersistedToken = { token, expiresAtMs, ...(refreshToken ? { refreshToken } : {}) };
      const dir = dirname(this.tokenFilePath);
      await mkdir(dir, { recursive: true });
      await writeFile(this.tokenFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      // Log but don't fail (persistence is best-effort)
      console.error('[spotify-token] Failed to save token to disk:', err);
    }
  }

  isConfigured(): boolean {
    return Boolean(
      this.env.SPOTIFY_WEBAPI_CLIENT_ID
        && this.env.SPOTIFY_WEBAPI_CLIENT_SECRET
        && (this.refreshTokenOverride || this.env.SPOTIFY_WEBAPI_REFRESH_TOKEN)
    );
  }

  private getRefreshToken(): string {
    return (this.refreshTokenOverride ?? this.env.SPOTIFY_WEBAPI_REFRESH_TOKEN ?? '').trim();
  }

  private parseHhmm(value: string): { hour: number; minute: number } {
    const [hour, minute] = value.split(':').map((v) => Number(v));
    return {
      hour: Number.isFinite(hour) ? hour : 0,
      minute: Number.isFinite(minute) ? minute : 0,
    };
  }

  private getRefreshBlackoutWindow(nowMs = Date.now()): RefreshBlackoutWindow {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = new Date(nowMs);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const midnightMs = midnight.getTime();

    const start = this.parseHhmm(this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START);
    const end = this.parseHhmm(this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END);
    const startOffsetMs = (start.hour * 60 + start.minute) * 60 * 1000;
    const endOffsetMs = (end.hour * 60 + end.minute) * 60 * 1000;

    const windows: Array<{ startMs: number; endMs: number }> = [];
    for (const offset of [-1, 0, 1, 2]) {
      const base = midnightMs + offset * dayMs;
      const startMs = base + startOffsetMs;
      let endMs = base + endOffsetMs;
      if (endMs <= startMs) endMs += dayMs;
      windows.push({ startMs, endMs });
    }

    const current = windows.find((w) => nowMs >= w.startMs && nowMs < w.endMs);
    const next = windows.find((w) => w.startMs > nowMs) ?? windows[windows.length - 1];

    return {
      inWindow: Boolean(current),
      ...(current ? { currentStartMs: current.startMs, currentEndMs: current.endMs } : {}),
      nextStartMs: next.startMs,
      nextEndMs: next.endMs,
    };
  }

  private shouldPreRefreshBeforeBlackout(expiresAtMs: number, nowMs = Date.now()): boolean {
    const blackout = this.getRefreshBlackoutWindow(nowMs);
    if (blackout.inWindow) return false;

    // Only pre-refresh when the token would expire DURING the blackout window (not just before it ends).
    // Original bug: `<= nextEndMs + skew` captured tokens expiring hours before the window start.
    const tokenExpiresDuringNextWindow =
      expiresAtMs >= blackout.nextStartMs - this.refreshSkewMs &&
      expiresAtMs <= blackout.nextEndMs + this.refreshSkewMs;
    if (tokenExpiresDuringNextWindow) return true;

    const msUntilNextWindow = Math.max(0, blackout.nextStartMs - nowMs);
    return msUntilNextWindow <= this.env.SPOTIFY_WEBAPI_PRE_REFRESH_WINDOW_MS
      && expiresAtMs <= blackout.nextStartMs + this.env.SPOTIFY_WEBAPI_PRE_REFRESH_WINDOW_MS;
  }

  private async refreshAccessTokenNow(): Promise<{ ok: true; token: string } | { ok: false; error: string; status?: number; details?: unknown }> {
    const clientId = this.env.SPOTIFY_WEBAPI_CLIENT_ID ?? '';
    const clientSecret = this.env.SPOTIFY_WEBAPI_CLIENT_SECRET ?? '';
    const refreshToken = this.getRefreshToken();
    if (!clientId || !clientSecret || !refreshToken) return { ok: false, error: 'spotify_webapi_not_configured' };

    const blackout = this.getRefreshBlackoutWindow();
    if (blackout.inWindow) {
      const untilEndSec = Math.max(0, Math.floor(((blackout.currentEndMs ?? Date.now()) - Date.now()) / 1000));
      this.log('warn', 'token_refresh_deferred_blackout', {
        blackoutStart: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START,
        blackoutEnd: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END,
        untilEndSec,
      });
      return {
        ok: false,
        error: 'spotify_refresh_deferred_blackout',
        status: 503,
        details: {
          blackoutStart: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START,
          blackoutEnd: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END,
          untilEndSec,
        },
      };
    }

    const url = new URL('/api/token', this.env.SPOTIFY_WEBAPI_ACCOUNTS_URL);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const controller = withTimeout(this.env.SPOTIFY_WEBAPI_TIMEOUT_MS);
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      const lower = text.toLowerCase();
      if (resp.status === 400 && lower.includes('invalid_grant')) {
        this.log('warn', 'token_refresh_failed', { status: resp.status, reason: 'invalid_grant' });
        return { ok: false, error: 'spotify_refresh_token_revoked', status: resp.status, details: text.slice(0, 500) };
      }
      this.log('warn', 'token_refresh_failed', { status: resp.status, reason: 'http_error' });
      return { ok: false, error: 'spotify_token_refresh_failed', status: resp.status, details: text.slice(0, 500) };
    }

    let parsed: SpotifyToken;
    try {
      parsed = JSON.parse(text) as SpotifyToken;
    } catch {
      this.log('warn', 'token_refresh_failed', { status: resp.status, reason: 'parse_error' });
      return { ok: false, error: 'spotify_token_parse_failed', status: resp.status, details: text.slice(0, 500) };
    }

    if (!parsed.access_token) return { ok: false, error: 'spotify_token_missing_access_token' };

    // Refresh a bit early.
    const ttlMs = Math.max(5, Number(parsed.expires_in || 3600) - 30) * 1000;
    const expiresAtMs = Date.now() + ttlMs;
    this.cached = { token: parsed.access_token, expiresAtMs };
    const previousRefreshToken = this.refreshTokenOverride;
    if (typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim()) {
      this.refreshTokenOverride = parsed.refresh_token.trim();
    }
    this.log('info', 'token_refreshed', {
      expiresInSec: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
      refreshTokenRotated: Boolean(
        parsed.refresh_token
          && parsed.refresh_token.trim()
          && parsed.refresh_token.trim() !== (previousRefreshToken ?? this.env.SPOTIFY_WEBAPI_REFRESH_TOKEN ?? '').trim()
      ),
    });
    
    // Persist token to disk (non-blocking)
    this.saveTokenToDisk(parsed.access_token, expiresAtMs, this.getRefreshToken()).catch(() => {
      // Ignore save errors
    });

    return { ok: true, token: parsed.access_token };
  }

  private async refreshAccessToken(): Promise<{ ok: true; token: string } | { ok: false; error: string; status?: number; details?: unknown }> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshAccessTokenNow().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async getAccessToken(): Promise<{ ok: true; token: string } | { ok: false; error: string; status?: number; details?: unknown }> {
    const nowMs = Date.now();

    if (this.cached && nowMs < this.cached.expiresAtMs - this.refreshSkewMs) {
      if (this.shouldPreRefreshBeforeBlackout(this.cached.expiresAtMs, nowMs)) {
        if (!this.refreshInFlight) {
          this.log('info', 'token_refresh_preemptive_before_blackout', {
            expiresInSec: Math.max(0, Math.floor((this.cached.expiresAtMs - nowMs) / 1000)),
            blackoutStart: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START,
            blackoutEnd: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END,
          });
        }
        return this.refreshAccessToken();
      }
      return { ok: true, token: this.cached.token };
    }

    if (this.cached && nowMs < this.cached.expiresAtMs) {
      const blackout = this.getRefreshBlackoutWindow(nowMs);
      if (blackout.inWindow) {
        this.log('info', 'token_refresh_delayed_blackout_window', {
          expiresInSec: Math.max(0, Math.floor((this.cached.expiresAtMs - nowMs) / 1000)),
          blackoutStart: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START,
          blackoutEnd: this.env.SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END,
        });
        return { ok: true, token: this.cached.token };
      }
    }

    return this.refreshAccessToken();
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  private isRetryableNetworkError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const rec = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    const name = String(rec.name ?? '').toLowerCase();
    const code = String(rec.code ?? '').toUpperCase();
    const message = String(rec.message ?? '').toLowerCase();

    if (name === 'aborterror') return true;
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED') return true;
    if (message.includes('timed out') || message.includes('network') || message.includes('fetch failed')) return true;

    const causeRec = rec.cause as { code?: unknown; message?: unknown } | undefined;
    if (causeRec) {
      const causeCode = String(causeRec.code ?? '').toUpperCase();
      const causeMessage = String(causeRec.message ?? '').toLowerCase();
      if (causeCode === 'ETIMEDOUT' || causeCode === 'ECONNRESET' || causeCode === 'EAI_AGAIN' || causeCode === 'ECONNREFUSED') {
        return true;
      }
      if (causeMessage.includes('timed out') || causeMessage.includes('network') || causeMessage.includes('fetch failed')) {
        return true;
      }
    }

    return false;
  }

  private parseRetryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const asSeconds = Number(trimmed);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }

    const atMs = Date.parse(trimmed);
    if (!Number.isFinite(atMs)) return undefined;
    return Math.max(0, atMs - Date.now());
  }

  private computeRetryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.env.SPOTIFY_WEBAPI_REQUEST_RETRY_MAX_DELAY_MS);
    }

    const base = Math.max(100, this.env.SPOTIFY_WEBAPI_REQUEST_RETRY_DELAY_MS);
    const cap = Math.max(base, this.env.SPOTIFY_WEBAPI_REQUEST_RETRY_MAX_DELAY_MS);
    const exponent = Math.max(0, attempt - 1);
    const backoff = Math.min(cap, base * (2 ** exponent));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 4)));
    return Math.min(cap, backoff + jitter);
  }

  private computeActionRetryDelayMs(attempt: number): number {
    const base = Math.max(200, this.env.SPOTIFY_WEBAPI_ACTION_RETRY_DELAY_MS);
    const cap = Math.max(base, base * 4);
    const exponent = Math.max(0, attempt - 1);
    const backoff = Math.min(cap, base * (2 ** exponent));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 5)));
    return Math.min(cap, backoff + jitter);
  }

  private isRetryableActionResult(result: SpotifyWebApiResult): boolean {
    if (result.ok) return false;

    if (typeof result.status === 'number' && this.shouldRetryStatus(result.status)) {
      return true;
    }

    if (result.status === 404 && this.isDeviceNotFoundError(result)) {
      return true;
    }

    return result.error === 'spotify_device_not_available'
      || result.error === 'spotify_target_device_not_active'
      || result.error === 'spotify_no_active_device';
  }

  private async withActionRetry(action: string, fn: () => Promise<SpotifyWebApiResult>): Promise<SpotifyWebApiResult> {
    const maxRetries = Math.max(0, this.env.SPOTIFY_WEBAPI_ACTION_RETRIES);
    let last: SpotifyWebApiResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await fn();
      if (result.ok) return result;

      last = result;
      if (attempt >= maxRetries || !this.isRetryableActionResult(result)) {
        return result;
      }

      const waitMs = this.computeActionRetryDelayMs(attempt + 1);
      this.log('warn', 'spotify_action_retry', {
        action,
        attempt,
        maxRetries,
        status: result.status,
        error: result.error,
        waitMs,
      });
      await sleep(waitMs);
    }

    return last ?? { ok: false, error: 'spotify_action_retry_exhausted' };
  }

  private async request(method: string, path: string, opts?: { query?: Record<string, string | undefined>; json?: unknown }): Promise<SpotifyWebApiResult> {
    const tokenRes = await this.getAccessToken();
    if (!tokenRes.ok) return { ok: false, error: tokenRes.error, status: tokenRes.status, details: tokenRes.details };

    const url = new URL(path, this.env.SPOTIFY_WEBAPI_BASE_URL);
    for (const [k, v] of Object.entries(opts?.query ?? {})) {
      if (typeof v === 'string' && v.trim()) url.searchParams.set(k, v.trim());
    }

    const callOnce = async (accessToken: string) => {
      const controller = withTimeout(this.env.SPOTIFY_WEBAPI_TIMEOUT_MS);
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(opts?.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts?.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: controller.signal,
      });
      const rawText = response.status === 204 ? '' : await response.text();
      return { response, rawText };
    };

    const canRetry = method === 'GET' || method === 'PUT';
    const maxRetries = canRetry ? Math.max(0, this.env.SPOTIFY_WEBAPI_REQUEST_RETRIES) : 0;
    let accessToken = tokenRes.token;
    let lastError: SpotifyWebApiErrorResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let resp: Response;
      let text: string;

      try {
        const call = await callOnce(accessToken);
        resp = call.response;
        text = call.rawText;
      } catch (err) {
        if (canRetry && attempt < maxRetries && this.isRetryableNetworkError(err)) {
          const waitMs = this.computeRetryDelayMs(attempt + 1);
          this.log('warn', 'webapi_transient_network_retry', {
            method,
            path,
            attempt,
            maxRetries,
            waitMs,
          });
          await sleep(waitMs);
          continue;
        }

        return {
          ok: false,
          error: 'spotify_webapi_network_error',
          details: toText(err),
        };
      }

      if (resp.status === 401) {
        const refreshed = await this.refreshAccessToken();
        if (!refreshed.ok) return { ok: false, error: refreshed.error, status: refreshed.status, details: refreshed.details };
        accessToken = refreshed.token;
        if (attempt < maxRetries) {
          const waitMs = this.computeRetryDelayMs(attempt + 1);
          this.log('warn', 'webapi_retry_after_refresh', { method, path, attempt, maxRetries, waitMs });
          await sleep(waitMs);
          continue;
        }
      }

      if (resp.status === 204) return { ok: true, status: 204 };

      if (!resp.ok) {
        if (canRetry && attempt < maxRetries && this.shouldRetryStatus(resp.status)) {
          const retryAfterMs = this.parseRetryAfterMs(resp.headers.get('retry-after'));
          const waitMs = this.computeRetryDelayMs(attempt + 1, retryAfterMs);
          this.log('warn', 'webapi_retryable_status_retry', {
            method,
            path,
            status: resp.status,
            attempt,
            maxRetries,
            waitMs,
          });
          await sleep(waitMs);
          continue;
        }

        if (resp.status === 403) {
          const lower = text.toLowerCase();
          if (lower.includes('insufficient')) {
            return { ok: false, status: resp.status, error: 'spotify_insufficient_scope', details: text.slice(0, 800) };
          }
          if (lower.includes('restriction violated')) {
            return { ok: false, status: resp.status, error: 'spotify_restriction_violated', details: text.slice(0, 800) };
          }
          if (lower.includes('premium')) {
            return { ok: false, status: resp.status, error: 'spotify_premium_required', details: text.slice(0, 800) };
          }
        }
        lastError = { ok: false, status: resp.status, error: 'spotify_webapi_request_failed', details: text.slice(0, 800) };
        return lastError;
      }

      if (!text.trim()) return { ok: true, status: resp.status };

      try {
        return { ok: true, status: resp.status, data: JSON.parse(text) };
      } catch {
        return { ok: true, status: resp.status, data: text };
      }
    }

    if (lastError) return lastError;
    return { ok: false, error: 'spotify_webapi_request_exhausted_retries' };
  }

  private resolveDeviceId(requestedDeviceId?: string): string {
    const forced = (this.env.SPOTIFY_WEBAPI_DEVICE_ID ?? '').trim();
    if (forced) return forced;
    return String(requestedDeviceId ?? '').trim();
  }

  private resolveRequestedDeviceAlias(requestedDeviceId?: string): 'phone' | 'computer' | 'salon' | undefined {
    const raw = String(requestedDeviceId ?? '').trim().toLowerCase();
    if (!raw.startsWith('alias:')) return undefined;
    const alias = raw.slice('alias:'.length).trim();
    if (alias === 'phone' || alias === 'telephone' || alias === 'tel' || alias === 'mobile') return 'phone';
    if (alias === 'salon' || alias === 'living_room' || alias === 'living-room' || alias === 'librespot') return 'salon';
    if (alias === 'computer' || alias === 'pc' || alias === 'ordinateur' || alias === 'ordi') return 'computer';
    return undefined;
  }

  private resolveAliasDeviceName(alias: 'phone' | 'computer' | 'salon'): string {
    if (alias === 'phone') {
      return (this.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_PHONE_NAME ?? 'S22+').trim();
    }

    if (alias === 'salon') {
      return (this.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_SALON_NAME ?? 'librespot').trim();
    }

    const explicitComputer = (this.env.SPOTIFY_WEBAPI_DEVICE_ALIAS_COMPUTER_NAME ?? '').trim();
    if (explicitComputer) return explicitComputer;
    return this.resolveDeviceName();
  }

  private resolveDeviceName(): string {
    return (this.env.SPOTIFY_WEBAPI_DEVICE_NAME ?? 'jarvis Home').trim();
  }

  private normalizeDeviceName(name: string): string {
    return name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private findDeviceByPreferredName(devices: SpotifyDevice[], preferredName: string): SpotifyDevice | undefined {
    const preferred = this.normalizeDeviceName(preferredName);
    if (!preferred) return undefined;

    let bestDevice: SpotifyDevice | undefined;
    let bestScore = 0;
    for (const device of devices) {
      const score = deviceNameMatchScore(device.name, preferredName);
      if (score > bestScore) {
        bestDevice = device;
        bestScore = score;
      }
    }

    return bestScore >= 500 ? bestDevice : undefined;
  }

  private findDeviceByType(devices: SpotifyDevice[], acceptedTypes: string[]): SpotifyDevice | undefined {
    const wanted = new Set(
      acceptedTypes
        .map((type) => String(type ?? '').trim().toLowerCase())
        .filter((type) => Boolean(type))
    );
    if (!wanted.size) return undefined;

    const activeTyped = devices.find((device) => {
      const type = String(device.type ?? '').trim().toLowerCase();
      return device.isActive && wanted.has(type);
    });
    if (activeTyped) return activeTyped;

    return devices.find((device) => {
      const type = String(device.type ?? '').trim().toLowerCase();
      return wanted.has(type);
    });
  }

  private async discoverDeviceByNameWithRetry(preferredName: string): Promise<SpotifyDevice | undefined> {
    const maxRetries = Math.max(0, this.env.SPOTIFY_WEBAPI_DEVICE_DISCOVERY_RETRIES);
    const delayMs = Math.max(100, this.env.SPOTIFY_WEBAPI_DEVICE_DISCOVERY_DELAY_MS);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const devicesRes = await this.listDevices();
      if (devicesRes.ok) {
        const found = this.findDeviceByPreferredName(devicesRes.devices, preferredName);
        if (found) {
          this.log('info', 'device_discovered_by_name', {
            preferredDeviceName: preferredName,
            resolvedDeviceName: found.name,
            resolvedDeviceId: found.id,
            resolvedDeviceActive: found.isActive,
            attempt,
          });
          return found;
        }
      } else {
        this.log('warn', 'device_discovery_list_failed', {
          preferredDeviceName: preferredName,
          status: devicesRes.status,
          error: devicesRes.error,
          attempt,
        });
      }

      if (attempt < maxRetries) {
        this.log('warn', 'device_discovery_retry', {
          preferredDeviceName: preferredName,
          attempt,
          waitMs: delayMs,
        });
        await sleep(delayMs);
      }
    }

    return undefined;
  }

  private isDeviceNotFoundError(result: SpotifyWebApiResult): boolean {
    if (result.ok) return false;
    if (result.status !== 404) return false;
    return toText(result.details).toLowerCase().includes('device not found');
  }

  private async listDevices(): Promise<
    | { ok: true; devices: SpotifyDevice[] }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const r = await this.request('GET', '/v1/me/player/devices');
    if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };
    const data = asRecord(r.data);
    const itemsRaw = data ? data['devices'] : undefined;
    const items = Array.isArray(itemsRaw) ? itemsRaw : [];
    const devices: SpotifyDevice[] = [];
    for (const item of items) {
      const rec = asRecord(item);
      const id = String(rec?.id ?? '').trim();
      if (!id) continue;
      devices.push({
        id,
        name: String(rec?.name ?? '').trim() || 'unknown',
        type: String(rec?.type ?? '').trim() || undefined,
        isActive: Boolean(rec?.is_active),
      });
    }
    return { ok: true, devices };
  }

  private async resolveDeviceIdWithFallback(requestedDeviceId?: string): Promise<string> {
    const requestedAlias = this.resolveRequestedDeviceAlias(requestedDeviceId);
    if (requestedAlias) {
      const aliasName = this.resolveAliasDeviceName(requestedAlias);
      const cachedAlias = this.getDiscoveredPreferredDeviceId(aliasName);
      if (cachedAlias) {
        this.log('info', 'device_selected_from_alias_cache', {
          requestedAlias,
          aliasName,
          resolvedDeviceId: cachedAlias,
        });
        return cachedAlias;
      }

      const discoveredAlias = await this.discoverDeviceByNameWithRetry(aliasName);
      if (discoveredAlias) {
        this.rememberDiscoveredPreferredDevice(discoveredAlias);
        this.log('info', 'device_selected_from_alias_name', {
          requestedAlias,
          aliasName,
          resolvedDeviceId: discoveredAlias.id,
          resolvedDeviceName: discoveredAlias.name,
        });
        return discoveredAlias.id;
      }

      if (requestedAlias === 'computer') {
        const devicesRes = await this.listDevices();
        if (devicesRes.ok) {
          const typed = this.findDeviceByType(devicesRes.devices, ['computer']);
          if (typed) {
            this.log('info', 'device_selected_from_alias_type', {
              requestedAlias,
              preferredType: 'computer',
              resolvedDeviceId: typed.id,
              resolvedDeviceName: typed.name,
              resolvedDeviceType: typed.type,
              resolvedDeviceActive: typed.isActive,
            });
            return typed.id;
          }
        }
      }

      this.log('warn', 'device_alias_not_found', { requestedAlias, aliasName });
      return MISSING_TARGET_DEVICE_SENTINEL;
    }

    const forced = (this.env.SPOTIFY_WEBAPI_DEVICE_ID ?? '').trim();
    const selected = this.resolveDeviceId(requestedDeviceId);
    const preferredName = this.resolveDeviceName();

    const cachedPreferred = this.getDiscoveredPreferredDeviceId(preferredName);

    if (forced) {
      const knownForced = await this.getKnownDevice(forced);
      if (knownForced.ok) return forced;

      this.log('warn', 'forced_device_unavailable_try_name_fallback', {
        forcedDeviceId: forced,
        preferredDeviceName: preferredName,
      });

      if (cachedPreferred) {
        this.log('info', 'device_fallback_using_cached_name_match', {
          preferredDeviceName: preferredName,
          resolvedDeviceId: cachedPreferred,
        });
        return cachedPreferred;
      }

      const discovered = await this.discoverDeviceByNameWithRetry(preferredName);
      if (discovered) {
        this.rememberDiscoveredPreferredDevice(discovered);
        return discovered.id;
      }

      return forced;
    }

    if (selected) return selected;

    // No explicit target: prefer currently active Spotify device first.
    const devicesRes = await this.listDevices();
    if (devicesRes.ok) {
      const active = devicesRes.devices.find((d) => d.isActive);
      if (active) {
        this.log('info', 'device_selected_from_active_primary', {
          resolvedDeviceId: active.id,
          resolvedDeviceName: active.name,
          preferredDeviceName: preferredName,
        });
        return active.id;
      }
    }

    if (cachedPreferred) {
      this.log('info', 'device_selected_from_cached_name_match', {
        preferredDeviceName: preferredName,
        resolvedDeviceId: cachedPreferred,
      });
      return cachedPreferred;
    }

    const discovered = await this.discoverDeviceByNameWithRetry(preferredName);
    if (discovered) {
      this.rememberDiscoveredPreferredDevice(discovered);
      return discovered.id;
    }

    this.log('warn', 'device_fallback_to_current_context', { preferredDeviceName: preferredName });
    return '';
  }

  private getDiscoveredPreferredDeviceId(preferredName: string): string | undefined {
    if (!this.discoveredPreferredDevice) return undefined;
    const ageMs = Date.now() - this.discoveredPreferredDevice.discoveredAtMs;
    if (ageMs > this.discoveredPreferredDeviceTtlMs) {
      this.discoveredPreferredDevice = undefined;
      return undefined;
    }

    const cachedName = this.normalizeDeviceName(this.discoveredPreferredDevice.name);
    const wantedName = this.normalizeDeviceName(preferredName);
    if (!cachedName || !wantedName || cachedName !== wantedName) return undefined;
    return this.discoveredPreferredDevice.id;
  }

  private rememberDiscoveredPreferredDevice(device: SpotifyDevice): void {
    this.discoveredPreferredDevice = {
      id: device.id,
      name: device.name,
      discoveredAtMs: Date.now(),
    };
  }

  private async retryWithTargetDevice(method: string, path: string, did: string, json?: unknown): Promise<SpotifyWebApiResult> {
    this.log('info', 'attempt_transfer_for_play', { method, path, targetDeviceId: did });
    const transfer = await this.transferPlaybackIfNeeded(did);
    if (!transfer.ok) return transfer;
    this.log('info', 'transfer_ok_retrying_action', { method, path, targetDeviceId: did });
    return this.request(method, path, {
      query: { device_id: did },
      ...(json !== undefined ? { json } : {}),
    });
  }

  private async getKnownDevice(deviceId: string): Promise<
    | { ok: true; device: SpotifyDevice }
    | { ok: false; result: SpotifyWebApiErrorResult }
  > {
    const devicesRes = await this.listDevices();
    if (!devicesRes.ok) {
      return {
        ok: false,
        result: { ok: false, error: 'spotify_devices_query_failed', status: devicesRes.status, details: devicesRes.details },
      };
    }

    const target = devicesRes.devices.find((d) => d.id === deviceId);
    if (!target) {
      return {
        ok: false,
        result: {
          ok: false,
          status: 404,
          error: 'spotify_device_not_available',
          details: {
            targetDeviceId: deviceId,
            availableDevices: devicesRes.devices.map((d) => ({ id: d.id, name: d.name, type: d.type, isActive: d.isActive })),
          },
        },
      };
    }

    return { ok: true, device: target };
  }

  private async waitForDeviceActivation(deviceId: string): Promise<
    | { ok: true; device: SpotifyDevice }
    | { ok: false; result: SpotifyWebApiErrorResult }
  > {
    const targetId = String(deviceId ?? '').trim();
    if (!targetId) {
      return { ok: false, result: { ok: false, status: 404, error: 'spotify_device_not_available' } };
    }

    for (let attempt = 0; attempt < DEVICE_ACTIVATION_CHECK_ATTEMPTS; attempt += 1) {
      const known = await this.getKnownDevice(targetId);
      if (known.ok && known.device.isActive) {
        return known;
      }

      if (attempt < DEVICE_ACTIVATION_CHECK_ATTEMPTS - 1) {
        await sleep(DEVICE_ACTIVATION_CHECK_DELAY_MS);
      }
    }

    const lastKnown = await this.getKnownDevice(targetId);
    if (!lastKnown.ok) return lastKnown;
    return {
      ok: false,
      result: {
        ok: false,
        status: 409,
        error: 'spotify_target_device_not_active',
        details: {
          targetDeviceId: targetId,
          targetDeviceName: lastKnown.device.name,
          targetDeviceActive: lastKnown.device.isActive,
        },
      },
    };
  }

  private async transferPlaybackIfNeeded(deviceId: string): Promise<SpotifyWebApiResult> {
    if (!deviceId) return { ok: true, status: 200 };
    const known = await this.getKnownDevice(deviceId);
    if (!known.ok) return known.result;

    // Transfer but do not force playback.
    const r = await this.request('PUT', '/v1/me/player', {
      json: { device_ids: [deviceId], play: false },
    });
    if (!r.ok) return r;

    const activated = await this.waitForDeviceActivation(deviceId);
    if (!activated.ok) return activated.result;

    return { ok: true, status: 200 };
  }

  async pause(deviceId?: string): Promise<SpotifyWebApiResult> {
    return this.withActionRetry('pause', async () => {
      const did = await this.resolveDeviceIdWithFallback(deviceId);
      const r = await this.request('PUT', '/v1/me/player/pause', { query: { device_id: did || undefined } });
      if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
        this.log('warn', 'pause_failed_no_takeover', { targetDeviceId: did, status: r.status });
        const known = await this.getKnownDevice(did);
        if (!known.ok) return known.result;
        return {
          ok: false,
          status: 409,
          error: 'spotify_target_device_not_active',
          details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: known.device.isActive },
        };
      }
      return r;
    });
  }

  async play(deviceId?: string): Promise<SpotifyWebApiResult> {
    return this.withActionRetry('play', async () => {
      const did = await this.resolveDeviceIdWithFallback(deviceId);

      if (did) {
        const transfer = await this.transferPlaybackIfNeeded(did);
        if (!transfer.ok) return transfer;
      }

      const r = await this.request('PUT', '/v1/me/player/play', { query: { device_id: did || undefined }, json: {} });
      if (!r.ok && did && this.isDeviceNotFoundError(r)) {
        return this.retryWithTargetDevice('PUT', '/v1/me/player/play', did, {});
      }
      if (!r.ok && r.status === 404 && did) {
        return this.retryWithTargetDevice('PUT', '/v1/me/player/play', did, {});
      }
      return r;
    });
  }

  async next(deviceId?: string): Promise<SpotifyWebApiResult> {
    const did = await this.resolveDeviceIdWithFallback(deviceId);
    const r = await this.request('POST', '/v1/me/player/next', { query: { device_id: did || undefined } });
    if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
      this.log('warn', 'next_failed_no_takeover', { targetDeviceId: did, status: r.status });
      const known = await this.getKnownDevice(did);
      if (!known.ok) return known.result;
      return {
        ok: false,
        status: 409,
        error: 'spotify_target_device_not_active',
        details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: known.device.isActive },
      };
    }
    return r;
  }

  async previous(deviceId?: string): Promise<SpotifyWebApiResult> {
    const did = await this.resolveDeviceIdWithFallback(deviceId);
    const r = await this.request('POST', '/v1/me/player/previous', { query: { device_id: did || undefined } });
    if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
      this.log('warn', 'previous_failed_no_takeover', { targetDeviceId: did, status: r.status });
      const known = await this.getKnownDevice(did);
      if (!known.ok) return known.result;
      return {
        ok: false,
        status: 409,
        error: 'spotify_target_device_not_active',
        details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: known.device.isActive },
      };
    }
    return r;
  }

  async setVolume(volumePercent: number, deviceId?: string): Promise<SpotifyWebApiResult> {
    return this.withActionRetry('set_volume', async () => {
      const v = Math.max(0, Math.min(100, Math.round(Number(volumePercent))));
      const did = await this.resolveDeviceIdWithFallback(deviceId);
      const r = await this.request('PUT', '/v1/me/player/volume', {
        query: { volume_percent: String(v), device_id: did || undefined },
      });
      if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
        this.log('warn', 'volume_set_failed_no_takeover', { targetDeviceId: did, status: r.status, volumePercent: v });
        const known = await this.getKnownDevice(did);
        if (!known.ok) return known.result;
        return {
          ok: false,
          status: 409,
          error: 'spotify_target_device_not_active',
          details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: known.device.isActive },
        };
      }
      return r;
    });
  }

  async addToQueueUri(uri: string, deviceId?: string): Promise<SpotifyWebApiResult> {
    const did = await this.resolveDeviceIdWithFallback(deviceId);
    const normalized = String(uri ?? '').trim();
    if (!normalized.startsWith('spotify:track:')) {
      return { ok: false, error: 'spotify_queue_invalid_uri' };
    }

    let r = await this.request('POST', '/v1/me/player/queue', {
      query: { uri: normalized, device_id: did || undefined },
    });

    if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
      this.log('warn', 'queue_add_retry_with_transfer', { targetDeviceId: did, status: r.status });
      const transfer = await this.transferPlaybackIfNeeded(did);
      if (transfer.ok) {
        r = await this.request('POST', '/v1/me/player/queue', {
          query: { uri: normalized, device_id: did || undefined },
        });
      }
    }

    if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
      this.log('warn', 'queue_add_failed_no_takeover', { targetDeviceId: did, status: r.status });
      const known = await this.getKnownDevice(did);
      if (!known.ok) return known.result;
      return {
        ok: false,
        status: 409,
        error: 'spotify_target_device_not_active',
        details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: known.device.isActive },
      };
    }
    return r;
  }

  async clearQueue(deviceId?: string): Promise<{ ok: true; cleared: number; was_empty: boolean } | { ok: false; error: string; status?: number }> {
    const did = await this.resolveDeviceIdWithFallback(deviceId);
    const queueResp = await this.request('GET', '/v1/me/player/queue', {
      query: { device_id: did || undefined },
    });
    if (!queueResp.ok) return { ok: false, error: queueResp.error, status: queueResp.status };

    const queueData = asRecord(queueResp.data);
    const queued = Array.isArray(queueData?.queue) ? (queueData.queue as unknown[]) : [];
    const count = Math.min(queued.length, 20);

    if (count === 0) {
      return { ok: true, cleared: 0, was_empty: true };
    }

    for (let i = 0; i < count; i++) {
      const skip = await this.next(did || undefined);
      if (!skip.ok) return { ok: false, error: skip.error, status: skip.status };
    }

    return { ok: true, cleared: count, was_empty: false };
  }

  async setRepeat(mode: 'off' | 'track' | 'context', deviceId?: string): Promise<SpotifyWebApiResult> {
    return this.withActionRetry('set_repeat', async () => {
      const did = await this.resolveDeviceIdWithFallback(deviceId);
      const normalized = mode === 'off' || mode === 'track' || mode === 'context' ? mode : 'context';

      const r = await this.request('PUT', '/v1/me/player/repeat', {
        query: { state: normalized, device_id: did || undefined },
      });
      if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
        this.log('warn', 'repeat_set_failed_no_takeover', { targetDeviceId: did, status: r.status, mode: normalized });
        const known = await this.getKnownDevice(did);
        if (!known.ok) return known.result;
        return {
          ok: false,
          status: 409,
          error: 'spotify_target_device_not_active',
          details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: known.device.isActive },
        };
      }
      return r;
    });
  }

  async setShuffle(state: boolean, deviceId?: string): Promise<SpotifyWebApiResult> {
    return this.withActionRetry('set_shuffle', async () => {
      const did = await this.resolveDeviceIdWithFallback(deviceId);
      const r = await this.request('PUT', '/v1/me/player/shuffle', {
        query: {
          state: state ? 'true' : 'false',
          device_id: did || undefined,
        },
      });
      if (!r.ok && did && (this.isDeviceNotFoundError(r) || r.status === 404)) {
        this.log('warn', 'shuffle_set_failed_no_takeover', { targetDeviceId: did, status: r.status, state });
        const known = await this.getKnownDevice(did);
        if (!known.ok) return known.result;
        return {
          ok: false,
          status: 409,
          error: 'spotify_target_device_not_active',
          details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: known.device.isActive },
        };
      }
      return r;
    });
  }

  async getCurrentVolumePercent(): Promise<
    | { ok: true; volumePercent: number }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const did = await this.resolveDeviceIdWithFallback();
    if (did) {
      const known = await this.getKnownDevice(did);
      if (!known.ok) return { ok: false, error: known.result.error, status: known.result.status, details: known.result.details };
      if (!known.device.isActive) {
        return {
          ok: false,
          error: 'spotify_target_device_not_active',
          status: 409,
          details: { targetDeviceId: did, targetDeviceName: known.device.name, targetDeviceActive: false },
        };
      }
    }

    const r = await this.request('GET', '/v1/me/player');
    if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };

    // 204 means “no active device”.
    if (r.status === 204) return { ok: false, error: 'spotify_no_active_device', status: 204 };

    const data = asRecord(r.data);
    const deviceRaw = data ? data['device'] : undefined;
    const device = asRecord(deviceRaw);
    const v = Number(device ? device['volume_percent'] : undefined);
    if (!Number.isFinite(v)) return { ok: false, error: 'spotify_missing_volume_percent', details: { hasDevice: Boolean(deviceRaw) } };

    const safe = Math.max(0, Math.min(100, Math.round(v)));
    return { ok: true, volumePercent: safe };
  }

  async searchTopTrackUri(
    query: string,
    artist?: string,
  ): Promise<{ ok: true; uri: string } | { ok: false; error: string; status?: number; details?: unknown }> {
    const q = String(query ?? '').trim();
    if (!q) return { ok: false, error: 'spotify_search_empty_query' };

    const artistClean = String(artist ?? '').trim();
    const queryCandidates = [
      artistClean ? `track:${q} artist:${artistClean}` : q,
      [q, artistClean].filter(Boolean).join(' ').trim(),
      q,
    ].filter((value, index, array) => value && array.indexOf(value) === index);

    let bestUri = '';
    let bestScore = 0;
    let lastError: { error: string; status?: number; details?: unknown } | undefined;

    for (const queryString of queryCandidates) {
      const r = await this.request('GET', '/v1/search', {
        query: {
          q: queryString,
          type: 'track',
          limit: '10',
        },
      });
      if (!r.ok) {
        lastError = { error: r.error, status: r.status, details: r.details };
        continue;
      }

      const data = asRecord(r.data);
      const tracks = asRecord(data ? data['tracks'] : undefined);
      const itemsRaw = tracks ? tracks['items'] : undefined;
      const items = Array.isArray(itemsRaw) ? itemsRaw : [];

      for (const item of items) {
        const rec = asRecord(item);
        const uri = typeof rec?.uri === 'string' ? rec.uri : '';
        if (!uri.startsWith('spotify:track:')) continue;

        const name = typeof rec?.name === 'string' ? rec.name : '';
        const artistsRaw = Array.isArray(rec?.artists) ? rec.artists : [];
        const artists = artistsRaw
          .map((artistItem) => asRecord(artistItem))
          .map((artistItem) => (typeof artistItem?.name === 'string' ? artistItem.name : ''))
          .filter((artistName) => artistName.length > 0);

        const popularity = Number(rec?.popularity);
        const popularityBoost = Number.isFinite(popularity) ? Math.round(popularity / 5) : 0;

        const score = trackMatchScore(name, artists, q, artistClean || undefined) + popularityBoost;
        if (score > bestScore) {
          bestScore = score;
          bestUri = uri;
        }
      }
    }

    if (bestUri) return { ok: true, uri: bestUri };

    if (lastError) {
      return { ok: false, error: lastError.error, status: lastError.status, details: lastError.details };
    }

    return { ok: false, error: 'spotify_search_no_results', details: { q, artist: artistClean || undefined } };
  }

  private async searchCatalogPlaylistContextUri(query: string): Promise<
    | { ok: true; uri: string; name: string }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const q = String(query ?? '').trim();
    if (!q) return { ok: false, error: 'spotify_playlist_search_empty_query' };

    const r = await this.request('GET', '/v1/search', {
      query: {
        q,
        type: 'playlist',
        limit: '8',
      },
    });
    if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };

    const data = asRecord(r.data);
    const playlists = asRecord(data ? data.playlists : undefined);
    const itemsRaw = playlists ? playlists.items : undefined;
    const items = Array.isArray(itemsRaw) ? itemsRaw : [];

    let best: { uri: string; name: string } | undefined;
    let bestScore = 0;
    for (const item of items) {
      const rec = asRecord(item);
      const uri = String(rec?.uri ?? '').trim();
      const name = String(rec?.name ?? '').trim();
      if (!uri.startsWith('spotify:playlist:') || !name) continue;

      const score = playlistMatchScore(name, q);
      if (score > bestScore) {
        best = { uri, name };
        bestScore = score;
      }
    }

    if (!best || bestScore <= 0) {
      return { ok: false, error: 'spotify_playlist_not_found', details: { query: q } };
    }

    return { ok: true, uri: best.uri, name: best.name };
  }

  private async listCurrentUserPlaylists(limit = 50): Promise<
    | { ok: true; playlists: SpotifyPlaylist[] }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const safeLimit = Math.max(1, Math.min(50, Math.round(Number(limit) || 50)));
    const playlists: SpotifyPlaylist[] = [];
    let offset = 0;
    let page = 0;
    const maxPages = 4;

    while (page < maxPages) {
      const r = await this.request('GET', '/v1/me/playlists', {
        query: {
          limit: String(safeLimit),
          offset: String(offset),
        },
      });
      if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };

      const data = asRecord(r.data);
      const itemsRaw = data ? data['items'] : undefined;
      const items = Array.isArray(itemsRaw) ? itemsRaw : [];
      for (const item of items) {
        const rec = asRecord(item);
        const id = String(rec?.id ?? '').trim();
        const name = String(rec?.name ?? '').trim();
        const uri = String(rec?.uri ?? '').trim();
        if (!id || !name || !/^spotify:playlist:/i.test(uri)) continue;
        playlists.push({ id, name, uri });
      }

      const next = typeof data?.next === 'string' ? data.next.trim() : '';
      if (!next) break;
      offset += safeLimit;
      page += 1;
    }

    return { ok: true, playlists };
  }

  async searchUserPlaylistContextUri(query: string): Promise<
    | { ok: true; uri: string; name: string }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const q = String(query ?? '').trim();
    if (!q) return { ok: false, error: 'spotify_playlist_search_empty_query' };

    const listed = await this.listCurrentUserPlaylists(50);
    if (!listed.ok) return listed;
    if (!listed.playlists.length) {
      return { ok: false, error: 'spotify_user_playlists_empty' };
    }

    let best: SpotifyPlaylist | undefined;
    let bestScore = 0;
    for (const playlist of listed.playlists) {
      const score = playlistMatchScore(playlist.name, q);
      if (score > bestScore) {
        best = playlist;
        bestScore = score;
      }
    }

    if (!best || bestScore <= 0) {
      if (this.env.SPOTIFY_WEBAPI_USER_PLAYLISTS_ONLY) {
        return {
          ok: false,
          error: 'spotify_user_playlist_not_found',
          details: {
            query: q,
            candidates: listed.playlists.slice(0, 20).map((p) => ({ name: p.name, uri: p.uri })),
          },
        };
      }

      const catalog = await this.searchCatalogPlaylistContextUri(q);
      if (catalog.ok) return catalog;

      return {
        ok: false,
        error: 'spotify_playlist_not_found',
        details: {
          query: q,
          candidates: listed.playlists.slice(0, 20).map((p) => ({ name: p.name, uri: p.uri })),
        },
      };
    }

    return { ok: true, uri: best.uri, name: best.name };
  }

  async playUris(uris: string[], deviceId?: string): Promise<SpotifyWebApiResult> {
    return this.withActionRetry('play_uris', async () => {
      const did = await this.resolveDeviceIdWithFallback(deviceId);
      const clean = (Array.isArray(uris) ? uris : []).map(String).filter((u) => u.startsWith('spotify:'));
      if (!clean.length) return { ok: false, error: 'spotify_play_missing_uris' };
      const r = await this.request('PUT', '/v1/me/player/play', {
        query: { device_id: did || undefined },
        json: { uris: clean },
      });
      if (!r.ok && did && this.isDeviceNotFoundError(r)) {
        return this.retryWithTargetDevice('PUT', '/v1/me/player/play', did, { uris: clean });
      }
      if (!r.ok && r.status === 404 && did) {
        return this.retryWithTargetDevice('PUT', '/v1/me/player/play', did, { uris: clean });
      }
      return r;
    });
  }

  async playContextUri(contextUri: string, deviceId?: string): Promise<SpotifyWebApiResult> {
    return this.withActionRetry('play_context', async () => {
      const did = await this.resolveDeviceIdWithFallback(deviceId);
      const uri = String(contextUri ?? '').trim();
      if (!uri.startsWith('spotify:')) return { ok: false, error: 'spotify_play_invalid_context_uri' };
      const r = await this.request('PUT', '/v1/me/player/play', {
        query: { device_id: did || undefined },
        json: { context_uri: uri },
      });
      if (!r.ok && did && this.isDeviceNotFoundError(r)) {
        return this.retryWithTargetDevice('PUT', '/v1/me/player/play', did, { context_uri: uri });
      }
      if (!r.ok && r.status === 404 && did) {
        return this.retryWithTargetDevice('PUT', '/v1/me/player/play', did, { context_uri: uri });
      }

      return r;
    });
  }

  async transferPlayback(deviceId?: string, play = false): Promise<SpotifyWebApiResult> {
    const did = await this.resolveDeviceIdWithFallback(deviceId);
    if (!did || did === MISSING_TARGET_DEVICE_SENTINEL) {
      return { ok: false, status: 404, error: 'spotify_device_not_available' };
    }

    const r = await this.request('PUT', '/v1/me/player', {
      json: { device_ids: [did], play: Boolean(play) },
    });
    if (!r.ok) return r;

    const activated = await this.waitForDeviceActivation(did);
    if (!activated.ok) return activated.result;

    return r;
  }

  startSituationPrefetch(): void {
    if (!this.isConfigured() || this.prefetchTimer) return;
    void this.fetchAndCacheSituation();
    this.prefetchTimer = setInterval(() => {
      void this.fetchAndCacheSituation();
    }, 30_000);
    this.prefetchTimer.unref?.();
    this.log('info', 'spotify_situation_prefetch_started', { intervalMs: 30_000 });
  }

  invalidateSituationCache(): void {
    this.cachedDeviceList = undefined;
    this.cachedNowPlaying = undefined;
  }

  scheduleSituationRefresh(delayMs = 600): void {
    const t = setTimeout(() => { void this.fetchAndCacheSituation(); }, delayMs);
    t.unref?.();
  }

  private async fetchAndCacheSituation(): Promise<void> {
    try {
      const fetchedAtMs = Date.now();
      const [devicesResult, nowPlayingResult] = await Promise.all([
        this.listDevices(),
        this.fetchNowPlayingRaw(),
      ]);
      this.cachedDeviceList = { result: devicesResult, fetchedAtMs };
      this.cachedNowPlaying = { result: nowPlayingResult, fetchedAtMs };
    } catch {
      // Ignore errors in background prefetch
    }
  }

  private async fetchNowPlayingRaw(): Promise<
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const r = await this.request('GET', '/v1/me/player/currently-playing');
    if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };
    if (r.status === 204) return { ok: false, error: 'spotify_no_active_device', status: 204 };
    const data = asRecord(r.data);
    return { ok: true, data: data ?? {} };
  }

  async listDevicesPublic(): Promise<
    | { ok: true; devices: Array<{ id: string; name: string; type?: string; isActive: boolean }> }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const now = Date.now();
    if (this.cachedDeviceList && now - this.cachedDeviceList.fetchedAtMs < this.shortCacheTtlMs) {
      return this.cachedDeviceList.result;
    }
    const result = await this.listDevices();
    this.cachedDeviceList = { result, fetchedAtMs: now };
    return result;
  }

  async getNowPlaying(): Promise<
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const now = Date.now();
    if (this.cachedNowPlaying && now - this.cachedNowPlaying.fetchedAtMs < this.shortCacheTtlMs) {
      return this.cachedNowPlaying.result;
    }
    const result = await this.fetchNowPlayingRaw();
    this.cachedNowPlaying = { result, fetchedAtMs: now };
    return result;
  }

  async seekToPosition(positionMs: number, deviceId?: string): Promise<SpotifyWebApiResult> {
    const did = await this.resolveDeviceIdWithFallback(deviceId);
    const clamped = Math.max(0, Math.round(Number(positionMs) || 0));
    return this.request('PUT', '/v1/me/player/seek', {
      query: {
        position_ms: String(clamped),
        device_id: did || undefined,
      },
    });
  }

  private async getCurrentTrackId(): Promise<
    | { ok: true; trackId: string }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const now = await this.getNowPlaying();
    if (!now.ok) return now;
    const item = asRecord(now.data.item);
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) return { ok: false, error: 'spotify_missing_track_id' };
    return { ok: true, trackId: id };
  }

  async likeTrack(trackId?: string): Promise<SpotifyWebApiResult> {
    let id = String(trackId ?? '').trim();
    if (!id) {
      const current = await this.getCurrentTrackId();
      if (!current.ok) return current;
      id = current.trackId;
    }

    return this.request('PUT', '/v1/me/tracks', {
      query: {
        ids: id,
      },
    });
  }

  async unlikeTrack(trackId?: string): Promise<SpotifyWebApiResult> {
    let id = String(trackId ?? '').trim();
    if (!id) {
      const current = await this.getCurrentTrackId();
      if (!current.ok) return current;
      id = current.trackId;
    }

    return this.request('DELETE', '/v1/me/tracks', {
      query: {
        ids: id,
      },
    });
  }

  async addUrisToPlaylist(playlistId: string, uris: string[]): Promise<SpotifyWebApiResult> {
    const cleanPlaylistId = String(playlistId ?? '').trim();
    if (!cleanPlaylistId) return { ok: false, error: 'spotify_missing_playlist_id' };

    const cleanUris = (Array.isArray(uris) ? uris : [])
      .map((uri) => String(uri ?? '').trim())
      .filter((uri) => uri.startsWith('spotify:'));

    if (!cleanUris.length) return { ok: false, error: 'spotify_missing_playlist_uris' };

    return this.request('POST', `/v1/playlists/${encodeURIComponent(cleanPlaylistId)}/tracks`, {
      json: { uris: cleanUris },
    });
  }

  async searchCatalog(type: string, query: string, limit = 5): Promise<
    | { ok: true; items: Array<Record<string, unknown>> }
    | { ok: false; error: string; status?: number; details?: unknown }
  > {
    const q = String(query ?? '').trim();
    const cleanType = String(type ?? '').trim().toLowerCase();
    const supported = new Set(['track', 'album', 'playlist', 'artist', 'show', 'episode']);
    if (!q) return { ok: false, error: 'spotify_search_empty_query' };
    if (!supported.has(cleanType)) return { ok: false, error: 'spotify_search_invalid_type', details: { type: cleanType } };

    const r = await this.request('GET', '/v1/search', {
      query: {
        q,
        type: cleanType,
        limit: String(Math.max(1, Math.min(20, Math.round(limit || 5)))),
      },
    });

    if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };

    const data = asRecord(r.data);
    const section = asRecord(data ? data[`${cleanType}s`] : undefined);
    const itemsRaw = section?.items;
    const items = Array.isArray(itemsRaw)
      ? itemsRaw
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => {
            const artistsRaw = cleanType === 'track' && Array.isArray(item.artists)
              ? (item.artists as Array<{ name?: unknown }>)
              : [];
            const artists_string = artistsRaw
              .map((a) => String(a?.name ?? '').trim())
              .filter(Boolean)
              .join(', ') || undefined;
            return {
              id: item.id,
              name: item.name,
              uri: item.uri,
              type: cleanType,
              ...(artists_string ? { artists_string } : {}),
            };
          })
      : [];

    return { ok: true, items };
  }

  async getFirstTrackUriFromContext(
    contextUri: string,
    artistHint?: string,
  ): Promise<{ ok: true; uri: string } | { ok: false; error: string; status?: number; details?: unknown }> {
    const parsed = parseSpotifyUri(contextUri);
    if (!parsed) return { ok: false, error: 'spotify_play_invalid_context_uri' };

    if (parsed.type === 'track') {
      return { ok: true, uri: `spotify:track:${parsed.id}` };
    }

    if (parsed.type === 'album') {
      const r = await this.request('GET', `/v1/albums/${encodeURIComponent(parsed.id)}/tracks`, {
        query: { limit: '1' },
      });
      if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };

      const data = asRecord(r.data);
      const items = Array.isArray(data?.items) ? data.items : [];
      const first = asRecord(items[0]);
      const uri = String(first?.uri ?? '').trim();
      if (!uri.startsWith('spotify:track:')) return { ok: false, error: 'spotify_album_tracks_empty' };
      return { ok: true, uri };
    }

    if (parsed.type === 'playlist') {
      const r = await this.request('GET', `/v1/playlists/${encodeURIComponent(parsed.id)}/tracks`, {
        query: { limit: '1' },
      });
      if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };

      const data = asRecord(r.data);
      const items = Array.isArray(data?.items) ? data.items : [];
      const firstItem = asRecord(items[0]);
      const track = asRecord(firstItem?.track);
      const uri = String(track?.uri ?? '').trim();
      if (!uri.startsWith('spotify:track:')) return { ok: false, error: 'spotify_playlist_tracks_empty' };
      return { ok: true, uri };
    }

    if (parsed.type === 'artist') {
      const r = await this.request('GET', `/v1/artists/${encodeURIComponent(parsed.id)}/top-tracks`, {
        query: { market: 'US' },
      });
      if (!r.ok) return { ok: false, error: r.error, status: r.status, details: r.details };

      const data = asRecord(r.data);
      const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
      if (!tracks.length) {
        if (artistHint && artistHint.trim()) {
          return this.searchTopTrackUri(artistHint, artistHint);
        }
        return { ok: false, error: 'spotify_artist_top_tracks_empty' };
      }

      const first = asRecord(tracks[0]);
      const uri = String(first?.uri ?? '').trim();
      if (!uri.startsWith('spotify:track:')) return { ok: false, error: 'spotify_artist_top_tracks_empty' };
      return { ok: true, uri };
    }

    return { ok: false, error: 'spotify_context_type_not_supported', details: { type: parsed.type } };
  }
}
