import { describe, expect, it, jest } from '@jest/globals';

import { dispatchAcceptedE1Route } from '../../src/routing/e1RouteDispatcher';
import { findRouteByKey } from '../../src/routing/semanticRouteCatalog';
import type { SemanticRouteDefinition } from '../../src/routing/semanticRouter.types';

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

  it('todo.list_tasks.today dispatches to todo agent and returns todo_text', async () => {
    const route = findRouteByKey('todo.list_tasks.today');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'Tu as 3 taches aujourd hui.'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: "Quelles sont mes taches d'aujourd'hui ?",
      deps,
    });

    expect(result).toEqual({
      kind: 'todo_text',
      routeKey: 'todo.list_tasks.today',
      data: 'Tu as 3 taches aujourd hui.',
    });
    expect(deps.callTodoAgent).toHaveBeenCalledTimes(1);
  });

  it('todo.list_lists dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.list_lists');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'Listes: Perso, Travail.'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Quelles sont mes listes ?',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Quelles sont mes listes ?');
  });

  it('mail.list_inbox.unread dispatches to mail agent and returns mail_text', async () => {
    const route = findRouteByKey('mail.list_inbox.unread');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => 'Tu as 2 mails non lus.'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'J ai des mails non lus ?',
      deps,
    });

    expect(result).toEqual({
      kind: 'mail_text',
      routeKey: 'mail.list_inbox.unread',
      data: 'Tu as 2 mails non lus.',
    });
    expect(deps.callMailAgent).toHaveBeenCalledTimes(1);
  });

  it('mail.search_emails dispatches to mail agent', async () => {
    const route = findRouteByKey('mail.search_emails');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => '3 emails trouves.'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Retrouve mes mails de Thomas sur le devis',
      deps,
    });

    expect(result?.kind).toBe('mail_text');
    expect(deps.callMailAgent).toHaveBeenCalledWith('Retrouve mes mails de Thomas sur le devis');
  });

  it('returns null for todo route when level is not E1', async () => {
    const todoRoute: SemanticRouteDefinition = {
      key: 'todo.list_tasks.today',
      level: 'E2',
      targetAgentId: 'todo',
      plannerRequired: true,
      directRequest: { domain: 'todo', action: 'list_tasks.today' },
      examples: ['mes taches aujourd hui'],
    };

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    const todoResult = await dispatchAcceptedE1Route({
      route: todoRoute,
      text: 'test',
      deps,
    });

    expect(todoResult).toBeNull();
  });

  it('returns null for mail route when level is not E1', async () => {
    const mailRoute: SemanticRouteDefinition = {
      key: 'mail.search_emails',
      level: 'E2',
      targetAgentId: 'mail',
      plannerRequired: true,
      directRequest: { domain: 'mail', action: 'search_emails' },
      examples: ['cherche mes mails'],
    };

    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async () => 'unused'),
      callTodoAgent: jest.fn(async () => 'unused'),
      callMailAgent: jest.fn(async () => 'unused'),
    };

    const mailResult = await dispatchAcceptedE1Route({
      route: mailRoute,
      text: 'test',
      deps,
    });

    expect(mailResult).toBeNull();
  });
});
