import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';

import { CONVERSATION_SCHEMA_VERSION } from '../src/conversation/repositories/conversationMigrations';
import { loadEnv } from '../src/env';
import { buildApp } from '../src/server';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('admin control-plane server wiring', () => {
  test('registers every phase 4 surface and migrates the configured database through buildApp', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-admin-wiring-'));
    directories.push(directory);
    const databasePath = join(directory, 'conversation.sqlite');
    const app = buildApp(
      loadEnv({
        LOG_LEVEL: 'silent',
        REQUIRE_API_KEY: 'true',
        SERVICE_API_KEYS_JSON: JSON.stringify([{ id: 'admin-wiring-service', token: 'admin-wiring-service-token-01234567', permissions: ['admin'] }]),
        OIDC_ENABLED: 'true',
        OIDC_ISSUER_URL: 'https://issuer.example.test/realms/jarvis',
        OIDC_AUDIENCE: 'jarvis-api',
        CONVERSATION_DB_PATH: databasePath,
      })
    );
    await app.ready();

    for (const url of [
      '/v1/admin/users',
      '/v1/admin/permissions',
      '/v1/admin/households',
      '/v1/admin/grants',
      '/v1/admin/integrations',
      '/v1/admin/audit',
      '/v1/admin/services',
      '/v1/admin/ai',
      '/v1/admin/home/inventory',
      '/v1/admin/operations',
    ]) {
      expect(app.hasRoute({ method: 'GET', url })).toBe(true);
    }
    const serviceAttempt = await app.inject({
      method: 'GET',
      url: '/v1/admin/services',
      headers: { 'x-api-key': 'admin-wiring-service-token-01234567' },
    });
    expect(serviceAttempt.statusCode).toBe(403);
    expect(serviceAttempt.json()).toEqual({ error: 'human_admin_required' });
    await app.close();

    const database = new Database(databasePath, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(database.prepare('SELECT name FROM schema_migrations WHERE version=6').get()).toEqual({
      name: 'admin_control_plane',
    });
    database.close();
  });

  test('does not expose the control plane when human identity is disabled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-admin-disabled-'));
    directories.push(directory);
    const app = buildApp(
      loadEnv({
        LOG_LEVEL: 'silent',
        REQUIRE_API_KEY: 'true',
        SERVICE_API_KEYS_JSON: JSON.stringify([{ id: 'admin-disabled-service', token: 'admin-disabled-service-token-012345', permissions: ['admin'] }]),
        OIDC_ENABLED: 'false',
        CONVERSATION_DB_PATH: join(directory, 'conversation.sqlite'),
      })
    );
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/services',
      headers: { 'x-api-key': 'admin-disabled-service-token-012345' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
