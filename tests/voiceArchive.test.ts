import Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';

import { runConversationMigrations } from '../src/conversation/repositories/conversationMigrations';
import { runWithRequestIdentityContext, setRequestPrincipal } from '../src/identity/requestIdentity';
import { VoiceArchiveRepository } from '../src/voice/VoiceArchiveRepository';
import { VoiceArchiveService } from '../src/voice/VoiceArchiveService';

describe('VoiceArchiveService', () => {
  let db: Database.Database;
  let repository: VoiceArchiveRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runConversationMigrations(db);
    repository = new VoiceArchiveRepository(db);
    db.prepare(`INSERT INTO conversation_threads(
      thread_id,created_at_ms,updated_at_ms
    ) VALUES (?,?,?)`).run('thread-voice', 1, 1);
  });

  afterEach(() => db.close());

  const asHomeAssistant = async (work: () => Promise<void>): Promise<void> =>
    runWithRequestIdentityContext(async () => {
      setRequestPrincipal({} as FastifyRequest, {
        kind: 'service',
        serviceId: 'home-assistant-pc',
        permissions: ['chat'],
      });
      await work();
    });

  test('stores one MP3 artifact per direction and links both sides to the conversation', async () => {
    const encodeMp3 = jest.fn(async () => Buffer.from('encoded-mp3'));
    const service = new VoiceArchiveService(repository, {
      enabled: true,
      retentionDays: 0,
      maxAudioBytes: 1024,
      logger: { warn: jest.fn() },
      encodeMp3,
    });
    const voiceTurnId = 'ha-turn-0123456789abcdef0123456789abcdef';

    await asHomeAssistant(async () => {
      service.archive({
      voiceTurnId,
      direction: 'input',
      audio: Buffer.from('wav-input'),
      contentType: 'audio/wav',
      transcript: 'Allume le salon',
      engineId: 'openai:test-stt',
      latencyMs: 320,
      });
      expect(service.linkTurn(voiceTurnId, 'thread-voice')).toBeUndefined();
      await service.close();

      service.archive({
      voiceTurnId,
      direction: 'output',
      audio: Buffer.from('wav-output'),
      contentType: 'audio/wav',
      transcript: "C'est fait.",
      engineId: 'openai:test-tts',
      latencyMs: 410,
      });
      await service.close();
    });

    expect(repository.find(voiceTurnId, 'input')).toMatchObject({
      threadId: 'thread-voice',
      transcript: 'Allume le salon',
      mp3Audio: Buffer.from('encoded-mp3'),
    });
    expect(repository.find(voiceTurnId, 'output')).toMatchObject({
      threadId: 'thread-voice',
      transcript: "C'est fait.",
      mp3Audio: Buffer.from('encoded-mp3'),
    });
    expect(encodeMp3).toHaveBeenCalledTimes(2);
  });

  test('is idempotent for retries and rejects non-Home-Assistant turn identifiers', async () => {
    const encodeMp3 = jest.fn(async (audio: Buffer) => Buffer.from(audio));
    const logger = { warn: jest.fn() };
    const service = new VoiceArchiveService(repository, {
      enabled: true,
      retentionDays: 0,
      maxAudioBytes: 1024,
      logger,
      encodeMp3,
    });
    const voiceTurnId = 'ha-turn-fedcba9876543210fedcba9876543210';
    await asHomeAssistant(async () => {
      service.archive({ voiceTurnId, direction: 'input', audio: Buffer.from('first'), contentType: 'audio/mpeg' });
      await service.close();
      service.archive({ voiceTurnId, direction: 'input', audio: Buffer.from('retry'), contentType: 'audio/mpeg' });
      service.archive({ voiceTurnId: 'desktop-turn', direction: 'input', audio: Buffer.from('ignored'), contentType: 'audio/mpeg' });
      await service.close();
    });

    expect(repository.find(voiceTurnId, 'input')?.mp3Audio).toEqual(Buffer.from('retry'));
    const count = db.prepare('SELECT COUNT(*) count FROM voice_artifacts').get() as { count: number };
    expect(count.count).toBe(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('keeps artifacts when retention is configured as unlimited', async () => {
    repository.save({
      voiceTurnId: 'ha-turn-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      direction: 'input',
      sourceContentType: 'audio/mpeg',
      sourceByteLength: 3,
      mp3Audio: Buffer.from('mp3'),
      createdAtMs: 1,
    });
    const service = new VoiceArchiveService(repository, {
      enabled: true,
      retentionDays: 0,
      maxAudioBytes: 1024,
      logger: { warn: jest.fn() },
    });
    expect(service.cleanup(Date.now())).toBe(0);
    expect(repository.find('ha-turn-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'input')).not.toBeNull();
  });

  test('does not archive a forged Home Assistant turn from a human session', async () => {
    const service = new VoiceArchiveService(repository, {
      enabled: true,
      retentionDays: 0,
      maxAudioBytes: 1024,
      logger: { warn: jest.fn() },
      encodeMp3: async (audio) => audio,
    });
    const voiceTurnId = 'ha-turn-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await runWithRequestIdentityContext(async () => {
      setRequestPrincipal({} as FastifyRequest, {
        kind: 'user',
        userId: '00000000-0000-4000-8000-000000000001',
        email: 'owner@example.test',
        displayName: 'Owner',
        status: 'active',
        roles: ['owner'],
        permissions: ['chat'],
        sessionId: 'session-owner',
      });
      service.archive({
        voiceTurnId,
        direction: 'input',
        audio: Buffer.from('forged'),
        contentType: 'audio/mpeg',
      });
      await service.close();
    });
    expect(repository.find(voiceTurnId, 'input')).toBeNull();
  });
});
