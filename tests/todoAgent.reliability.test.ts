import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  executeTodoAgentAction,
  stopTodoTokenKeepalives,
  type TodoAction,
  type TodoEnv,
} from '../src/todo/todoAgent';

const originalFetch = global.fetch;

function env(name: string): TodoEnv {
  return {
    MICROSOFT_CLIENT_ID: `client-${name}`,
    MICROSOFT_CLIENT_SECRET: 'secret',
    MICROSOFT_REFRESH_TOKEN: 'refresh',
    OPENAI_API_KEY: 'openai',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_TIMEOUT_MS: 1_000,
  };
}

function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function token(accessToken = 'access'): Response {
  return json({ access_token: accessToken, expires_in: 3600 });
}

function defaultList() {
  return { id: 'tasks', displayName: 'Tâches', wellknownListName: 'defaultList' };
}

async function execute(action: TodoAction, name: string): Promise<string> {
  return executeTodoAgentAction(action, env(name));
}

afterEach(async () => {
  await stopTodoTokenKeepalives();
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('Microsoft To Do reliability', () => {
  it.each([
    'http://graph.microsoft.com/v1.0/me/todo/lists/tasks/tasks?page=2',
    'https://graph.microsoft.com:444/v1.0/me/todo/lists/tasks/tasks?page=2',
    'https://user:password@graph.microsoft.com/v1.0/me/todo/lists/tasks/tasks?page=2',
    'https://graph.microsoft.com/beta/me/todo/lists/tasks/tasks?page=2',
    'https://graph.microsoft.com/v1.0/me/todo/lists/tasks/tasks?page=2#fragment',
    'https://attacker.example/v1.0/me/todo/lists/tasks/tasks?page=2',
  ])('rejects an unexpected Graph nextLink without forwarding credentials: %s', async (nextLink) => {
    const requested: string[] = [];
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      return json({ value: [], '@odata.nextLink': nextLink });
    }) as typeof fetch;

    await expect(execute({ action: 'list_tasks' }, `next-link-${requested.length}-${nextLink.length}`))
      .rejects.toThrow('todo_graph_untrusted_next_link');

    expect(requested).not.toContain(nextLink);
  });

  it('disallows redirects on authenticated Graph reads', async () => {
    const graphOptions: RequestInit[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      graphOptions.push(init ?? {});
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      return json({ value: [] });
    }) as typeof fetch;

    await execute({ action: 'list_tasks' }, 'redirect-policy');

    expect(graphOptions).not.toHaveLength(0);
    expect(graphOptions.every((options) => options.redirect === 'error')).toBe(true);
  });

  it('retries one throttled read after Retry-After without repeating indefinitely', async () => {
    let taskReads = 0;
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      taskReads += 1;
      return taskReads === 1
        ? json({ error: { code: 'TooManyRequests' } }, 429, { 'retry-after': '0' })
        : json({ value: [{ id: 'one', title: 'Une', status: 'notStarted' }] });
    }) as typeof fetch;

    const result = await execute({ action: 'list_tasks' }, 'throttle');

    expect(result).toContain('Une');
    expect(taskReads).toBe(2);
  });

  it('does not retry before a Retry-After delay that exceeds the bounded read window', async () => {
    let taskReads = 0;
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      taskReads += 1;
      return json({ error: { code: 'TooManyRequests' } }, 429, { 'retry-after': '3600' });
    }) as typeof fetch;

    await expect(execute({ action: 'list_tasks' }, 'long-throttle'))
      .rejects.toThrow('todo_graph_get_failed:429');
    expect(taskReads).toBe(1);
  });

  it('rejects a collection response with no value array instead of treating it as empty', async () => {
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      return json({ '@odata.context': 'unexpected' });
    }) as typeof fetch;

    await expect(execute({ action: 'list_tasks' }, 'malformed-collection'))
      .rejects.toThrow('todo_graph_malformed_collection');
  });

  it('refreshes an expired access token once and repeats only the refused operation', async () => {
    let refreshes = 0;
    let taskReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) {
        refreshes += 1;
        return token(`access-${refreshes}`);
      }
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      taskReads += 1;
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      return authorization === 'Bearer access-1'
        ? json({ error: { code: 'InvalidAuthenticationToken' } }, 401)
        : json({ value: [{ id: 'one', title: 'Récupérée', status: 'notStarted' }] });
    }) as typeof fetch;

    const result = await execute({ action: 'list_tasks' }, 'expired-access');

    expect(result).toContain('Récupérée');
    expect(refreshes).toBe(2);
    expect(taskReads).toBe(2);
  });

  it('does not refresh the access token for a Graph permission failure', async () => {
    let refreshes = 0;
    let taskReads = 0;
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2')) {
        refreshes += 1;
        return token(`access-${refreshes}`);
      }
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      taskReads += 1;
      return json({ error: { code: 'Authorization_RequestDenied' } }, 403);
    }) as typeof fetch;

    await expect(execute({ action: 'list_tasks' }, 'permission-denied'))
      .rejects.toThrow('todo_graph_get_failed:403');
    expect(refreshes).toBe(1);
    expect(taskReads).toBe(1);
  });

  it('uses the task id returned by a successful creation as proof of success', async () => {
    let posts = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      if (init?.method === 'POST' && url.endsWith('/tasks')) {
        posts += 1;
        return json({ id: 'created-task-id', title: 'Créée', status: 'notStarted' }, 201);
      }
      if (url.startsWith('https://api.openai.com/')) return json({}, 500);
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await execute({ action: 'add_task', title: 'Créée' }, 'create-id');

    expect(result).toBe("C'est noté.");
    expect(posts).toBe(1);
  });

  it('does not report a creation as successful when Graph omits the task id', async () => {
    let posts = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      if (init?.method === 'POST' && url.endsWith('/tasks')) {
        posts += 1;
        return json({ title: 'Sans preuve', status: 'notStarted' }, 201);
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(execute({ action: 'add_task', title: 'Sans preuve' }, 'missing-created-id'))
      .rejects.toThrow('todo_graph_post_uncertain');
    expect(posts).toBe(1);
  });

  it('does not retry a creation whose network outcome is uncertain', async () => {
    let posts = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      if (init?.method === 'POST' && url.endsWith('/tasks')) {
        posts += 1;
        throw new DOMException('timed out after upload', 'TimeoutError');
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(execute({ action: 'add_task', title: 'Ne pas dupliquer' }, 'uncertain-create'))
      .rejects.toThrow('todo_graph_post_uncertain');
    expect(posts).toBe(1);
  });

  it('does not retry a creation after a transient Graph server response', async () => {
    let posts = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      if (init?.method === 'POST' && url.endsWith('/tasks')) {
        posts += 1;
        return json({ error: { code: 'ServiceUnavailable' } }, 503, { 'retry-after': '0' });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(execute({ action: 'add_task', title: 'Une seule fois' }, 'uncertain-server'))
      .rejects.toThrow('todo_graph_post_uncertain:503');
    expect(posts).toBe(1);
  });

  it('refuses to mutate when identical task titles exist in the selected list', async () => {
    let patches = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      if (url.includes('/tasks?')) {
        return json({ value: [
          { id: 'first', title: 'Rapport', status: 'notStarted' },
          { id: 'second', title: 'Rapport', status: 'notStarted' },
        ] });
      }
      if (init?.method === 'PATCH') {
        patches += 1;
        return new Response(null, { status: 204 });
      }
      if (url.startsWith('https://api.openai.com/')) return json({}, 500);
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await execute({ action: 'complete_task', title: 'Rapport', list_name: 'Tâches' }, 'duplicates');

    expect(result).toContain('plusieurs tâches');
    expect(patches).toBe(0);
  });

  it('treats deletion of an already absent task as an idempotent success', async () => {
    let deletes = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      if (url.includes('/tasks?')) return json({ value: [{ id: 'gone', title: 'Ancienne', status: 'notStarted' }] });
      if (init?.method === 'DELETE') {
        deletes += 1;
        return json({ error: { code: 'NotFound' } }, 404);
      }
      if (url.startsWith('https://api.openai.com/')) return json({}, 500);
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await execute({ action: 'delete_task', title: 'Ancienne', list_name: 'Tâches' }, 'delete-absent');

    expect(result).toContain('a bien été supprimée');
    expect(deletes).toBe(1);
  });

  it.each(['2026-03-29T09:00', '2026-10-25T09:00', '2026-10-25T23:59'])(
    'keeps a Paris-local reminder stable across daylight-saving boundaries: %s',
    async (reminderDate) => {
      let sentBody: Record<string, unknown> | undefined;
      global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('oauth2')) return token();
        if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
        if (init?.method === 'POST' && url.endsWith('/tasks')) {
          sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return json({ id: 'created', title: 'Rappel', status: 'notStarted' }, 201);
        }
        if (url.startsWith('https://api.openai.com/')) return json({}, 500);
        throw new Error(`unexpected request: ${url}`);
      }) as typeof fetch;

      await execute({
        action: 'add_task',
        title: 'Rappel',
        due_date: reminderDate.slice(0, 10),
        reminder_date: reminderDate,
        recurrence: { type: 'weekly', daysOfWeek: ['sunday'] },
      }, `dst-${reminderDate}`);

      expect(sentBody).toMatchObject({
        dueDateTime: { dateTime: `${reminderDate.slice(0, 10)}T00:00:00.0000000`, timeZone: 'UTC' },
        reminderDateTime: { dateTime: `${reminderDate}:00.0000000`, timeZone: 'Romance Standard Time' },
        recurrence: {
          pattern: { type: 'weekly', interval: 1, daysOfWeek: ['sunday'], firstDayOfWeek: 'monday' },
          range: { type: 'noEnd', startDate: reminderDate.slice(0, 10) },
        },
      });
    },
  );

  it('rejects an impossible due date before sending a mutation', async () => {
    let posts = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) return json({ value: [defaultList()] });
      if (init?.method === 'POST') posts += 1;
      return json({ id: 'unexpected' }, 201);
    }) as typeof fetch;

    await expect(execute({ action: 'add_task', title: 'Impossible', due_date: '2026-02-30' }, 'invalid-date'))
      .rejects.toThrow('todo_invalid_date');
    expect(posts).toBe(0);
  });

  it('keeps successful lists and marks the response partial when another list fails', async () => {
    const taskReads = new Map<string, number>();
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('oauth2')) return token();
      if (url.endsWith('/me/todo/lists')) {
        return json({ value: [
          defaultList(),
          { id: 'daily', displayName: 'Vie quotidienne' },
        ] });
      }
      if (url.includes('/lists/tasks/tasks?')) {
        return json({ value: [{ id: 'ok', title: 'Disponible', status: 'notStarted' }] });
      }
      if (url.includes('/lists/daily/tasks?')) {
        taskReads.set('daily', (taskReads.get('daily') ?? 0) + 1);
        return json({ error: { code: 'ServiceUnavailable' } }, 503, { 'retry-after': '0' });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await execute({ action: 'list_tasks' }, 'partial-lists');

    expect(result).toContain('Disponible');
    expect(result).toContain('partiel');
    expect(taskReads.get('daily')).toBe(2);
  });
});
