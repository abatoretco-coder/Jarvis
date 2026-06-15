export type SnapshotCacheOptions = {
  ttlMs: number;
  staleMs: number;
};

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

export class AsyncSnapshotCache<T> {
  private entry?: CacheEntry<T>;
  private refreshPromise?: Promise<T>;

  constructor(
    private readonly loader: () => Promise<T>,
    private readonly options: SnapshotCacheOptions,
  ) {}

  async get(): Promise<{ value: T; cached: boolean; stale: boolean; fetchedAt: number }> {
    const now = Date.now();
    const age = this.entry ? now - this.entry.fetchedAt : Number.POSITIVE_INFINITY;

    if (this.entry && age <= this.options.ttlMs) {
      return { value: this.entry.value, cached: true, stale: false, fetchedAt: this.entry.fetchedAt };
    }

    if (this.entry && age <= this.options.staleMs) {
      void this.refresh();
      return { value: this.entry.value, cached: true, stale: true, fetchedAt: this.entry.fetchedAt };
    }

    const value = await this.refresh();
    return { value, cached: false, stale: false, fetchedAt: this.entry?.fetchedAt ?? now };
  }

  invalidate(): void {
    this.entry = undefined;
  }

  private refresh(): Promise<T> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.loader()
      .then((value) => {
        this.entry = { value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });

    return this.refreshPromise;
  }
}
