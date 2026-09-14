import assert from "node:assert/strict";
import { test } from "node:test";
import { withRetry } from "../src/net/retry.js";

function noSleep() {
  return async () => {}; // instant, deterministic - no real waiting in tests
}

test("succeeds on the first attempt with no retries needed", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      return "ok";
    },
    { maxRetries: 3, baseDelayMs: 10, shouldRetry: () => true, sleep: noSleep() },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("retries a transient failure and eventually succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
    { maxRetries: 5, baseDelayMs: 1, shouldRetry: () => true, sleep: noSleep() },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("stops after maxRetries and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`fail ${calls}`);
        },
        { maxRetries: 2, baseDelayMs: 1, shouldRetry: () => true, sleep: noSleep() },
      ),
    /fail 3/,
  );
  assert.equal(calls, 3); // 1 initial attempt + 2 retries
});

test("does not retry when shouldRetry returns false", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error("permanent");
        },
        { maxRetries: 5, baseDelayMs: 1, shouldRetry: () => false, sleep: noSleep() },
      ),
    /permanent/,
  );
  assert.equal(calls, 1, "a non-retryable error must not be retried at all");
});

test("maxRetries: 0 means exactly one attempt, no retries", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error("fail");
        },
        { maxRetries: 0, baseDelayMs: 1, shouldRetry: () => true, sleep: noSleep() },
      ),
  );
  assert.equal(calls, 1);
});

test("delay grows exponentially with the base delay", async () => {
  const delays: number[] = [];
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls += 1;
        throw new Error("fail");
      },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        shouldRetry: () => true,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    ),
  );
  assert.deepEqual(delays, [100, 200, 400]);
});
