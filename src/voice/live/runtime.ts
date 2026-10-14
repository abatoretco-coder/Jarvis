import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';

import { SqliteMessageRepository, SqliteThreadRepository } from '../../conversation/repositories/SqliteRepositories';
import type { Env } from '../../env';
import { LiveContextAdapter } from './LiveContextAdapter';
import { LiveDelegationCoordinator } from './LiveDelegationCoordinator';
import { LiveEventValidator } from './LiveEventValidator';
import { LiveFallbackCoordinator } from './LiveFallbackCoordinator';
import { LiveSessionRegistry } from './LiveSessionRegistry';
import { type LiveProviderTransport,LiveSessionService } from './LiveSessionService';
import { LiveTtsAdapter } from './LiveTtsAdapter';

export type LiveVoiceRuntime = {
  sessions: LiveSessionService;
  registry: LiveSessionRegistry;
  delegations: LiveDelegationCoordinator;
  fallback: LiveFallbackCoordinator;
  tts: LiveTtsAdapter;
};

export function createLiveVoiceRuntime(input: {
  env: Env;
  db: Database.Database;
  log: FastifyBaseLogger;
  transport?: LiveProviderTransport;
}): LiveVoiceRuntime {
  const registry = new LiveSessionRegistry(input.db);
  const delegations = new LiveDelegationCoordinator(
    registry,
    input.env.OPENAI_LIVE_MAX_DELEGATIONS_PER_SESSION
  );
  const context = new LiveContextAdapter(
    new SqliteThreadRepository(input.db),
    new SqliteMessageRepository(input.db)
  );
  const sessions = new LiveSessionService(
    input.env,
    registry,
    delegations,
    context,
    new LiveEventValidator(input.env.OPENAI_LIVE_MAX_EVENT_BYTES),
    input.log,
    input.transport
  );
  return {
    sessions,
    registry,
    delegations,
    fallback: new LiveFallbackCoordinator(),
    tts: new LiveTtsAdapter(),
  };
}
