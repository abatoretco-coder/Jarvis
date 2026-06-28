import { describe, expect, it, jest } from '@jest/globals';

import { dispatchAcceptedE1Route } from '../../src/routing/e1RouteDispatcher';
import { findRouteByKey } from '../../src/routing/semanticRouteCatalog';
import type { SemanticRouteDefinition } from '../../src/routing/semanticRouter.types';

describe('dispatchAcceptedE1Route (live-safe subset)', () => {
  it('search.deep.analysis dispatches to search.deep and returns search_text', async () => {
    const route = findRouteByKey('search.deep.analysis');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'Analyse approfondie.'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => {
        throw new Error('search_deep_unavailable');
      }),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => plan),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Tu as 3 taches aujourd hui.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Listes: Perso, Travail.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'Tu as 2 mails non lus.'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => '3 emails trouves.'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Retrouve mes mails de Thomas sur le devis',
      deps,
    });

    expect(result?.kind).toBe('mail_text');
    expect(deps.callMailAgent).toHaveBeenCalledWith('Retrouve mes mails de Thomas sur le devis');
  });

  it('todo.add_task dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.add_task');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Tache ajoutee.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Ajoute appeler Arthur demain dans mes taches.',
      deps,
    });

    expect(result).toEqual({
      kind: 'todo_text',
      routeKey: 'todo.add_task',
      data: 'Tache ajoutee.',
    });
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Ajoute appeler Arthur demain dans mes taches.');
  });

  it('todo.complete_task dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.complete_task');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Tache marquee comme faite.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Marque envoyer le devis comme fait.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Marque envoyer le devis comme fait.');
  });

  it('mail.mark_read dispatches to mail agent', async () => {
    const route = findRouteByKey('mail.mark_read');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'Mail marque comme lu.'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Marque le dernier mail de Thomas comme lu.',
      deps,
    });

    expect(result).toEqual({
      kind: 'mail_text',
      routeKey: 'mail.mark_read',
      data: 'Mail marque comme lu.',
    });
    expect(deps.callMailAgent).toHaveBeenCalledWith('Marque le dernier mail de Thomas comme lu.');
  });

  it('mail.mark_unread dispatches to mail agent', async () => {
    const route = findRouteByKey('mail.mark_unread');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'Mail remis en non lu.'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Remets le mail de Marie en non lu.',
      deps,
    });

    expect(result?.kind).toBe('mail_text');
    expect(deps.callMailAgent).toHaveBeenCalledWith('Remets le mail de Marie en non lu.');
  });

  it('todo.update_task dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.update_task');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Tache mise a jour.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Decale la tache envoyer le devis a vendredi.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Decale la tache envoyer le devis a vendredi.');
  });

  it('todo.delete_task dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.delete_task');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Tache supprimee.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Supprime la tache acheter du lait.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Supprime la tache acheter du lait.');
  });

  it('todo.create_list dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.create_list');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Liste creee.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Cree une liste vacances.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Cree une liste vacances.');
  });

  it('todo.delete_list dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.delete_list');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Liste supprimee.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Supprime la liste courses.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Supprime la liste courses.');
  });

  it('todo.add_checklist_item dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.add_checklist_item');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Element ajoute.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Ajoute preparer les documents a la checklist.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Ajoute preparer les documents a la checklist.');
  });

  it('todo.complete_checklist_item dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.complete_checklist_item');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Element coche.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Coche le point appeler le client.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Coche le point appeler le client.');
  });

  it('todo.delete_checklist_item dispatches to todo agent', async () => {
    const route = findRouteByKey('todo.delete_checklist_item');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'Element supprime.'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Supprime cet item de checklist.',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledWith('Supprime cet item de checklist.');
  });

  it('mail.flag_email dispatches to mail agent', async () => {
    const route = findRouteByKey('mail.flag_email');
    expect(route).toBeDefined();

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'Mail marque important.'),
    };

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Marque le dernier mail de Thomas comme important.',
      deps,
    });

    expect(result?.kind).toBe('mail_text');
    expect(deps.callMailAgent).toHaveBeenCalledWith('Marque le dernier mail de Thomas comme important.');
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
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
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const mailResult = await dispatchAcceptedE1Route({
      route: mailRoute,
      text: 'test',
      deps,
    });

    expect(mailResult).toBeNull();
  });

  it('returns null for unsupported E1 route', async () => {
    const route = {
      key: 'executor.timer',
      level: 'E1',
      targetAgentId: 'executors',
      plannerRequired: true,
      directRequest: { domain: 'executors', action: 'timer' },
      examples: ['lance un minuteur'],
    } as unknown as SemanticRouteDefinition;

    const deps = {
      planSpotifyAction: jest.fn(async (..._args: unknown[]) => ({ route: 'none', reason: 'unused' })),
      callSearchAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callTodoAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
      callMailAgent: jest.fn(async (..._args: unknown[]) => 'unused'),
    };

    const result = await dispatchAcceptedE1Route({
      route,
      text: 'Lance un minuteur de 10 minutes',
      deps,
    });

    expect(result).toBeNull();
    expect(deps.planSpotifyAction).not.toHaveBeenCalled();
    expect(deps.callSearchAgent).not.toHaveBeenCalled();
    expect(deps.callTodoAgent).not.toHaveBeenCalled();
    expect(deps.callMailAgent).not.toHaveBeenCalled();
  });
});
