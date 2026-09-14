import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLaunchReadiness } from "../src/analysis/launchReadiness.js";
import type { CoreWebVitalsReport, Issue, RuntimeFinding, RuntimeVerificationReport } from "../src/types.js";

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    category: "seo",
    severity: "medium",
    title: "test issue",
    affected: "https://example.com",
    whyItMatters: "because",
    recommendedFix: "fix it",
    difficulty: "easy",
    priorityScore: 40,
    source: "measured",
    evidence: [],
    ...overrides,
  };
}

function runtimeFinding(overrides: Partial<RuntimeFinding>): RuntimeFinding {
  return {
    id: "runtime-1",
    severity: "critical",
    title: "test runtime finding",
    affected: "https://example.com",
    whyItMatters: "because",
    recommendedFix: "fix it",
    difficulty: "easy",
    source: "measured",
    evidence: [],
    ...overrides,
  };
}

const availableCwv: CoreWebVitalsReport = {
  providerName: "pagespeed-insights",
  providerStatus: "available",
  evidence: null,
  factors: [],
  cached: false,
};

const notConfiguredCwv: CoreWebVitalsReport = {
  ...availableCwv,
  providerStatus: "not_configured",
  errorMessage: "No API key configured.",
};

const cleanAccessibilityCoverage = { checkedAreas: ["html lang attribute"], notVerifiable: ["color contrast"] };

