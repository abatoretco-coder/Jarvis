import { toSingleParagraphPlainText } from './plainText';
import { completeOllamaChat, isOllamaBaseUrl } from '../ollamaChat';
import {
  OLLAMA_SYSTEM_PROMPT_SUMMARIZER,
  OLLAMA_TITLE_SYSTEM_PROMPT,
  OLLAMA_USER_TEMPLATE_SUMMARIZER,
} from './prompts/ollamaConversationPrompts';
import type { MessageRepository } from './repositories/MessageRepository';
import type { ThreadRepository } from './repositories/ThreadRepository';

export type SummarizationServiceOptions = {
  hotWindowK: number;
  minDeltaM: number;
  triggerEveryInteractions: number;
  llmApiKey?: string;
  llmBaseUrl: string;
  llmModel: string;
  llmTimeoutMs: number;
};

function sanitizeSummaryOutput(input: string): string {
  let out = toSingleParagraphPlainText(input);
  if (!out) return out;

  out = out.replace(/^\s*(résumé\s*:|summary\s*:|output\s*:|assistant\s*:)/i, '').trim();

  const stripPair = (value: string, left: string, right: string): string => {
    if (value.startsWith(left) && value.endsWith(right) && value.length > left.length + right.length) {
      return value.slice(left.length, value.length - right.length).trim();
    }
    return value;
  };

  out = stripPair(out, '"', '"');
  out = stripPair(out, "'", "'");
  out = stripPair(out, '«', '»');
  out = stripPair(out, '`', '`');

  return toSingleParagraphPlainText(out);
}

