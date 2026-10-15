export type HaConversationAgentSnapshot = {
  available: boolean;
  agentIds: string[];
  observedAtMs: number;
  cached: boolean;
};

type StateSource = {
  getStates(): Promise<unknown>;
};

type InventoryOptions = {
  ttlMs?: number;
  failureTtlMs?: number;
};

type CachedSnapshot = Omit<HaConversationAgentSnapshot, 'cached'> & {
  expiresAtMs: number;
};

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FAILURE_TTL_MS = 5_000;

function conversationEntityIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const entityId = (item as { entity_id?: unknown }).entity_id;
        return typeof entityId === 'string' && entityId.startsWith('conversation.')
          ? [entityId]
          : [];
      })
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/**
 * Bounded runtime view of Home Assistant conversation entities.
 *
 * Home Assistant also supports opaque config-entry agent identifiers. Those
 * cannot be discovered through `/api/states`, so this inventory deliberately
 * validates only entity-style identifiers (`conversation.*`) and leaves opaque
 * identifiers to Home Assistant.
 */
export class HaConversationAgentInventory {
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private cached?: CachedSnapshot;
  private inFlight?: Promise<CachedSnapshot>;

  constructor(
    private readonly source: StateSource,
    options: InventoryOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  }

  async getSnapshot(options: { force?: boolean } = {}): Promise<HaConversationAgentSnapshot> {
    const now = Date.now();
    if (!options.force && this.cached && this.cached.expiresAtMs > now) {
      return this.toPublicSnapshot(this.cached, true);
    }
    if (this.inFlight) {
      const snapshot = await this.inFlight;
      return this.toPublicSnapshot(snapshot, true);
    }

    this.inFlight = this.load();
    try {
      const snapshot = await this.inFlight;
      return this.toPublicSnapshot(snapshot, false);
    } finally {
      this.inFlight = undefined;
    }
  }

  isEntityStyleAgentAvailable(
    agentId: string,
    snapshot: HaConversationAgentSnapshot
  ): boolean | undefined {
    if (!agentId.startsWith('conversation.')) return undefined;
    return snapshot.available && snapshot.agentIds.includes(agentId);
  }

  private async load(): Promise<CachedSnapshot> {
    const observedAtMs = Date.now();
    try {
      const states = await this.source.getStates();
      const snapshot: CachedSnapshot = {
        available: true,
        agentIds: conversationEntityIds(states),
        observedAtMs,
        expiresAtMs: observedAtMs + this.ttlMs,
      };
      this.cached = snapshot;
      return snapshot;
    } catch {
      const snapshot: CachedSnapshot = {
        available: false,
        agentIds: [],
        observedAtMs,
        expiresAtMs: observedAtMs + this.failureTtlMs,
      };
      this.cached = snapshot;
      return snapshot;
    }
  }

  private toPublicSnapshot(snapshot: CachedSnapshot, cached: boolean): HaConversationAgentSnapshot {
    return {
      available: snapshot.available,
      agentIds: snapshot.agentIds,
      observedAtMs: snapshot.observedAtMs,
      cached,
    };
  }
}
