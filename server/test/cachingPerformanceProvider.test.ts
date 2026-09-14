import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCache } from "../src/cache/cache.js";
import { CachingPerformanceProvider } from "../src/providers/cachingPerformanceProvider.js";
import type { PerformanceProvider, PerformanceProviderResult } from "../src/types.js";

function countingProvider(result: PerformanceProviderResult, delayMs = 0) {
  let calls = 0;
  const provider: PerformanceProvider = {
    name: "counting-provider",
    analyze: async () => {
      calls += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return result;
    },
  };
  return { provider, callCount: () => calls };
}

const AVAILABLE_RESULT: PerformanceProviderResult = {
  status: "available",
  evidence: {
    strategy: "mobile",
    lighthousePerformanceScore: 80,
    metrics: {
      lcp: { value: 2000, unit: "ms", status: "good", source: "pagespeed-lab" },
      inp: { value: 150, unit: "ms", status: "good", source: "pagespeed-lab" },
      cls: { value: 0.05, unit: "unitless", status: "good", source: "pagespeed-lab" },
      ttfb: { value: 300, unit: "ms", status: "good", source: "pagespeed-lab" },
      fcp: { value: 1200, unit: "ms", status: "good", source: "pagespeed-lab" },
      speedIndex: { value: 2000, unit: "ms", status: "good", source: "pagespeed-lab" },
      tbt: { value: 100, unit: "ms", status: "good", source: "pagespeed-lab" },
    },
    opportunities: [],
    coverage: { metricsAvailable: 7, metricsTotal: 7 },
  },
};

test("a cache miss calls the inner provider and caches the result", async () => {
  const { provider, callCount } = countingProvider(AVAILABLE_RESULT);
  const cache = new InMemoryCache<PerformanceProviderResult>();
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 60_000 });

  const result = await caching.analyze("https://example.com/page");
  assert.equal(result.status, "available");
  assert.equal(result.cache?.hit, false);
  assert.equal(callCount(), 1);
  assert.equal(caching.stats.misses, 1);
  assert.equal(caching.stats.hits, 0);
  cache.stopSweeping();
});

test("a second scan of the same URL is served from cache, not the inner provider", async () => {
  const { provider, callCount } = countingProvider(AVAILABLE_RESULT);
  const cache = new InMemoryCache<PerformanceProviderResult>();
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 60_000 });

  await caching.analyze("https://example.com/page");
  const second = await caching.analyze("https://example.com/page");

  assert.equal(callCount(), 1, "inner provider should only be called once");
  assert.equal(second.cache?.hit, true);
  assert.equal(caching.stats.hits, 1);
  cache.stopSweeping();
});

test("cache entries expire after the configured TTL", async () => {
  let now = 0;
  const { provider, callCount } = countingProvider(AVAILABLE_RESULT);
  const cache = new InMemoryCache<PerformanceProviderResult>(() => now, 0);
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 5_000 });

  await caching.analyze("https://example.com/page");
  now += 6_000; // past the 5s TTL
  await caching.analyze("https://example.com/page");

  assert.equal(callCount(), 2, "a second inner call is made once the cached entry has expired");
  cache.stopSweeping();
});

test("a failed (non-available) result is never cached", async () => {
  const { provider, callCount } = countingProvider({ status: "rate_limited", evidence: null, errorMessage: "rate limited" });
  const cache = new InMemoryCache<PerformanceProviderResult>();
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 60_000 });

  await caching.analyze("https://example.com/page");
  await caching.analyze("https://example.com/page");

  assert.equal(callCount(), 2, "every scan retries a previously-failed provider instead of caching the failure");
  cache.stopSweeping();
});

test("the same normalized URL (different casing/trailing slash) shares one cache entry", async () => {
  const { provider, callCount } = countingProvider(AVAILABLE_RESULT);
  const cache = new InMemoryCache<PerformanceProviderResult>();
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 60_000 });

  await caching.analyze("https://Example.com/page/");
  await caching.analyze("https://example.com/page");

  assert.equal(callCount(), 1);
  cache.stopSweeping();
});

test("different URLs get independent cache entries", async () => {
  const { provider, callCount } = countingProvider(AVAILABLE_RESULT);
  const cache = new InMemoryCache<PerformanceProviderResult>();
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 60_000 });

  await caching.analyze("https://example.com/a");
  await caching.analyze("https://example.com/b");

  assert.equal(callCount(), 2);
  cache.stopSweeping();
});

test("concurrent scans of the same URL are coalesced into a single inner provider call", async () => {
  const { provider, callCount } = countingProvider(AVAILABLE_RESULT, 30);
  const cache = new InMemoryCache<PerformanceProviderResult>();
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 60_000 });

  const [a, b, c] = await Promise.all([
    caching.analyze("https://example.com/page"),
    caching.analyze("https://example.com/page"),
    caching.analyze("https://example.com/page"),
  ]);

  assert.equal(callCount(), 1, "three concurrent identical requests should share one provider call");
  assert.equal(a.status, "available");
  assert.equal(b.status, "available");
  assert.equal(c.status, "available");
  cache.stopSweeping();
});

test("concurrent scans of different URLs are NOT coalesced", async () => {
  const { provider, callCount } = countingProvider(AVAILABLE_RESULT, 20);
  const cache = new InMemoryCache<PerformanceProviderResult>();
  const caching = new CachingPerformanceProvider(provider, cache, { ttlMs: 60_000 });

  await Promise.all([caching.analyze("https://example.com/a"), caching.analyze("https://example.com/b")]);

  assert.equal(callCount(), 2);
  cache.stopSweeping();
});
