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

export type HaAgentEntry = {
  /** HA conversation entity_id, e.g. "conversation.jarvis_search" */
  agentId: string;
  /** One-line hint used in the router prompt */
  hint: string;
};

export type RouterResult = {
  agentId: string;
  confidence: number;
  reason: string;
};

export type RouterOptions = {
  openAiApiKey: string;
  openAiBaseUrl: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
  generalAgentId: string;
};

// Minimal system prompt — token budget is tight.
const SYSTEM_PROMPT = `You are a routing classifier. Given a user message and optional context, pick the best agent from the provided list.
Return ONLY valid JSON matching the schema: {"agentId":"<id>","confidence":<0-1>,"reason":"<10 words max>"}.
Rules:
- Pick the most specific agent when confident.
- If unsure or the message spans multiple domains, pick the general agent.
- confidence reflects your certainty (1.0=certain, 0.5=unsure).
- Do not explain. Do not add keys. Output only the JSON object.`;

function buildUserPrompt(params: {
  text: string;
  agents: HaAgentEntry[];
  summary?: string;
  recentMessages: MessageRecord[];
}): string {
  const parts: string[] = [];

  if (params.summary?.trim()) {
    parts.push(`Context summary: ${params.summary.trim()}`);
  }

  if (params.recentMessages.length > 0) {
    const recent = params.recentMessages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    parts.push(`Recent:\n${recent}`);
  }

  const agentList = params.agents
    .map((a) => `- ${a.agentId}: ${a.hint}`)
    .join('\n');
  parts.push(`Agents:\n${agentList}`);

  parts.push(`Message: ${params.text}`);

  return parts.join('\n\n');
}

export async function routeToHaAgent(params: {
  text: string;
  agents: HaAgentEntry[];
  summary?: string;
  recentMessages: MessageRecord[];
  options: RouterOptions;
}): Promise<RouterResult> {
  const { options } = params;

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
          max_tokens: 80,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(params) },
          ],
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`router_openai_http_${response.status}`);
    }

    const raw = await response.json() as Record<string, unknown>;
    const content = (raw?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? '';

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('router_invalid_json');
    }

    const result = parsed as Record<string, unknown>;
    const agentId = typeof result.agentId === 'string' ? result.agentId.trim() : '';
    const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
    const reason = typeof result.reason === 'string' ? result.reason.trim() : '';

    // Validate that the returned agentId is in our known list
    const knownIds = new Set(params.agents.map((a) => a.agentId));
    if (!agentId || !knownIds.has(agentId)) {
      throw new Error(`router_unknown_agent:${agentId}`);
    }

    return { agentId, confidence, reason };
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
export function parseAgentMap(raw: string | undefined): HaAgentEntry[] {
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
      const agentId = segment.slice(firstColon + 1, secondColon).trim();
      const hint = segment.slice(secondColon + 1).trim();
      if (!agentId || !hint) return null;
      return { agentId, hint } satisfies HaAgentEntry;
    })
    .filter((e): e is HaAgentEntry => e !== null);
}
