import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCache } from "../src/cache/cache.js";

test("set then get returns the stored value", async () => {
  const cache = new InMemoryCache<string>();
  await cache.set("k1", "hello", 10_000);
  const entry = await cache.get("k1");
  assert.equal(entry?.value, "hello");
  cache.stopSweeping();
});

test("get on a missing key returns null", async () => {
  const cache = new InMemoryCache<string>();
  const entry = await cache.get("does-not-exist");
  assert.equal(entry, null);
  cache.stopSweeping();
});

test("entries expire after their TTL", async () => {
  let now = 1_000_000;
  const cache = new InMemoryCache<string>(() => now, 0); // sweep disabled, rely on lazy expiry
  await cache.set("k1", "value", 5_000);

  now += 4_000;
  assert.equal((await cache.get("k1"))?.value, "value", "still fresh before TTL elapses");

  now += 2_000; // total 6000ms elapsed, TTL was 5000ms
  assert.equal(await cache.get("k1"), null, "expired after TTL elapses");
  cache.stopSweeping();
});

test("delete removes an entry immediately", async () => {
  const cache = new InMemoryCache<string>();
  await cache.set("k1", "value", 10_000);
  await cache.delete("k1");
  assert.equal(await cache.get("k1"), null);
  cache.stopSweeping();
});

test("different keys are independent", async () => {
  const cache = new InMemoryCache<number>();
  await cache.set("a", 1, 10_000);
  await cache.set("b", 2, 10_000);
  assert.equal((await cache.get("a"))?.value, 1);
  assert.equal((await cache.get("b"))?.value, 2);
  cache.stopSweeping();
});

test("cachedAt/expiresAt reflect the injected clock", async () => {
  let now = 500_000;
  const cache = new InMemoryCache<string>(() => now, 0);
  await cache.set("k1", "v", 1_000);
  const entry = await cache.get("k1");
  assert.equal(entry?.cachedAt, 500_000);
  assert.equal(entry?.expiresAt, 501_000);
  cache.stopSweeping();
});
