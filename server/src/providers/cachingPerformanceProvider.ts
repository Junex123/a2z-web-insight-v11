import type { PerformanceProvider, PerformanceProviderResult } from "../types.js";
import type { Cache } from "../cache/cache.js";
import { normalizeCacheKey } from "../cache/urlNormalize.js";
import { logEvent } from "../logging/logger.js";

export interface CachingProviderStats {
  hits: number;
  misses: number;
  providerRequests: number;
}

/**
 * Wraps any PerformanceProvider with:
 *  - result caching (successful results only - failures are never
 *    permanently cached, so a transient PageSpeed outage self-heals on
 *    the next scan instead of being "stuck" unavailable for the TTL)
 *  - in-flight request coalescing, so two scans of the same normalized
 *    URL that arrive while a PageSpeed call is already running share
 *    that one call instead of firing a second one
 *
 * This is a decorator, not a rewrite of PageSpeedProvider - swapping the
 * Cache<T> implementation (e.g. for Redis) or removing caching entirely
 * needs zero changes to the underlying provider.
 */
export class CachingPerformanceProvider implements PerformanceProvider {
  name: string;

  private readonly inner: PerformanceProvider;
  private readonly cache: Cache<PerformanceProviderResult>;
  private readonly ttlMs: number;
  private readonly strategy: "mobile" | "desktop";
  private readonly inFlight = new Map<string, Promise<PerformanceProviderResult>>();

  readonly stats: CachingProviderStats = { hits: 0, misses: 0, providerRequests: 0 };

  constructor(
    inner: PerformanceProvider,
    cache: Cache<PerformanceProviderResult>,
    options: { ttlMs: number; strategy?: "mobile" | "desktop" },
  ) {
    this.inner = inner;
    this.cache = cache;
    this.ttlMs = options.ttlMs;
    this.strategy = options.strategy ?? "mobile";
    this.name = inner.name;
  }

  async analyze(url: string): Promise<PerformanceProviderResult> {
    const key = normalizeCacheKey(url, this.strategy);

    const cached = await this.cache.get(key);
    if (cached) {
      this.stats.hits += 1;
      const ageMs = Date.now() - cached.cachedAt;
      logEvent("cache_hit", { key, ageMs });
      return { ...cached.value, cache: { hit: true, ageMs } };
    }
    this.stats.misses += 1;
    logEvent("cache_miss", { key });

    // Coalesce concurrent requests for the same key into one inner call.
    const existing = this.inFlight.get(key);
    if (existing) {
      const result = await existing;
      return { ...result, cache: { hit: false, ageMs: 0 } };
    }

    const promise = this.runAndCache(key, url);
    this.inFlight.set(key, promise);
    try {
      const result = await promise;
      return { ...result, cache: { hit: false, ageMs: 0 } };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async runAndCache(key: string, url: string): Promise<PerformanceProviderResult> {
    this.stats.providerRequests += 1;
    const result = await this.inner.analyze(url);
    if (result.status === "available") {
      await this.cache.set(key, result, this.ttlMs);
    }
    // failures (rate_limited / timeout / error / not_configured / unavailable)
    // are deliberately NOT cached, so the very next scan gets a fresh try.
    return result;
  }
}
