/**
 * HA Agent Router — LLM-based orchestrator (gpt-4o-mini, structured output).
 *
 * Receives the user text + minimal context (summary + 3 recent messages) and
 * returns which HA conversation agent to call, plus a confidence score.
 *
 * Contract:
 *  - Uses structured output (JSON schema) — never free text.
 *  - If the LLM call fails, times out, or returns low confidence → caller falls back to general agent.
 *  - Does NOT transform the user text — routing only.
 */

import { buildOrchestratorSystemPrompt } from './prompts/orchestratorSystemPrompt';
import { buildOrchestratorUserPrompt } from './prompts/orchestratorUserTemplate';
import type { MessageRecord } from './repositories/MessageRepository';

type MinLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export type AgentRouteEntry = {
  /** HA conversation entity_id, e.g. "conversation.jarvis_search", or SPOTIFY_AGENT_ID */
  agentId: string;
  /** One-line hint used in the router prompt */
  hint: string;
  /** Routing key from HA_AGENT_MAP — e.g. "search", "executors" (human label only) */
  key?: string;
  /** Stable semantic identifier exposed to the model, distinct from an HA entity id. */
  routerId?: string;
};

/**
 * Special sentinel agentId returned by the router when the request should be
 * handled by the Spotify executor (not an HA conversation entity).
 */
export const SPOTIFY_AGENT_ID = 'spotify' as const;
/** Explicit model-facing destination for ordinary conversation. */
export const GENERAL_ROUTER_AGENT_ID = 'general' as const;
/** Model-facing name for the HA executor; avoids the misleading `conversation.*` entity id. */
export const HOME_CONTROL_ROUTER_AGENT_ID = 'home_control' as const;
/** Model-facing name for the local HA weather source (never external cities). */
export const LOCAL_WEATHER_ROUTER_AGENT_ID = 'weather_local' as const;

export type RouterTarget = {
  agentId: string;
  confidence: number;
  /** Spotify only: action to execute directly (skip music planner) */
  action?: string;
  /** Spotify only: action slots (device, query, etc.) */
  slots?: Record<string, unknown>;
};

export type RouterResult = {
  targets: RouterTarget[];
  reason: string;
  provider?: 'ollama' | 'openai';
  model?: string;
  latencyMs?: number;
  fallbackReason?: string;
};

export type RouterOptions = {
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
  generalAgentId: string;
  provider?: 'ollama' | 'openai';
  fallback?: {
    openAiApiKey: string;
    openAiBaseUrl: string;
    model: string;
    timeoutMs: number;
  };
  log?: MinLogger;
};

// System prompt loaded from conversation/prompts/orchestratorSystemPrompt.json
const SYSTEM_PROMPT = buildOrchestratorSystemPrompt();



export async function routeUserRequest(params: {
  text: string;
  agents: AgentRouteEntry[];
  summary?: string;
  recentMessages: MessageRecord[];
  options: RouterOptions;
}): Promise<RouterResult> {
  const { options } = params;
  const log = options.log;
  const primaryProvider = options.provider ?? 'openai';

  try {
    return await routeWithProvider(params, {
      provider: primaryProvider,
      openAiApiKey: options.openAiApiKey,
      openAiBaseUrl: options.openAiBaseUrl,
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (!options.fallback || primaryProvider !== 'ollama') throw error;
    const fallbackReason = normalizeFallbackReason(error);
    log?.warn({ fallback_reason: fallbackReason, err: error }, 'ha_agent_router_local_fallback_openai');
    const result = await routeWithProvider(params, { provider: 'openai', ...options.fallback });
    return { ...result, fallbackReason };
  }
}

type ProviderRequest = {
  provider: 'ollama' | 'openai';
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  timeoutMs: number;
};

/**
 * Ollama can constrain output against a JSON Schema through its OpenAI
 * compatibility endpoint.  This is stricter than JSON mode and prevents a
 * local model from inventing an unavailable agent identifier.
 */
export function buildOrchestratorResponseFormat(
  provider: 'ollama' | 'openai',
  routerIds: string[],
): Record<string, unknown> {
  if (provider !== 'ollama') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: { name: 'jarvis_orchestrator_route', strict: true, schema: buildOrchestratorJsonSchema(routerIds) },
  };
}

function buildOrchestratorJsonSchema(routerIds: string[]): Record<string, unknown> {
  return {
        type: 'object',
        additionalProperties: false,
        required: ['targets', 'reason'],
        properties: {
          targets: {
            type: 'array',
            minItems: 1,
            maxItems: Math.max(1, routerIds.length),
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['agentId', 'confidence'],
              properties: {
                agentId: { type: 'string', enum: routerIds },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                action: { type: 'string' },
                slots: { type: 'object', additionalProperties: true },
              },
            },
          },
          reason: { type: 'string', minLength: 2, maxLength: 80 },
        },
  };
}

