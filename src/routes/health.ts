import type { FastifyInstance } from 'fastify';

import {
  HEALTH_CONTRACT_VERSION,
  HealthDiagnostics,
  type HealthDiagnosticsOptions,
} from '../health/healthDiagnostics';
import type { AppDeps } from '../server';

export function registerHealthRoute(
  app: FastifyInstance,
  deps?: AppDeps,
  options: HealthDiagnosticsOptions = {}
): void {
  const healthDiagnostics = deps ? new HealthDiagnostics(deps, options) : undefined;

  app.get('/live', async () => ({
    status: 'healthy',
    contractVersion: HEALTH_CONTRACT_VERSION,
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    if (!deps) return { status: 'ok' };
    const database = await healthDiagnostics!.getReadiness();
    if (database.status === 'healthy') {
      return {
        status: 'ready',
        schemaVersion: database.schemaVersion,
        contractVersion: HEALTH_CONTRACT_VERSION,
        readiness: { status: 'healthy' },
        dependencies: { conversationDatabase: database },
      };
    }
    return reply.code(503).send({
      status: 'not_ready',
      dependency: 'database',
      contractVersion: HEALTH_CONTRACT_VERSION,
      readiness: { status: 'unavailable' },
      dependencies: { conversationDatabase: database },
    });
  });

  app.get('/health', async () => {
    const timestamp = new Date().toISOString();
    
    // Basic health
    const basic = { status: 'ok', timestamp };
    
    // If no deps, return basic health only
    if (!deps) return basic;

    const snapshot = await healthDiagnostics!.getSnapshot();

    // Legacy fields remain stable for Desktop, Android and deployment scripts.
    const spotifyWebApiConfigured = deps.spotifyWebApi.isConfigured();

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
      homeassistant: { status: snapshot.legacyHomeAssistantStatus },
      spotifyWebApi: spotifyWebApiConfigured
        ? { status: 'configured', hasToken: true }
        : { status: 'not_configured' },
    };

    return {
      status: 'ok',
      timestamp,
      contractVersion: HEALTH_CONTRACT_VERSION,
      dependencies,
      diagnostics: snapshot.diagnostics,
    };
  });
}
