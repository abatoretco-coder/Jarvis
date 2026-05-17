import type { SemanticRouteDefinition } from './semanticRouter.types';

export type E1DispatchResult =
  | { kind: 'spotify_plan'; routeKey: string; data: unknown }
  | { kind: 'search_text'; routeKey: string; data: string }
  | { kind: 'todo_text'; routeKey: string; data: string }
  | { kind: 'mail_text'; routeKey: string; data: string };

export type E1DispatcherDeps = {
  planSpotifyAction: (text: string) => Promise<unknown>;
  callSearchAgent: (agentKey: 'search.deep', params: { text: string }) => Promise<string>;
  callTodoAgent: (text: string) => Promise<string>;
  callMailAgent: (text: string) => Promise<string>;
};

export async function dispatchAcceptedE1Route(input: {
  route: SemanticRouteDefinition;
  text: string;
  deps: E1DispatcherDeps;
}): Promise<E1DispatchResult | null> {
  const { route, text, deps } = input;
  if (route.level !== 'E1') return null;

  if (route.key.startsWith('spotify.')) {
    const data = await deps.planSpotifyAction(text);
    return { kind: 'spotify_plan', routeKey: route.key, data };
  }

  if (route.key.startsWith('search.deep.')) {
    const data = await deps.callSearchAgent('search.deep', { text });
    return { kind: 'search_text', routeKey: route.key, data };
  }

  if (route.key.startsWith('todo.')) {
    const data = await deps.callTodoAgent(text);
    return { kind: 'todo_text', routeKey: route.key, data };
  }

  if (route.key.startsWith('mail.')) {
    const data = await deps.callMailAgent(text);
    return { kind: 'mail_text', routeKey: route.key, data };
  }

  return null;
}
