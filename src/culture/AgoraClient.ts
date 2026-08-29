import type { z } from 'zod';

import {
  type AgoraDiscoverResponse,
  agoraDiscoverResponseSchema,
  type AgoraItemResponse,
  agoraItemResponseSchema,
  type AgoraVenueResponse,
  agoraVenueResponseSchema,
  type AgoraVenuesResponse,
  agoraVenuesResponseSchema,
} from './contracts';

export type AgoraClientErrorCode = 'timeout' | 'unauthorized' | 'unavailable' | 'invalid_response' | 'http_error';

export class AgoraClientError extends Error {
  constructor(public readonly code: AgoraClientErrorCode, public readonly status?: number, cause?: unknown) {
    super(`agora_${code}`, { cause });
    this.name = 'AgoraClientError';
  }
}

type QueryValue = string | number | undefined;

export class AgoraClient {
  private readonly baseUrl: URL;

  constructor(private readonly config: { baseUrl: string; token: string; timeoutMs: number }) {
    this.baseUrl = new URL(config.baseUrl);
  }

  private async request<T>(path: string, schema: z.ZodType<T>, params?: Record<string, QueryValue>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.config.token}`, accept: 'application/json' },
      });
      if (!response.ok) {
        if (response.status === 401) throw new AgoraClientError('unauthorized', response.status);
        if (response.status === 503) throw new AgoraClientError('unavailable', response.status);
        throw new AgoraClientError('http_error', response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new AgoraClientError('invalid_response', response.status, error);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new AgoraClientError('invalid_response', response.status, parsed.error);
      return parsed.data;
    } catch (error) {
      if (error instanceof AgoraClientError) throw error;
      if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
        throw new AgoraClientError('timeout', undefined, error);
      }
      throw new AgoraClientError('unavailable', undefined, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  discover(params: Record<string, QueryValue>): Promise<AgoraDiscoverResponse> {
    return this.request('/v1/discover', agoraDiscoverResponseSchema, params);
  }

  async getItem(id: string, params?: Record<string, QueryValue>): Promise<AgoraItemResponse> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) throw new AgoraClientError('invalid_response');
    return this.request(`/v1/items/${encodeURIComponent(id)}`, agoraItemResponseSchema, params);
  }

  findVenues(params: Record<string, QueryValue>): Promise<AgoraVenuesResponse> {
    return this.request('/v1/venues', agoraVenuesResponseSchema, params);
  }

  async getVenue(id: string): Promise<AgoraVenueResponse> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) throw new AgoraClientError('invalid_response');
    return this.request(`/v1/venues/${encodeURIComponent(id)}`, agoraVenueResponseSchema);
  }
}
