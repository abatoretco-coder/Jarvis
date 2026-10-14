import type { MessageRepository } from '../../conversation/repositories/MessageRepository';
import type { ThreadRepository } from '../../conversation/repositories/ThreadRepository';

export type LiveSeedMessage = { role: 'user' | 'assistant'; content: string };

function clean(value: string): string {
  return value
    .replace(/\0/gu, '')
    .replace(/\b(?:sk|sess|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu, '[secret retiré]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/giu, 'Bearer [secret retiré]')
    .replace(/\b((?:api[_ -]?key|token|secret|password|mot de passe))\s*[:=]\s*\S+/giu, '$1=[secret retiré]')
    .replace(/\s+/gu, ' ')
    .trim();
}

function takeUtf8Budget(value: string, budget: number): string {
  if (Buffer.byteLength(value, 'utf8') <= budget) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > budget) break;
    result += character;
  }
  return result.trim();
}

/**
 * Uses UTF-8 bytes as a conservative token upper bound. A BPE token cannot
 * consume less than one encoded byte, so a 6,000-byte payload cannot exceed
 * 6,000 model tokens even for adversarial Unicode input.
 */
export class LiveContextAdapter {
  constructor(
    private readonly threads: ThreadRepository,
    private readonly messages: MessageRepository,
    private readonly maxMessages = 20,
    private readonly maxTokenUpperBound = 6_000
  ) {}

  async build(threadId: string, contextNote?: string): Promise<{
    input: LiveSeedMessage[];
    contextNote?: string;
  }> {
    const thread = await this.threads.findById(threadId);
    const recent = thread ? await this.messages.getRecentMessages(threadId, this.maxMessages) : [];
    const chronological = [...recent].sort((left, right) => left.seq - right.seq);
    let remaining = this.maxTokenUpperBound;
    const reversed: LiveSeedMessage[] = [];
    for (const message of chronological.reverse()) {
      const content = clean(message.content);
      if (!content || remaining <= 0) continue;
      const bounded = takeUtf8Budget(content, remaining);
      if (!bounded) continue;
      remaining -= Buffer.byteLength(bounded, 'utf8');
      reversed.push({ role: message.role, content: bounded });
    }
    if (thread?.summary && remaining > 0) {
      const summary = takeUtf8Budget(clean(thread.summary), remaining);
      if (summary) reversed.push({ role: 'assistant', content: `Résumé Jarvis : ${summary}` });
    }
    const note = contextNote ? takeUtf8Budget(clean(contextNote), 1_000) : '';
    return {
      input: reversed.reverse(),
      ...(note ? { contextNote: note } : {}),
    };
  }
}
