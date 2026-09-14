import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRuntimeFindings, resetRuntimeFindingIdCounter } from "../src/analysis/runtimeFindings.js";
import type { RuntimeVerificationEvidence } from "../src/types.js";

function baseEvidence(overrides: Partial<RuntimeVerificationEvidence> = {}): RuntimeVerificationEvidence {
  return {
    requestedUrl: "http://example.test/",
    finalUrl: "http://example.test/",
    httpStatus: 200,
    navigationOk: true,
    jsErrors: [],
    consoleMessages: [],
    requests: [],
    forms: [],
    domSnapshot: { visibleTextLength: 500, visibleTextSample: "Hello world", elementCount: 20, hasBodyContent: true },
    contentComparison: null,
    screenshot: null,
    timing: { navigationMs: 100, totalMs: 100 },
    viewport: { width: 1280, height: 800 },
    engine: "chromium",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("a clean page produces zero findings", () => {
  resetRuntimeFindingIdCounter();
  const findings = detectRuntimeFindings(baseEvidence());
  assert.deepEqual(findings, []);
});

test("an uncaught JS exception produces a critical finding", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    jsErrors: [{ message: "ReferenceError: foo is not defined", stack: "at <anonymous>", source: "pageerror" }],
  });
  const findings = detectRuntimeFindings(evidence);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "critical");
  assert.match(findings[0].title, /Uncaught JavaScript error/);
  assert.ok(findings[0].evidence.length > 0);
});

test("a console-error-sourced jsError does NOT also trigger the uncaught-exception rule", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    jsErrors: [{ message: "deliberate test console error", stack: null, source: "console-error" }],
    consoleMessages: [{ level: "error", text: "deliberate test console error" }],
  });
  const findings = detectRuntimeFindings(evidence);
  assert.equal(findings.length, 1, "only the console-error rule should fire, not the uncaught-exception rule");
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /Console errors/);
});

test("console warnings never produce a finding on their own", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    consoleMessages: [
      { level: "warning", text: "deprecated API used" },
      { level: "warning", text: "another warning" },
    ],
  });
  const findings = detectRuntimeFindings(evidence);
  assert.deepEqual(findings, []);
});

test("a failed first-party document/xhr/fetch request is critical severity", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    requests: [
      { url: "http://example.test/api/data", resourceType: "xhr", method: "GET", isFirstParty: true, status: null, ok: null, failureReason: "net::ERR_CONNECTION_REFUSED", outcome: "failed" },
    ],
  });
  const findings = detectRuntimeFindings(evidence);
  const found = findings.find((f) => /First-party requests failed/.test(f.title));
  assert.ok(found);
  assert.equal(found!.severity, "critical");
});

test("a failed first-party image (non-critical resource type) is high, not critical, severity", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    requests: [
      { url: "http://example.test/hero.png", resourceType: "image", method: "GET", isFirstParty: true, status: 404, ok: false, failureReason: "HTTP 404", outcome: "failed" },
    ],
  });
  const findings = detectRuntimeFindings(evidence);
  const found = findings.find((f) => /First-party requests failed/.test(f.title));
  assert.ok(found);
  assert.equal(found!.severity, "high");
});

test("third-party request failures NEVER produce a finding, regardless of count", () => {
  resetRuntimeFindingIdCounter();
  const manyThirdPartyFailures = Array.from({ length: 20 }, (_, i) => ({
    url: `http://ad-network.invalid/pixel${i}.gif`,
    resourceType: "image",
    method: "GET",
    isFirstParty: false,
    status: null,
    ok: null,
    failureReason: "net::ERR_NAME_NOT_RESOLVED",
    outcome: "failed" as const,
  }));
  const findings = detectRuntimeFindings(baseEvidence({ requests: manyThirdPartyFailures }));
  assert.deepEqual(findings, [], "no finding should ever be produced purely from third-party failures");
});

