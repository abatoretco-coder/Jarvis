import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { verifyConversationDatabase } from '../src/conversation/conversationDbBackup';
import { loadEnv } from '../src/env';
import { initializeRuntime } from '../src/runtime/initializeRuntime';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('runtime initialization', () => {
  test('creates and migrates the persistent database before listening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-runtime-init-'));
    directories.push(directory);
    const databasePath = join(directory, 'data', 'conversation.sqlite');
    const env = loadEnv({ REQUIRE_API_KEY: 'false', CONVERSATION_DB_PATH: databasePath });

    initializeRuntime(env);

    expect(existsSync(databasePath)).toBe(true);
    expect(verifyConversationDatabase(databasePath).schemaVersion).toBeGreaterThan(0);
  });
});
