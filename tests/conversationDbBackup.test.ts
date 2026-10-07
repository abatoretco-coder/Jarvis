import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';

import {
  backupConversationDatabase,
  createEncryptedConversationBackup,
  decryptBackupFile,
  encryptBackupFile,
  restoreConversationDatabase,
  restoreEncryptedConversationBackup,
  verifyConversationDatabase,
} from '../src/conversation/conversationDbBackup';
import { CONVERSATION_SCHEMA_VERSION } from '../src/conversation/repositories/conversationMigrations';
import { createConversationDb } from '../src/conversation/repositories/SqliteRepositories';
import { IdentityRepository } from '../src/identity/IdentityRepository';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('conversation database backup and restore', () => {
  test('backs up a live WAL database and restores a verified copy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-backup-'));
    directories.push(directory);
    const sourcePath = join(directory, 'live', 'conversation.sqlite');
    const backupPath = join(directory, 'backups', 'conversation.sqlite');
    const restoredPath = join(directory, 'restored', 'conversation.sqlite');
    mkdirSync(join(directory, 'live'));
    const live = createConversationDb(sourcePath);
    live.exec(`
      INSERT INTO conversation_threads(thread_id, created_at_ms, updated_at_ms)
      VALUES ('thread-1', 1, 1);
      INSERT INTO conversation_messages(thread_id, seq, role, content, created_at_ms)
      VALUES ('thread-1', 1, 'user', 'Bonjour', 1);
    `);
    const identities = new IdentityRepository(live);
    const owner = identities.provisionOidcIdentity(
      {
        issuer: 'https://id.example.test',
        subject: 'owner',
        email: 'owner@example.test',
        emailVerified: true,
      },
      2
    );
    identities.bootstrapOwner(owner.userId, 3);
    identities.claimLegacyConversationData(owner.userId, 4);
    live
      .prepare(
        `INSERT INTO integration_connections(
      connection_id,owner_user_id,provider,status,scopes_json,credential_reference,created_at_ms,updated_at_ms
    ) VALUES ('integration-1',?,'google','active','[]','vault://integration-1',5,5)`
      )
      .run(owner.userId);
    live
      .prepare(
        `INSERT INTO resource_grants(
      grant_id,resource_type,resource_id,grantee_user_id,permissions_json,created_by_user_id,created_at_ms
    ) VALUES ('grant-1','device','light.office',?,'["control"]',?,5)`
      )
      .run(owner.userId, owner.userId);
    live
      .prepare(
        `INSERT INTO admin_idempotency_keys(
      actor_user_id,idempotency_key,request_fingerprint,response_json,created_at_ms
    ) VALUES (?,'backup-key-1','fingerprint','{}',5)`
      )
      .run(owner.userId);

    await expect(backupConversationDatabase(sourcePath, backupPath)).resolves.toMatchObject({
      threadCount: 1,
      messageCount: 1,
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      userCount: 1,
      ownedThreadCount: 1,
      serviceOwnedThreadCount: 0,
      unownedThreadCount: 0,
      auditEventCount: 1,
      integrationConnectionCount: 1,
      resourceGrantCount: 1,
      adminIdempotencyKeyCount: 1,
    });
    await expect(restoreConversationDatabase(backupPath, restoredPath)).resolves.toMatchObject({
      threadCount: 1,
      messageCount: 1,
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      userCount: 1,
      ownedThreadCount: 1,
      serviceOwnedThreadCount: 0,
      auditEventCount: 1,
      integrationConnectionCount: 1,
      resourceGrantCount: 1,
      adminIdempotencyKeyCount: 1,
    });
    live.close();
    expect(readdirSync(join(directory, 'backups'))).toEqual(['conversation.sqlite']);
    expect(readdirSync(join(directory, 'restored'))).toEqual(['conversation.sqlite']);
    const restored = new Database(restoredPath, { readonly: true });
    expect(
      restored
        .prepare(
          `SELECT t.owner_user_id owner,u.email_normalized email
      FROM conversation_threads t JOIN users u ON u.user_id=t.owner_user_id
      WHERE t.thread_id='thread-1'`
        )
        .get()
    ).toEqual({
      owner: owner.userId,
      email: 'owner@example.test',
    });
    expect(restored.prepare('SELECT action,target_id FROM audit_events').get()).toEqual({
      action: 'conversation_ownership_backfill_batch',
      target_id: owner.userId,
    });
    restored.close();
    expect(verifyConversationDatabase(restoredPath)).toMatchObject({
      threadCount: 1,
      messageCount: 1,
    });
  });

  test('never overwrites an existing destination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-backup-no-overwrite-'));
    directories.push(directory);
    const sourcePath = join(directory, 'source.sqlite');
    const destinationPath = join(directory, 'destination.sqlite');
    createConversationDb(sourcePath).close();
    writeFileSync(destinationPath, 'keep-me');

    await expect(backupConversationDatabase(sourcePath, destinationPath)).rejects.toThrow(
      'conversation_database_destination_exists'
    );
  });

  test('encrypts and authenticates a backup before restoring it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-secure-backup-'));
    directories.push(directory);
    const sourcePath = join(directory, 'source.sqlite');
    const encryptedPath = join(directory, 'backup.jarvisdb');
    const restoredPath = join(directory, 'restored.sqlite');
    const passphrase = 'a-unique-test-passphrase-with-32-characters';
    const source = createConversationDb(sourcePath);
    source.exec(`
      INSERT INTO conversation_threads(thread_id, created_at_ms, updated_at_ms)
      VALUES ('encrypted-thread', 1, 1);
      INSERT INTO conversation_messages(thread_id, seq, role, content, created_at_ms)
      VALUES ('encrypted-thread', 1, 'user', 'secret history', 1);
    `);
    source.close();

    await expect(
      createEncryptedConversationBackup(sourcePath, encryptedPath, passphrase)
    ).resolves.toMatchObject({ threadCount: 1, messageCount: 1 });
    expect(readFileSync(encryptedPath).includes(Buffer.from('secret history'))).toBe(false);
    await expect(
      restoreEncryptedConversationBackup(encryptedPath, restoredPath, passphrase)
    ).resolves.toMatchObject({ threadCount: 1, messageCount: 1 });
    expect(verifyConversationDatabase(restoredPath)).toMatchObject({
      threadCount: 1,
      messageCount: 1,
    });
  });

  test('rejects a tampered encrypted backup without creating the destination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-secure-backup-tampered-'));
    directories.push(directory);
    const sourcePath = join(directory, 'source.sqlite');
    const encryptedPath = join(directory, 'backup.jarvisdb');
    const restoredPath = join(directory, 'restored.sqlite');
    const passphrase = 'another-unique-test-passphrase-over-32-chars';
    createConversationDb(sourcePath).close();
    await createEncryptedConversationBackup(sourcePath, encryptedPath, passphrase);
    const tampered = readFileSync(encryptedPath);
    tampered[Math.floor(tampered.length / 2)] ^= 1;
    writeFileSync(encryptedPath, tampered);

    await expect(
      restoreEncryptedConversationBackup(encryptedPath, restoredPath, passphrase)
    ).rejects.toThrow('conversation_backup_decryption_failed');
    expect(() => verifyConversationDatabase(restoredPath)).toThrow();
  });

  test('encrypts and restores a generic identity archive', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-identity-archive-'));
    directories.push(directory);
    const sourcePath = join(directory, 'identity.zip');
    const encryptedPath = join(directory, 'identity.zip.jarvisdb');
    const restoredPath = join(directory, 'identity-restored.zip');
    const passphrase = 'identity-archive-test-passphrase-32-chars';
    writeFileSync(sourcePath, Buffer.from('keycloak-identity-archive'));

    await encryptBackupFile(sourcePath, encryptedPath, passphrase);
    expect(readFileSync(encryptedPath).includes(Buffer.from('keycloak-identity-archive'))).toBe(false);
    await decryptBackupFile(encryptedPath, restoredPath, passphrase);
    expect(readFileSync(restoredPath).toString()).toBe('keycloak-identity-archive');
  });

  test('rejects a SQLite file that is not a Jarvis conversation database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-backup-invalid-'));
    directories.push(directory);
    const databasePath = join(directory, 'empty.sqlite');
    createConversationDb(databasePath).close();
    const database = createConversationDb(databasePath);
    database.exec('DROP TABLE conversation_messages');
    database.close();

    expect(() => verifyConversationDatabase(databasePath)).toThrow(
      'conversation_database_missing_table:conversation_messages'
    );
  });

  test('rejects a v6 backup missing a control-plane table or column', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-backup-v6-invalid-'));
    directories.push(directory);
    const missingTablePath = join(directory, 'missing-table.sqlite');
    const missingColumnPath = join(directory, 'missing-column.sqlite');

    createConversationDb(missingTablePath).close();
    const missingTable = new Database(missingTablePath);
    missingTable.exec('DROP TABLE admin_idempotency_keys');
    missingTable.close();
    expect(() => verifyConversationDatabase(missingTablePath)).toThrow(
      'conversation_database_missing_table:admin_idempotency_keys'
    );

    createConversationDb(missingColumnPath).close();
    const missingColumn = new Database(missingColumnPath);
    missingColumn.exec('ALTER TABLE integration_connections DROP COLUMN last_error_code');
    missingColumn.close();
    expect(() => verifyConversationDatabase(missingColumnPath)).toThrow(
      'conversation_database_missing_column:integration_connections.last_error_code'
    );
  });

  test('restores a pre-identity backup so the current runtime can migrate it forward', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-backup-legacy-'));
    directories.push(directory);
    const backupPath = join(directory, 'legacy.sqlite');
    const restoredPath = join(directory, 'restored.sqlite');
    const legacy = new Database(backupPath);
    legacy.exec(`
      CREATE TABLE conversation_threads(
        thread_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',summary_upto_seq INTEGER NOT NULL DEFAULT 0,
        summary_version INTEGER NOT NULL DEFAULT 0,summary_candidate TEXT,
        summary_candidate_upto_seq INTEGER,summary_status TEXT NOT NULL DEFAULT 'idle',
        summary_last_error TEXT,interaction_count INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE conversation_messages(
        thread_id TEXT NOT NULL,seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(thread_id,seq),FOREIGN KEY(thread_id) REFERENCES conversation_threads(thread_id) ON DELETE CASCADE
      );
      INSERT INTO conversation_threads(thread_id,created_at_ms,updated_at_ms) VALUES ('legacy-thread',1,1);
      INSERT INTO conversation_messages VALUES ('legacy-thread',1,'user','Bonjour',1);
    `);
    legacy.close();

    await expect(restoreConversationDatabase(backupPath, restoredPath)).resolves.toMatchObject({
      schemaVersion: 0,
      threadCount: 1,
      userCount: 0,
      ownedThreadCount: 0,
      serviceOwnedThreadCount: 0,
      unownedThreadCount: 1,
    });
    const migrated = createConversationDb(restoredPath);
    expect(migrated.pragma('user_version', { simple: true })).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(
      migrated
        .prepare("SELECT thread_id FROM conversation_threads WHERE thread_id='legacy-thread'")
        .get()
    ).toEqual({ thread_id: 'legacy-thread' });
    migrated.close();
  });
});
