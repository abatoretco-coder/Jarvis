import { describe, expect, it, jest } from '@jest/globals';

import { dispatchAcceptedSearchE2Route } from '../../src/routing/routeDispatcher';
import type { SemanticRouteDefinition } from '../../src/routing/semanticRouter.types';

function makeRoute(
  key: string,
  domain: 'search.news' | 'search.web',
  action: string,
): SemanticRouteDefinition {
  return {
    key,
    level: 'E2',
    targetAgentId: 'search',
    plannerRequired: false,
    directRequest: { domain, action },
    examples: ['example'],
  };
}

const baseSearchParams = {
  openAiApiKey: 'test-openai-key',
  openAiBaseUrl: 'https://api.openai.com/v1',
  timeoutMs: 1000,
};

describe('dispatchAcceptedSearchE2Route', () => {
  it('search.news.external_weather -> calls callSearchAgent(search.news)', async () => {
    const callSearchAgent = jest.fn(async (..._args: unknown[]) => 'Météo externe.');
    const result = await dispatchAcceptedSearchE2Route({
      route: makeRoute('search.news.external_weather', 'search.news', 'external_weather'),
      text: 'Météo à Paris demain',
      callSearchAgent,
      searchCallParams: baseSearchParams,
    });

    expect(result?.domain).toBe('search.news');
    expect(callSearchAgent).toHaveBeenCalledWith(
      'search.news',
      expect.objectContaining({ text: 'Météo à Paris demain' }),
    );
  });

  it('search.news.current_news -> calls callSearchAgent(search.news)', async () => {
    const callSearchAgent = jest.fn(async (..._args: unknown[]) => 'Actus du jour.');
    const result = await dispatchAcceptedSearchE2Route({
      route: makeRoute('search.news.current_news', 'search.news', 'current_news'),
      text: 'Quelles sont les actus ?',
      callSearchAgent,
      searchCallParams: baseSearchParams,
    });

    expect(result?.domain).toBe('search.news');
    expect(callSearchAgent).toHaveBeenCalledWith(
      'search.news',
      expect.objectContaining({ text: 'Quelles sont les actus ?' }),
    );
  });

  it('search.web.definition -> calls callSearchAgent(search.web)', async () => {
    const callSearchAgent = jest.fn(async (..._args: unknown[]) => 'Définition.');
    const result = await dispatchAcceptedSearchE2Route({
      route: makeRoute('search.web.definition', 'search.web', 'definition'),
      text: "C'est quoi une ZTL ?",
      callSearchAgent,
      searchCallParams: baseSearchParams,
    });

    expect(result?.domain).toBe('search.web');
    expect(callSearchAgent).toHaveBeenCalledWith(
      'search.web',
      expect.objectContaining({ text: "C'est quoi une ZTL ?" }),
    );
  });

  it('returns null when search agent throws', async () => {
    const callSearchAgent = jest.fn(async (..._args: unknown[]) => {
      throw new Error('search_unavailable');
    });
    const result = await dispatchAcceptedSearchE2Route({
      route: makeRoute('search.web.definition', 'search.web', 'definition'),
      text: "C'est quoi une ZTL ?",
      callSearchAgent,
      searchCallParams: baseSearchParams,
    });

    expect(result).toBeNull();
  });
});
