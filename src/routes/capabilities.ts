import type { FastifyInstance } from 'fastify';

import { getVm400Capabilities } from '../capabilities';
import { getRequestPrincipal } from '../identity/requestIdentity';
import type { AppDeps } from '../server';
import { canUseLivePilot } from '../voice/live/LiveAccessPolicy';

export function registerCapabilitiesRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/capabilities', async (request) => {
    const liveAvailability = deps.liveVoice?.sessions.availability();
    const pilotEligible = canUseLivePilot(
      getRequestPrincipal(request),
      deps.env.OPENAI_LIVE_PILOT_OWNER_ONLY
    );
    const desktopEnabled = deps.env.OPENAI_LIVE_DESKTOP_ENABLED && pilotEligible;
    const androidEnabled = deps.env.OPENAI_LIVE_ANDROID_ENABLED && pilotEligible;
    const anyLiveClientEnabled =
      desktopEnabled ||
      androidEnabled ||
      deps.env.OPENAI_LIVE_HA_TTS_ENABLED;
    const pilotRestricted =
      !pilotEligible &&
      (deps.env.OPENAI_LIVE_DESKTOP_ENABLED || deps.env.OPENAI_LIVE_ANDROID_ENABLED) &&
      !deps.env.OPENAI_LIVE_HA_TTS_ENABLED;
    const caps = getVm400Capabilities({
      haConfigured: Boolean(deps.ha),
      spotifyWebApiConfigured: deps.spotifyWebApi.isConfigured(),
      requireApiKey: deps.env.REQUIRE_API_KEY,
      live: {
        available: Boolean(liveAvailability?.available && anyLiveClientEnabled),
        ...(liveAvailability?.reason
          ? { reason: liveAvailability.reason }
          : pilotRestricted
            ? { reason: 'pilot_restricted' }
          : !anyLiveClientEnabled
            ? { reason: 'client_disabled' }
            : {}),
        enabled: deps.env.OPENAI_LIVE_ENABLED,
        pilotOwnerOnly: deps.env.OPENAI_LIVE_PILOT_OWNER_ONLY,
        desktopEnabled,
        androidEnabled,
        homeAssistantTtsEnabled: deps.env.OPENAI_LIVE_HA_TTS_ENABLED,
        voice: deps.env.OPENAI_LIVE_VOICE,
        idleTimeoutMs: deps.env.OPENAI_LIVE_IDLE_TIMEOUT_MS,
        delegationTimeoutMs: deps.env.OPENAI_LIVE_DELEGATION_TIMEOUT_MS,
      },
    });

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...caps,
    };
  });
}

