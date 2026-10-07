import { completeOpenAiResponse } from '../openai/responsesClient';
import { toSingleParagraphPlainText } from './plainText';
import {
  CONVERSATION_SUMMARY_SYSTEM_PROMPT,
  CONVERSATION_SUMMARY_USER_TEMPLATE,
  CONVERSATION_TITLE_SYSTEM_PROMPT,
} from './prompts/conversationSummaryPrompts';
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
  llmMaxOutputTokens?: number;
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

    const prompt = CONVERSATION_SUMMARY_USER_TEMPLATE.replace('{{old_summary}}', normalizedOld || 'Aucune.').replace(
      '{{messages_delta}}',
      normalizedDelta
    );

    const content = await completeOpenAiResponse({
      apiKey: this.options.llmApiKey,
      baseUrl: this.options.llmBaseUrl,
      model: this.options.llmModel,
      capability: 'summary',
      messages: [
        { role: 'system', content: CONVERSATION_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      maxOutputTokens: Math.min(320, this.options.llmMaxOutputTokens ?? 512),
      timeoutMs: this.options.llmTimeoutMs,
      reasoningEffort: 'none',
    });
    const cleaned = sanitizeSummaryOutput(content || normalizedOld);
    return cleaned || normalizedOld;
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
    try {
      if (!this.options.llmApiKey) return;
      const raw = await completeOpenAiResponse({
        apiKey: this.options.llmApiKey,
        baseUrl: this.options.llmBaseUrl,
        model: this.options.llmModel,
        capability: 'summary',
        messages: [
          { role: 'system', content: CONVERSATION_TITLE_SYSTEM_PROMPT },
          { role: 'user', content: `Utilisateur: ${toSingleParagraphPlainText(userText)}\nJarvis: ${toSingleParagraphPlainText(assistantText)}` },
        ],
        maxOutputTokens: Math.min(64, this.options.llmMaxOutputTokens ?? 512),
        timeoutMs: this.options.llmTimeoutMs,
        reasoningEffort: 'none',
      });
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
    }
  }
}
