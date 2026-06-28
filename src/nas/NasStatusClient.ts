import type { Env } from '../env';

export type NasStatus = {
  hostname: string;
  generatedAt: string;
  uptimeSeconds: number;
  load: { one: number; five: number; fifteen: number };
  memory: { totalBytes: number; availableBytes: number; usedPercent: number };
  swap: { totalBytes: number; freeBytes: number; usedPercent: number };
  filesystems: Array<{
    mount: string;
    totalBytes: number;
    availableBytes: number;
    usedPercent: number;
  }>;
  temperatures: Array<{ label: string; celsius: number }>;
  protocols: Array<{ name: string; available: boolean; port?: number }>;
};

export class NasStatusClient {
  private readonly url?: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheStaleMs: number;
  private cached?: { value: NasStatus; fetchedAt: number };
  private inFlight?: Promise<NasStatus>;

  constructor(env: Env) {
    this.url = env.NAS_STATUS_URL;
    this.token = env.NAS_STATUS_TOKEN;
    this.timeoutMs = env.NAS_STATUS_TIMEOUT_MS;
    this.cacheTtlMs = env.NAS_STATUS_CACHE_TTL_MS;
    this.cacheStaleMs = env.NAS_STATUS_CACHE_STALE_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.token);
  }

  async getStatus(): Promise<NasStatus> {
    if (!this.url || !this.token) throw new Error('NAS status is not configured');
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt <= this.cacheTtlMs) {
      return this.cached.value;
    }
    if (this.cached && now - this.cached.fetchedAt <= this.cacheStaleMs) {
      void this.refreshStatus();
      return this.cached.value;
    }
    return this.refreshStatus();
  }

  private async refreshStatus(): Promise<NasStatus> {
    if (this.inFlight) return this.inFlight;
    const url = this.url;
    const token = this.token;
    if (!url || !token) throw new Error('NAS status is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.inFlight = (async () => {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`NAS status failed (${response.status})`);
      const value = await response.json() as NasStatus;
      this.cached = { value, fetchedAt: Date.now() };
      return value;
    })().finally(() => {
      clearTimeout(timeout);
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
