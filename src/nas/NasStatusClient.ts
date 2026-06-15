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

  constructor(env: Env) {
    this.url = env.NAS_STATUS_URL;
    this.token = env.NAS_STATUS_TOKEN;
    this.timeoutMs = env.NAS_STATUS_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.token);
  }

  async getStatus(): Promise<NasStatus> {
    if (!this.url || !this.token) throw new Error('NAS status is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`NAS status failed (${response.status})`);
      return await response.json() as NasStatus;
    } finally {
      clearTimeout(timeout);
    }
  }
}
