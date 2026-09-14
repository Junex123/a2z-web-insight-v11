// Real-Chromium, real-HTTP end-to-end test of the includeBrowserVerification
// opt-in flag on POST /api/analyze. Requires `npx playwright install
// chromium` (see README.md).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { closeSharedBrowser } from "../src/browser/browserManager.js";
import type { AnalysisReport } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let mockServer: Server;
let appServer: Server;
let mockPort: number;
let appPort: number;

before(async () => {
  const { createMockApp } = await import("../mock-site/app.js");
  mockServer = createMockApp().listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;

  const app = createApp({ rateLimiter: false });
  appServer = app.listen(0);
  await new Promise((r) => appServer.once("listening", r));
  appPort = (appServer.address() as any).port;
});

after(async () => {
  delete process.env.ALLOW_LOCAL_TARGETS;
  await closeSharedBrowser();
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
});

async function analyze(path: string, includeBrowserVerification?: boolean): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://localhost:${appPort}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `http://localhost:${mockPort}${path}`, includeBrowserVerification }),
  });
  return { status: res.status, body: await res.json() };
}

test("without includeBrowserVerification, the response has no runtimeVerification field", async () => {
  const { status, body } = await analyze("/browser/js-ok");
  assert.equal(status, 200);
  const report = body as AnalysisReport;
  assert.equal(report.runtimeVerification, undefined);
});

test("includeBrowserVerification: true returns a populated runtimeVerification field over the real HTTP API", async () => {
  const { status, body } = await analyze("/browser/js-error", true);
  assert.equal(status, 200);
  const report = body as AnalysisReport;
  assert.ok(report.runtimeVerification);
  assert.equal(report.runtimeVerification!.status, "completed");
  assert.ok(report.runtimeVerification!.findings.some((f: any) => /Uncaught JavaScript error/.test(f.title)));
});
