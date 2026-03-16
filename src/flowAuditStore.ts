import fs from 'node:fs/promises';
import path from 'node:path';

export type FlowAuditRecord = {
  at: string;
  requestId: string;
  text: string;
  conversationId?: string;
  ingestLatencyMs: number;
  jarvis: {
    requestId?: string;
    intent?: string;
    skill?: string;
    actions: string[];
    mode?: string;
    responseType?: string;
  };
  execution: {
    executedCount: number;
    failedCount: number;
    skippedCount: number;
    statuses: Array<{ type: string; status: 'executed' | 'failed' | 'skipped'; error?: string }>;
  };
  reply: {
    source: 'jarvis' | 'vm400';
    kind: 'chat' | 'action' | 'error';
    text: string;
  };
};

export class FlowAuditStore {
  constructor(private readonly filePath: string, private readonly enabled: boolean) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  async append(record: FlowAuditRecord): Promise<void> {
    if (!this.enabled) return;

    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async recent(limit: number): Promise<FlowAuditRecord[]> {
    if (!this.enabled) return [];

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const tail = lines.slice(-Math.max(1, limit));
      const parsed: FlowAuditRecord[] = [];

      for (const line of tail) {
        try {
          parsed.push(JSON.parse(line) as FlowAuditRecord);
        } catch {
          continue;
        }
      }

      return parsed.reverse();
    } catch {
      return [];
    }
  }
}
