import { type OpenAiCapability, supportsReasoningEffort } from './capabilities';
import {
  executeOpenAiOperation,
  getOpenAiResilienceSnapshot,
  OpenAiHttpError,
  resetOpenAiResilienceForTests,
  retryAfterMsFromHeaders,
} from './resilience';

export type OpenAiInputMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string;
};

export type OpenAiResponseResult = {
  text: string;
  sources: string[];
};

export type OpenAiResponseParams = {
  apiKey: string;
  baseUrl: string;
  model: string;
  capability: OpenAiCapability;
  messages: OpenAiInputMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  jsonMode?: boolean;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  reasoningEffort?: 'none' | 'low';
  tools?: Array<Record<string, unknown>>;
  toolChoice?: 'auto' | 'required';
  signal?: AbortSignal;
};

type OpenAiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

function extractOutput(payload: Record<string, unknown>): OpenAiResponseResult {
  if (typeof payload.output_text === 'string') return { text: payload.output_text.trim(), sources: [] };
  const output = Array.isArray(payload.output) ? payload.output : [];
  const pieces: string[] = [];
  const sources = new Set<string>();
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as { type?: unknown; text?: unknown; annotations?: unknown };
      if (record.type === 'output_text' && typeof record.text === 'string') pieces.push(record.text);
      const annotations = Array.isArray(record.annotations) ? record.annotations : [];
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== 'object') continue;
        const url = (annotation as { url?: unknown }).url;
        if (typeof url === 'string' && /^https?:\/\//u.test(url)) sources.add(url);
      }
    }
  }
  return { text: pieces.join('').trim(), sources: [...sources] };
}

export async function requestOpenAiResponse(params: OpenAiResponseParams): Promise<OpenAiResponseResult> {
  return executeOpenAiOperation({
    capability: params.capability,
    model: params.model,
    signal: params.signal,
    operation: async (_attempt, operationSignal) => {
      const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
      const signal = AbortSignal.any([operationSignal, timeoutSignal]);
      const response = await fetch(`${params.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: params.model,
          input: params.messages,
          max_output_tokens: Math.max(16, Math.floor(params.maxOutputTokens)),
          store: false,
          ...(params.tools?.length ? { tools: params.tools } : {}),
          ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
          ...(params.jsonSchema
            ? { text: { format: { type: 'json_schema', name: params.jsonSchema.name, strict: true, schema: params.jsonSchema.schema }, verbosity: 'low' } }
            : params.jsonMode
              ? { text: { format: { type: 'json_object' }, verbosity: 'low' } }
              : {}),
          ...(params.reasoningEffort && supportsReasoningEffort(params.model)
            ? { reasoning: { effort: params.reasoningEffort } }
            : {}),
        }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new OpenAiHttpError(
          response.status,
          retryAfterMsFromHeaders(response.headers),
          `openai_responses_http_${response.status}`,
        );
      }

      const payload = await response.json() as Record<string, unknown>;
      if (payload.status === 'incomplete') {
        const reason = (payload.incomplete_details as { reason?: unknown } | undefined)?.reason;
        throw new Error(`openai_responses_incomplete_${typeof reason === 'string' ? reason : 'unknown'}`);
      }
      if (payload.status === 'failed') throw new Error('openai_responses_failed');

      const result = extractOutput(payload);
      if (!result.text) throw new Error('openai_responses_empty_output');
      const usage = (payload.usage ?? {}) as OpenAiUsage;
      return {
        value: result,
        status: response.status,
        model: params.model,
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
        },
      };
    },
  });
}

export async function completeOpenAiResponse(params: OpenAiResponseParams): Promise<string> {
  return (await requestOpenAiResponse(params)).text;
}

export function getOpenAiTelemetrySnapshot(): Record<string, unknown> {
  return getOpenAiResilienceSnapshot();
}

export function resetOpenAiTelemetryForTests(): void {
  resetOpenAiResilienceForTests();
}
