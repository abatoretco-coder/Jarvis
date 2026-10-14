import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  compactTodoListForFallback,
  executeTodoAgentAction,
  formatDueDateForUser,
  formatTodoActionPreview,
  getMicrosoftTodoAccessToken,
  stopTodoTokenKeepalives,
} from '../src/todo/todoAgent';

const originalFetch = global.fetch;

describe('todoAgent formatting', () => {
  afterEach(async () => {
    await stopTodoTokenKeepalives();
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('cancels Microsoft token keepalive work at shutdown', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      access_token: 'access-for-shutdown',
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    await getMicrosoftTodoAccessToken({
      MICROSOFT_CLIENT_ID: 'shutdown-test',
      MICROSOFT_CLIENT_SECRET: 'secret',
      MICROSOFT_REFRESH_TOKEN: 'refresh',
    });
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await stopTodoTokenKeepalives();

    expect(jest.getTimerCount()).toBe(0);
  });

  it("follows Microsoft Graph pagination and returns every task due today", async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith('/me/todo/lists')) {
        return new Response(JSON.stringify({ value: [{ id: 'tasks', displayName: 'Tâches', wellknownListName: 'defaultList' }] }), { status: 200 });
      }
      if (url.includes('page=2')) {
        return new Response(JSON.stringify({ value: [
          { id: '3', title: 'Trois', status: 'notStarted', dueDateTime: { dateTime: '2026-10-13T00:00:00', timeZone: 'UTC' } },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        value: [
          { id: '1', title: 'Une', status: 'notStarted', dueDateTime: { dateTime: '2026-10-13T00:00:00', timeZone: 'UTC' } },
          { id: '2', title: 'Deux', status: 'notStarted', dueDateTime: { dateTime: '2026-10-13T00:00:00', timeZone: 'UTC' } },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/tasks/tasks?page=2',
      }), { status: 200 });
    }) as typeof fetch;

    const response = await executeTodoAgentAction(
      { action: 'list_tasks', period: 'today' },
      {
        MICROSOFT_CLIENT_ID: 'pagination-test',
        MICROSOFT_CLIENT_SECRET: 'secret',
        MICROSOFT_REFRESH_TOKEN: 'refresh',
        OPENAI_API_KEY: 'openai',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_TIMEOUT_MS: 1_000,
      },
    );
    expect(response).toContain('Une');
    expect(response).toContain('Deux');
    expect(response).toContain('Trois');
  });

  it('never forwards the Microsoft access token to an untrusted next-page URL', async () => {
    const requestedUrls: string[] = [];
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'sensitive-access', expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith('/me/todo/lists')) {
        return new Response(JSON.stringify({ value: [{ id: 'tasks', displayName: 'Tâches', wellknownListName: 'defaultList' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        value: [],
        '@odata.nextLink': 'https://attacker.example/steal',
      }), { status: 200 });
    }) as typeof fetch;

    await executeTodoAgentAction(
      { action: 'list_tasks', period: 'today' },
      {
        MICROSOFT_CLIENT_ID: 'untrusted-next-link-test',
        MICROSOFT_CLIENT_SECRET: 'secret',
        MICROSOFT_REFRESH_TOKEN: 'refresh',
        OPENAI_API_KEY: 'openai',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_TIMEOUT_MS: 1_000,
      },
    );
    expect(requestedUrls.some((url) => url.includes('attacker.example'))).toBe(false);
  });

  it('coalesces concurrent Microsoft refreshes and persists one rotated token', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onRefreshToken = jest.fn(async (_token: string) => undefined);
    global.fetch = jest.fn(async () => {
      await gate;
      return new Response(JSON.stringify({
        access_token: 'access-shared',
        expires_in: 3600,
        refresh_token: 'refresh-rotated',
      }), { status: 200 });
    }) as typeof fetch;
    const env = {
      MICROSOFT_CLIENT_ID: 'single-flight-test',
      MICROSOFT_CLIENT_SECRET: 'secret',
      MICROSOFT_REFRESH_TOKEN: 'refresh-original',
      onRefreshToken,
    };

    const first = getMicrosoftTodoAccessToken(env);
    const second = getMicrosoftTodoAccessToken(env);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(['access-shared', 'access-shared']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(onRefreshToken).toHaveBeenCalledTimes(1);
    expect(onRefreshToken).toHaveBeenCalledWith('refresh-rotated');
  });

  it('surfaces a revoked Microsoft refresh token as a reconnect-required error', async () => {
    const onConnectionError = jest.fn(async (_code: string, _terminal: boolean) => undefined);
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'sensitive provider detail',
    }), { status: 400 })) as typeof fetch;

    await expect(getMicrosoftTodoAccessToken({
      MICROSOFT_CLIENT_ID: 'revoked-token-test',
      MICROSOFT_CLIENT_SECRET: 'secret',
      MICROSOFT_REFRESH_TOKEN: 'refresh-secret',
      onConnectionError,
    })).rejects.toThrow('todo_ms_token_refresh_failed:400:invalid_grant');
    expect(onConnectionError).toHaveBeenCalledWith('microsoft_invalid_grant', true);
  });

  it("keeps every task in today's written list", () => {
    const text = "Tu as 6 tâches aujourd'hui : Une ; Deux ; Trois ; Quatre ; Cinq ; Six.";
    expect(compactTodoListForFallback(text)).toBe(text);
  });

  it('uses relative wording for today and tomorrow', () => {
    expect(formatDueDateForUser('2026-07-05', '2026-07-05')).toBe("aujourd'hui");
    expect(formatDueDateForUser('2026-07-06', '2026-07-05')).toBe('demain');
  });

  it('does not expose raw ISO dates in add-task confirmation previews', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-05T10:00:00.000Z'));
    const preview = formatTodoActionPreview({
      action: 'add_task',
      title: 'Faire du sport',
      due_date: '2026-08-24',
    });

    expect(preview).toBe("J'ajoute la tache Faire du sport pour le 24 août.");
    expect(preview).not.toContain('2026-08-24');
    expect(preview).not.toContain('prochaine echeance');
  });
});
