import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeEvidenceCoverage } from "../src/analysis/evidenceInventory.js";
import type { AnalysisReport, CoreWebVitalsReport, Issue, PerformanceVerificationEntry, PerformanceVerificationSummary } from "../src/types.js";

function makeIssue(category: Issue["category"], severity: Issue["severity"], title = "x"): Issue {
  return {
    id: `id-${Math.random()}`,
    category,
    severity,
    title,
    affected: "https://example.com/",
    whyItMatters: "why",
    recommendedFix: "fix",
    difficulty: "easy",
    priorityScore: 1,
    source: "measured",
    evidence: [],
  };
}

function emptyCwv(): CoreWebVitalsReport {
  return { providerName: "fake", providerStatus: "not_configured", evidence: null, factors: [], cached: false };
}

function perfVerification(states: PerformanceVerificationEntry["state"][]): PerformanceVerificationSummary {
  const entries = states.map((state, i) => ({ area: `area-${i}`, label: `label-${i}`, state, measurementMethod: "test", note: "" }));
  (entries as PerformanceVerificationSummary).checks = [];
  return entries as PerformanceVerificationSummary;
}

function baseReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    reportId: "r1",
    url: "https://example.com/",
    scannedAt: new Date().toISOString(),
    status: "success",
    scores: { performance: 100, seo: 100, security: 100, accessibility: 100, ux: 100, responsiveness: 100, overall: 100 },
    categoriesAnalyzed: ["performance", "seo", "security", "accessibility"],
    categoriesNotYetAnalyzed: [],
    issueCounts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    topPriorityIssues: [],
    allIssues: [],
    coreWebVitals: emptyCwv(),
    fetchQuality: "usable",
    accessibilityCoverage: { checkedAreas: ["alt text"], notVerifiable: ["keyboard navigation"] },
    performanceVerification: perfVerification(["verified"]),
    responsiveVerification: { mobile: { passed: 0, warnings: 0, failures: 0, unverified: 0 }, desktop: { passed: 0, warnings: 0, failures: 0, unverified: 0 }, checks: [] },
    evidenceLog: { fetch: {} as any, html: {} as any, accessibility: {} as any, seo: {} as any, security: {} as any, ux: {} as any, responsive: {} as any },
    ...overrides,
  } as any;
}

test("performance and accessibility are reported as having a dedicated verification model; security and seo are not", () => {
  const summary = summarizeEvidenceCoverage(baseReport());
  const byCategory = Object.fromEntries(summary.domains.map((d) => [d.category, d]));
  assert.equal(byCategory.performance.hasDedicatedVerificationModel, true);
  assert.equal(byCategory.accessibility.hasDedicatedVerificationModel, true);
  assert.equal(byCategory.security.hasDedicatedVerificationModel, false);
  assert.equal(byCategory.seo.hasDedicatedVerificationModel, false);
  assert.deepEqual(summary.domainsWithDedicatedVerificationModel.sort(), ["accessibility", "performance", "responsiveness"]);
  assert.deepEqual(summary.domainsWithBaselineRulesOnly.sort(), ["security", "seo", "ux"]);
});

test("issue counts and severity breakdown are computed per domain from allIssues", () => {
  const report = baseReport({
    allIssues: [
      makeIssue("security", "critical", "Site is not served over HTTPS"),
      makeIssue("security", "medium", "No Referrer-Policy header"),
      makeIssue("seo", "low", "Missing canonical tag"),
    ],
  });
  const summary = summarizeEvidenceCoverage(report);
  const security = summary.domains.find((d) => d.category === "security")!;
  assert.equal(security.issueCount, 2);
  assert.equal(security.bySeverity.critical, 1);
  assert.equal(security.bySeverity.medium, 1);
  const seo = summary.domains.find((d) => d.category === "seo")!;
  assert.equal(seo.issueCount, 1);
  const performance = summary.domains.find((d) => d.category === "performance")!;
  assert.equal(performance.issueCount, 0);
});

test("performance domain exposes the report's actual verification states, not a fabricated one", () => {
  const report = baseReport({ performanceVerification: perfVerification(["unverified", "warning", "verified"]) });
  const performance = summarizeEvidenceCoverage(report).domains.find((d) => d.category === "performance")!;
  assert.deepEqual(performance.verificationStates, ["unverified", "warning", "verified"]);
});

test("accessibility domain exposes the report's actual notVerifiable list", () => {
  const report = baseReport({ accessibilityCoverage: { checkedAreas: [], notVerifiable: ["color contrast", "focus order"] } });
  const accessibility = summarizeEvidenceCoverage(report).domains.find((d) => d.category === "accessibility")!;
  assert.deepEqual(accessibility.notVerifiable, ["color contrast", "focus order"]);
});

test("security and seo never report verificationStates or notVerifiable (no such model exists for them today)", () => {
  const summary = summarizeEvidenceCoverage(baseReport());
  const security = summary.domains.find((d) => d.category === "security")!;
  const seo = summary.domains.find((d) => d.category === "seo")!;
  assert.equal(security.verificationStates, null);
  assert.equal(security.notVerifiable, null);
  assert.equal(seo.verificationStates, null);
  assert.equal(seo.notVerifiable, null);
});

test("an empty-issue clean report still reports all four domains, never omitting one", () => {
  const summary = summarizeEvidenceCoverage(baseReport());
  assert.equal(summary.domains.length, 6);
  assert.deepEqual(
    summary.domains.map((d) => d.category).sort(),
    ["accessibility", "performance", "security", "seo"],
  );
});

test("scannedUrl reflects the report's actual url", () => {
  const summary = summarizeEvidenceCoverage(baseReport({ url: "https://example.com/pricing" }));
  assert.equal(summary.scannedUrl, "https://example.com/pricing");
});
