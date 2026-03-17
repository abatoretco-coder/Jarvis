import { z } from 'zod';

import type { Env } from '../env';
import type { SpotifyWebApiClient } from '../spotifyWebApi';
import { SPOTIFY_CAPABILITIES } from './capabilityRegistry';
import { buildMusicAgentSystemPrompt } from './prompts/musicAgentSystemPrompt';
import { buildMusicAgentUserTemplate } from './prompts/musicAgentUserTemplate';
import { spotifyActionSchema } from './contracts';

type MusicAgentPlan = {
  route: 'spotify' | 'none';
  reason: string;
  request?: {
    domain: 'spotify';
    action: z.infer<typeof spotifyActionSchema>;
    slots: Record<string, unknown>;
    understanding?: { entities?: Record<string, unknown> };
    text?: string;
  };
};

const plannedSpotifyRequestSchema = z.object({
  domain: z.literal('spotify'),
  action: spotifyActionSchema,
  slots: z.record(z.unknown()).default({}),
  context: z.record(z.unknown()).default({}),
  understanding: z.object({ entities: z.record(z.unknown()).optional() }).optional(),
  text: z.string().optional(),
});

const plannerResponseSchema = z.object({
  route: z.enum(['spotify', 'none']),
  reason: z.string().min(1).default('planner_reason_missing'),
  request: z.object({
    domain: z.literal('spotify'),
    action: spotifyActionSchema,
    slots: z.record(z.unknown()).default({}),
    understanding: z
      .object({
        entities: z.record(z.unknown()).optional(),
      })
      .optional(),
    text: z.string().optional(),
  }).optional(),
});

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('music_agent_invalid_json');
  }
}

function buildActionCatalog(): string {
  return SPOTIFY_CAPABILITIES.map((cap) => {
    const lines = [`ACTION: ${cap.action} — ${cap.description}`];
    if (cap.required.length > 0) {
      lines.push(`  REQUIS    : ${cap.required.join(' | ')}`);
    }
    if (cap.optional.length > 0) {
      lines.push(`  OPTIONNEL : ${cap.optional.join(', ')}`);
    }
    const nonDeviceForbidden = cap.forbidden.filter((f) => f !== 'slots.device');
    if (nonDeviceForbidden.length > 0) {
      lines.push(`  INTERDIT  : ${nonDeviceForbidden.join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

async function requestPlannerCandidate(input: {
  env: Env;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  variant: 'primary' | 'strict';
}): Promise<z.infer<typeof plannerResponseSchema>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.env.OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(`${input.env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.env.OPENAI_MODEL_MUSIC_AGENT,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`music_agent_provider_error:${input.variant}:${response.status}:${raw.slice(0, 500)}`);
    }

    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const choices =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { choices?: unknown[] }).choices)
        ? ((parsed as { choices: Array<{ message?: { content?: string } }> }).choices ?? [])
        : [];
    const content = choices[0]?.message?.content ?? '';
    const candidateJson = parseJsonObject(content);
    return plannerResponseSchema.parse(candidateJson);
  } finally {
    clearTimeout(timeout);
  }
}

function extractNowPlayingSummary(data: Record<string, unknown>): {
  is_playing: boolean;
  device: { name?: string; volume_percent?: number };
  item: { name?: string; artists: string[] };
} {
  const item = data.item && typeof data.item === 'object' && !Array.isArray(data.item)
    ? (data.item as Record<string, unknown>)
    : undefined;
  const device = data.device && typeof data.device === 'object' && !Array.isArray(data.device)
    ? (data.device as Record<string, unknown>)
    : undefined;

  const artistsRaw = Array.isArray(item?.artists) ? item.artists : [];
  const artists = (artistsRaw as unknown[])
    .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>) : undefined))
    .map((a) => (typeof a?.name === 'string' ? a.name : ''))
    .filter((n) => n.length > 0);

  return {
    is_playing: data.is_playing === true,
    device: {
      name: typeof device?.name === 'string' ? device.name : undefined,
      volume_percent: typeof device?.volume_percent === 'number' ? device.volume_percent : undefined,
    },
    item: {
      name: typeof item?.name === 'string' ? item.name : undefined,
      artists,
    },
  };
}

async function buildMusicSituation(spotifyWebApi: SpotifyWebApiClient, env: Env): Promise<string> {
  const [devices, nowPlaying] = await Promise.all([
    spotifyWebApi.listDevicesPublic(),
    spotifyWebApi.getNowPlaying(),
  ]);

  const aliases = {
    pc: (env.SPOTIFY_WEBAPI_DEVICE_ALIAS_COMPUTER_NAME ?? 'JARVIS').trim(),
    salon: (env.SPOTIFY_WEBAPI_DEVICE_ALIAS_SALON_NAME ?? 'Salon').trim(),
    phone: (env.SPOTIFY_WEBAPI_DEVICE_ALIAS_PHONE_NAME ?? 'phone').trim(),
  };

  const lines: string[] = [];

  lines.push(`Appareils Spotify disponibles (aliases: pc="${aliases.pc}", salon="${aliases.salon}", phone="${aliases.phone}"):`);
  if (devices.ok && devices.devices.length > 0) {
    for (const d of devices.devices) {
      lines.push(`  - ${d.name} (${d.type})${d.isActive ? ' [ACTIF]' : ''}`);
    }
  } else {
    lines.push('  - aucun appareil disponible');
  }

  if (nowPlaying.ok) {
    const s = extractNowPlayingSummary(nowPlaying.data);
    const artists = s.item.artists.join(', ');
    const title = s.item.name ?? 'inconnu';
    const state = s.is_playing ? 'en lecture' : 'en pause';
    const activeDevice = devices.ok ? devices.devices.find((d) => d.isActive) : undefined;
    const deviceName = s.device.name ?? activeDevice?.name ?? 'inconnu';
    const vol = s.device.volume_percent !== undefined ? ` (volume ${s.device.volume_percent}%)` : '';
    lines.push(`Lecture actuelle ${state} sur "${deviceName}"${vol}: "${title}"${artists ? ` par ${artists}` : ''}.`);
  } else {
    lines.push('Aucune lecture Spotify active en ce moment.');
  }

  return lines.join('\n');
}

