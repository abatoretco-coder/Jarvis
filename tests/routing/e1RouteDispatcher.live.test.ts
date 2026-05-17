import { describe, expect, it, jest } from '@jest/globals';

import { dispatchAcceptedE1Route } from '../../src/routing/e1RouteDispatcher';
import { findRouteByKey } from '../../src/routing/semanticRouteCatalog';

describe('dispatchAcceptedE1Route (live-safe subset)', () => {
  it('search.deep.analysis dispatches to search.deep and returns search_text', async () => {
    const route = findRouteByKey('search.deep.analysis');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'Analyse approfondie.'),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Analyse ce sujet en profondeur',
      deps,
    });

    expect(result).toEqual({
      kind: 'search_text',
      routeKey: 'search.deep.analysis',
      data: 'Analyse approfondie.',
    });
    expect(deps.callSearchAgent).toHaveBeenCalledWith('search.deep', { text: 'Analyse ce sujet en profondeur' });
    expect(deps.planSpotifyAction).not.toHaveBeenCalled();
  });

  it('search.deep.comparison propagates search failure (handled by caller fallback)', async () => {
    const route = findRouteByKey('search.deep.comparison');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => {
        throw new Error('search_deep_unavailable');
      }),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    await expect(dispatchAcceptedE1Route({
      route: route!,
      text: 'Compare F-22 et F-35',
      deps,
    })).rejects.toThrow('search_deep_unavailable');
  });

  it('spotify.search_and_play dispatches to planner and returns spotify_plan', async () => {
    const route = findRouteByKey('spotify.search_and_play');
    expect(route).toBeDefined();

    const plan = {
      route: 'spotify' as const,
      reason: 'planner_ok',
      request: {
        domain: 'spotify' as const,
        action: 'search_and_play' as const,
        slots: { query: 'jazz', device: 'salon' },
      },
    };

    const deps = {
      planSpotifyAction: jest.fn(async () => plan),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Mets du jazz au salon',
      deps,
    });

    expect(result).toEqual({ kind: 'spotify_plan', routeKey: 'spotify.search_and_play', data: plan });
    expect(deps.planSpotifyAction).toHaveBeenCalledWith('Mets du jazz au salon');
    expect(deps.callSearchAgent).not.toHaveBeenCalled();
  });

  it('returns null for non-E1 route', async () => {
    const route = findRouteByKey('search.web.definition');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: "C'est quoi une ZTL ?",
      deps,
    });

    expect(result).toBeNull();
  });
});
