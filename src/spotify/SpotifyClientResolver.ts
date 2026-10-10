import type { Env } from '../env';
import type { IntegrationService } from '../integrations/IntegrationService';
import { SpotifyWebApiClient } from '../spotifyWebApi';

type SpotifyLogger = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

export class SpotifyClientResolver {
  private readonly personalClients = new Map<string, { token: string; client: SpotifyWebApiClient }>();

  constructor(
    private readonly env: Env,
    private readonly fallbackClient: SpotifyWebApiClient,
    private readonly integrations?: IntegrationService,
    private readonly logger?: SpotifyLogger,
  ) {}

  forUser(userId?: string, connectionId?: string): SpotifyWebApiClient {
    if (!userId) return this.fallbackClient;
    const token = this.integrations?.resolveRefreshToken(userId, 'spotify', connectionId);
    if (!token) {
      return new SpotifyWebApiClient(
        { ...this.env, SPOTIFY_WEBAPI_REFRESH_TOKEN: undefined },
        this.logger,
        { persistTokenFile: false },
      );
    }

    const cacheKey = `${userId}:${connectionId ?? 'personal'}`;
    const existing = this.personalClients.get(cacheKey);
    if (existing?.token === token) return existing.client;

    const client = new SpotifyWebApiClient(
      { ...this.env, SPOTIFY_WEBAPI_REFRESH_TOKEN: token },
      this.logger,
      {
        refreshToken: token,
        persistTokenFile: false,
        onRefreshToken: async (next) =>
          this.integrations?.rotateRefreshToken(userId, 'spotify', next, connectionId),
      },
    );
    this.personalClients.set(cacheKey, { token, client });
    return client;
  }
}
