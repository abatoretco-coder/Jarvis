import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { loadEnv } from '../src/env';
import { buildTasksSection } from '../src/routes/dashboard';

function makeEnv() {
  return loadEnv({
    REQUIRE_API_KEY: 'false',
    LOG_LEVEL: 'silent',
    MICROSOFT_CLIENT_ID: 'client-id',
    MICROSOFT_CLIENT_SECRET: 'client-secret',
    MICROSOFT_REFRESH_TOKEN: 'refresh-token',
  });
}

describe('dashboard todo section', () => {
  afterEach(() => {
    (global as { fetch?: unknown }).fetch = undefined;
    jest.useRealTimers();
  });

  it('keeps Jarvis focused on dated overdue and today tasks, excluding tasks without a deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-06T08:00:00+02:00'));

    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({
          access_token: 'access-token',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (url === 'https://graph.microsoft.com/v1.0/me/todo/lists?$top=50') {
        return new Response(JSON.stringify({
          value: [{ id: 'tasks-list', displayName: 'Tasks' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (url === 'https://graph.microsoft.com/v1.0/me/todo/lists/tasks-list/tasks?$orderby=createdDateTime desc&$top=200') {
        return new Response(JSON.stringify({
          value: [
            {
              id: 'overdue-1',
              title: 'Refaire CV',
              status: 'notStarted',
              importance: 'normal',
              dueDateTime: { dateTime: '2026-03-23T09:00:00.0000000', timeZone: 'UTC' },
              createdDateTime: '2026-03-20T08:00:00Z',
            },
            {
              id: 'today-1',
              title: 'Sport',
              status: 'notStarted',
              importance: 'normal',
              dueDateTime: { dateTime: '2026-07-06T09:00:00.0000000', timeZone: 'UTC' },
              createdDateTime: '2026-07-01T08:00:00Z',
            },
            {
              id: 'future-1',
              title: 'Controle technique',
              status: 'notStarted',
              importance: 'normal',
              dueDateTime: { dateTime: '2026-07-08T09:00:00.0000000', timeZone: 'UTC' },
              createdDateTime: '2026-07-01T08:00:00Z',
            },
            {
              id: 'undated-1',
              title: 'Sans deadline',
              status: 'notStarted',
              importance: 'high',
              dueDateTime: null,
              createdDateTime: '2026-07-06T05:00:00Z',
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const section = await buildTasksSection(makeEnv());

    expect(section.summary).toContain('1 en retard');
    expect(section.summary).toContain('1 aujourd hui');
    expect(section.lines).toEqual([
      expect.stringContaining('En retard: Refaire CV'),
      expect.stringContaining('Aujourd hui: Sport'),
      expect.stringContaining('Cette semaine: Controle technique'),
    ]);
    expect(section.lines.join('\n')).not.toContain('Sans deadline');
    expect(section.items?.map((item) => (item as { title: string }).title)).toEqual([
      'Refaire CV',
      'Sport',
      'Controle technique',
    ]);
  });
});
