type InfluxEnv = {
  INFLUXDB_URL?: string;
  INFLUXDB_TOKEN?: string;
  INFLUXDB_ORG?: string;
  INFLUXDB_BUCKET?: string;
  INFLUXDB_TIMEOUT_MS: number;
  METRICS_INSTANCE: string;
};

function escMeasurement(s: string): string {
  // https://docs.influxdata.com/influxdb/v2/reference/syntax/line-protocol/
  return s.replace(/[,\s]/g, (m) => `\\${m}`);
}

function escTagKeyOrValue(s: string): string {
  return s.replace(/[,=\s]/g, (m) => `\\${m}`);
}

function escFieldStringValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toFieldValue(v: string | number | boolean): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '0';
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `"${escFieldStringValue(v)}"`;
}

export type InfluxPoint = {
  measurement: string;
  tags?: Record<string, string | undefined>;
  fields: Record<string, string | number | boolean | undefined>;
  // epoch ms
  timestampMs?: number;
};

export class InfluxWriter {
  private readonly enabled: boolean;
  private readonly url?: string;
  private readonly token?: string;
  private readonly org?: string;
  private readonly bucket?: string;
  private readonly timeoutMs: number;

  constructor(private readonly env: InfluxEnv) {
    this.url = env.INFLUXDB_URL?.replace(/\/$/, '');
    this.token = env.INFLUXDB_TOKEN;
    this.org = env.INFLUXDB_ORG;
    this.bucket = env.INFLUXDB_BUCKET;
    this.timeoutMs = env.INFLUXDB_TIMEOUT_MS;

    this.enabled = Boolean(this.url && this.token && this.org && this.bucket);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  pointToLine(point: InfluxPoint): string {
    const measurement = escMeasurement(point.measurement);

    const tags: string[] = [];
    const allTags: Record<string, string | undefined> = {
      instance: this.env.METRICS_INSTANCE,
      ...(point.tags ?? {}),
    };

    for (const [k, v] of Object.entries(allTags)) {
      if (v === undefined) continue;
      const kk = escTagKeyOrValue(String(k));
      const vv = escTagKeyOrValue(String(v));
      if (!kk || !vv) continue;
      tags.push(`${kk}=${vv}`);
    }

    const fields: string[] = [];
    for (const [k, v] of Object.entries(point.fields)) {
      if (v === undefined) continue;
      const kk = escTagKeyOrValue(String(k));
      if (!kk) continue;
      fields.push(`${kk}=${toFieldValue(v)}`);
    }

    if (fields.length === 0) {
      // Influx rejects empty field sets.
      fields.push('noop=true');
    }

    const ts = point.timestampMs ?? Date.now();
    const prefix = tags.length ? `${measurement},${tags.join(',')}` : measurement;
    return `${prefix} ${fields.join(',')} ${ts}`;
  }

  async writePoints(points: InfluxPoint[]): Promise<void> {
    if (!this.enabled) return;

    const lines = points.map((p) => this.pointToLine(p)).join('\n');
    if (!lines.trim()) return;

    const writeUrl = new URL('/api/v2/write', this.url);
    writeUrl.searchParams.set('org', this.org as string);
    writeUrl.searchParams.set('bucket', this.bucket as string);
    writeUrl.searchParams.set('precision', 'ms');

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(writeUrl, {
        method: 'POST',
        headers: {
          authorization: `Token ${this.token}`,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: lines,
        signal: controller.signal,
      });

      if (!resp.ok) {
        // Swallow errors (metrics must never break the request path).
        await resp.text().catch(() => '');
      }
    } catch {
      // Swallow errors.
    } finally {
      clearTimeout(t);
    }
  }
}
