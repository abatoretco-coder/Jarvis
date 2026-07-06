import type { FastifyBaseLogger } from 'fastify';

import { AsyncSnapshotCache } from '../cache/AsyncSnapshotCache';
import type { Env } from '../env';
import type { HomeAssistantClient } from '../haClient';
import type { NasStatusClient } from '../nas/NasStatusClient';
import {
  buildAgendaFromGoogle,
  buildMailSection,
  buildTasksSection,
  type DashboardSection,
} from '../routes/dashboard';
import type { SpotifyWebApiClient } from '../spotifyWebApi';
import { synthesizeDeterministicWeatherReply } from '../weather/deterministicWeatherReply';
import { buildWeatherSnapshotFromStates, type HaStateLike, type WeatherSnapshot } from '../weather/weatherSnapshot';

export type ProactiveContextDomain =
  | 'spotify'
  | 'mail'
  | 'todo'
  | 'calendar'
  | 'weather'
  | 'home'
  | 'nas'
  | 'news'
  | 'daily_brief';

export type PreparedContextAnswer = {
  domain: ProactiveContextDomain;
  questionKey: string;
  answerText: string;
  fetchedAt: string;
  freshness: 'fresh' | 'stale';
  sourceRefs?: Array<{ type: string; id?: string; label?: string }>;
  requiresLiveRefresh?: boolean;
};

export type ProactiveContextSnapshot<T = unknown> = {
  domain: ProactiveContextDomain;
  value: T;
  preparedAnswers: PreparedContextAnswer[];
};

export type ProactiveContextResult<T = unknown> = {
  domain: ProactiveContextDomain;
  enabled: boolean;
  cached: boolean;
  stale: boolean;
  fetchedAt: string;
  snapshot: ProactiveContextSnapshot<T>;
};

export type ProactiveContextMetrics = {
  hits: number;
  misses: number;
  staleHits: number;
  refreshes: number;
  failures: number;
  consecutiveFailures: number;
  lastHitAt?: string;
  lastRefreshAt?: string;
  lastFailureAt?: string;
};

export type ProactiveContextStatus = {
  domain: ProactiveContextDomain;
  enabled: boolean;
  configured: boolean;
  cached: boolean;
  stale: boolean;
  fetchedAt?: string;
  lastError?: string;
  nextRetryAt?: string;
  metrics: ProactiveContextMetrics;
};

type Provider = {
  domain: ProactiveContextDomain;
  configured: () => boolean;
  cache: AsyncSnapshotCache<ProactiveContextSnapshot>;
  metrics: ProactiveContextMetrics;
  lastError?: string;
  retryAfterMs?: number;
};

type Deps = {
  env: Env;
  ha?: HomeAssistantClient;
  spotifyWebApi: SpotifyWebApiClient;
  nasStatus?: NasStatusClient;
  log?: FastifyBaseLogger;
};

type NewsItem = {
  title: string;
  source?: string;
  link?: string;
  publishedAt?: string;
};

type SpotifyNowPlaying = {
  isPlaying?: boolean;
  title?: string;
  artists: string[];
  album?: string;
  device?: { id?: string; name?: string; type?: string; volumePercent?: number };
};

type WeatherForecastPoint = WeatherSnapshot['forecast'][number];

type DailyBriefDraft = {
  weather?: {
    currentTemperature?: number;
    todayHigh?: number;
    rainRiskPercent?: number;
    condition?: string;
  };
  calendar?: {
    summary: string;
    lines: string[];
    items: unknown[];
  };
  mail?: {
    summary: string;
    lines: string[];
    items: unknown[];
  };
  todo?: {
    summary: string;
    lines: string[];
    items: unknown[];
  };
};

