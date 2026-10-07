import type { FastifyInstance } from 'fastify';

import { verifyConversationDatabase } from '../conversation/conversationDbBackup';
import type { AppDeps } from '../server';

export function registerHealthRoute(app: FastifyInstance, deps?: AppDeps): void {
  app.get('/ready', async (_request, reply) => {
    if (!deps) return { status: 'ok' };
    try {
      const verification = verifyConversationDatabase(deps.env.CONVERSATION_DB_PATH);
      return { status: 'ready', schemaVersion: verification.schemaVersion };
    } catch {
      return reply.code(503).send({ status: 'not_ready', dependency: 'database' });
    }
  });

  app.get('/health', async () => {
    const timestamp = new Date().toISOString();
    
    // Basic health
    const basic = { status: 'ok', timestamp };
    
    // If no deps, return basic health only
    if (!deps) return basic;

    // Detailed health check
    const spotifyWebApiConfigured = deps.spotifyWebApi.isConfigured();
    
    const homeAssistantStatus = deps.ha
      ? await probeHomeAssistantStatus(deps.ha)
      : 'not_configured';

    const dependencies: Record<string, unknown> = {
      llm: {
        provider: deps.env.LLM_PROVIDER,
        api: 'responses',
        configured: Boolean(deps.env.OPENAI_API_KEY?.trim()),
      },
      voice: {
        sttProvider: 'openai',
        ttsProvider: 'openai',
        configured: Boolean(deps.env.OPENAI_API_KEY?.trim()),
      },
      planner: {
        status: 'ok',
        mode: 'semantic_router',
      },
      homeassistant: { status: homeAssistantStatus },
      spotifyWebApi: spotifyWebApiConfigured
        ? { status: 'configured', hasToken: true }
        : { status: 'not_configured' },
    };

    return {
      status: 'ok',
      timestamp,
      dependencies,
    };
  });
}

/**
 * The health endpoint must always remain responsive.  The HA client itself
 * aborts its fetch, but a stalled socket/DNS lookup can occasionally fail to
 * settle promptly in Node.  This outer deadline protects the HTTP route.
 */
async function probeHomeAssistantStatus(ha: NonNullable<AppDeps['ha']>): Promise<'ok' | 'unauthorized' | 'unreachable'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ha.probeHealth(),
      new Promise<'unreachable'>((resolve) => {
        timeout = setTimeout(() => resolve('unreachable'), 2_000);
      }),
    ]);
  } catch {
    return 'unreachable';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
