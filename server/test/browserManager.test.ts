import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConcurrencyLimiter,
  closeSharedBrowser,
  getSharedBrowser,
  isSharedBrowserConnected,
} from "../src/browser/browserManager.js";

// -----------------------------------------------------------------------
// ConcurrencyLimiter - pure logic, no browser/network involved at all.
// -----------------------------------------------------------------------

test("ConcurrencyLimiter runs up to `max` tasks concurrently and queues the rest", async () => {
  const limiter = new ConcurrencyLimiter(2);
  let concurrent = 0;
  let maxObservedConcurrent = 0;

  async function task(): Promise<void> {
    concurrent += 1;
    maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 20));
    concurrent -= 1;
  }

  await Promise.all([limiter.run(task), limiter.run(task), limiter.run(task), limiter.run(task), limiter.run(task)]);

  assert.equal(maxObservedConcurrent, 2, "never more than 2 tasks should run at once");
  assert.equal(limiter.activeCount(), 0, "all tasks should have released their slot");
});

test("ConcurrencyLimiter releases a slot even if the task throws", async () => {
  const limiter = new ConcurrencyLimiter(1);

  await assert.rejects(() =>
    limiter.run(async () => {
      throw new Error("boom");
    }),
  );

  // if the slot wasn't released, this would hang forever
  let ran = false;
  await limiter.run(async () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.equal(limiter.activeCount(), 0);
});

test("ConcurrencyLimiter with max=1 fully serializes tasks", async () => {
  const limiter = new ConcurrencyLimiter(1);
  const order: number[] = [];

  async function task(n: number): Promise<void> {
    order.push(n);
    await new Promise((r) => setTimeout(r, 5));
  }

  await Promise.all([limiter.run(() => task(1)), limiter.run(() => task(2)), limiter.run(() => task(3))]);

  assert.deepEqual(order, [1, 2, 3]);
});

// -----------------------------------------------------------------------
// Shared browser lifecycle - uses an injected fake launchFn, so these
// tests need no real Chromium install at all.
// -----------------------------------------------------------------------

function fakeBrowser(overrides: Partial<{ isConnected: () => boolean }> = {}) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    isConnected: overrides.isConnected ?? (() => true),
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
    },
    async close() {
      (listeners["disconnected"] ?? []).forEach((cb) => cb());
    },
    __emit(event: string) {
      (listeners[event] ?? []).forEach((cb) => cb());
    },
  } as any;
}

test("getSharedBrowser launches once and reuses the same instance across calls", async () => {
  let launchCount = 0;
  const browser = fakeBrowser();
  const launchFn = async () => {
    launchCount += 1;
    return browser;
  };

  try {
    const a = await getSharedBrowser(launchFn);
    const b = await getSharedBrowser(launchFn);
    assert.equal(a, browser);
    assert.equal(b, browser);
    assert.equal(launchCount, 1, "should only launch once");
  } finally {
    await closeSharedBrowser();
  }
});

test("getSharedBrowser relaunches if the previous shared browser disconnected", async () => {
  const first = fakeBrowser({ isConnected: () => false }); // simulate an already-dead handle
  const second = fakeBrowser();
  let calls = 0;
  const launchFn = async () => {
    calls += 1;
    return calls === 1 ? first : second;
  };

  try {
    const a = await getSharedBrowser(launchFn);
    assert.equal(a, first);
    // first.isConnected() reports false, so the next call must relaunch
    const b = await getSharedBrowser(launchFn);
    assert.equal(b, second);
    assert.equal(calls, 2);
  } finally {
    await closeSharedBrowser();
  }
});

test("a rejected launchFn propagates and does not leave a stuck launch promise behind", async () => {
  const failingLaunch = async () => {
    throw new Error("simulated launch failure");
  };
  await assert.rejects(() => getSharedBrowser(failingLaunch), /simulated launch failure/);

  // a subsequent call with a working launchFn must succeed, proving the
  // failed attempt didn't leave anything stuck
  const browser = fakeBrowser();
  const workingLaunch = async () => browser;
  try {
    const result = await getSharedBrowser(workingLaunch);
    assert.equal(result, browser);
  } finally {
    await closeSharedBrowser();
  }
});

test("closeSharedBrowser closes the browser and clears the shared instance", async () => {
  let closed = false;
  const browser = fakeBrowser();
  browser.close = async () => {
    closed = true;
  };
  await getSharedBrowser(async () => browser);
  assert.equal(isSharedBrowserConnected(), true);

  await closeSharedBrowser();
  assert.equal(closed, true);
  assert.equal(isSharedBrowserConnected(), false);
});

test("a 'disconnected' event from the browser itself clears the shared instance proactively", async () => {
  const browser = fakeBrowser();
  await getSharedBrowser(async () => browser);
  assert.equal(isSharedBrowserConnected(), true);

  browser.__emit("disconnected"); // simulate the browser process crashing on its own
  assert.equal(isSharedBrowserConnected(), false, "the disconnected event should proactively clear the shared instance");
});

test("closeSharedBrowser is safe to call when nothing was ever launched", async () => {
  await closeSharedBrowser();
  await closeSharedBrowser(); // idempotent
  assert.equal(isSharedBrowserConnected(), false);
});
