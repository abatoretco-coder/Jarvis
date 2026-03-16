import { describe, expect, test } from '@jest/globals';

import { InMemoryMessageRepository, InMemoryThreadRepository } from '../src/conversation/repositories/InMemoryRepositories';
import { SummarizationService } from '../src/conversation/SummarizationService';

describe('conversation services', () => {
  test('commitCandidateIfReady performs atomic candidate swap', async () => {
    const threadRepository = new InMemoryThreadRepository();

    await threadRepository.getOrCreate('t-2');
    await threadRepository.markSummaryCandidateReady('t-2', 'summary candidate', 42);

    const committed = await threadRepository.commitCandidateIfReady('t-2');
    const after = await threadRepository.getOrCreate('t-2');

    expect(committed.committed).toBe(true);
    expect(after.summary).toBe('summary candidate');
    expect(after.summaryUptoSeq).toBe(42);
    expect(after.summaryCandidate).toBeNull();
    expect(after.summaryCandidateUptoSeq).toBeNull();
    expect(after.summaryStatus).toBe('idle');
  });

  test('shouldPresummarize triggers on M delta and every 10 interactions', async () => {
    const threadRepository = new InMemoryThreadRepository();
    const messageRepository = new InMemoryMessageRepository();
    const service = new SummarizationService(threadRepository, messageRepository, {
      hotWindowK: 10,
      minDeltaM: 20,
      triggerEveryInteractions: 10,
      openAiApiKey: undefined,
      openAiModelSummary: 'gpt-4',
      openAiTimeoutMs: 3000,
    });

    await threadRepository.getOrCreate('t-3');

    for (let i = 0; i < 40; i += 1) {
      await messageRepository.appendMessage({
        threadId: 't-3',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m-${i}`,
      });
    }

    expect(await service.shouldPresummarize('t-3')).toBe(true);

    await threadRepository.markSummaryCandidateReady('t-3', 'ready', 30);
    expect(await service.shouldPresummarize('t-3')).toBe(false);

    await threadRepository.commitCandidateIfReady('t-3');

    for (let i = 0; i < 10; i += 1) {
      await threadRepository.incrementInteractionCount('t-3');
    }
    for (let i = 0; i < 6; i += 1) {
      await messageRepository.appendMessage({
        threadId: 't-3',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `n-${i}`,
      });
    }

    expect(await service.shouldPresummarize('t-3')).toBe(true);
  });
});
