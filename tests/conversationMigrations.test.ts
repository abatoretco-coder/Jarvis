import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';

import {
  CONVERSATION_SCHEMA_VERSION,
  runConversationMigrations,
} from '../src/conversation/repositories/conversationMigrations';
import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('conversation database migrations', () => {
  test('records the schema version once and is idempotent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-schema-version-'));
    directories.push(directory);
    const databasePath = join(directory, 'conversation.sqlite');

    const first = createConversationDb(databasePath);
    expect(first.pragma('user_version', { simple: true })).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(
      first.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 1, name: 'initial_conversation_schema' },
      { version: 2, name: 'identity_foundation' },
      { version: 3, name: 'authorization_policy' },
      { version: 4, name: 'user_data_ownership' },
      { version: 5, name: 'service_data_ownership' },
      { version: 6, name: 'admin_control_plane' },
      { version: 7, name: 'personal_integrations' },
      { version: 8, name: 'simple_home_roles' },
    ]);
    first.close();

    const reopened = createConversationDb(databasePath);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 8,
    });
    reopened.close();
  });

  test('adopts a legacy database without dropping its rows', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE conversation_threads (
        thread_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',
        summary_upto_seq INTEGER NOT NULL DEFAULT 0,
        summary_version INTEGER NOT NULL DEFAULT 0,
        summary_candidate TEXT,
        summary_candidate_upto_seq INTEGER,
        summary_status TEXT NOT NULL DEFAULT 'idle',
        summary_last_error TEXT,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO conversation_threads(thread_id, created_at_ms, updated_at_ms)
      VALUES ('legacy-thread', 1, 2);
    `);

    runConversationMigrations(legacy);

    expect(legacy.prepare('SELECT thread_id FROM conversation_threads').get()).toEqual({
      thread_id: 'legacy-thread',
    });
    const columns = legacy.prepare('PRAGMA table_info(conversation_threads)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'channel',
        'title',
        'title_source',
        'conversation_window_expires_at_ms',
      ])
    );
    legacy.close();
  });

  test('refuses a database created by a newer runtime', () => {
    const database = new Database(':memory:');
    database.pragma(`user_version = ${CONVERSATION_SCHEMA_VERSION + 1}`);
    expect(() => runConversationMigrations(database)).toThrow(
      'conversation_database_newer_than_runtime'
    );
    database.close();
  });

  test('refuses a modified applied migration checksum', () => {
    const database = createConversationDb(':memory:');
    database
      .prepare("UPDATE schema_migrations SET checksum = 'unexpected' WHERE version = 1")
      .run();
    expect(() => runConversationMigrations(database)).toThrow(
      'conversation_migration_checksum_mismatch:1'
    );
    database.close();
  });

  test('creates constrained identity, role and revocable session tables additively', () => {
    const database = createConversationDb(':memory:');
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'users',
        'oidc_identities',
        'roles',
        'permissions',
        'user_roles',
        'role_permissions',
        'auth_sessions',
      ])
    );
    expect(database.prepare('SELECT role_key FROM roles ORDER BY rank DESC').all()).toEqual([
      { role_key: 'owner' },
      { role_key: 'resident' },
      { role_key: 'guest' },
    ]);
    expect(
      database
        .prepare(
          `SELECT permission_key FROM role_permissions
      WHERE role_key='guest' ORDER BY permission_key`
        )
        .all()
    ).toEqual([
      { permission_key: 'chat' },
      { permission_key: 'home' },
      { permission_key: 'music' },
    ]);
    expect(() =>
      database
        .prepare(
          `INSERT INTO users(user_id,email_normalized,status,created_at_ms,updated_at_ms)
      VALUES ('u1','person@example.test','unknown',1,1)`
        )
        .run()
    ).toThrow();
    database
      .prepare(
        `INSERT INTO users(user_id,email_normalized,status,created_at_ms,updated_at_ms)
      VALUES ('u1','person@example.test','pending',1,1)`
      )
      .run();
    expect(() =>
      database
        .prepare(
          `INSERT INTO auth_sessions(session_id,user_id,status,created_at_ms,expires_at_ms,last_seen_at_ms)
      VALUES ('s1','u1','active',10,9,10)`
        )
        .run()
    ).toThrow();
    database.close();
  });

  test('folds legacy admin accounts into the single owner level', () => {
    const database = createConversationDb(':memory:');
    database.exec(`
      INSERT INTO roles(role_key,rank) VALUES ('admin',80);
      INSERT INTO role_permissions(role_key,permission_key) VALUES ('admin','admin');
      INSERT INTO users(user_id,email_normalized,display_name,status,created_at_ms,updated_at_ms)
        VALUES ('legacy-admin','legacy@example.test','Legacy','active',1,1);
      INSERT INTO user_roles(user_id,role_key,granted_at_ms) VALUES ('legacy-admin','admin',1);
      INSERT INTO households(household_id,name,created_by_user_id,created_at_ms,updated_at_ms)
        VALUES ('home:legacy-admin','Maison','legacy-admin',1,1);
      INSERT INTO household_memberships(household_id,user_id,role_key,status,created_at_ms,updated_at_ms)
        VALUES ('home:legacy-admin','legacy-admin','admin','active',1,1);
      DELETE FROM schema_migrations WHERE version=8;
      PRAGMA user_version=7;
    `);
    runConversationMigrations(database);
    expect(database.prepare("SELECT role_key FROM user_roles WHERE user_id='legacy-admin'").all()).toEqual([{ role_key: 'owner' }]);
    expect(database.prepare("SELECT role_key FROM household_memberships WHERE user_id='legacy-admin'").get()).toEqual({ role_key: 'owner' });
    expect(database.prepare("SELECT 1 FROM roles WHERE role_key='admin'").get()).toBeUndefined();
    database.close();
  });

  test('adds the ownership, household, integration, grant and audit foundation additively', () => {
    const database = createConversationDb(':memory:');
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'households',
        'household_memberships',
        'integration_connections',
        'resource_grants',
        'audit_events',
        'admin_idempotency_keys',
        'integration_credentials',
        'oauth_transactions',
      ])
    );
    const columns = database.prepare('PRAGMA table_info(conversation_threads)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['owner_user_id', 'owner_service_id'])
    );
    const integrationColumns = database
      .prepare('PRAGMA table_info(integration_connections)')
      .all() as Array<{ name: string }>;
    expect(integrationColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'last_sync_at_ms',
        'last_error_code',
        'revoked_at_ms',
        'connection_kind',
        'display_name',
        'provider_subject',
        'provider_email',
      ])
    );
    const grantColumns = database.prepare('PRAGMA table_info(resource_grants)').all() as Array<{
      name: string;
    }>;
    expect(grantColumns.map((column) => column.name)).toContain('revoked_at_ms');
    expect(() =>
      database
        .prepare(
          `INSERT INTO resource_grants(
      grant_id,resource_type,resource_id,permissions_json,created_by_user_id,created_at_ms
    ) VALUES ('g','device','light.1','[]','missing',1)`
        )
        .run()
    ).toThrow();
    database
      .prepare(
        `INSERT INTO audit_events(
      event_id,actor_kind,action,target_type,outcome,created_at_ms
    ) VALUES ('event','system','test','database','success',1)`
      )
      .run();
    expect(() => database.prepare("DELETE FROM audit_events WHERE event_id='event'").run()).toThrow(
      'audit_events_append_only'
    );
    database
      .prepare(
        `INSERT INTO conversation_threads(thread_id,created_at_ms,updated_at_ms)
      VALUES ('owned-thread',1,1)`
      )
      .run();
    expect(() =>
      database
        .prepare(
          `UPDATE conversation_threads
      SET owner_user_id='missing-user',owner_service_id='service' WHERE thread_id='owned-thread'`
        )
        .run()
    ).toThrow('conversation_owner_ambiguous');
    expect(() =>
      database
        .prepare(
          `INSERT INTO pending_mutations(
      proposal_id,thread_id,agent,action,effect,preview,payload_json,status,expires_at_ms,created_at_ms,owner_service_id
    ) VALUES ('mismatch','owned-thread','todo','add','write','x','{}','pending',2,1,'other-service')`
        )
        .run()
    ).toThrow('pending_mutation_owner_mismatch');
    database.close();
  });

  test('upgrades a v4 ownership database to service isolation and repairs its indexes', () => {
    const database = createConversationDb(':memory:');
    database.exec(`
      DROP TRIGGER conversation_threads_owner_insert;
      DROP TRIGGER conversation_threads_owner_update;
      DROP TRIGGER pending_mutations_owner_insert;
      DROP TRIGGER pending_mutations_owner_update;
      DROP TRIGGER conversation_result_sets_owner_insert;
      DROP TRIGGER conversation_result_sets_owner_update;
      DELETE FROM schema_migrations WHERE version=5;
      PRAGMA user_version=4;
      DROP INDEX idx_conversation_threads_owner_updated;
      DROP INDEX idx_pending_mutations_owner_thread_status;
      DROP INDEX idx_conversation_result_sets_owner_thread;
      ALTER TABLE conversation_result_sets DROP COLUMN owner_service_id;
      ALTER TABLE pending_mutations DROP COLUMN owner_service_id;
      ALTER TABLE conversation_threads DROP COLUMN owner_service_id;
      CREATE INDEX idx_conversation_threads_owner_updated ON conversation_threads(owner_user_id,updated_at_ms DESC);
      CREATE INDEX idx_pending_mutations_owner_thread_status
        ON pending_mutations(owner_user_id,thread_id,status,expires_at_ms DESC);
      CREATE INDEX idx_conversation_result_sets_owner_thread
        ON conversation_result_sets(owner_user_id,thread_id,expires_at_ms DESC);
    `);

    runConversationMigrations(database);

    expect(database.pragma('user_version', { simple: true })).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(database.prepare('SELECT name FROM schema_migrations WHERE version=5').get()).toEqual({
      name: 'service_data_ownership',
    });
    const indexColumns = database
      .prepare('PRAGMA index_info(idx_conversation_threads_owner_updated)')
      .all() as Array<{ name: string }>;
    expect(indexColumns.map((column) => column.name)).toEqual([
      'owner_user_id',
      'owner_service_id',
      'updated_at_ms',
    ]);
    database.close();
  });

  test('upgrades a v5 database to the admin control-plane schema', () => {
    const database = createConversationDb(':memory:');
    database.exec(`
      DROP INDEX idx_integration_connections_status_updated;
      DROP INDEX idx_resource_grants_active_resource;
      DROP INDEX idx_audit_events_action_created;
      DROP INDEX idx_audit_events_target_created;
      DROP TABLE admin_idempotency_keys;
      ALTER TABLE integration_connections DROP COLUMN last_sync_at_ms;
      ALTER TABLE integration_connections DROP COLUMN last_error_code;
      ALTER TABLE integration_connections DROP COLUMN revoked_at_ms;
      ALTER TABLE resource_grants DROP COLUMN revoked_at_ms;
      DELETE FROM schema_migrations WHERE version=6;
      PRAGMA user_version=5;
    `);

    runConversationMigrations(database);

    expect(database.pragma('user_version', { simple: true })).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(database.prepare('SELECT name FROM schema_migrations WHERE version=6').get()).toEqual({
      name: 'admin_control_plane',
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='admin_idempotency_keys'"
        )
        .get()
    ).toEqual({ name: 'admin_idempotency_keys' });
    const integrationColumns = database
      .prepare('PRAGMA table_info(integration_connections)')
      .all() as Array<{ name: string }>;
    expect(integrationColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['last_sync_at_ms', 'last_error_code', 'revoked_at_ms'])
    );
    database.close();
  });

  test('fails closed when a pre-v5 child row has a different owner than its thread', () => {
    const database = createConversationDb(':memory:');
    database.exec(`
      DROP TRIGGER pending_mutations_owner_insert;
      DELETE FROM schema_migrations WHERE version=5;
      PRAGMA user_version=4;
      INSERT INTO conversation_threads(thread_id,created_at_ms,updated_at_ms,owner_service_id)
        VALUES ('service-thread',1,1,'service-a');
      INSERT INTO pending_mutations(
        proposal_id,thread_id,agent,action,effect,preview,payload_json,status,expires_at_ms,created_at_ms,owner_service_id
      ) VALUES ('bad-owner','service-thread','todo','add','write','x','{}','pending',2,1,'service-b');
    `);

    expect(() => runConversationMigrations(database)).toThrow(
      'conversation_ownership_invariant_failed:1'
    );
    database.close();
  });
});