export class SummarizationService {
  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly messageRepository: MessageRepository,
    private readonly options: SummarizationServiceOptions
  ) {}

  async shouldPresummarize(threadId: string): Promise<boolean> {
    const thread = await this.threadRepository.getOrCreate(threadId);
    if (thread.summaryStatus === 'running' || thread.summaryStatus === 'ready') {
      return false;
    }

    const maxSeq = await this.messageRepository.getMaxSeq(threadId);
    const targetUpto = Math.max(0, maxSeq - Math.max(1, this.options.hotWindowK));
    if (targetUpto <= thread.summaryUptoSeq) {
      return false;
    }

    const unsummarizedCount = targetUpto - thread.summaryUptoSeq;
    if (unsummarizedCount >= Math.max(1, this.options.minDeltaM)) {
      return true;
    }

    const cadence = Math.max(1, this.options.triggerEveryInteractions);
    return thread.interactionCount > 0 && thread.interactionCount % cadence === 0;
  }

  startPresummarize(threadId: string): void {
    void this.runPresummarize(threadId);
  }

  startTitleGeneration(threadId: string, userText: string, assistantText: string): void {
    if (!this.options.llmApiKey) return;
    void this.runTitleGeneration(threadId, userText, assistantText);
  }

  async commitCandidateIfReady(threadId: string): Promise<{ committed: boolean; usedSummaryVersion?: string }> {
    return this.threadRepository.commitCandidateIfReady(threadId);
  }

  async createIncrementalSummary(oldSummary: string, messagesDelta: string): Promise<string> {
    const normalizedOld = toSingleParagraphPlainText(oldSummary);
    const normalizedDelta = toSingleParagraphPlainText(messagesDelta);

    if (!normalizedDelta) {
      return normalizedOld;
    }

    if (!this.options.llmApiKey) {
      const merged = `${normalizedOld} ${normalizedDelta}`.trim();
      return merged.length <= 2200 ? merged : `${merged.slice(0, 2199)}…`;
    }

    const prompt = OLLAMA_USER_TEMPLATE_SUMMARIZER.replace('{{old_summary}}', normalizedOld || 'Aucune.').replace(
      '{{messages_delta}}',
      normalizedDelta
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.llmTimeoutMs);

    try {
      if (isOllamaBaseUrl(this.options.llmBaseUrl)) {
        const content = await completeOllamaChat({
          baseUrl: this.options.llmBaseUrl,
          model: this.options.llmModel,
          temperature: 0.2,
          numPredict: 220,
          messages: [{ role: 'system', content: OLLAMA_SYSTEM_PROMPT_SUMMARIZER }, { role: 'user', content: prompt }],
          signal: controller.signal,
        });
        return sanitizeSummaryOutput(content || normalizedOld) || normalizedOld;
      }
      const resp = await fetch(`${this.options.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.llmApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.llmModel,
          temperature: 0.2,
          messages: [
            { role: 'system', content: OLLAMA_SYSTEM_PROMPT_SUMMARIZER },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });

      const raw = await resp.text();
      let data: unknown = raw;
      try {
        data = raw ? (JSON.parse(raw) as unknown) : {};
      } catch {
        data = raw;
      }

      if (!resp.ok) {
        throw new Error(`summary_provider_error:${resp.status}`);
      }

      const choices =
        data && typeof data === 'object' && Array.isArray((data as { choices?: unknown[] }).choices)
          ? ((data as { choices: Array<{ message?: { content?: string } }> }).choices ?? [])
          : [];
      const content = choices[0]?.message?.content ?? '';
      const cleaned = sanitizeSummaryOutput(content || normalizedOld);
      return cleaned || normalizedOld;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runPresummarize(threadId: string): Promise<void> {
    const locked = await this.threadRepository.tryStartSummary(threadId);
    if (!locked) return;

    try {
      const thread = await this.threadRepository.getOrCreate(threadId);
      const maxSeq = await this.messageRepository.getMaxSeq(threadId);
      const targetUpto = Math.max(0, maxSeq - Math.max(1, this.options.hotWindowK));

      if (targetUpto <= thread.summaryUptoSeq) {
        await this.threadRepository.resetSummaryStatus(threadId);
        return;
      }

      const deltaRows = await this.messageRepository.getMessagesRange(threadId, thread.summaryUptoSeq, targetUpto);
      if (deltaRows.length === 0) {
        await this.threadRepository.resetSummaryStatus(threadId);
        return;
      }

      const deltaText = deltaRows
        .map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Jarvis'}: ${toSingleParagraphPlainText(m.content)}`)
        .join(' ');

      const nextSummary = await this.createIncrementalSummary(thread.summary, deltaText);
      await this.threadRepository.markSummaryCandidateReady(threadId, nextSummary, targetUpto);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'summary_job_failed';
      await this.threadRepository.markSummaryFailed(threadId, reason);
    }
  }

  private async runTitleGeneration(threadId: string, userText: string, assistantText: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.llmTimeoutMs);
    try {
      if (isOllamaBaseUrl(this.options.llmBaseUrl)) {
        const raw = await completeOllamaChat({
          baseUrl: this.options.llmBaseUrl,
          model: this.options.llmModel,
          temperature: 0.15,
          numPredict: 30,
          messages: [
            { role: 'system', content: OLLAMA_TITLE_SYSTEM_PROMPT },
            { role: 'user', content: `Utilisateur: ${toSingleParagraphPlainText(userText)}\nJarvis: ${toSingleParagraphPlainText(assistantText)}` },
          ],
          signal: controller.signal,
        });
        const title = toSingleParagraphPlainText(raw)
          .replace(/^\s*(titre\s*:|title\s*:)/i, '').replace(/^["'«`]+|["'»`]+$/g, '').replace(/[.!?;:]+$/g, '').trim().split(/\s+/).slice(0, 7).join(' ');
        if (title) await this.threadRepository.updateTitle(threadId, title);
        return;
      }
      const response = await fetch(`${this.options.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.llmApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.llmModel,
          temperature: 0.15,
          max_tokens: 30,
          messages: [
            {
              role: 'system',
              content: OLLAMA_TITLE_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: `Utilisateur: ${toSingleParagraphPlainText(userText)}\nJarvis: ${toSingleParagraphPlainText(assistantText)}`,
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return;
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const title = toSingleParagraphPlainText(raw)
        .replace(/^\s*(titre\s*:|title\s*:)/i, '')
        .replace(/^["'«`]+|["'»`]+$/g, '')
        .replace(/[.!?;:]+$/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 7)
        .join(' ');
      if (title) await this.threadRepository.updateTitle(threadId, title);
    } catch {
      // The immediate deterministic title remains available on provider failure.
    } finally {
      clearTimeout(timeout);
    }
  }
}
