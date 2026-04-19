import type { Env } from './env';

export type HomeAssistantServiceCall = {
  domain: string;
  service: string;
  serviceData?: Record<string, unknown>;
  target?: Record<string, unknown>;
  // When true, adds `?return_response=true` to the REST service call (HA versions that support it)
  // so the response body contains the service response rather than the default state change list.
  returnResponse?: boolean;
};

export type HomeAssistantConversationProcessInput = {
  text: string;
  conversationId?: string;
  language?: string;
  agentId?: string;
};

export class HomeAssistantClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(env: Env) {
    if (!env.HA_BASE_URL || !env.HA_TOKEN) {
      throw new Error('Home Assistant is not configured (HA_BASE_URL/HA_TOKEN missing)');
    }
    this.baseUrl = env.HA_BASE_URL.replace(/\/$/, '');
    this.token = env.HA_TOKEN;
    this.timeoutMs = env.HA_TIMEOUT_MS;
  }

  private async readResponseBody(resp: Response): Promise<unknown> {
    const contentType = resp.headers.get('content-type') ?? '';
    const raw = await resp.text().catch(() => '');
    if (!contentType.includes('application/json')) return raw;
    try {
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return raw;
    }
  }

  async callService(input: HomeAssistantServiceCall): Promise<{ status: number; data: unknown }> {
    const base = `${this.baseUrl}/api/services/${encodeURIComponent(input.domain)}/${encodeURIComponent(input.service)}`;
    const url = input.returnResponse ? `${base}?return_response=true` : base;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    // Home Assistant REST API expects target fields at top-level (entity_id/area_id/device_id/...)
    // rather than a nested { target: { ... } } shape (that's common in websocket/service-call patterns).
    const body: Record<string, unknown> = {
      ...(input.serviceData ?? {}),
      ...(input.target ?? {}),
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = await this.readResponseBody(resp);
      if (!resp.ok) {
        const details = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`Home Assistant callService failed (${input.domain}.${input.service}): ${resp.status}: ${details}`);
      }
      return { status: resp.status, data };
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(`Home Assistant request failed: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStates(): Promise<unknown> {
    const url = `${this.baseUrl}/api/states`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
      });

      const data = await this.readResponseBody(resp);
      if (!resp.ok) {
        const details = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`Home Assistant getStates failed: ${resp.status}: ${details}`);
      }
      return data;
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(`Home Assistant request failed: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getState(entityId: string): Promise<unknown> {
    const url = `${this.baseUrl}/api/states/${encodeURIComponent(entityId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
      });

      const data = await this.readResponseBody(resp);
      if (!resp.ok) {
        const details = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`Home Assistant getState failed: ${resp.status}: ${details}`);
      }
      return data;
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(`Home Assistant request failed: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async processConversation(input: HomeAssistantConversationProcessInput): Promise<{ status: number; data: unknown }> {
    const url = `${this.baseUrl}/api/conversation/process`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: Record<string, unknown> = {
      text: input.text,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.agentId ? { agent_id: input.agentId } : {}),
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = await this.readResponseBody(resp);
      if (!resp.ok) {
        const details = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`Home Assistant conversation.process failed: ${resp.status}: ${details}`);
      }
      return { status: resp.status, data };
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(`Home Assistant request failed: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
