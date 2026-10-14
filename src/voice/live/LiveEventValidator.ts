import { z } from 'zod';

const eventEnvelopeSchema = z.object({
  type: z.string().min(1).max(128),
}).passthrough();

const allowedEventTypes = new Set([
  'session.started',
  'session.updated',
  'session.closed',
  'session.usage.updated',
  'session.input_transcript.delta',
  'session.output_transcript.delta',
  'session.delegation.created',
  'session.instructions.appended',
  'session.thinking.appended',
  'session.commentary.appended',
  'session.input_audio.append',
  'session.output_audio.delta',
  'error',
]);

export type ValidatedLiveEvent = Record<string, unknown> & { type: string };

export class LiveEventValidator {
  constructor(private readonly maxEventBytes: number) {}

  parse(raw: Buffer | ArrayBuffer | Buffer[]): ValidatedLiveEvent {
    const buffer = Array.isArray(raw)
      ? Buffer.concat(raw)
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : raw;
    if (buffer.byteLength > this.maxEventBytes) throw new Error('live_event_too_large');
    let decoded: unknown;
    try {
      decoded = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new Error('live_event_invalid_json');
    }
    const parsed = eventEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new Error('live_event_invalid');
    if (!allowedEventTypes.has(parsed.data.type)) throw new Error('live_event_not_allowed');
    return parsed.data;
  }

  delegationId(event: ValidatedLiveEvent): string | null {
    if (event.type !== 'session.delegation.created') return null;
    const delegation = event['delegation'];
    if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)) {
      throw new Error('live_delegation_invalid');
    }
    const id = (delegation as Record<string, unknown>)['id'];
    const target = (delegation as Record<string, unknown>)['target'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(id)) {
      throw new Error('live_delegation_invalid');
    }
    if (target !== 'client') throw new Error('live_delegation_target_invalid');
    return id;
  }

  usageSeconds(event: ValidatedLiveEvent): number | null {
    if (event.type !== 'session.usage.updated' && event.type !== 'session.closed') return null;
    const usage = event['usage'];
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
    const seconds = (usage as Record<string, unknown>)['seconds'];
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? Math.floor(seconds)
      : null;
  }
}
