import type { SemanticRouteDefinition } from './semanticRouter.types';

export const LIVE_SEARCH_E2_ROUTE_KEYS = new Set([
  'search.news.external_weather',
  'search.news.live_sport',
  'search.news.current_news',
  'search.web.definition',
  'search.web.quick_lookup',
]);

export type SearchAgentCallParams = {
  text: string;
  openAiApiKey: string;
  openAiBaseUrl: string;
  perplexityApiKey?: string;
  perplexityBaseUrl?: string;
  timeoutMs: number;
  log?: { info: (obj: Record<string, unknown>, msg: string) => void };
};

export type SearchAgentResponse = string | {
  text: string;
  sources?: string[];
};

export type DispatchAcceptedSearchE2RouteInput = {
  route: SemanticRouteDefinition;
  text: string;
  callSearchAgent: (agentKey: string, params: SearchAgentCallParams) => Promise<SearchAgentResponse>;
  searchCallParams: Omit<SearchAgentCallParams, 'text'>;
  liveRouteKeys?: Set<string>;
};

export type DispatchAcceptedSearchE2RouteResult = {
  routeKey: string;
  domain: 'search.news' | 'search.web';
  responseText: string;
  sources?: string[];
};

export async function dispatchAcceptedSearchE2Route(
  input: DispatchAcceptedSearchE2RouteInput,
): Promise<DispatchAcceptedSearchE2RouteResult | null> {
  const routeKey = input.route.key;
  const liveRouteKeys = input.liveRouteKeys ?? LIVE_SEARCH_E2_ROUTE_KEYS;
  if (!liveRouteKeys.has(routeKey)) return null;
  if (input.route.level !== 'E2' || input.route.targetAgentId !== 'search') return null;

  const domain = input.route.directRequest?.domain;
  if (domain !== 'search.news' && domain !== 'search.web') return null;

  try {
    const response = await input.callSearchAgent(domain, {
      ...input.searchCallParams,
      text: input.text,
    });
    const responseText = typeof response === 'string' ? response : response.text;
    const sources = typeof response === 'string' ? [] : response.sources ?? [];
    if (!responseText.trim()) return null;
    return { routeKey, domain, responseText, ...(sources.length > 0 ? { sources } : {}) };
  } catch {
    return null;
  }
}
