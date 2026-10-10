import { createConversationDb } from '../conversation/repositories/SqliteRepositories';
import type { Env } from '../env';

/** Run additive SQLite migrations before accepting traffic. */
export function initializeRuntime(env: Env): void {
  const database = createConversationDb(env.CONVERSATION_DB_PATH);
  database.close();
}
