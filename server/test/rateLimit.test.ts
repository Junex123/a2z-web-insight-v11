import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createRateLimiter } from "../src/middleware/rateLimit.js";

function buildTestApp(max: number, windowMs: number, now?: () => number) {
  const app = express();
  app.use(createRateLimiter({ max, windowMs, now, keyFn: () => "fixed-test-key" }));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

async function request(server: import("node:http").Server, path: string) {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return fetch(`http://localhost:${port}${path}`);
}

test("requests below the threshold are allowed", async () => {
  const app = buildTestApp(3, 60_000);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  const r1 = await request(server, "/ping");
  const r2 = await request(server, "/ping");
  const r3 = await request(server, "/ping");

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);

  await new Promise((r) => server.close(r));
});

test("a request beyond the threshold gets HTTP 429 with a Retry-After header", async () => {
  const app = buildTestApp(2, 60_000);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  await request(server, "/ping");
  await request(server, "/ping");
  const blocked = await request(server, "/ping");

  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
  const body = (await blocked.json()) as { code?: string };
  assert.equal(body.code, "RATE_LIMITED");

  await new Promise((r) => server.close(r));
});

test("the limit resets once the window elapses", async () => {
  let now = 0;
  const app = buildTestApp(1, 1_000, () => now);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  const first = await request(server, "/ping");
  assert.equal(first.status, 200);

  const secondBlocked = await request(server, "/ping");
  assert.equal(secondBlocked.status, 429);

  now += 1_001; // past the 1s window
  const afterReset = await request(server, "/ping");
  assert.equal(afterReset.status, 200);

  await new Promise((r) => server.close(r));
});

test("different keys (e.g. different IPs) are tracked independently", async () => {
  const app = express();
  let currentKey = "a";
  app.use(createRateLimiter({ max: 1, windowMs: 60_000, keyFn: () => currentKey }));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  currentKey = "a";
  const a1 = await request(server, "/ping");
  assert.equal(a1.status, 200);

  currentKey = "b";
  const b1 = await request(server, "/ping"); // different key, should not be blocked by "a"'s usage
  assert.equal(b1.status, 200);

  currentKey = "a";
  const a2 = await request(server, "/ping"); // "a" is now over its own limit
  assert.equal(a2.status, 429);

  await new Promise((r) => server.close(r));
});

test("X-RateLimit-Remaining header counts down correctly", async () => {
  const app = buildTestApp(3, 60_000);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  const r1 = await request(server, "/ping");
  const r2 = await request(server, "/ping");

  assert.equal(r1.headers.get("x-ratelimit-remaining"), "2");
  assert.equal(r2.headers.get("x-ratelimit-remaining"), "1");

  await new Promise((r) => server.close(r));
});
