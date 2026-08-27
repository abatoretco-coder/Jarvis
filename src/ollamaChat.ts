export type OllamaChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function isOllamaBaseUrl(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname.toLowerCase().includes('ollama'); } catch { return false; }
}

export async function completeOllamaChat(params: {
  baseUrl: string;
  model: string;
  messages: OllamaChatMessage[];
  temperature: number;
  numPredict: number;
  format?: 'json';
  signal?: AbortSignal;
}): Promise<string> {
  const endpoint = `${params.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/chat`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: false,
      think: false,
      ...(params.format ? { format: params.format } : {}),
      options: { temperature: params.temperature, num_predict: params.numPredict },
    }),
    signal: params.signal,
  });
  if (!response.ok) throw new Error(`ollama_chat_http_${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  return payload.message?.content?.trim() ?? '';
}