export async function planSpotifyActionFromTextWithOpenAi(input: {
  env: Env;
  spotifyWebApi: SpotifyWebApiClient;
  text: string;
  correlationId?: string;
  userId?: string;
}): Promise<MusicAgentPlan> {
  const apiKey = input.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { route: 'none', reason: 'openai_api_key_missing' };
  }

  const situation = await buildMusicSituation(input.spotifyWebApi, input.env);
  const actionCatalog = buildActionCatalog();
  const systemPrompt = buildMusicAgentSystemPrompt(actionCatalog);
  const userPrompt = buildMusicAgentUserTemplate({
    userText: input.text,
    musicSituation: situation,
    metadataJson: compactJson({ correlation_id: input.correlationId ?? null, user_id: input.userId ?? null }),
  });

  const strictUserPrompt = `${userPrompt}\nreason doit être non vide.`;

  const plan = await requestPlannerCandidate({
    env: input.env,
    apiKey,
    systemPrompt,
    userPrompt: strictUserPrompt,
    variant: 'primary',
  }).catch((err: unknown) => {
    if (err instanceof Error) throw err;
    throw new Error('music_agent_planning_failed');
  });

  if (plan.route === 'none') {
    return { route: 'none', reason: plan.reason };
  }

  if (!plan.request) {
    return { route: 'none', reason: 'music_agent_missing_request' };
  }

  const normalizedRequest = plannedSpotifyRequestSchema.parse({
    ...plan.request,
    slots: plan.request.slots ?? {},
    context: {
      planner: 'openai_music_agent',
      payload_version: 'music-agent-v1',
    },
  });

  return {
    route: 'spotify',
    reason: plan.reason,
    request: normalizedRequest,
  };
}

type SearchCandidate = {
  type: string;
  name: string;
  artists_string?: string;
  uri?: string;
};

/** Asks OpenAI to pick the best candidate from a Spotify search result list.
 *  Returns the 0-based index of the best match.
 *  Throws on OpenAI/config/response errors to avoid silent bad matches. */
export async function selectBestSpotifyResult(input: {
  env: Env;
  userText: string;
  query: string;
  candidates: Array<SearchCandidate | Record<string, unknown>>;
}): Promise<number> {
  const { env, userText, query, candidates } = input;

  if (!candidates.length) return 0;
  if (candidates.length === 1) return 0;

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('openai_api_key_missing');
  }

  const list = candidates
    .map((c, i) => {
      const name = typeof (c as SearchCandidate).name === 'string' ? (c as SearchCandidate).name : String(c.name ?? '');
      const type = typeof (c as SearchCandidate).type === 'string' ? (c as SearchCandidate).type : String(c.type ?? '');
      const sub = typeof (c as SearchCandidate).artists_string === 'string' ? ` — ${(c as SearchCandidate).artists_string}` : '';
      return `${i}: [${type}] "${name}"${sub}`;
    })
    .join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL_MUSIC_AGENT,
        temperature: 0,
        response_format: { type: 'json_object' },
        max_tokens: 20,
        messages: [
          { role: 'system', content: 'Sélectionne le meilleur résultat Spotify. Réponds uniquement {"index":N}.' },
          { role: 'user', content: `Commande: "${userText}"\nRecherche: "${query}"\nCandidats:\n${list}` },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`openai_selection_failed:${response.status}:${raw.slice(0, 500)}`);
    }

    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const choices = Array.isArray((parsed as { choices?: unknown[] }).choices)
      ? (parsed as { choices: Array<{ message?: { content?: string } }> }).choices
      : [];
    const content = choices[0]?.message?.content ?? '';
    const data = parseJsonObject(content);

    if (!data || typeof data !== 'object') {
      throw new Error('openai_selection_invalid_response');
    }
    const idx = (data as { index?: unknown }).index;
    if (typeof idx !== 'number' || !Number.isFinite(idx)) {
      throw new Error('openai_selection_invalid_index');
    }
    return Math.min(Math.max(0, Math.round(idx)), candidates.length - 1);
  } catch (err: unknown) {
    if (err instanceof Error) throw err;
    throw new Error('openai_selection_failed_unknown');
  } finally {
    clearTimeout(timeout);
  }
}
