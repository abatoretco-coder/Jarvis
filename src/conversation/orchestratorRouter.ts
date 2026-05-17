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

import type { MessageRecord } from './repositories/MessageRepository';
import { buildOrchestratorSystemPrompt } from './prompts/orchestratorSystemPrompt';
import { buildOrchestratorUserPrompt } from './prompts/orchestratorUserTemplate';

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
};

/**
 * Special sentinel agentId returned by the router when the request should be
 * handled by the Spotify executor (not an HA conversation entity).
 */
export const SPOTIFY_AGENT_ID = 'spotify' as const;

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
};

export type RouterOptions = {
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
  generalAgentId: string;
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
  const t0 = Date.now();

  log?.info(
    { model: options.model, agents: params.agents.map((a) => a.agentId), timeout_ms: options.timeoutMs },
    'ha_agent_router_start',
  );

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
          temperature: 0,
          max_tokens: 120,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildOrchestratorUserPrompt(params) },
          ],
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      log?.warn({ status: response.status, elapsed_ms: Date.now() - t0 }, 'ha_agent_router_openai_http_error');
      throw new Error(`router_openai_http_${response.status}`);
    }

    const raw = await response.json() as Record<string, unknown>;
    const content = (raw?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? '';

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

    const knownIds = new Set(params.agents.map((a) => a.agentId));
    const targets: RouterTarget[] = (rawTargets as unknown[])
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t) => {
        const agentId = typeof t['agentId'] === 'string' ? (t['agentId'] as string).trim() : '';
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
      .filter((t) => t.agentId && knownIds.has(t.agentId));

    if (targets.length === 0) {
      log?.warn({ rawTargets, knownIds: [...knownIds], elapsed_ms: Date.now() - t0 }, 'ha_agent_router_no_valid_targets');
      throw new Error('router_no_valid_targets');
    }

    log?.info(
      { targets: targets.map((t) => `${t.agentId}:${t.confidence}`), reason, elapsed_ms: Date.now() - t0 },
      'ha_agent_router_done',
    );
    return { targets, reason };
  } finally {
    clearTimeout(timeoutId);
  }
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
    .map((segment) => {
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
      return { agentId, hint, ...(key ? { key } : {}) };
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
  return parts
    .map((p) => p.text.trim().replace(/\.?\s*$/, ''))
    .join('. ')
    .concat('.');
}
