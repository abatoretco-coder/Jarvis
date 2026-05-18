import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SemanticRouteDefinition } from '../../src/routing/semanticRouter.types';
import { clearRouteEmbeddingCache, warmupRouteEmbeddings } from '../../src/routing/routeScoring';
import { getEmbeddings } from '../../src/routing/embeddingClient';

jest.mock('../../src/routing/embeddingClient', () => ({
  getEmbeddings: jest.fn(),
}));

const mockedGetEmbeddings = getEmbeddings as jest.MockedFunction<typeof getEmbeddings>;

const config = {
  provider: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small',
  timeoutMs: 1000,
  apiKey: 'test-key',
};

const routes: SemanticRouteDefinition[] = [
  {
    key: 'search.web.definition',
    level: 'E2',
    targetAgentId: 'search',
    directRequest: { domain: 'search.web', action: 'definition' },
    plannerRequired: false,
    examples: ['c est quoi', 'definition rapide'],
  },
  {
    key: 'todo.list_tasks.today',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'list_tasks', slots: { period: 'today' } },
    plannerRequired: true,
    examples: ['taches du jour', 'que dois je faire aujourd hui'],
  },
  {
    key: 'mail.list_inbox.unread',
    level: 'E1',
    targetAgentId: 'mail',
    directRequest: { domain: 'mail', action: 'list_inbox', slots: { unread_only: true } },
    plannerRequired: true,
    examples: ['mails non lus', 'nouveaux mails'],
  },
];

describe('warmupRouteEmbeddings', () => {
  beforeEach(() => {
    clearRouteEmbeddingCache();
    mockedGetEmbeddings.mockReset();
    mockedGetEmbeddings.mockImplementation(async (texts: string[]) => {
      const vectors = texts.map((text) => {
        const n = (text.length % 7) + 1;
        return [n, n + 1, n + 2];
      });
      return {
        vectors,
        model: config.model,
        elapsedMs: 1,
        cachedCount: 0,
        fetchedCount: texts.length,
      };
    });
  });

  it('warms route embeddings in batches and reuses cache on second run', async () => {
    const first = await warmupRouteEmbeddings({ routes, config, batchSize: 2 });
    expect(first.warmed).toBe(3);
    expect(first.skipped).toBe(0);
    expect(first.failed).toBe(0);
    expect(mockedGetEmbeddings).toHaveBeenCalledTimes(3);

    const second = await warmupRouteEmbeddings({ routes, config, batchSize: 2 });
    expect(second.warmed).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.failed).toBe(0);
    expect(mockedGetEmbeddings).toHaveBeenCalledTimes(3);
  });
});