function splitAgentList(raw?: string): Set<ProactiveContextDomain> | null {
  const values = raw
    ?.split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean) ?? [];
  if (values.length === 0) return null;
  return new Set(values as ProactiveContextDomain[]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function freshness(stale: boolean): 'fresh' | 'stale' {
  return stale ? 'stale' : 'fresh';
}

function formatTemperature(value: number): string {
  return `${Math.round(value)}°C`;
}

function normalizeCondition(condition: string): string {
  const normalized = condition
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
  if (/sunny|clear|ensoleille/iu.test(normalized)) return 'ensoleillé';
  if (/partlycloudy|partly.cloudy|partiellement/iu.test(normalized)) return 'partiellement nuageux';
  if (/cloudy|nuage/iu.test(normalized)) return 'nuageux';
  if (/rain|pluie|averse/iu.test(normalized)) return 'pluvieux';
  if (/snow|neige/iu.test(normalized)) return 'neigeux';
  if (/fog|brouillard/iu.test(normalized)) return 'brumeux';
  return condition.replace(/_/gu, ' ');
}

function dateKeyFromDate(date: Date): string {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function forecastDateKey(point: WeatherForecastPoint): string {
  return point.date.slice(0, 10);
}

function forecastHour(point: WeatherForecastPoint): string | undefined {
  const match = /T(\d{2}):?(\d{2})?/u.exec(point.date);
  if (!match?.[1]) return undefined;
  return `${match[1]}h`;
}

function summarizeForecastPoint(point: WeatherForecastPoint): string {
  const parts = [normalizeCondition(point.condition)];
  if (point.temperature !== undefined) parts.push(formatTemperature(point.temperature));
  if (point.tempLow !== undefined) parts.push(`min ${formatTemperature(point.tempLow)}`);
  if (point.precipitation !== undefined) parts.push(`${Math.round(point.precipitation)}% pluie`);
  return parts.join(', ');
}

function pickForecastForDay(forecast: WeatherForecastPoint[], key: string): WeatherForecastPoint | undefined {
  return forecast.find((point) => forecastDateKey(point) === key);
}

function forecastRange(points: WeatherForecastPoint[]): { min?: number; max?: number } {
  const lows = points
    .map((point) => point.tempLow)
    .filter((value): value is number => value !== undefined);
  const highs = points
    .map((point) => point.temperature)
    .filter((value): value is number => value !== undefined);
  return {
    ...(lows.length ? { min: Math.min(...lows) } : {}),
    ...(highs.length ? { max: Math.max(...highs) } : {}),
  };
}

function withFreshness(answer: Omit<PreparedContextAnswer, 'fetchedAt' | 'freshness'>, fetchedAt: string, stale: boolean): PreparedContextAnswer {
  return {
    ...answer,
    fetchedAt,
    freshness: freshness(stale),
  };
}

function emptyMetrics(): ProactiveContextMetrics {
  return {
    hits: 0,
    misses: 0,
    staleHits: 0,
    refreshes: 0,
    failures: 0,
    consecutiveFailures: 0,
  };
}

function recordNow(): string {
  return new Date().toISOString();
}

function dashboardAnswer(domain: ProactiveContextDomain, questionKey: string, section: DashboardSection, fetchedAt: string): PreparedContextAnswer {
  const lines = section.lines.slice(0, 3);
  const suffix = lines.length ? ` ${lines.join(' ')}` : '';
  return {
    domain,
    questionKey,
    answerText: `${section.summary}${suffix}`.trim(),
    fetchedAt,
    freshness: 'fresh',
    sourceRefs: [{ type: 'dashboard-section', label: section.title }],
  };
}

function dashboardBriefSection(section: unknown, limits: { maxLines?: number; maxItems?: number } = {}): { summary: string; lines: string[]; items: unknown[] } | undefined {
  if (!isRecord(section)) return undefined;
  const summary = asString(section.summary);
  const status = asString(section.status);
  if (!summary || status === 'empty' || status === 'error') return undefined;
  const rawLines = Array.isArray(section.lines) ? section.lines : [];
  const rawItems = Array.isArray(section.items) ? section.items : [];
  const maxLines = limits.maxLines ?? 6;
  const maxItems = limits.maxItems ?? 6;
  return {
    summary,
    lines: rawLines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0).slice(0, maxLines),
    items: rawItems.slice(0, maxItems),
  };
}

function filterMailBriefSection(section: ReturnType<typeof dashboardBriefSection>): ReturnType<typeof dashboardBriefSection> {
  if (!section) return undefined;
  const noisy = /\b(newsletter|promotion|promo|soldes|bonus|selection|s[eé]lection|d[eé]couvrez|offres?|jeux d'[eé]t[eé]|soleil et des jeux|re[cç]u uber|course uber)\b/iu;
  const actionable = /\b(alerte|s[eé]curit[eé]|urgent|facture|paiement|impay[eé]|validation|valider|recueil|contrat|devis|r[eé]servation|billet|train|retard|annulation)\b/iu;
  const itemText = (item: unknown): string => {
    if (!isRecord(item)) return '';
    return [item.from, item.subject, item.snippet]
      .map((value) => typeof value === 'string' ? value : '')
      .join(' ');
  };
  const filteredItems = section.items.filter((item) => {
    const text = itemText(item);
    if (!text) return false;
    if (noisy.test(text) && !actionable.test(text)) return false;
    return actionable.test(text) || !noisy.test(text);
  });
  const filteredLines = section.lines.filter((line) => !(noisy.test(line) && !actionable.test(line)));
  if (filteredItems.length === 0 && filteredLines.length === 0) {
    return {
      summary: 'Aucun mail prioritaire detecte.',
      lines: ['Rien de prioritaire cote mails.'],
      items: [],
    };
  }
  return {
    summary: filteredItems.length
      ? `${filteredItems.length} email(s) potentiellement actionnable(s).`
      : section.summary,
    lines: filteredLines.slice(0, 4),
    items: filteredItems.slice(0, 4),
  };
}

function buildDailyBriefWeatherDraft(weather: WeatherSnapshot | null | undefined): DailyBriefDraft['weather'] {
  if (!weather) return undefined;
  const todayKey = dateKeyFromDate(new Date());
  const todayPoints = weather.forecast.filter((point) => forecastDateKey(point) === todayKey);
  const source = todayPoints.length ? todayPoints : weather.forecast.slice(0, 1);
  const range = forecastRange(source);
  const rainValues = [
    weather.current?.precipitation,
    ...source.map((point) => point.precipitation),
  ].filter((value): value is number => value !== undefined);
  const rainRiskPercent = rainValues.length ? Math.max(...rainValues) : undefined;
  return {
    ...(weather.current?.temperature !== undefined ? { currentTemperature: weather.current.temperature } : {}),
    ...(range.max !== undefined ? { todayHigh: range.max } : {}),
    ...(rainRiskPercent !== undefined ? { rainRiskPercent } : {}),
    ...(weather.current?.condition ? { condition: normalizeCondition(weather.current.condition) } : {}),
  };
}

function parseHaForecastPoint(item: unknown, index: number, fallbackCondition: string): WeatherForecastPoint | null {
  if (!isRecord(item)) return null;
  return {
    date: asString(item.datetime) ?? new Date(Date.now() + index * 86_400_000).toISOString(),
    condition: asString(item.condition) ?? fallbackCondition,
    ...(asNumber(item.temperature) !== undefined ? { temperature: asNumber(item.temperature) } : {}),
    ...(asNumber(item.templow) !== undefined ? { tempLow: asNumber(item.templow) } : {}),
    ...(asNumber(item.precipitation_probability) !== undefined
      ? { precipitation: asNumber(item.precipitation_probability) }
      : asNumber(item.precipitation) !== undefined
        ? { precipitation: asNumber(item.precipitation) }
        : {}),
    ...(asNumber(item.wind_speed) !== undefined ? { windSpeed: asNumber(item.wind_speed) } : {}),
  };
}

function extractHaForecastResponse(data: unknown, entityId: string, fallbackCondition: string): WeatherForecastPoint[] {
  if (!isRecord(data) || !isRecord(data.service_response)) return [];
  const entityResponse = data.service_response[entityId];
  if (!isRecord(entityResponse) || !Array.isArray(entityResponse.forecast)) return [];
  return entityResponse.forecast
    .map((item, index) => parseHaForecastPoint(item, index, fallbackCondition))
    .filter((point): point is WeatherForecastPoint => Boolean(point))
    .slice(0, 10);
}

function buildFallbackDailyBrief(draft: DailyBriefDraft): string {
  const parts: string[] = [];
  const weather = draft.weather;
  if (weather?.currentTemperature !== undefined || weather?.todayHigh !== undefined) {
    const weatherParts = [
      weather.currentTemperature !== undefined ? `il fait ${formatTemperature(weather.currentTemperature)}` : '',
      weather.todayHigh !== undefined ? `maximum prevu ${formatTemperature(weather.todayHigh)}` : '',
      weather.rainRiskPercent !== undefined && weather.rainRiskPercent >= 25 ? `risque de pluie ${Math.round(weather.rainRiskPercent)}%` : '',
    ].filter(Boolean);
    if (weatherParts.length) parts.push(`Meteo: ${weatherParts.join(', ')}.`);
  }
  if (draft.calendar?.lines.length) parts.push(`Agenda: ${draft.calendar.lines.slice(0, 3).join('. ')}.`);
  if (draft.mail?.lines.length) parts.push(`Mails: ${draft.mail.lines.slice(0, 3).join('. ')}.`);
  if (draft.todo?.lines.length) parts.push(`Taches: ${draft.todo.lines.slice(0, 3).join('. ')}.`);
  return parts.length
    ? `Brief du jour: ${parts.join(' ')}`
    : 'Brief du jour indisponible pour le moment: aucun contexte exploitable.';
}

function extractOpenAiText(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return asString(first.message.content);
}

function parseSpotifyNowPlaying(data: Record<string, unknown>): SpotifyNowPlaying {
  const item = isRecord(data.item) ? data.item : {};
  const album = isRecord(item.album) && typeof item.album.name === 'string' ? item.album.name.trim() : undefined;
  const artists = Array.isArray(item.artists)
    ? item.artists
        .map((artist) => isRecord(artist) && typeof artist.name === 'string' ? artist.name.trim() : '')
        .filter(Boolean)
    : [];
  const device = isRecord(data.device) ? data.device : {};
  return {
    isPlaying: data.is_playing === true ? true : data.is_playing === false ? false : undefined,
    title: typeof item.name === 'string' ? item.name.trim() || undefined : undefined,
    artists,
    album,
    device: {
      id: typeof device.id === 'string' ? device.id.trim() || undefined : undefined,
      name: typeof device.name === 'string' ? device.name.trim() || undefined : undefined,
      type: typeof device.type === 'string' ? device.type.trim() || undefined : undefined,
      volumePercent: asNumber(device.volume_percent),
    },
  };
}

function extractHomeStates(states: HaStateLike[]): Array<Record<string, unknown>> {
  const allowedDomains = new Set(['light', 'switch', 'timer', 'cover', 'climate', 'lock', 'scene']);
  return states
    .filter((state) => allowedDomains.has(state.entity_id.split('.')[0] ?? ''))
    .slice(0, 80)
    .map((state) => ({
      entityId: state.entity_id,
      state: state.state,
      label: typeof state.attributes?.friendly_name === 'string' ? state.attributes.friendly_name : undefined,
      remaining: typeof state.attributes?.remaining === 'string' ? state.attributes.remaining : undefined,
      position: asNumber(state.attributes?.current_position),
      temperature: asNumber(state.attributes?.temperature),
    }));
}

export class ProactiveContextCache {
  private providers = new Map<ProactiveContextDomain, Provider>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private readonly enabledAgents: Set<ProactiveContextDomain> | null;

  constructor(private readonly deps: Deps) {
    this.enabledAgents = splitAgentList(deps.env.PROACTIVE_CONTEXT_CACHE_AGENTS);
    this.registerProviders();
  }

  start(): void {
    if (!this.deps.env.PROACTIVE_CONTEXT_CACHE_ENABLED || this.refreshTimer) return;
    void this.refreshAll().catch((error) => {
      this.deps.log?.warn({ error }, 'proactive_context_cache_start_refresh_failed');
    });
    this.refreshTimer = setInterval(() => {
      void this.refreshAll().catch((error) => {
        this.deps.log?.warn({ error }, 'proactive_context_cache_periodic_refresh_failed');
      });
    }, this.deps.env.PROACTIVE_CONTEXT_CACHE_REFRESH_MS);
    this.refreshTimer.unref?.();
    this.deps.log?.info(
      { intervalMs: this.deps.env.PROACTIVE_CONTEXT_CACHE_REFRESH_MS },
      'proactive_context_cache_started',
    );
  }

  stop(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  domains(): ProactiveContextDomain[] {
    return [...this.providers.keys()];
  }

  status(): ProactiveContextStatus[] {
    return this.domains().map((domain) => {
      const provider = this.providers.get(domain);
      const debug = provider?.cache.peek();
      const age = debug ? Date.now() - debug.fetchedAt : Number.POSITIVE_INFINITY;
      const options = provider?.cache.getOptions();
      return {
        domain,
        enabled: this.isDomainEnabled(domain),
        configured: Boolean(provider?.configured()),
        cached: Boolean(debug),
        stale: Boolean(debug && options && age > options.ttlMs),
        ...(debug ? { fetchedAt: new Date(debug.fetchedAt).toISOString() } : {}),
        ...(provider?.lastError ? { lastError: provider.lastError } : {}),
        ...(provider?.retryAfterMs && provider.retryAfterMs > Date.now()
          ? { nextRetryAt: new Date(provider.retryAfterMs).toISOString() }
          : {}),
        metrics: provider?.metrics ?? emptyMetrics(),
      };
    });
  }

  async get(domain: ProactiveContextDomain, options?: { force?: boolean }): Promise<ProactiveContextResult | null> {
    const provider = this.providers.get(domain);
    if (!provider || !this.isDomainEnabled(domain)) return null;
    if (!provider.configured()) {
      provider.lastError = 'not_configured';
      provider.metrics.misses += 1;
      return null;
    }
    if (!options?.force && provider.retryAfterMs && provider.retryAfterMs > Date.now()) {
      const debug = provider.cache.peek();
      const cacheOptions = provider.cache.getOptions();
      if (debug && Date.now() - debug.fetchedAt <= cacheOptions.staleMs) {
        provider.metrics.staleHits += 1;
        provider.metrics.lastHitAt = recordNow();
        return this.toContextResult(domain, {
          value: debug.value,
          cached: true,
          stale: true,
          fetchedAt: debug.fetchedAt,
        });
      }
      provider.metrics.misses += 1;
      return null;
    }

    try {
      if (options?.force) provider.cache.invalidate();
      const result = await provider.cache.get();
      provider.lastError = undefined;
      provider.retryAfterMs = undefined;
      if (result.cached && result.stale) {
        provider.metrics.staleHits += 1;
        provider.metrics.lastHitAt = recordNow();
      } else if (result.cached) {
        provider.metrics.hits += 1;
        provider.metrics.lastHitAt = recordNow();
      } else {
        provider.metrics.refreshes += 1;
        provider.metrics.lastRefreshAt = recordNow();
      }
      provider.metrics.consecutiveFailures = 0;
      return this.toContextResult(domain, result);
    } catch (error) {
      provider.lastError = error instanceof Error ? error.message : String(error);
      provider.metrics.failures += 1;
      provider.metrics.consecutiveFailures += 1;
      provider.metrics.lastFailureAt = recordNow();
      const backoffMs = Math.min(300_000, 10_000 * (2 ** Math.min(provider.metrics.consecutiveFailures - 1, 5)));
      provider.retryAfterMs = Date.now() + backoffMs;
      throw error;
    }
  }

  async refreshAll(): Promise<ProactiveContextResult[]> {
    const results = await Promise.allSettled(
      this.domains()
        .filter((domain) => this.isDomainEnabled(domain))
        .map((domain) => this.get(domain, { force: true })),
    );
    return results
      .filter((result): result is PromiseFulfilledResult<ProactiveContextResult | null> => result.status === 'fulfilled')
      .map((result) => result.value)
      .filter((result): result is ProactiveContextResult => Boolean(result));
  }

  private isDomainEnabled(domain: ProactiveContextDomain): boolean {
    if (!this.deps.env.PROACTIVE_CONTEXT_CACHE_ENABLED) return false;
    return this.enabledAgents === null || this.enabledAgents.has(domain);
  }

  private toContextResult(
    domain: ProactiveContextDomain,
    result: { value: ProactiveContextSnapshot; cached: boolean; stale: boolean; fetchedAt: number },
  ): ProactiveContextResult {
    return {
      domain,
      enabled: true,
      cached: result.cached,
      stale: result.stale,
      fetchedAt: new Date(result.fetchedAt).toISOString(),
      snapshot: {
        ...result.value,
        preparedAnswers: result.value.preparedAnswers.map((answer) => ({
          ...answer,
          fetchedAt: new Date(result.fetchedAt).toISOString(),
          freshness: freshness(result.stale),
        })),
      },
    };
  }

  private registerProviders(): void {
    this.addProvider('spotify', this.deps.env.PROACTIVE_CONTEXT_CACHE_SPOTIFY_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_SPOTIFY_STALE_MS, () => this.buildSpotifySnapshot(), () => this.deps.spotifyWebApi.isConfigured());
    this.addProvider('weather', this.deps.env.PROACTIVE_CONTEXT_CACHE_WEATHER_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_WEATHER_STALE_MS, () => this.buildWeatherSnapshot(), () => Boolean(this.deps.ha));
    this.addProvider('home', this.deps.env.PROACTIVE_CONTEXT_CACHE_HOME_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_HOME_STALE_MS, () => this.buildHomeSnapshot(), () => Boolean(this.deps.ha));
    this.addProvider('nas', this.deps.env.PROACTIVE_CONTEXT_CACHE_NAS_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_NAS_STALE_MS, () => this.buildNasSnapshot(), () => Boolean(this.deps.nasStatus?.isConfigured()));
    this.addProvider('mail', this.deps.env.PROACTIVE_CONTEXT_CACHE_MAIL_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_MAIL_STALE_MS, () => this.buildMailSnapshot(), () => true);
    this.addProvider('todo', this.deps.env.PROACTIVE_CONTEXT_CACHE_TODO_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_TODO_STALE_MS, () => this.buildTodoSnapshot(), () => true);
    this.addProvider('calendar', this.deps.env.PROACTIVE_CONTEXT_CACHE_CALENDAR_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_CALENDAR_STALE_MS, () => this.buildCalendarSnapshot(), () => true);
    this.addProvider('news', this.deps.env.PROACTIVE_CONTEXT_CACHE_NEWS_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_NEWS_STALE_MS, () => this.buildNewsSnapshot(), () => Boolean(this.deps.env.HELIX_NEWS_BASE_URL));
    this.addProvider('daily_brief', this.deps.env.PROACTIVE_CONTEXT_CACHE_DAILY_BRIEF_TTL_MS, this.deps.env.PROACTIVE_CONTEXT_CACHE_DAILY_BRIEF_STALE_MS, () => this.buildDailyBriefSnapshot(), () => true);
  }

  private addProvider(
    domain: ProactiveContextDomain,
    ttlMs: number,
    staleMs: number,
    loader: () => Promise<ProactiveContextSnapshot>,
    configured: () => boolean,
  ): void {
    this.providers.set(domain, {
      domain,
      configured,
      cache: new AsyncSnapshotCache(loader, { ttlMs, staleMs }),
      metrics: emptyMetrics(),
    });
  }

  private async getHaStates(): Promise<HaStateLike[]> {
    if (!this.deps.ha) throw new Error('home_assistant_not_configured');
    const raw = await this.deps.ha.getStates();
    if (!Array.isArray(raw)) throw new Error('home_assistant_states_invalid');
    return raw.filter((item): item is HaStateLike => isRecord(item) && typeof item.entity_id === 'string');
  }

  private async buildSpotifySnapshot(): Promise<ProactiveContextSnapshot> {
    const [now, devices] = await Promise.all([
      this.deps.spotifyWebApi.getNowPlaying(),
      this.deps.spotifyWebApi.listDevicesPublic(),
    ]);
    const fetchedAt = new Date().toISOString();
    const nowPlaying = now.ok ? parseSpotifyNowPlaying(now.data) : null;
    const deviceList = devices.ok ? devices.devices : [];
    const answers: PreparedContextAnswer[] = [];

    if (nowPlaying?.title) {
      const artists = nowPlaying.artists.length ? ` de ${nowPlaying.artists.join(', ')}` : '';
      answers.push(withFreshness({
        domain: 'spotify',
        questionKey: 'spotify.now_playing',
        answerText: `En cours : ${nowPlaying.title}${artists}.`,
        sourceRefs: [{ type: 'spotify-now-playing', label: nowPlaying.title }],
      }, fetchedAt, false));
      answers.push(withFreshness({
        domain: 'spotify',
        questionKey: 'spotify.playback_state',
        answerText: nowPlaying.isPlaying === false ? 'La musique est en pause.' : 'La musique est en lecture.',
        sourceRefs: [{ type: 'spotify-now-playing', label: nowPlaying.title }],
      }, fetchedAt, false));
    } else {
      answers.push(withFreshness({
        domain: 'spotify',
        questionKey: 'spotify.now_playing',
        answerText: 'Rien ne joue actuellement sur Spotify.',
      }, fetchedAt, false));
    }

    const activeDevice = deviceList.find((device) => device.isActive) ?? (nowPlaying?.device?.name ? nowPlaying.device : undefined);
    if (activeDevice?.name) {
      answers.push(withFreshness({
        domain: 'spotify',
        questionKey: 'spotify.active_device',
        answerText: `Spotify est actif sur ${activeDevice.name}.`,
        sourceRefs: [{ type: 'spotify-device', id: activeDevice.id, label: activeDevice.name }],
      }, fetchedAt, false));
    }
    answers.push(withFreshness({
      domain: 'spotify',
      questionKey: 'spotify.list_devices',
      answerText: deviceList.length
        ? `${deviceList.length} appareil(s) Spotify disponible(s) : ${deviceList.map((device) => device.name).join(', ')}.`
        : 'Aucun appareil Spotify disponible pour le moment.',
      sourceRefs: deviceList.slice(0, 8).map((device) => ({ type: 'spotify-device', id: device.id, label: device.name })),
    }, fetchedAt, false));

    return {
      domain: 'spotify',
      value: { nowPlaying, devices: deviceList, errors: { now: now.ok ? null : now.error, devices: devices.ok ? null : devices.error } },
      preparedAnswers: answers,
    };
  }

  private async buildWeatherSnapshot(): Promise<ProactiveContextSnapshot<WeatherSnapshot | null>> {
    const states = await this.getHaStates();
    const weather = buildWeatherSnapshotFromStates(states);
    if (weather?.current?.entityId && weather.forecast.length === 0) {
      try {
        const forecastResponse = await this.deps.ha?.callService({
          domain: 'weather',
          service: 'get_forecasts',
          serviceData: {
            entity_id: weather.current.entityId,
            type: 'daily',
          },
          returnResponse: true,
        });
        weather.forecast = extractHaForecastResponse(
          forecastResponse?.data,
          weather.current.entityId,
          weather.current.condition,
        );
      } catch (error) {
        this.deps.log?.warn({ error, entityId: weather.current.entityId }, 'weather_forecast_service_failed');
      }
    }
    const fetchedAt = new Date().toISOString();
    const answers: PreparedContextAnswer[] = [];
    if (weather?.current?.temperature !== undefined) {
      answers.push(withFreshness({
        domain: 'weather',
        questionKey: 'weather.temperature',
        answerText: `Il fait actuellement ${Math.round(weather.current.temperature)}°C.`,
      }, fetchedAt, false));
    }
    if (weather?.current?.humidity !== undefined) {
      answers.push(withFreshness({
        domain: 'weather',
        questionKey: 'weather.humidity',
        answerText: `L'humidite est actuellement de ${Math.round(weather.current.humidity)}%.`,
      }, fetchedAt, false));
    }
    if (weather) {
      const now = new Date();
      const todayKey = dateKeyFromDate(now);
      const tomorrowKey = dateKeyFromDate(addDays(now, 1));
      const todayPoints = weather.forecast.filter((point) => forecastDateKey(point) === todayKey);
      const tomorrowPoint = pickForecastForDay(weather.forecast, tomorrowKey);
      const todaySource = todayPoints.length ? todayPoints : weather.forecast.slice(0, 1);
      const todayRange = forecastRange(todaySource);
      const hourlyToday = todayPoints
        .filter((point) => forecastHour(point))
        .slice(0, 6);

      if (todayRange.max !== undefined) {
        answers.push(withFreshness({
          domain: 'weather',
          questionKey: 'weather.today_high',
          answerText: `La maximale prévue aujourd'hui est ${formatTemperature(todayRange.max)}.`,
        }, fetchedAt, false));
      }
      if (todayRange.min !== undefined) {
        answers.push(withFreshness({
          domain: 'weather',
          questionKey: 'weather.today_low',
          answerText: `La minimale prévue aujourd'hui est ${formatTemperature(todayRange.min)}.`,
        }, fetchedAt, false));
      }
      if (todayRange.min !== undefined || todayRange.max !== undefined) {
        const rangeParts = [
          todayRange.min !== undefined ? `min ${formatTemperature(todayRange.min)}` : '',
          todayRange.max !== undefined ? `max ${formatTemperature(todayRange.max)}` : '',
        ].filter(Boolean);
        answers.push(withFreshness({
          domain: 'weather',
          questionKey: 'weather.today_outfit',
          answerText: `Pour t'habiller aujourd'hui : ${rangeParts.join(', ')}${weather.current?.condition ? `, temps ${normalizeCondition(weather.current.condition)}` : ''}.`,
        }, fetchedAt, false));
      }
      if (tomorrowPoint) {
        answers.push(withFreshness({
          domain: 'weather',
          questionKey: 'weather.tomorrow',
          answerText: `Demain : ${summarizeForecastPoint(tomorrowPoint)}.`,
        }, fetchedAt, false));
      }
      if (weather.forecast.length >= 2) {
        const weekPoints = weather.forecast.slice(0, 7);
        const weekRange = forecastRange(weekPoints);
        const labels = weekPoints.slice(0, 5).map((point) => {
          const day = point.date.slice(5, 10);
          return `${day} ${normalizeCondition(point.condition)}${point.temperature !== undefined ? ` ${formatTemperature(point.temperature)}` : ''}`;
        });
        const range = [
          weekRange.min !== undefined ? `min ${formatTemperature(weekRange.min)}` : '',
          weekRange.max !== undefined ? `max ${formatTemperature(weekRange.max)}` : '',
        ].filter(Boolean);
        answers.push(withFreshness({
          domain: 'weather',
          questionKey: 'weather.weekly_trend',
          answerText: `Tendance semaine : ${labels.join('; ')}${range.length ? `. Fourchette ${range.join(', ')}.` : '.'}`,
        }, fetchedAt, false));
      }
      if (hourlyToday.length) {
        answers.push(withFreshness({
          domain: 'weather',
          questionKey: 'weather.today_by_hour',
          answerText: `Aujourd'hui par heure : ${hourlyToday.map((point) => `${forecastHour(point)} ${summarizeForecastPoint(point)}`).join('; ')}.`,
        }, fetchedAt, false));
      }
    }

    const questions = [
      ['weather.conditions', 'Quel temps il fait ?'],
      ['weather.precipitation', 'Il pleut ?'],
    ] as const;
    return {
      domain: 'weather',
      value: weather,
      preparedAnswers: weather
        ? [
            ...answers,
            ...questions
            .map(([questionKey, userText]) => {
              const answerText = synthesizeDeterministicWeatherReply({ userText, weather });
              return answerText ? withFreshness({ domain: 'weather', questionKey, answerText }, fetchedAt, false) : null;
            })
            .filter((answer): answer is PreparedContextAnswer => Boolean(answer)),
          ]
        : [],
    };
  }

  private async buildHomeSnapshot(): Promise<ProactiveContextSnapshot> {
    const states = await this.getHaStates();
    const entities = extractHomeStates(states);
    const timers = entities.filter((entity) => String(entity.entityId).startsWith('timer.'));
    const activeTimers = timers.filter((entity) => entity.state === 'active');
    const lightsOn = entities.filter((entity) => String(entity.entityId).startsWith('light.') && entity.state === 'on');
    const fetchedAt = new Date().toISOString();
    return {
      domain: 'home',
      value: {
        entities,
        counts: {
          entities: entities.length,
          activeTimers: activeTimers.length,
          lightsOn: lightsOn.length,
        },
      },
      preparedAnswers: [
        withFreshness({
          domain: 'home',
          questionKey: 'executor.timer_state',
          answerText: activeTimers.length
            ? `${activeTimers.length} minuteur(s) actif(s) : ${activeTimers.map((timer) => `${timer.label ?? timer.entityId}${timer.remaining ? `, reste ${timer.remaining}` : ''}`).join('; ')}.`
            : 'Aucun minuteur actif repere.',
        }, fetchedAt, false),
        withFreshness({
          domain: 'home',
          questionKey: 'executor.light_state',
          answerText: lightsOn.length
            ? `${lightsOn.length} lumiere(s) allumee(s) : ${lightsOn.slice(0, 8).map((light) => light.label ?? light.entityId).join(', ')}.`
            : 'Aucune lumiere allumee reperee dans le snapshot.',
        }, fetchedAt, false),
      ],
    };
  }

  private async buildNasSnapshot(): Promise<ProactiveContextSnapshot> {
    if (!this.deps.nasStatus) throw new Error('nas_status_not_configured');
    const nas = await this.deps.nasStatus.getStatus();
    const hottest = nas.temperatures.slice().sort((left, right) => right.celsius - left.celsius)[0];
    const fullest = nas.filesystems.slice().sort((left, right) => right.usedPercent - left.usedPercent)[0];
    const fetchedAt = new Date().toISOString();
    const healthParts = [
      `charge ${nas.load.one.toFixed(2)}`,
      `memoire ${Math.round(nas.memory.usedPercent)}%`,
      fullest ? `disque ${fullest.mount} ${Math.round(fullest.usedPercent)}%` : '',
      hottest ? `${hottest.label} ${Math.round(hottest.celsius)}°C` : '',
    ].filter(Boolean);
    return {
      domain: 'nas',
      value: nas,
      preparedAnswers: [
        withFreshness({
          domain: 'nas',
          questionKey: 'nas.health',
          answerText: `${nas.hostname} repond. ${healthParts.join(', ')}.`,
        }, fetchedAt, false),
        withFreshness({
          domain: 'nas',
          questionKey: 'nas.storage',
          answerText: fullest
            ? `Le volume le plus rempli est ${fullest.mount}, utilise a ${Math.round(fullest.usedPercent)}%.`
            : 'Aucun volume disque remonte dans le snapshot NAS.',
        }, fetchedAt, false),
        withFreshness({
          domain: 'nas',
          questionKey: 'nas.thermal',
          answerText: hottest
            ? `Temperature la plus haute : ${hottest.label}, ${Math.round(hottest.celsius)}°C.`
            : 'Aucune temperature remontee par le NAS.',
        }, fetchedAt, false),
      ],
    };
  }

  private async buildMailSnapshot(): Promise<ProactiveContextSnapshot<DashboardSection>> {
    const section = await buildMailSection(this.deps.env, this.deps.log ?? noopLogger);
    const fetchedAt = new Date().toISOString();
    return {
      domain: 'mail',
      value: section,
      preparedAnswers: [
        dashboardAnswer('mail', 'mail.unread_summary', section, fetchedAt),
        dashboardAnswer('mail', 'mail.latest_summary', section, fetchedAt),
        dashboardAnswer('mail', 'mail.important_summary', section, fetchedAt),
      ],
    };
  }

  private async buildTodoSnapshot(): Promise<ProactiveContextSnapshot<DashboardSection>> {
    const section = await buildTasksSection(this.deps.env);
    const fetchedAt = new Date().toISOString();
    return {
      domain: 'todo',
      value: section,
      preparedAnswers: [
        dashboardAnswer('todo', 'todo.today', section, fetchedAt),
        dashboardAnswer('todo', 'todo.overdue', section, fetchedAt),
        dashboardAnswer('todo', 'todo.next', section, fetchedAt),
        dashboardAnswer('todo', 'todo.lists', section, fetchedAt),
      ],
    };
  }

  private async buildCalendarSnapshot(): Promise<ProactiveContextSnapshot<DashboardSection>> {
    const section = await buildAgendaFromGoogle(this.deps.env);
    const fetchedAt = new Date().toISOString();
    return {
      domain: 'calendar',
      value: section,
      preparedAnswers: [
        dashboardAnswer('calendar', 'calendar.next_event', section, fetchedAt),
        dashboardAnswer('calendar', 'calendar.today', section, fetchedAt),
        dashboardAnswer('calendar', 'calendar.tomorrow', section, fetchedAt),
        dashboardAnswer('calendar', 'calendar.free_busy', section, fetchedAt),
      ],
    };
  }

  private async buildNewsSnapshot(): Promise<ProactiveContextSnapshot> {
    const baseUrl = this.deps.env.HELIX_NEWS_BASE_URL?.trim();
    if (!baseUrl) throw new Error('helix_news_not_configured');

    const params = new URLSearchParams({ limit: '8' });
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/news/items?${params.toString()}`, {
      headers: {
        accept: 'application/json',
        ...(this.deps.env.HELIX_NEWS_API_TOKEN?.trim() ? { 'x-api-token': this.deps.env.HELIX_NEWS_API_TOKEN.trim() } : {}),
      },
      signal: AbortSignal.timeout(this.deps.env.HELIX_NEWS_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`helix_news_items_failed:${response.status}:${body.slice(0, 200)}`);
    }

    const payload = await response.json() as unknown;
    const rawItems = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.items)
        ? payload.items
        : isRecord(payload) && Array.isArray(payload.data)
          ? payload.data
          : [];
    const items: NewsItem[] = rawItems
      .filter(isRecord)
      .map((item) => ({
        title: asString(item.title) ?? asString(item.headline) ?? '(sans titre)',
        source: asString(item.source) ?? asString(item.publisher),
        link: asString(item.link) ?? asString(item.url),
        publishedAt: asString(item.publishedAt) ?? asString(item.published_at) ?? asString(item.date),
      }))
      .filter((item) => item.title !== '(sans titre)')
      .slice(0, 8);
    const fetchedAt = new Date().toISOString();
    const topTitles = items.slice(0, 5).map((item) => item.source ? `${item.title} (${item.source})` : item.title);

    return {
      domain: 'news',
      value: {
        items,
        count: items.length,
      },
      preparedAnswers: [
        withFreshness({
          domain: 'news',
          questionKey: 'news.headlines',
          answerText: topTitles.length
            ? `Voici les dernieres actus suivies: ${topTitles.join('; ')}.`
            : 'Aucune actualite recente disponible dans le cache pour le moment.',
          sourceRefs: items
            .filter((item) => item.link || item.source)
            .map((item) => ({ type: 'news-item', id: item.link, label: item.source ?? item.title })),
        }, fetchedAt, false),
      ],
    };
  }

  private async synthesizeDailyBriefWithOpenAi(draft: DailyBriefDraft): Promise<string | null> {
    const apiKey = this.deps.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;

    const system = [
      'Tu prepares le brief oral du matin pour une maison connectee.',
      'Reponds en francais naturel, fluide, tutoie, sans markdown, sans puces, sans emoji.',
      'Commence par "Brief du jour:".',
      'Fais court mais utile: 80 a 130 mots maximum.',
      'Meteo: donne la temperature exterieure actuelle et la maximale du jour si elles existent, toujours avec le mot "degres".',
      'Meteo: ne parle de pluie que si rainRiskPercent est present et superieur ou egal a 25.',
      'Agenda: reformule pour que ce soit lisible a l oral, avec heure ou deadline quand disponible.',
      'Gmail: mentionne seulement les emails vraiment actionnables: securite, personne connue, administratif, argent, voyage, travail.',
      'Gmail: ignore newsletters, promotions, recus et contenus marketing; si rien de prioritaire, dis simplement "rien de prioritaire cote mails".',
      'Taches: rappelle toutes les taches en retard et toutes les taches du jour presentes dans le contexte.',
      'Taches: ignore les taches sans deadline; elles sont traitees hors Jarvis.',
      'Taches: ne dis "urgent" que pour les elements explicitement marques urgents/high; sinon dis "a faire" ou "a surveiller".',
      'Ne parle jamais d actualites/news.',
      'N invente pas de source, de deadline ou de meteo absente.',
    ].join(' ');

    const response = await fetch(`${this.deps.env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.deps.env.OPENAI_MODEL_SUMMARY,
        temperature: 0.2,
        max_tokens: 280,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(draft) },
        ],
      }),
      signal: AbortSignal.timeout(Math.min(this.deps.env.OPENAI_TIMEOUT_MS, 10_000)),
    });

    if (!response.ok) {
      this.deps.log?.warn({ status: response.status }, 'daily_brief_openai_failed');
      return null;
    }

    const payload = await response.json().catch(() => null);
    const text = extractOpenAiText(payload);
    if (!text) return null;
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return /^brief du jour\s*:/iu.test(cleaned) ? cleaned : `Brief du jour: ${cleaned}`;
  }

  private async buildDailyBriefSnapshot(): Promise<ProactiveContextSnapshot> {
    const fetchedAt = new Date().toISOString();
    const [weather, calendar, mail, todo] = await Promise.all([
      this.get('weather').catch(() => null),
      this.get('calendar').catch(() => null),
      this.get('mail').catch(() => null),
      this.get('todo').catch(() => null),
    ]);
    const draft: DailyBriefDraft = {
      weather: buildDailyBriefWeatherDraft(weather?.snapshot.value as WeatherSnapshot | null | undefined),
      calendar: dashboardBriefSection(calendar?.snapshot.value),
      mail: filterMailBriefSection(dashboardBriefSection(mail?.snapshot.value)),
      todo: dashboardBriefSection(todo?.snapshot.value, { maxLines: 30, maxItems: 30 }),
    };
    const answerText = await this.synthesizeDailyBriefWithOpenAi(draft)
      ?? buildFallbackDailyBrief(draft);
    const sections = [
      draft.weather ? `Meteo: ${JSON.stringify(draft.weather)}` : '',
      draft.calendar ? `Agenda: ${draft.calendar.summary}` : '',
      draft.mail ? `Mails: ${draft.mail.summary}` : '',
      draft.todo ? `Taches: ${draft.todo.summary}` : '',
    ].filter(Boolean);

    return {
      domain: 'daily_brief',
      value: {
        draft,
        sections,
        sources: {
          weather: Boolean(weather),
          calendar: Boolean(calendar),
          mail: Boolean(mail),
          todo: Boolean(todo),
        },
      },
      preparedAnswers: [
        withFreshness({
          domain: 'daily_brief',
          questionKey: 'daily_brief.today',
          answerText,
          sourceRefs: [
            { type: 'context-cache', label: 'weather' },
            { type: 'context-cache', label: 'calendar' },
            { type: 'context-cache', label: 'mail' },
            { type: 'context-cache', label: 'todo' },
          ],
        }, fetchedAt, false),
      ],
    };
  }
}

const noopLogger = {
  warn: () => undefined,
} as unknown as FastifyBaseLogger;
