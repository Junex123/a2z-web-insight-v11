import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import type { AnalysisReport } from "../src/types.js";

// Full-pipeline integration test for the launch-readiness engine:
// AnalysisReport -> launchDecision -> structured readiness result, using
// the real deterministic pipeline against the bundled local mock target
// site (no external websites, no network dependency - same pattern as
// test/integration.test.ts).

process.env.ALLOW_LOCAL_TARGETS = "true";

let mockServer: Server;
let appServer: Server;
let mockPort: number;
let appPort: number;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;

  const app = createApp({ rateLimiter: false });
  appServer = app.listen(0);
  await new Promise((r) => appServer.once("listening", r));
  appPort = (appServer.address() as any).port;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
});

async function analyze(path: string): Promise<AnalysisReport> {
  const res = await fetch(`http://localhost:${appPort}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `http://localhost:${mockPort}${path}` }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as AnalysisReport;
}

test("the API response includes a fully-formed launchDecision", async () => {
  const report = await analyze("/clean");
  assert.ok(report.launchDecision);
  assert.ok(["READY", "READY_WITH_WARNINGS", "NOT_READY"].includes(report.launchDecision.status));
  assert.ok(Array.isArray(report.launchDecision.blockers));
  assert.ok(Array.isArray(report.launchDecision.categoryReadiness));
  assert.equal(report.launchDecision.categoryReadiness.length, report.categoriesAnalyzed.length);
});

test("/clean is NOT_READY because the local mock target is plain HTTP - a real, evidence-backed blocker, not a fabricated one", async () => {
  const report = await analyze("/clean");
  // The mock site itself has no TLS in this sandboxed test environment
  // (see test/integration.test.ts's identical note), so the one expected
  // blocker is the HTTPS one - everything else on /clean is deliberately
  // clean, which is exactly why this is a good end-to-end check: a real,
  // measured HTTP fact drives the decision, nothing invented.
  assert.equal(report.launchDecision.status, "NOT_READY");
  assert.equal(report.launchDecision.blockers.length, 1);
  assert.equal(report.launchDecision.blockers[0].title, "Site is not served over HTTPS");
  assert.equal(report.launchDecision.blockers[0].category, "security");
  assert.ok(report.launchDecision.blockers[0].affected.includes(report.url));
  assert.equal(report.launchDecision.whyNotReady.length, 1);
  assert.match(report.launchDecision.whyNotReady[0], /HTTPS/);
});

test("/messy has the same HTTPS blocker plus its many other findings correctly demoted to warnings", async () => {
  const report = await analyze("/messy");
  assert.equal(report.launchDecision.status, "NOT_READY");
  assert.equal(report.launchDecision.blockers.length, 1, "only the curated HTTPS rule blocks - the many other /messy findings are warnings, not extra blockers");
  assert.ok(report.launchDecision.warnings.length > 0, "/messy has real non-blocking findings too (e.g. missing compression, multiple H1s)");
  // every warning issueId must trace back to a real Issue on the report
  const allIssueIds = new Set(report.allIssues.map((i) => i.id));
  for (const w of report.launchDecision.warnings) {
    for (const id of w.issueIds) assert.ok(allIssueIds.has(id), `warning issueId ${id} must trace to a real Issue`);
  }
  for (const id of report.launchDecision.blockers[0].issueIds) assert.ok(allIssueIds.has(id));
});

test("scanCompleteness honestly reflects that roadmap categories beyond the current four are not yet implemented", async () => {
  const report = await analyze("/clean");
  assert.equal(report.launchDecision.scanCompleteness.isComplete, false);
  assert.ok(report.launchDecision.scanCompleteness.categoriesUnavailable.length > 0);
});

test("prioritizedFixes puts the blocker first and every entry traces to real issueIds", async () => {
  const report = await analyze("/messy");
  const fixes = report.launchDecision.prioritizedFixes;
  assert.ok(fixes.length > 0);
  assert.equal(fixes[0].blocking, true);
  const allIssueIds = new Set(report.allIssues.map((i) => i.id));
  for (const f of fixes) {
    for (const id of f.issueIds) assert.ok(allIssueIds.has(id));
  }
});
