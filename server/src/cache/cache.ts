/**
 * A minimal cache contract. Anything that can get/set/delete a value by
 * string key with a TTL implements this - an in-memory Map today, Redis
 * or another shared store later, without the caller (the performance
 * provider decorator) changing at all.
 */
export interface CacheEntry<T> {
  value: T;
  cachedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

export interface Cache<T> {
  get(key: string): Promise<CacheEntry<T> | null>;
  set(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * In-memory cache. Good enough for a single-process MVP. Entries are
 * lazily expired on read; a light periodic sweep also clears expired
 * entries so memory doesn't grow unbounded from keys that are written
 * once and never read again. The sweep timer is unref()'d so it never
 * keeps the Node process (or a test run) alive on its own.
 */
export class InMemoryCache<T> implements Cache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now, sweepIntervalMs = 60_000) {
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  async get(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    const cachedAt = this.now();
    this.store.set(key, { value, cachedAt, expiresAt: cachedAt + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  private sweep() {
    const now = this.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  /** for tests/shutdown - stops the sweep timer */
  stopSweeping() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** for tests - current entry count, not part of the Cache<T> contract */
  size(): number {
    return this.store.size;
  }
}
