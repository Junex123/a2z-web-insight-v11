import assert from "node:assert/strict";
import { test } from "node:test";
import { PageSpeedProvider } from "../src/providers/pageSpeedProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function minimalPsiPayload() {
  return {
    lighthouseResult: {
      categories: { performance: { score: 0.9 } },
      audits: { "largest-contentful-paint": { numericValue: 1800 } },
    },
  };
}

function instantSleep() {
  return async () => {};
}

test("a transient 503 is retried and succeeds on the second attempt", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 2,
    sleep: instantSleep(),
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "unavailable" }, 503);
      return jsonResponse(minimalPsiPayload());
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "available");
  assert.equal(calls, 2);
});

test("a persistent 502 exhausts retries and returns status error", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 2,
    sleep: instantSleep(),
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ error: "bad gateway" }, 502);
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test("a network-level throw is retried", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 2,
    sleep: instantSleep(),
    fetchImpl: (async () => {
      calls += 1;
      if (calls < 2) throw new Error("ECONNRESET");
      return jsonResponse(minimalPsiPayload());
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "available");
  assert.equal(calls, 2);
});

test("a 429 is never retried, even once", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 3,
    sleep: instantSleep(),
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ error: "rate limited" }, 429);
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "rate_limited");
  assert.equal(calls, 1, "429 must not be retried");
});

test("a 404 is never retried", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 3,
    sleep: instantSleep(),
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.equal(calls, 1);
});

test("a malformed response body is never retried (retrying would return the same malformed body)", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 3,
    sleep: instantSleep(),
    fetchImpl: (async () => {
      calls += 1;
      return new Response("not json{{{", { status: 200 });
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.equal(calls, 1);
});

test("a timeout is not retried (retrying would multiply an already-slow wait)", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 3,
    timeoutMs: 15,
    sleep: instantSleep(),
    fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "timeout");
  assert.equal(calls, 1);
});

test("respects a maxRetries of 0 - a single 503 fails immediately with no retry", async () => {
  let calls = 0;
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    maxRetries: 0,
    sleep: instantSleep(),
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({}, 503);
    }) as unknown as typeof fetch,
  });

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.equal(calls, 1);
});
