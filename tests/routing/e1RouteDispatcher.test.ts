import { describe, expect, it, jest } from '@jest/globals';

import { dispatchAcceptedE1Route } from '../../src/routing/e1RouteDispatcher';
import { findRouteByKey } from '../../src/routing/semanticRouteCatalog';

describe('dispatchAcceptedE1Route', () => {
  it('spotify.search_and_play uses Spotify planner', async () => {
    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'spotify', reason: 'ok' })),
      callSearchAgent: jest.fn(async () => 'search'),
      callTodoAgent: jest.fn(async () => 'todo'),
      callMailAgent: jest.fn(async () => 'mail'),
    };
    const route = findRouteByKey('spotify.search_and_play');
    expect(route).toBeDefined();

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Mets du jazz au salon',
      deps,
    });

    expect(result?.kind).toBe('spotify_plan');
    expect(deps.planSpotifyAction).toHaveBeenCalledTimes(1);
    expect(deps.callSearchAgent).not.toHaveBeenCalled();
  });

  it('search.deep.analysis uses search.deep agent', async () => {
    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'spotify', reason: 'ok' })),
      callSearchAgent: jest.fn(async () => 'analyse'),
      callTodoAgent: jest.fn(async () => 'todo'),
      callMailAgent: jest.fn(async () => 'mail'),
    };
    const route = findRouteByKey('search.deep.analysis');
    expect(route).toBeDefined();

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Compare F-22 et F-35',
      deps,
    });

    expect(result?.kind).toBe('search_text');
    expect(deps.callSearchAgent).toHaveBeenCalledWith('search.deep', { text: 'Compare F-22 et F-35' });
  });

  it('todo.add_task uses Todo agent', async () => {
    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'spotify', reason: 'ok' })),
      callSearchAgent: jest.fn(async () => 'analyse'),
      callTodoAgent: jest.fn(async () => 'todo_ok'),
      callMailAgent: jest.fn(async () => 'mail'),
    };
    const route = findRouteByKey('todo.add_task');
    expect(route).toBeDefined();

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Ajoute acheter du pain demain',
      deps,
    });

    expect(result?.kind).toBe('todo_text');
    expect(deps.callTodoAgent).toHaveBeenCalledTimes(1);
  });

  it('mail.search_emails uses Mail agent', async () => {
    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'spotify', reason: 'ok' })),
      callSearchAgent: jest.fn(async () => 'analyse'),
      callTodoAgent: jest.fn(async () => 'todo_ok'),
      callMailAgent: jest.fn(async () => 'mail_ok'),
    };
    const route = findRouteByKey('mail.search_emails');
    expect(route).toBeDefined();

    const result = await dispatchAcceptedE1Route({
      route: route!,
      text: 'Cherche mes mails de Thomas sur le devis',
      deps,
    });

    expect(result?.kind).toBe('mail_text');
    expect(deps.callMailAgent).toHaveBeenCalledTimes(1);
  });

  it('calendar.create_event uses Calendar agent', async () => {
    const deps = {
      planSpotifyAction: jest.fn(async () => ({ route: 'spotify', reason: 'ok' })),
      callSearchAgent: jest.fn(async () => 'analyse'),
      callTodoAgent: jest.fn(async () => 'todo_ok'),
      callMailAgent: jest.fn(async () => 'mail_ok'),
      callCalendarAgent: jest.fn(async () => 'calendar_ok'),
    };
    const route = findRouteByKey('calendar.create_event');
    expect(route).toBeDefined();

    const text = 'Jarvis, cree un evenement pour mardi toute la journee appele Bar Match Equipe de France';
    const result = await dispatchAcceptedE1Route({
      route: route!,
      text,
      deps,
    });

    expect(result).toEqual({ kind: 'calendar_text', routeKey: 'calendar.create_event', data: 'calendar_ok' });
    expect(deps.callCalendarAgent).toHaveBeenCalledWith(text);
    expect(deps.callMailAgent).not.toHaveBeenCalled();
  });
});
