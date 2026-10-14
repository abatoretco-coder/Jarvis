import type { FastifyInstance } from 'fastify';

import { getVm400Capabilities } from '../capabilities';
import type { AppDeps } from '../server';

export function registerCapabilitiesRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/capabilities', async () => {
    const liveAvailability = deps.liveVoice?.sessions.availability();
    const anyLiveClientEnabled =
      deps.env.OPENAI_LIVE_DESKTOP_ENABLED ||
      deps.env.OPENAI_LIVE_ANDROID_ENABLED ||
      deps.env.OPENAI_LIVE_HA_TTS_ENABLED;
    const caps = getVm400Capabilities({
      haConfigured: Boolean(deps.ha),
      spotifyWebApiConfigured: deps.spotifyWebApi.isConfigured(),
      requireApiKey: deps.env.REQUIRE_API_KEY,
      live: {
        available: Boolean(liveAvailability?.available && anyLiveClientEnabled),
        ...(liveAvailability?.reason
          ? { reason: liveAvailability.reason }
          : !anyLiveClientEnabled
            ? { reason: 'client_disabled' }
            : {}),
        enabled: deps.env.OPENAI_LIVE_ENABLED,
        desktopEnabled: deps.env.OPENAI_LIVE_DESKTOP_ENABLED,
        androidEnabled: deps.env.OPENAI_LIVE_ANDROID_ENABLED,
        homeAssistantTtsEnabled: deps.env.OPENAI_LIVE_HA_TTS_ENABLED,
        voice: deps.env.OPENAI_LIVE_VOICE,
        idleTimeoutMs: deps.env.OPENAI_LIVE_IDLE_TIMEOUT_MS,
      },
    });

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...caps,
    };
  });
}

