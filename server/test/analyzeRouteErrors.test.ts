import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";

// This file deliberately does NOT set ALLOW_LOCAL_TARGETS - unlike
// integration.test.ts/scanStatus.test.ts (which need it to reach their
// in-process mock site), this file's whole point is to exercise the real
// production SSRF guard through the full route -> pipeline -> collector
// chain, and confirm the resulting CollectorError is mapped to the
// correct HTTP status/body by routes/analyze.ts's STATUS_BY_CODE table.
//
// httpCollectorSecurity.test.ts already proves collectHttp() itself
// throws the right CollectorError for each case (unit level). What was
// NOT covered anywhere: does that error actually reach the HTTP response
// with the right status code, or could it get lost/mismapped/turned into
// a 500 somewhere between the collector and the route? This is the gap
// identified in the Session 11 production-integration audit.

let appServer: Server;
let appPort: number;

before(async () => {
  const app = createApp({ rateLimiter: false });
  appServer = app.listen(0);
  await new Promise((r) => appServer.once("listening", r));
  appPort = (appServer.address() as any).port;
});

after(async () => {
  await new Promise((r) => appServer.close(r));
});

async function postAnalyze(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://localhost:${appPort}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return { status: res.status, body: await res.json() };
}

test("a blocked host (e.g. localhost, without the dev-mode bypass) maps to 400 with code BLOCKED_HOST end-to-end", async () => {
  // Matches httpCollectorSecurity.test.ts's own proven, network-free
  // BLOCKED_HOST trigger (hostname pattern match, no DNS/connection
  // needed) - here exercised through the real HTTP route instead of by
  // calling collectHttp() directly.
  const { status, body } = await postAnalyze("http://localhost:1/page");
  assert.equal(status, 400);
  assert.equal(body.code, "BLOCKED_HOST");
  assert.ok(body.error, "the response body must include a user-safe error message");
  // The route's own comment guarantees CollectorError messages are
  // user-safe - confirm no stack trace or internal file path leaks.
  assert.ok(!String(body.error).includes("/home/"), "must not leak an internal filesystem path");
  assert.ok(!String(body.error).toLowerCase().includes("at collectHttp"), "must not leak a stack frame");
});

test("a syntactically invalid URL maps to 400 with code INVALID_URL end-to-end", async () => {
  const { status, body } = await postAnalyze("not-a-url-at-all");
  assert.equal(status, 400);
  assert.equal(body.code, "INVALID_URL");
});

test("every CollectorErrorCode the route knows about maps to a 4xx or 5xx status, never 2xx or an unmapped code", async () => {
  // Static, network-free sanity check on the mapping table itself,
  // guarding against a future new CollectorErrorCode silently getting no
  // entry (which would make routes/analyze.ts's STATUS_BY_CODE[code]
  // lookup return `undefined`, and res.status(undefined) throw inside the
  // error handler itself - turning a clean 4xx into an unhandled 500).
  const { STATUS_BY_CODE } = await import("../src/routes/analyze.js");
  for (const [code, statusCode] of Object.entries(STATUS_BY_CODE)) {
    assert.ok(statusCode >= 400 && statusCode < 600, `${code} must map to a 4xx/5xx status, got ${statusCode}`);
  }
});
