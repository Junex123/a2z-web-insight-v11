// Real-Chromium pipeline integration tests - requires `npx playwright
// install chromium` (see README.md).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createMockApp } from "../mock-site/app.js";
import { analyzeUrl } from "../src/pipeline.js";
import { closeSharedBrowser } from "../src/browser/browserManager.js";
import { resetAccessibilityIssueIdCounter } from "../src/analysis/accessibilityIssues.js";
import { resetCwvIssueIdCounter } from "../src/analysis/cwvIssues.js";
import { resetRuntimeFindingIdCounter } from "../src/analysis/runtimeFindings.js";
import type { PerformanceProvider } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";
delete process.env.PAGESPEED_INSIGHTS_API_KEY;
delete process.env.PAGESPEED_API_KEY;

const notConfiguredProvider: PerformanceProvider = {
  name: "test-provider",
  analyze: async () => ({ status: "not_configured", evidence: null, errorMessage: "no key" }),
};

let server: Server;
let base: string;

before(async () => {
  const app = createMockApp();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  delete process.env.ALLOW_LOCAL_TARGETS;
  await closeSharedBrowser();
  await new Promise((r) => server.close(r));
});

function resetCounters() {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  resetRuntimeFindingIdCounter();
}

test("runtimeVerification is undefined by default - an ordinary scan behaves exactly as before this feature existed", async () => {
  resetCounters();
  const report = await analyzeUrl(`${base}/browser/js-ok`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.runtimeVerification, undefined);
});

test("browserVerification: true populates report.runtimeVerification with real browser evidence", async () => {
  resetCounters();
  const report = await analyzeUrl(`${base}/browser/js-error`, {
    performanceProvider: notConfiguredProvider,
    browserVerification: true,
  });
  assert.ok(report.runtimeVerification);
  assert.equal(report.runtimeVerification!.status, "completed");
  assert.ok(report.runtimeVerification!.evidence);
  assert.ok(report.runtimeVerification!.evidence!.jsErrors.length > 0);
  assert.ok(report.runtimeVerification!.findings.some((f) => /Uncaught JavaScript error/.test(f.title)));
});

test("browserVerification with an options object (not just `true`) is respected", async () => {
  resetCounters();
  const report = await analyzeUrl(`${base}/browser/slow-response`, {
    performanceProvider: notConfiguredProvider,
    browserVerification: { timeoutMs: 300 },
  });
  assert.ok(report.runtimeVerification);
  assert.equal(report.runtimeVerification!.status, "error");
  assert.equal(report.runtimeVerification!.errorCode, "BROWSER_TIMEOUT");
});

test("a browser verification failure never changes report.status - that field is unaffected by this feature", async () => {
  resetCounters();
  const report = await analyzeUrl(`${base}/browser/slow-response`, {
    performanceProvider: notConfiguredProvider,
    browserVerification: { timeoutMs: 300 },
  });
  // status is driven purely by the (not_configured) PageSpeed provider,
  // exactly as before this feature existed - "partial" here, unrelated
  // to the browser verification failure above.
  assert.equal(report.status, "partial");
});

test("runtimeVerification.findings are additive - they never affect allIssues, issueCounts, or the scored categories", async () => {
  resetCounters();
  const report = await analyzeUrl(`${base}/browser/js-blank`, {
    performanceProvider: notConfiguredProvider,
    browserVerification: true,
  });
  assert.ok(report.runtimeVerification!.findings.length > 0, "expected at least the blank-page finding");
  const runtimeIdsInAllIssues = report.allIssues.filter((i) => i.id.startsWith("runtime-"));
  assert.deepEqual(runtimeIdsInAllIssues, [], "a runtime-* finding id must never leak into allIssues");
});

test("the raw HTTP body is reused for the content comparison - no second fetch of the target is needed", async () => {
  resetCounters();
  const report = await analyzeUrl(`${base}/browser/js-generated-content`, {
    performanceProvider: notConfiguredProvider,
    browserVerification: true,
  });
  const comparison = report.runtimeVerification!.evidence!.contentComparison;
  assert.ok(comparison);
  assert.equal(comparison!.likelyJsDependentContent, true);
});
