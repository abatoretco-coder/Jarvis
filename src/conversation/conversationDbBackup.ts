import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { constants, existsSync, rmSync } from 'node:fs';
import { chmod, copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

const ENCRYPTED_BACKUP_MAGIC = Buffer.from('JARVISDB1');
const BACKUP_SALT_BYTES = 16;
const BACKUP_IV_BYTES = 12;
const BACKUP_TAG_BYTES = 16;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

export type ConversationDatabaseVerification = {
  path: string;
  schemaVersion: number;
  threadCount: number;
  messageCount: number;
  userCount: number;
  ownedThreadCount: number;
  serviceOwnedThreadCount: number;
  unownedThreadCount: number;
  auditEventCount: number;
  integrationConnectionCount: number;
  resourceGrantCount: number;
  adminIdempotencyKeyCount: number;
};

function temporarySibling(destinationPath: string): string {
  return path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp`
  );
}

async function removeTemporaryDatabase(temporaryPath: string): Promise<void> {
  await Promise.all([
    rm(temporaryPath, { force: true }),
    rm(`${temporaryPath}-shm`, { force: true }),
    rm(`${temporaryPath}-wal`, { force: true }),
  ]);
}

function assertDistinctPaths(sourcePath: string, destinationPath: string): void {
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    throw new Error('conversation_database_source_equals_destination');
  }
}

function assertDestinationDoesNotExist(destinationPath: string): void {
  if (existsSync(destinationPath)) {
    throw new Error(`conversation_database_destination_exists:${destinationPath}`);
  }
}

function deriveBackupKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 32) throw new Error('conversation_backup_passphrase_too_short');
  return scryptSync(passphrase, salt, 32, { maxmem: 64 * 1024 * 1024 });
}

async function readBounded(pathname: string): Promise<Buffer> {
  const metadata = await stat(pathname);
  if (metadata.size > MAX_BACKUP_BYTES) throw new Error('conversation_backup_too_large');
  return readFile(pathname);
}

async function encryptDatabaseFile(
  sourcePath: string,
  destinationPath: string,
  passphrase: string
): Promise<void> {
  assertDistinctPaths(sourcePath, destinationPath);
  assertDestinationDoesNotExist(destinationPath);
  const plaintext = await readBounded(sourcePath);
  const salt = randomBytes(BACKUP_SALT_BYTES);
  const iv = randomBytes(BACKUP_IV_BYTES);
  const header = Buffer.concat([ENCRYPTED_BACKUP_MAGIC, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', deriveBackupKey(passphrase, salt), iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = temporarySibling(destinationPath);
  try {
    await writeFile(temporaryPath, payload, { flag: 'wx', mode: 0o600 });
    await link(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function decryptDatabaseFile(
  sourcePath: string,
  destinationPath: string,
  passphrase: string
): Promise<void> {
  assertDistinctPaths(sourcePath, destinationPath);
  assertDestinationDoesNotExist(destinationPath);
  const payload = await readBounded(sourcePath);
  const headerBytes = ENCRYPTED_BACKUP_MAGIC.length + BACKUP_SALT_BYTES + BACKUP_IV_BYTES;
  if (payload.length <= headerBytes + BACKUP_TAG_BYTES) {
    throw new Error('conversation_backup_encrypted_payload_invalid');
  }
  if (!payload.subarray(0, ENCRYPTED_BACKUP_MAGIC.length).equals(ENCRYPTED_BACKUP_MAGIC)) {
    throw new Error('conversation_backup_encrypted_magic_invalid');
  }
  const saltStart = ENCRYPTED_BACKUP_MAGIC.length;
  const ivStart = saltStart + BACKUP_SALT_BYTES;
  const cipherStart = ivStart + BACKUP_IV_BYTES;
  const tagStart = payload.length - BACKUP_TAG_BYTES;
  const header = payload.subarray(0, cipherStart);
  const salt = payload.subarray(saltStart, ivStart);
  const iv = payload.subarray(ivStart, cipherStart);
  const decipher = createDecipheriv('aes-256-gcm', deriveBackupKey(passphrase, salt), iv);
  decipher.setAAD(header);
  decipher.setAuthTag(payload.subarray(tagStart));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(payload.subarray(cipherStart, tagStart)), decipher.final()]);
  } catch {
    throw new Error('conversation_backup_decryption_failed');
  }
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, plaintext, { flag: 'wx', mode: 0o600 });
}

export async function encryptBackupFile(
  sourcePath: string,
  destinationPath: string,
  passphrase: string
): Promise<void> {
  await encryptDatabaseFile(sourcePath, destinationPath, passphrase);
}

export async function decryptBackupFile(
  sourcePath: string,
  destinationPath: string,
  passphrase: string
): Promise<void> {
  await decryptDatabaseFile(sourcePath, destinationPath, passphrase);
}

function verifyConversationDatabaseFile(
  databasePath: string,
  cleanupNewSidecars: boolean
): ConversationDatabaseVerification {
  const sidecars = [`${databasePath}-shm`, `${databasePath}-wal`];
  const existingSidecars = new Set(sidecars.filter((candidate) => existsSync(candidate)));
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const checks = db.pragma('quick_check') as Array<{ quick_check: string }>;
    if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') {
      throw new Error(`conversation_database_integrity_failed:${JSON.stringify(checks)}`);
    }

    const tableExists = (table: string): boolean =>
      Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      );
    const schemaVersion = Number(db.pragma('user_version', { simple: true }));
    const requiredTables = ['conversation_threads', 'conversation_messages'];
    if (schemaVersion >= 2) requiredTables.push('users', 'auth_sessions');
    if (schemaVersion >= 4)
      requiredTables.push(
        'households',
        'household_memberships',
        'integration_connections',
        'resource_grants',
        'audit_events'
      );
    if (schemaVersion >= 6) requiredTables.push('admin_idempotency_keys');
    if (schemaVersion >= 7) requiredTables.push('integration_credentials', 'oauth_transactions');
    for (const table of requiredTables) {
      if (!tableExists(table)) throw new Error(`conversation_database_missing_table:${table}`);
    }
    if (schemaVersion >= 6) {
      const requiredColumns: Record<string, string[]> = {
        integration_connections: ['last_sync_at_ms', 'last_error_code', 'revoked_at_ms'],
        resource_grants: ['revoked_at_ms'],
      };
      for (const [table, columns] of Object.entries(requiredColumns)) {
        const available = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name
          )
        );
        for (const column of columns) {
          if (!available.has(column))
            throw new Error(`conversation_database_missing_column:${table}.${column}`);
        }
      }
    }
    if (schemaVersion >= 7) {
      const available = new Set(
        (db.prepare('PRAGMA table_info(integration_connections)').all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      );
      for (const column of ['connection_kind', 'display_name', 'provider_subject', 'provider_email']) {
        if (!available.has(column)) {
          throw new Error(`conversation_database_missing_column:integration_connections.${column}`);
        }
      }
    }

    const threadCount = db.prepare('SELECT COUNT(*) AS count FROM conversation_threads').get() as {
      count: number;
    };
    const messageCount = db
      .prepare('SELECT COUNT(*) AS count FROM conversation_messages')
      .get() as {
      count: number;
    };
    const userCount = tableExists('users')
      ? (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
      : { count: 0 };
    const threadColumns = db.prepare('PRAGMA table_info(conversation_threads)').all() as Array<{
      name: string;
    }>;
    const hasUserOwner = threadColumns.some((column) => column.name === 'owner_user_id');
    const hasServiceOwner = threadColumns.some((column) => column.name === 'owner_service_id');
    const userOwnerExpression = hasUserOwner ? 'owner_user_id IS NOT NULL' : '0';
    const serviceOwnerExpression = hasServiceOwner ? 'owner_service_id IS NOT NULL' : '0';
    const unownedExpression = [
      hasUserOwner ? 'owner_user_id IS NULL' : '1',
      hasServiceOwner ? 'owner_service_id IS NULL' : '1',
    ].join(' AND ');
    const ownershipCounts = db
      .prepare(
        `SELECT
      SUM(CASE WHEN ${userOwnerExpression} THEN 1 ELSE 0 END) AS user_owned,
      SUM(CASE WHEN ${serviceOwnerExpression} THEN 1 ELSE 0 END) AS service_owned,
      SUM(CASE WHEN ${unownedExpression} THEN 1 ELSE 0 END) AS unowned
      FROM conversation_threads`
      )
      .get() as { user_owned: number | null; service_owned: number | null; unowned: number | null };
    const auditEventCount = tableExists('audit_events')
      ? (db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number })
      : { count: 0 };
    const integrationConnectionCount = tableExists('integration_connections')
      ? (db.prepare('SELECT COUNT(*) AS count FROM integration_connections').get() as {
          count: number;
        })
      : { count: 0 };
    const resourceGrantCount = tableExists('resource_grants')
      ? (db.prepare('SELECT COUNT(*) AS count FROM resource_grants').get() as { count: number })
      : { count: 0 };
    const adminIdempotencyKeyCount = tableExists('admin_idempotency_keys')
      ? (db.prepare('SELECT COUNT(*) AS count FROM admin_idempotency_keys').get() as {
          count: number;
        })
      : { count: 0 };
    const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyErrors.length > 0) {
      throw new Error(`conversation_database_foreign_key_failed:${foreignKeyErrors.length}`);
    }
    return {
      path: path.resolve(databasePath),
      schemaVersion,
      threadCount: Number(threadCount.count),
      messageCount: Number(messageCount.count),
      userCount: Number(userCount.count),
      ownedThreadCount: Number(ownershipCounts.user_owned ?? 0),
      serviceOwnedThreadCount: Number(ownershipCounts.service_owned ?? 0),
      unownedThreadCount: Number(ownershipCounts.unowned ?? 0),
      auditEventCount: Number(auditEventCount.count),
      integrationConnectionCount: Number(integrationConnectionCount.count),
      resourceGrantCount: Number(resourceGrantCount.count),
      adminIdempotencyKeyCount: Number(adminIdempotencyKeyCount.count),
    };
  } finally {
    db.close();
    if (cleanupNewSidecars) {
      for (const sidecar of sidecars) {
        if (!existingSidecars.has(sidecar)) rmSync(sidecar, { force: true });
      }
    }
  }
}

export function verifyConversationDatabase(databasePath: string): ConversationDatabaseVerification {
  return verifyConversationDatabaseFile(databasePath, false);
}

export async function backupConversationDatabase(
  sourcePath: string,
  destinationPath: string
): Promise<ConversationDatabaseVerification> {
  assertDistinctPaths(sourcePath, destinationPath);
  assertDestinationDoesNotExist(destinationPath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = temporarySibling(destinationPath);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });

  try {
    await source.backup(temporaryPath);
    const verification = verifyConversationDatabaseFile(temporaryPath, true);
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, destinationPath);
    return { ...verification, path: path.resolve(destinationPath) };
  } finally {
    source.close();
    await removeTemporaryDatabase(temporaryPath);
  }
}

export async function restoreConversationDatabase(
  backupPath: string,
  destinationPath: string
): Promise<ConversationDatabaseVerification> {
  assertDistinctPaths(backupPath, destinationPath);
  verifyConversationDatabaseFile(backupPath, true);
  assertDestinationDoesNotExist(destinationPath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = temporarySibling(destinationPath);

  try {
    await copyFile(backupPath, temporaryPath, constants.COPYFILE_EXCL);
    const verification = verifyConversationDatabaseFile(temporaryPath, true);
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, destinationPath);
    return { ...verification, path: path.resolve(destinationPath) };
  } finally {
    await removeTemporaryDatabase(temporaryPath);
  }
}

export async function createEncryptedConversationBackup(
  sourcePath: string,
  destinationPath: string,
  passphrase: string
): Promise<ConversationDatabaseVerification> {
  assertDestinationDoesNotExist(destinationPath);
  const plainBackup = temporarySibling(destinationPath);
  try {
    const verification = await backupConversationDatabase(sourcePath, plainBackup);
    await encryptDatabaseFile(plainBackup, destinationPath, passphrase);
    return { ...verification, path: path.resolve(destinationPath) };
  } finally {
    await removeTemporaryDatabase(plainBackup);
  }
}

export async function restoreEncryptedConversationBackup(
  sourcePath: string,
  destinationPath: string,
  passphrase: string
): Promise<ConversationDatabaseVerification> {
  assertDestinationDoesNotExist(destinationPath);
  const plainBackup = temporarySibling(destinationPath);
  try {
    await decryptDatabaseFile(sourcePath, plainBackup, passphrase);
    return await restoreConversationDatabase(plainBackup, destinationPath);
  } finally {
    await removeTemporaryDatabase(plainBackup);
  }
}
