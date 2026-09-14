import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let mockServer: Server;
let mockPort: number;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

test("POST /api/analyze is rate limited per the configured threshold, returning 429 with Retry-After", async () => {
  const app = createApp({ rateLimiter: { max: 2, windowMs: 60_000 } });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  const post = () =>
    fetch(`http://localhost:${port}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://localhost:${mockPort}/clean` }),
    });

  const r1 = await post();
  const r2 = await post();
  const r3 = await post();

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.ok(r3.headers.get("retry-after"));
  const body = (await r3.json()) as { code?: string; retryAfterSeconds?: number };
  assert.equal(body.code, "RATE_LIMITED");
  assert.ok(typeof body.retryAfterSeconds === "number");

  await new Promise((r) => server.close(r));
});

test("rateLimiter: false disables rate limiting entirely", async () => {
  const app = createApp({ rateLimiter: false });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  const post = () =>
    fetch(`http://localhost:${port}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://localhost:${mockPort}/clean` }),
    });

  for (let i = 0; i < 5; i++) {
    const res = await post();
    assert.equal(res.status, 200, `request ${i + 1} should not be rate limited`);
  }

  await new Promise((r) => server.close(r));
});

test("an oversized request body is rejected cleanly with 413, not a crash", async () => {
  const app = createApp({ rateLimiter: false });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  const hugeUrl = "https://example.com/" + "a".repeat(200_000); // well over the 100kb JSON body limit
  const res = await fetch(`http://localhost:${port}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: hugeUrl }),
  });

  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string; code?: string };
  assert.ok(body.error);
  assert.equal(body.code, "PAYLOAD_TOO_LARGE");

  // server must still be alive after this
  const health = await fetch(`http://localhost:${port}/api/health`);
  assert.equal(health.status, 200);

  await new Promise((r) => server.close(r));
});

test("malformed JSON body is rejected cleanly, not a crash", async () => {
  const app = createApp({ rateLimiter: false });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  const res = await fetch(`http://localhost:${port}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not valid json",
  });

  assert.ok(res.status >= 400 && res.status < 500);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error);

  const health = await fetch(`http://localhost:${port}/api/health`);
  assert.equal(health.status, 200);

  await new Promise((r) => server.close(r));
});