test("a mix of first-party and third-party failures only reports the first-party ones", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    requests: [
      { url: "http://example.test/app.js", resourceType: "script", method: "GET", isFirstParty: true, status: 404, ok: false, failureReason: "HTTP 404", outcome: "failed" },
      { url: "http://ads.invalid/tracker.js", resourceType: "script", method: "GET", isFirstParty: false, status: null, ok: null, failureReason: "net::ERR_NAME_NOT_RESOLVED", outcome: "failed" },
    ],
  });
  const findings = detectRuntimeFindings(evidence);
  const found = findings.find((f) => /First-party requests failed/.test(f.title));
  assert.ok(found);
  assert.equal(found!.estimatedImpact!.includes("1 first-party"), true);
});

test("a blank rendered page (no body content) produces a critical finding", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    domSnapshot: { visibleTextLength: 0, visibleTextSample: "", elementCount: 3, hasBodyContent: false },
  });
  const findings = detectRuntimeFindings(evidence);
  const found = findings.find((f) => /renders blank/.test(f.title));
  assert.ok(found);
  assert.equal(found!.severity, "critical");
});

test("JS-dependent content that successfully renders real content does NOT trigger the blank-page finding", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    domSnapshot: { visibleTextLength: 800, visibleTextSample: "Real content, rendered by JavaScript.", elementCount: 40, hasBodyContent: true },
    contentComparison: { rawHtmlVisibleTextLength: 0, renderedVisibleTextLength: 800, likelyJsDependentContent: true },
  });
  const findings = detectRuntimeFindings(evidence);
  assert.deepEqual(
    findings.filter((f) => /renders blank/.test(f.title)),
    [],
  );
});

test("a non-ok final navigation status produces a high-severity finding", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({ navigationOk: false, httpStatus: 500 });
  const findings = detectRuntimeFindings(evidence);
  const found = findings.find((f) => /did not load successfully/.test(f.title));
  assert.ok(found);
  assert.equal(found!.severity, "high");
  assert.match(found!.estimatedImpact!, /500/);
});

test("an insecure (http://) form action from an https page produces a high-severity finding", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    finalUrl: "https://example.test/",
    forms: [{ action: "http://insecure.example/collect", method: "post", isHttpsPage: true, actionIsInsecureHttp: true, hasSubmitControl: true }],
  });
  const findings = detectRuntimeFindings(evidence);
  const found = findings.find((f) => /insecure http:\/\/ URL/.test(f.title));
  assert.ok(found);
  assert.equal(found!.severity, "high");
});

test("a form action is NOT flagged when the page itself is not https", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    finalUrl: "http://example.test/",
    forms: [{ action: "http://example.test/submit", method: "post", isHttpsPage: false, actionIsInsecureHttp: false, hasSubmitControl: true }],
  });
  const findings = detectRuntimeFindings(evidence);
  assert.deepEqual(
    findings.filter((f) => /insecure http:\/\/ URL/.test(f.title)),
    [],
  );
});

test("multiple independent problems each produce their own finding, all with unique ids", () => {
  resetRuntimeFindingIdCounter();
  const evidence = baseEvidence({
    jsErrors: [{ message: "boom", stack: null, source: "pageerror" }],
    navigationOk: false,
    httpStatus: 503,
    domSnapshot: { visibleTextLength: 500, visibleTextSample: "x", elementCount: 10, hasBodyContent: true },
  });
  const findings = detectRuntimeFindings(evidence);
  assert.equal(findings.length, 2); // uncaught JS error + non-ok navigation; page is NOT blank here
  const ids = findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "every finding must have a unique id");
  for (const f of findings) {
    assert.ok(f.whyItMatters.length > 0);
    assert.ok(f.recommendedFix.length > 0);
    assert.ok(f.evidence.length > 0);
  }
});

test("resetRuntimeFindingIdCounter resets ids back to runtime-1", () => {
  resetRuntimeFindingIdCounter();
  const first = detectRuntimeFindings(baseEvidence({ jsErrors: [{ message: "x", stack: null, source: "pageerror" }] }));
  assert.equal(first[0].id, "runtime-1");

  resetRuntimeFindingIdCounter();
  const second = detectRuntimeFindings(baseEvidence({ jsErrors: [{ message: "x", stack: null, source: "pageerror" }] }));
  assert.equal(second[0].id, "runtime-1");
});