async function routeWithProvider(params: {
  text: string;
  agents: AgentRouteEntry[];
  summary?: string;
  recentMessages: MessageRecord[];
  options: RouterOptions;
}, providerRequest: ProviderRequest): Promise<RouterResult> {
  const { options } = params;
  const log = options.log;
  const t0 = Date.now();

  const routingAgents = withGeneralRoutingAgent(params.agents, options.generalAgentId);
  const routerIdToAgentId = new Map(routingAgents.map((agent) => [agent.routerId ?? agent.agentId, agent.agentId]));

  log?.info(
    { provider: providerRequest.provider, model: providerRequest.model, agents: [...routerIdToAgentId.keys()], timeout_ms: providerRequest.timeoutMs },
    'ha_agent_router_start',
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), providerRequest.timeoutMs);

  try {
    const ollama = providerRequest.provider === 'ollama';
    const endpoint = ollama
      ? `${providerRequest.openAiBaseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/chat`
      : `${providerRequest.openAiBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildOrchestratorUserPrompt({ ...params, agents: routingAgents }) },
    ];
    const response = await fetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${providerRequest.openAiApiKey}`,
        },
        body: JSON.stringify(ollama
          ? {
              model: providerRequest.model,
              messages,
              stream: false,
              think: false,
              format: buildOrchestratorJsonSchema([...routerIdToAgentId.keys()]),
              options: { temperature: 0, top_p: 1, seed: 17, num_predict: 160 },
            }
          : {
              model: providerRequest.model,
              temperature: 0,
              top_p: 1,
              max_tokens: 160,
              response_format: buildOrchestratorResponseFormat('openai', [...routerIdToAgentId.keys()]),
              messages,
            }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      log?.warn({ status: response.status, elapsed_ms: Date.now() - t0 }, 'ha_agent_router_openai_http_error');
      throw new Error(`router_${providerRequest.provider}_http_${response.status}`);
    }

    const raw = await response.json() as Record<string, unknown>;
    const content = ollama
      ? ((raw.message as { content?: string } | undefined)?.content
        ?? (raw.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content
        ?? '')
      : ((raw?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? '');

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      log?.warn({ content: content.slice(0, 200), elapsed_ms: Date.now() - t0 }, 'ha_agent_router_invalid_json');
      throw new Error('router_invalid_json');
    }

    const result = parsed as Record<string, unknown>;
    const rawTargets = Array.isArray(result.targets) ? result.targets : [];
    const reason = typeof result.reason === 'string' ? result.reason.trim() : '';

    const knownIds = new Set(routerIdToAgentId.keys());
    const targets: RouterTarget[] = (rawTargets as unknown[])
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t) => {
        const routerId = typeof t['agentId'] === 'string' ? (t['agentId'] as string).trim() : '';
        const agentId = routerIdToAgentId.get(routerId) ?? '';
        const confidence = typeof t['confidence'] === 'number' ? (t['confidence'] as number) : 0;
        const entry: RouterTarget = { agentId, confidence };
        if (agentId === SPOTIFY_AGENT_ID) {
          if (typeof t['action'] === 'string' && t['action']) {
            entry.action = (t['action'] as string).trim();
          }
          if (typeof t['slots'] === 'object' && t['slots'] !== null && !Array.isArray(t['slots'])) {
            entry.slots = t['slots'] as Record<string, unknown>;
          }
        }
        return entry;
      })
      .filter((t) => t.agentId);

    if (targets.length === 0) {
      log?.warn({ rawTargets, knownIds: [...knownIds], elapsed_ms: Date.now() - t0 }, 'ha_agent_router_no_valid_targets');
      throw new Error('router_no_valid_targets');
    }

    if (!targets.some((target) => target.confidence >= options.confidenceThreshold)) {
      log?.warn({ targets, threshold: options.confidenceThreshold, elapsed_ms: Date.now() - t0 }, 'ha_agent_router_low_confidence');
      throw new Error('router_low_confidence');
    }

    log?.info(
      { targets: targets.map((t) => `${t.agentId}:${t.confidence}`), reason, elapsed_ms: Date.now() - t0 },
      'ha_agent_router_done',
    );
    return { targets, reason, provider: providerRequest.provider, model: providerRequest.model, latencyMs: Date.now() - t0 };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('router_timeout');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function withGeneralRoutingAgent(agents: AgentRouteEntry[], generalAgentId: string): AgentRouteEntry[] {
  if (agents.some((agent) => agent.agentId === generalAgentId)) {
    // Keep the model contract stable even when an operator also puts the
    // general agent in HA_AGENT_MAP.
    return agents.map((agent) => agent.agentId === generalAgentId
      ? { ...agent, routerId: GENERAL_ROUTER_AGENT_ID, key: agent.key ?? GENERAL_ROUTER_AGENT_ID }
      : agent);
  }
  return [
    {
      agentId: generalAgentId,
      routerId: GENERAL_ROUTER_AGENT_ID,
      key: GENERAL_ROUTER_AGENT_ID,
      hint: 'Conversation générale: salutations, discussion, questions générales, vérification du chat, blagues et aide sur Jarvis sans action connectée',
    },
    ...agents,
  ];
}

function normalizeFallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'router_timeout') return 'local_timeout';
  if (message === 'router_invalid_json') return 'local_invalid_json';
  if (message === 'router_no_valid_targets') return 'local_invalid_target';
  if (message === 'router_low_confidence') return 'local_low_confidence';
  if (message.startsWith('router_ollama_http_')) return 'local_http_error';
  return 'local_error';
}

/**
 * Parse HA_AGENT_MAP env var into HaAgentEntry[].
 *
 * Format: "key:entity_id:hint|key2:entity_id2:hint2"
 * Example: "search:conversation.jarvis_search:Recherche internet|assistant:conversation.jarvis_assistant:Domotique et général"
 */
export function parseAgentMap(raw: string | undefined): AgentRouteEntry[] {
  if (!raw?.trim()) return [];
  return raw
    .split('|')
    .map((segment): AgentRouteEntry | null => {
      // Format per entry: "key:entity_id:hint"
      // key      = routing label (ignored at runtime, just for human readability)
      // entity_id = e.g. "conversation.jarvis_search"
      // hint     = one-line description for the router prompt
      // We split on the first colon (key) and second colon (entity_id boundary).
      const firstColon = segment.indexOf(':');
      const secondColon = segment.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) return null;
      const key = segment.slice(0, firstColon).trim().replace(/^=+/, '') || undefined;
      const agentId = segment.slice(firstColon + 1, secondColon).trim();
      const hint = segment.slice(secondColon + 1).trim();
      if (!agentId || !hint) return null;
      return {
        agentId,
        hint,
        ...(key ? { key } : {}),
        ...(key === 'executors' ? { routerId: HOME_CONTROL_ROUTER_AGENT_ID } : {}),
      };
    })
    .filter((e): e is AgentRouteEntry => e !== null);
}

/**
 * Synthesize multiple sub-agent responses into a single coherent French reply.
 *
 * Called by the orchestrator when ≥2 specialized agents returned results for
 * the same user message (e.g. "joue du jazz et donne-moi les nouvelles").
 * Falls back to a plain join when the LLM call fails.
 */
export async function synthesizeAgentResponses(params: {
  userText: string;
  parts: { agentId: string; text: string }[];
  options: {
    openAiApiKey: string;
    openAiBaseUrl: string;
    model: string;
    timeoutMs: number;
    log?: MinLogger;
  };
}): Promise<string> {
  const { options } = params;

  const agentLines = params.parts
    .map((p, i) => `[Sous-agent ${i + 1}]: ${p.text.trim()}`)
    .join('\n');

  const systemPrompt =
    'Tu es un assistant vocal français. ' +
    'Plusieurs sous-agents ont chacun traité une partie de la demande de l\'utilisateur. ' +
    'Synthétise leurs réponses en une seule réponse naturelle, fluide et concise. ' +
    'Ne répète pas les réponses mot pour mot — fusionne-les intelligemment. ' +
    'Ne mentionne jamais les noms d\'agents ni les termes techniques. ' +
    'Réponds uniquement par la synthèse, sans phrase d\'introduction ni de conclusion.';

  const userPrompt =
    `Demande originale de l'utilisateur : "${params.userText}"\n\n` +
    `Réponses des sous-agents :\n${agentLines}\n\nSynthèse :`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(
      `${options.openAiBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.openAiApiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          temperature: 0.3,
          max_tokens: 350,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      options.log?.warn({ status: response.status }, 'synthesize_agent_responses_http_error');
      throw new Error(`synthesizer_http_${response.status}`);
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const content =
      (raw?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? '';
    return content.trim() || fallbackJoin(params.parts);
  } catch (err) {
    options.log?.warn({ err }, 'synthesize_agent_responses_failed_fallback');
    return fallbackJoin(params.parts);
  } finally {
    clearTimeout(timeoutId);
  }
}

function fallbackJoin(parts: { text: string }[]): string {
  const snippets = parts
    .map((p) => p.text.trim())
    .filter(Boolean)
    .map((text) => {
      const m = text.match(/^(.+?[.!?])(?:\s|$)/);
      const first = (m ? m[1] : text).trim();
      return first.replace(/\.?\s*$/, '');
    })
    .slice(0, 4);

  if (snippets.length === 0) return '';
  if (snippets.length === 1) return `${snippets[0]}.`;
  if (snippets.length === 2) return `${snippets[0]}. ${snippets[1]}.`;
  return `${snippets.slice(0, -1).join('. ')}. Et aussi: ${snippets[snippets.length - 1]}.`;
}
