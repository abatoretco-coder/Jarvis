import { completeOpenAiResponse } from '../../openai/responsesClient';
import { getSpotifyResponse } from '../deterministic/spotifyResponses';
import { RENDER_DOMAIN_REPHRASE_OPENAI_CONFIG } from './openAiConfig';
import { resolveRenderPolicy } from './policies';
import { buildDomainRephraseSystemPrompt } from './prompts/domainRephraseSystemPrompt';
import { buildDomainRephraseUserPrompt } from './prompts/domainRephraseUserPrompt';
import type { ActionExecutionResult } from './types';

type RenderDeps = {
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiModel?: string;
  maxOutputTokens?: number;
  timeoutMs: number;
  log?: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clamp(text: string, maxChars?: number): string {
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function renderDeterministicError(result: ActionExecutionResult): string {
  if (result.status === 'need_clarification') {
    return 'J’ai besoin d’une précision pour terminer cette action.';
  }
  if (result.status === 'out_of_scope') {
    return 'Cette demande ne correspond pas au périmètre de cette action.';
  }
  const code = result.errorCode?.trim();
  if (code) {
    return `Je n’ai pas pu terminer l’action (${code}).`;
  }
  return 'Je n’ai pas pu terminer cette action.';
}

function renderDeterministicTemplate(result: ActionExecutionResult): string | null {
  if (result.actionKey === 'spotify.now_playing') {
    const facts = asRecord(result.facts);
    const data = asRecord(facts.data);
    const track = firstString([data.track_name, data.track, facts.track_name, facts.track]);
    const artist = firstString([data.artist_name, data.artist, facts.artist_name, facts.artist]);
    if (track && artist) return `Ça joue: ${track} par ${artist}.`;
    if (track) return `Ça joue: ${track}.`;
    return null;
  }

  if (result.actionKey === 'spotify.list_devices') {
    const facts = asRecord(result.facts);
    const data = asRecord(facts.data);
    const devicesRaw = data.devices ?? facts.devices;
    if (Array.isArray(devicesRaw) && devicesRaw.length > 0) {
      const names = devicesRaw
        .map((device) => {
          if (typeof device === 'string') return device.trim();
          if (device && typeof device === 'object' && typeof (device as Record<string, unknown>).name === 'string') {
            return ((device as Record<string, unknown>).name as string).trim();
          }
          return '';
        })
        .filter((name) => name.length > 0)
        .slice(0, 5);
      if (names.length > 0) return `Appareils disponibles: ${names.join(', ')}.`;
    }
    return null;
  }

  if (result.domain === 'spotify') {
    // Generic template for remaining spotify actions when structured facts are available.
    const action = result.actionKey.replace(/^spotify\./, '');
    const target = firstString([
      asRecord(result.facts).query,
      asRecord(result.facts).device,
      asRecord(result.facts).playlist,
    ]);
    if (target) return `Action ${action} effectuée: ${target}.`;
    return `Action ${action} effectuée.`;
  }

  return null;
}

async function renderWithDomainPrompt(result: ActionExecutionResult, deps: RenderDeps): Promise<string | null> {
  if (!deps.openAiApiKey || !deps.openAiBaseUrl || !deps.openAiModel) return null;
  const source = normalizeText(result.rawText ?? '');
  if (!source) return null;

  try {
    const text = await completeOpenAiResponse({
      apiKey: deps.openAiApiKey,
      baseUrl: deps.openAiBaseUrl,
      model: deps.openAiModel,
      capability: 'synthesis',
      messages: [
        { role: 'system', content: buildDomainRephraseSystemPrompt() },
        { role: 'user', content: buildDomainRephraseUserPrompt(result, source) },
      ],
      maxOutputTokens: Math.min(RENDER_DOMAIN_REPHRASE_OPENAI_CONFIG.maxTokens, deps.maxOutputTokens ?? 768),
      timeoutMs: deps.timeoutMs,
      reasoningEffort: 'low',
    });
    return normalizeText(text) || null;
  } catch (err) {
    deps.log?.warn({ err, actionKey: result.actionKey, domain: result.domain }, 'render_policy_llm_rephrase_failed');
    return null;
  }
}

export async function renderSingleExecutionResult(result: ActionExecutionResult, deps: RenderDeps): Promise<string> {
  const policy = resolveRenderPolicy(result);

  if (policy.mode === 'deterministic_error') {
    return clamp(renderDeterministicError(result), policy.maxChars);
  }

  if (policy.mode === 'deterministic_static') {
    if (result.domain === 'spotify') {
      const action = result.actionKey.replace(/^spotify\./, '');
      return clamp(getSpotifyResponse(action), policy.maxChars);
    }
    return clamp('Action effectuée.', policy.maxChars);
  }

  if (policy.mode === 'deterministic_template') {
    const templated = renderDeterministicTemplate(result);
    if (templated) return clamp(templated, policy.maxChars);
  }

  if (policy.mode === 'llm_domain_rephrase') {
    const rephrased = await renderWithDomainPrompt(result, deps);
    if (rephrased) return clamp(rephrased, policy.maxChars);
  }

  const raw = normalizeText(result.rawText ?? '');
  if (raw) return clamp(raw, policy.maxChars);

  // Last fallback if no source text is available
  return clamp('Action effectuée.', policy.maxChars);
}

export async function renderMultipleExecutionResults(results: ActionExecutionResult[], deps: RenderDeps): Promise<string> {
  const usable = results.filter((result) => result.status !== 'out_of_scope');
  if (usable.length === 0) return 'Je n ai pas trouve de resultat exploitable.';
  if (usable.length === 1) return renderSingleExecutionResult(usable[0]!, deps);

  if (deps.openAiApiKey && deps.openAiBaseUrl && deps.openAiModel) {
    try {
      const summaries = await Promise.all(usable.map(async (result) => ({
        domain: result.domain,
        actionKey: result.actionKey,
        status: result.status,
        text: await renderSingleExecutionResult(result, { ...deps, openAiApiKey: undefined }),
      })));
      const text = await completeOpenAiResponse({
        apiKey: deps.openAiApiKey,
        baseUrl: deps.openAiBaseUrl,
        model: deps.openAiModel,
        capability: 'synthesis',
        messages: [
          { role: 'system', content: 'Tu combines plusieurs resultats d actions Jarvis en une reponse courte, factuelle, en francais. N invente rien.' },
          { role: 'user', content: JSON.stringify({ results: summaries }) },
        ],
        maxOutputTokens: Math.min(RENDER_DOMAIN_REPHRASE_OPENAI_CONFIG.maxTokens, deps.maxOutputTokens ?? 768),
        timeoutMs: deps.timeoutMs,
        reasoningEffort: 'low',
      });
      if (text) return clamp(normalizeText(text), 700);
    } catch (err) {
      deps.log?.warn({ err, count: usable.length }, 'render_policy_multi_synthesis_failed');
    }
  }

  const rendered = await Promise.all(usable.map((result) => renderSingleExecutionResult(result, deps)));
  return clamp(rendered.filter(Boolean).join(' '), 700);
}