test("a clean site (no issues) is READY, with a green headline and no must-fix/important findings", () => {
  const result = computeLaunchReadiness({
    allIssues: [],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.verdict, "ready");
  assert.match(result.headline, /🟢/);
  assert.deepEqual(result.mustFix, []);
  assert.deepEqual(result.important, []);
  assert.deepEqual(result.passedCategories.sort(), ["accessibility", "performance", "responsiveness", "security", "seo", "ux"]);
});

test("a warning site (only high-severity issues, no criticals) is ALMOST_READY with a yellow headline", () => {
  const result = computeLaunchReadiness({
    allIssues: [issue({ severity: "high", category: "seo" }), issue({ severity: "medium", category: "performance" })],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.verdict, "almost_ready");
  assert.match(result.headline, /🟡/);
  assert.equal(result.mustFix.length, 0);
  assert.equal(result.important.length, 1);
  assert.equal(result.improvements.length, 1);
  assert.match(result.summary, /1 thing you should fix/);
});

test("a critical site (any critical-severity issue) is NOT_READY with a red headline, regardless of how many other findings exist", () => {
  const result = computeLaunchReadiness({
    allIssues: [
      issue({ severity: "critical", category: "security", title: "Site is not served over HTTPS" }),
      issue({ severity: "high", category: "seo" }),
      issue({ severity: "low", category: "performance" }),
    ],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.verdict, "not_ready");
  assert.match(result.headline, /🔴/);
  assert.equal(result.mustFix.length, 1);
  assert.equal(result.mustFix[0].issue.title, "Site is not served over HTTPS");
  assert.equal(result.important.length, 1);
  assert.equal(result.improvements.length, 1);
});

test("headline/summary pluralization: exactly one must-fix says 'thing', more than one says 'things'", () => {
  const one = computeLaunchReadiness({
    allIssues: [issue({ severity: "critical" })],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.match(one.summary, /1 thing you must fix/);
  assert.doesNotMatch(one.summary, /1 things/);

  const three = computeLaunchReadiness({
    allIssues: [issue({ severity: "critical" }), issue({ severity: "critical" }), issue({ severity: "critical" })],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.match(three.summary, /3 things you must fix/);
});

test("UNVERIFIED never silently becomes FAILED: browser verification not requested does not push the verdict toward not_ready", () => {
  const result = computeLaunchReadiness({
    allIssues: [], // no static-analysis issues at all
    coreWebVitals: availableCwv,
    runtimeVerification: undefined, // browser checks simply weren't run
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.verdict, "ready", "an unchecked area must never count as a failure");
  assert.equal(result.unverifiedAreas.length, 1);
  assert.match(result.unverifiedAreas[0].area, /Real-browser checks/);
  assert.match(result.unverifiedAreas[0].reason, /opt-in|not requested/i);
});

test("UNVERIFIED is distinct from FAILED even when browser verification was attempted but errored", () => {
  const erroredRuntime: RuntimeVerificationReport = {
    status: "error",
    errorMessage: "Browser navigation timed out.",
    errorCode: "BROWSER_TIMEOUT",
    evidence: null,
    findings: [],
  };
  const result = computeLaunchReadiness({
    allIssues: [],
    coreWebVitals: availableCwv,
    runtimeVerification: erroredRuntime,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.verdict, "ready");
  assert.equal(result.unverifiedAreas.length, 1);
  assert.match(result.unverifiedAreas[0].reason, /timed out/);
});

test("a completed browser verification's findings ARE counted toward the verdict, using the same severity->priority mapping", () => {
  const completedRuntime: RuntimeVerificationReport = {
    status: "completed",
    evidence: null as any,
    findings: [runtimeFinding({ severity: "critical", title: "Page renders blank after JavaScript execution" })],
  };
  const result = computeLaunchReadiness({
    allIssues: [],
    coreWebVitals: availableCwv,
    runtimeVerification: completedRuntime,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.verdict, "not_ready");
  assert.equal(result.mustFix.length, 1);
  assert.equal(result.mustFix[0].category, "runtime");
  assert.equal(result.unverifiedAreas.length, 0, "a completed run has nothing to report as unverified");
});

test("Core Web Vitals unavailable is surfaced as unverified, not as a failure, and does not affect the verdict", () => {
  const result = computeLaunchReadiness({
    allIssues: [],
    coreWebVitals: notConfiguredCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.verdict, "ready");
  const cwvArea = result.unverifiedAreas.find((a) => /Core Web Vitals/.test(a.area));
  assert.ok(cwvArea);
  assert.equal(cwvArea!.reason, "No API key configured.");
});

test("accessibility's notVerifiable list is folded into unverifiedAreas", () => {
  const result = computeLaunchReadiness({
    allIssues: [],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: cleanAccessibilityCoverage,
    fetchQuality: "usable",
  });
  assert.ok(result.unverifiedAreas.some((a) => a.area === "color contrast"));
});

test("passedCategories only includes categories with literally zero issues", () => {
  const result = computeLaunchReadiness({
    allIssues: [issue({ category: "seo", severity: "low" })],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.ok(!result.passedCategories.includes("seo"));
  assert.ok(result.passedCategories.includes("performance"));
  assert.ok(result.passedCategories.includes("security"));
  assert.ok(result.passedCategories.includes("accessibility"));
});

test("technical evidence is preserved unmodified on every prioritized finding - nothing is stripped for the human-readable view", () => {
  const originalIssue = issue({
    severity: "critical",
    evidence: [{ type: "header", label: "Strict-Transport-Security", value: "missing" }],
    estimatedImpact: "some impact detail",
  });
  const result = computeLaunchReadiness({
    allIssues: [originalIssue],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.deepEqual(result.mustFix[0].issue, originalIssue);
});

test("medium and low severities both bucket as improvements, not important or must-fix", () => {
  const result = computeLaunchReadiness({
    allIssues: [issue({ severity: "medium" }), issue({ severity: "low" })],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    fetchQuality: "usable",
  });
  assert.equal(result.improvements.length, 2);
  assert.equal(result.mustFix.length, 0);
  assert.equal(result.important.length, 0);
});


test("empty fetch content does not turn SEO/accessibility absence findings into launch blockers", () => {
  const result = computeLaunchReadiness({
    allIssues: [
      issue({ severity: "critical", category: "seo" }),
      issue({ severity: "high", category: "accessibility" }),
      issue({ severity: "medium", category: "security" }),
    ],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: cleanAccessibilityCoverage,
    fetchQuality: "empty",
  });
  assert.equal(result.mustFix.length, 0);
  assert.equal(result.important.length, 1);
  assert.deepEqual(result.unverifiedAreas.slice(0, 2).map((x) => x.area), [
    "SEO (page content analysis)",
    "Accessibility (page content analysis)",
  ]);
});

test("usable fetch content leaves SEO/accessibility findings in the normal readiness calculation", () => {
  const result = computeLaunchReadiness({
    allIssues: [issue({ severity: "critical", category: "seo" })],
    coreWebVitals: availableCwv,
    runtimeVerification: undefined,
    accessibilityCoverage: cleanAccessibilityCoverage,
    fetchQuality: "usable",
  });
  assert.equal(result.mustFix.length, 1);
});
