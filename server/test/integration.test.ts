import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import type { AnalysisReport } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let mockServer: Server;
let appServer: Server;
let mockPort: number;
let appPort: number;

before(async () => {
  // Start the mock target site in-process on a random port.
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;

  const app = createApp({ rateLimiter: false }); // this file exercises the pipeline broadly; rate limiting is tested separately
  appServer = app.listen(0);
  await new Promise((r) => appServer.once("listening", r));
  appPort = (appServer.address() as any).port;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
});

async function analyze(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://localhost:${appPort}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `http://localhost:${mockPort}${path}` }),
  });
  return { status: res.status, body: await res.json() };
}

test("GET /api/health responds ok", async () => {
  const res = await fetch(`http://localhost:${appPort}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("analyzing the messy page finds many issues and a low score", async () => {
  const { status, body } = await analyze("/messy");
  assert.equal(status, 200);
  const report = body as AnalysisReport;
  assert.ok(report.issueCounts.total >= 8, `expected >=8 issues, got ${report.issueCounts.total}`);
  assert.ok(report.scores.overall < 70, `expected a low overall score, got ${report.scores.overall}`);
  assert.ok(report.topPriorityIssues.length > 0);
  // sanity: specific known-broken things on /messy are actually caught
  const titles = report.allIssues.map((i) => i.title);
  assert.ok(titles.some((t) => t.includes("Multiple H1")));
  assert.ok(titles.some((t) => t.includes("not compressed")));
});

test("analyzing the clean page finds few or no issues and a high score", async () => {
  const { status, body } = await analyze("/clean");
  assert.equal(status, 200);
  const report = body as AnalysisReport;
  // Note: our local mock target is served over plain HTTP (no TLS in this
  // sandbox), so the one expected critical finding is "not served over
  // HTTPS" - a transport artifact of local testing, not a real page issue.
  // Every OTHER security header is deliberately set correctly on /clean.
  assert.ok(report.scores.overall >= 85, `expected a high overall score, got ${report.scores.overall}`);
  assert.equal(report.issueCounts.critical, 1);
  const criticalTitles = report.allIssues.filter((i) => i.severity === "critical").map((i) => i.title);
  assert.deepEqual(criticalTitles, ["Site is not served over HTTPS"]);
});

test("redirects are detected and flagged", async () => {
  const { body } = await analyze("/redirect-me");
  const report = body as AnalysisReport;
  const redirectIssue = report.allIssues.find((i) => i.title.includes("redirects"));
  assert.ok(redirectIssue);
});

test("invalid URL returns 400 with a clear error", async () => {
  const res = await fetch(`http://localhost:${appPort}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "not-a-url" }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error);
});

test("missing url field returns 400", async () => {
  const res = await fetch(`http://localhost:${appPort}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});
