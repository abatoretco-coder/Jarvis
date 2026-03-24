import { toSingleParagraphPlainText } from './plainText';
import type { MessageRepository } from './repositories/MessageRepository';
import type { ThreadRepository } from './repositories/ThreadRepository';

export type ConversationServiceOptions = {
  haBaseUrl: string;
  haToken: string;
  requestTimeoutMs: number;
  minIntervalMs: number;
  retryCount: number;
  retryDelayMs: number;
};

const JARVIS_HA_AGENT_ID = 'conversation.openai_conversation';

function sleep(ms: number): Promise<void> {
  const safeMs = Math.max(0, Math.floor(ms));
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

function parseAssistantTextFromHaResponse(data: unknown): string {
  const normalizeHaSpeech = (text: string): string => {
    const clean = text.trim();
    if (/^error talking to openai$/i.test(clean)) {
      return 'Je ne peux pas joindre OpenAI pour le moment. Reessaie dans quelques secondes.';
    }
    if (/(insufficient\s+funds|insufficient\s+quota|quota|billing|credit)/i.test(clean)) {
      return 'OpenAI n\'a plus de crédit disponible pour le moment. Recharge le compte, puis réessaie.';
    }
    return clean;
  };

  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

  const root = asRecord(data);
  const response = asRecord(root?.response);
  const speech = asRecord(response?.speech);
  const plain = asRecord(speech?.plain);
  const fromPrimary = typeof plain?.speech === 'string' ? plain.speech : '';
  if (fromPrimary.trim()) return normalizeHaSpeech(fromPrimary);

  if (Array.isArray(data) && data.length > 0) {
    const first = asRecord(data[0]);
    const nestedResponse = asRecord(first?.response);
    const nestedSpeech = asRecord(nestedResponse?.speech);
    const nestedPlain = asRecord(nestedSpeech?.plain);
    const fromArray = typeof nestedPlain?.speech === 'string' ? nestedPlain.speech : '';
    if (fromArray.trim()) return normalizeHaSpeech(fromArray);
  }

  return 'Je ne peux pas répondre correctement pour le moment.';
}

export class ConversationService {
  private lastHaCallAtMs = 0;
  private haGate: Promise<void> = Promise.resolve();

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly messageRepository: MessageRepository,
    private readonly options: ConversationServiceOptions
  ) {}

  private async waitForHaSlot(): Promise<void> {
    const run = async () => {
      const now = Date.now();
      const elapsed = now - this.lastHaCallAtMs;
      const waitMs = this.options.minIntervalMs - elapsed;
      if (waitMs > 0) await sleep(waitMs);
      this.lastHaCallAtMs = Date.now();
    };

    const next = this.haGate.then(run, run);
    this.haGate = next.then(() => undefined, () => undefined);
    await next;
  }

  private shouldRetry(respStatus: number): boolean {
    return respStatus === 429 || respStatus === 500 || respStatus === 502 || respStatus === 503 || respStatus === 504;
  }

  async callHomeAssistantConversation(userText: string, threadId: string, externalSignal?: AbortSignal): Promise<string> {
    const textForAgent = toSingleParagraphPlainText(userText);
    const maxAttempts = Math.max(1, this.options.retryCount + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (externalSignal?.aborted) throw new Error('ha_conversation_aborted');

      await this.waitForHaSlot();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      const onExternalAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const resp = await fetch(`${this.options.haBaseUrl.replace(/\/$/, '')}/api/conversation/process`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.haToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            agent_id: JARVIS_HA_AGENT_ID,
            text: textForAgent,
            conversation_id: threadId,
          }),
          signal: controller.signal,
        });

        const bodyText = await resp.text();
        let data: unknown = bodyText;
        try {
          data = bodyText ? (JSON.parse(bodyText) as unknown) : {};
        } catch {
          data = bodyText;
        }

        if (resp.ok) {
          return toSingleParagraphPlainText(parseAssistantTextFromHaResponse(data));
        }

        if (attempt < maxAttempts && this.shouldRetry(resp.status)) {
          await sleep(this.options.retryDelayMs * attempt);
          continue;
        }

        throw new Error(`home_assistant_conversation_failed:${resp.status}`);
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        await sleep(this.options.retryDelayMs * attempt);
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', onExternalAbort);
      }
    }

    throw new Error('home_assistant_conversation_failed:exhausted_retries');
  }

  async persistMessages(threadId: string, userText: string, assistantText: string): Promise<void> {
    const now = Date.now();
    await this.threadRepository.getOrCreate(threadId);
    await this.messageRepository.appendMessage({
      threadId,
      role: 'user',
      content: toSingleParagraphPlainText(userText),
      createdAtMs: now,
    });
    await this.messageRepository.appendMessage({
      threadId,
      role: 'assistant',
      content: toSingleParagraphPlainText(assistantText),
      createdAtMs: now + 1,
    });
    await this.threadRepository.incrementInteractionCount(threadId);
  }
}
