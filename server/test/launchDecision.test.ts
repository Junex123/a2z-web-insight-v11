import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { evaluateLaunchDecision, groupIssues } from "../src/analysis/launchDecision.js";
import { makeIssue, makeReportInput, resetFixtureIdCounter } from "./fixtures/launchDecisionFixtures.js";

beforeEach(() => {
  resetFixtureIdCounter();
});

// ---------------------------------------------------------------------
// 1. No findings -> READY
// ---------------------------------------------------------------------
test("no findings at all -> READY", () => {
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: [] }));
  assert.equal(decision.status, "READY");
  assert.equal(decision.blockers.length, 0);
  assert.equal(decision.warnings.length, 0);
  assert.ok(decision.whyReady.length > 0);
  assert.deepEqual(decision.whyNotReady, []);
});

// ---------------------------------------------------------------------
// 2. Low-severity findings -> READY_WITH_WARNINGS
// ---------------------------------------------------------------------
test("only low-severity findings -> READY_WITH_WARNINGS", () => {
  const issues = [makeIssue({ category: "seo", title: "No Cache-Control header", severity: "low" })];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.status, "READY_WITH_WARNINGS");
  assert.equal(decision.blockers.length, 0);
  assert.equal(decision.warnings.length, 1);
});

// ---------------------------------------------------------------------
// 3. High-severity, non-blocking findings -> READY_WITH_WARNINGS
// ---------------------------------------------------------------------
test("high-severity findings that are not on the blocking list -> READY_WITH_WARNINGS, not NOT_READY", () => {
  const issues = [
    makeIssue({ category: "security", title: "Missing Strict-Transport-Security (HSTS) header", severity: "high" }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.status, "READY_WITH_WARNINGS");
  assert.equal(decision.blockers.length, 0, "severity must not equal blocking");
});

// ---------------------------------------------------------------------
// 4. Critical security blocker -> NOT_READY
// ---------------------------------------------------------------------
test("critical security blocker (no HTTPS) -> NOT_READY", () => {
  const issues = [makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical" })];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.status, "NOT_READY");
  assert.equal(decision.blockers.length, 1);
  assert.equal(decision.blockers[0].category, "security");
  assert.match(decision.blockers[0].reason, /HTTPS/);
});

// ---------------------------------------------------------------------
// 5. Confirmed indexability blocker -> NOT_READY
//    (stand-in for "critical runtime blocker" - this pipeline has no
//    runtime/browser collector yet; noindex is the current defensible
//    "would clearly undermine the site's purpose" rule - see module doc)
// ---------------------------------------------------------------------
test("site-wide noindex blocker -> NOT_READY", () => {
  const issues = [makeIssue({ category: "seo", title: "Page is set to noindex", severity: "critical" })];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.status, "NOT_READY");
  assert.equal(decision.blockers.length, 1);
  assert.equal(decision.blockers[0].category, "seo");
});

// ---------------------------------------------------------------------
// 6. Multiple blockers
// ---------------------------------------------------------------------
test("multiple distinct blockers are all reported", () => {
  const issues = [
    makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical" }),
    makeIssue({ category: "seo", title: "Page is set to noindex", severity: "critical" }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.status, "NOT_READY");
  assert.equal(decision.blockers.length, 2);
  assert.equal(decision.whyNotReady.length, 2);
});

// ---------------------------------------------------------------------
// 7 & 8. Blocker on one page vs site-wide blocker -> affected scope
// ---------------------------------------------------------------------
test("blocker found on a single page reports a single affected page", () => {
  const issues = [
    makeIssue({
      category: "security",
      title: "Site is not served over HTTPS",
      severity: "critical",
      affected: "http://example.com/checkout",
    }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.deepEqual(decision.blockers[0].affected, ["http://example.com/checkout"]);
});

test("the same blocker found on several pages is aggregated into ONE site-wide blocker, not several", () => {
  const issues = [
    makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical", affected: "http://example.com/" }),
    makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical", affected: "http://example.com/about" }),
    makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical", affected: "http://example.com/pricing" }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.blockers.length, 1, "must not double-count the same rule across pages as separate blockers");
  assert.equal(decision.blockers[0].affected.length, 3);
  assert.equal(decision.blockers[0].issueIds.length, 3);
});

// ---------------------------------------------------------------------
// 9. Many warnings but no blockers -> READY_WITH_WARNINGS, never NOT_READY
// ---------------------------------------------------------------------
test("many non-blocking findings, including criticals, never become NOT_READY on their own", () => {
  const issues = [
    makeIssue({ category: "seo", title: "Missing <title> tag", severity: "critical" }),
    makeIssue({ category: "seo", title: "Missing canonical tag", severity: "medium" }),
    makeIssue({ category: "accessibility", title: "Missing lang attribute on <html>", severity: "high" }),
    makeIssue({ category: "security", title: "No Content-Security-Policy header", severity: "low" }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.status, "READY_WITH_WARNINGS");
  assert.equal(decision.blockers.length, 0);
  assert.equal(decision.warnings.length, 4);
});

// ---------------------------------------------------------------------
// 10 & 26. Unavailable category / all categories unavailable
// ---------------------------------------------------------------------
test("a category missing from categoriesAnalyzed gets an explicit UNVERIFIED entry - a real Category never silently disappears (regression test for a bug found and fixed this session)", () => {
  const decision = evaluateLaunchDecision(
    makeReportInput({ allIssues: [], categoriesAnalyzed: ["performance", "seo", "accessibility"], categoriesNotYetAnalyzed: ["content"] }),
  );
  const security = decision.categoryReadiness.find((c) => c.category === "security");
  assert.ok(security, "a completely unscanned real Category must still get a CategoryReadiness entry, not vanish");
  assert.equal(security!.status, "UNVERIFIED");
  assert.equal(security!.verification, "UNVERIFIED");
  assert.ok(decision.scanCompleteness.categoriesUnavailable.includes("security") === false, "categoriesUnavailable tracks roadmap gaps (categoriesNotYetAnalyzed), not a missing real Category - that's covered by categoryReadiness instead");
  assert.ok(decision.notVerified.some((line) => line.includes("security")));
  // this is the actual bug: previously this whole scenario silently
  // resulted in a clean READY because the missing category simply had
  // no representation anywhere in the decision.
  assert.notEqual(decision.status, "READY", "a website with an entirely unscanned category must never be reported as a clean READY");
  assert.equal(decision.status, "READY_WITH_WARNINGS");
});

test("all categories unavailable (total scan failure) -> NOT_READY, never READY", () => {
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: [], status: "failed" }));
  assert.equal(decision.status, "NOT_READY");
  assert.equal(decision.overallVerification, "SCAN_FAILED");
  assert.ok(decision.categoryReadiness.every((c) => c.status === "UNVERIFIED"));
  assert.ok(decision.whyNotReady.length > 0);
});

// ---------------------------------------------------------------------
// 11. Failed scan
// ---------------------------------------------------------------------
test("failed scan status is never converted into a clean report", () => {
  const decision = evaluateLaunchDecision(makeReportInput({ status: "failed" }));
  assert.notEqual(decision.status, "READY");
  assert.equal(decision.scanCompleteness.pagesFailed, 1);
  assert.equal(decision.scanCompleteness.isComplete, false);
});

// ---------------------------------------------------------------------
// 12. Unverified category (present but not fully confirmed) never
//     becomes a silent READY
// ---------------------------------------------------------------------
test("performance verification is PARTIALLY_VERIFIED (not VERIFIED) when the CWV provider did not return data", () => {
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: [], providerStatus: "timeout" }));
  const perf = decision.categoryReadiness.find((c) => c.category === "performance")!;
  assert.equal(perf.verification, "PARTIALLY_VERIFIED");
  // Real HTTP-based evidence still exists for performance (unlike a full
  // SCAN_FAILED), so this alone does not force NOT_READY/READY_WITH_WARNINGS
  // - but it must never be silently reported as fully VERIFIED, and the
  // gap must be disclosed in notVerified regardless of the final status.
  assert.notEqual(decision.overallVerification, "VERIFIED");
  assert.ok(decision.notVerified.some((line) => line.includes("Core Web Vitals")));
});

// ---------------------------------------------------------------------
// 13. Score high but blocker exists -> NOT_READY
// ---------------------------------------------------------------------
test("score is irrelevant once a real blocker exists", () => {
  const issues = [makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical" })];
  const report = makeReportInput({ allIssues: issues });
  report.scores = { performance: 95, seo: 98, security: 40, accessibility: 92, overall: 81 }; // high overall average
  const decision = evaluateLaunchDecision(report);
  assert.equal(decision.status, "NOT_READY", "a high overall average must not override an explicit blocker");
});

// ---------------------------------------------------------------------
// 14. Score low but no blocker -> policy-driven warning state, not NOT_READY
// ---------------------------------------------------------------------
test("score is low but there is no real blocker -> READY_WITH_WARNINGS, not NOT_READY", () => {
  const issues = [
    makeIssue({ category: "performance", title: "Server response time is very slow", severity: "critical" }),
    makeIssue({ category: "performance", title: "HTML document is large", severity: "medium" }),
  ];
  const report = makeReportInput({ allIssues: issues });
  report.scores.overall = 45; // low
  const decision = evaluateLaunchDecision(report);
  assert.equal(decision.status, "READY_WITH_WARNINGS");
});

// ---------------------------------------------------------------------
// 15 & 16. Duplicate / related findings and site-wide aggregation
//    (already exercised above at #8; groupIssues() unit-level below)
// ---------------------------------------------------------------------
test("groupIssues merges same-category-same-title issues and keeps distinct titles separate", () => {
  const issues = [
    makeIssue({ category: "seo", title: "Images missing alt text", severity: "medium", affected: "https://example.com/a" }),
    makeIssue({ category: "seo", title: "Images missing alt text", severity: "high", affected: "https://example.com/b" }),
    makeIssue({ category: "accessibility", title: "Images with no alt attribute at all", severity: "high", affected: "https://example.com/a" }),
  ];
  const groups = groupIssues(issues);
  assert.equal(groups.length, 2, "distinct rules with different titles must stay distinct, even about the same topic");
  const seoGroup = groups.find((g) => g.category === "seo")!;
  assert.equal(seoGroup.affected.length, 2);
  assert.equal(seoGroup.severity, "high", "group severity is the max of its members");
  assert.equal(seoGroup.issueIds.length, 2);
});

// ---------------------------------------------------------------------
// 17. Affected-page counts surfaced on category readiness
// ---------------------------------------------------------------------
test("category readiness exposes the affected page list", () => {
  const issues = [
    makeIssue({ category: "seo", title: "Missing canonical tag", severity: "medium", affected: "https://example.com/x" }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  const seo = decision.categoryReadiness.find((c) => c.category === "seo")!;
  assert.deepEqual(seo.affectedPages, ["https://example.com/x"]);
});

// ---------------------------------------------------------------------
// 18 & 19. Prioritized remediation list + deterministic ordering
// ---------------------------------------------------------------------
test("prioritized fixes put blockers first, then order deterministically by scope/confidence/severity", () => {
  const issues = [
    makeIssue({ category: "seo", title: "Missing canonical tag", severity: "medium" }),
    makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical" }),
    makeIssue({ category: "accessibility", title: "Duplicate id attributes", severity: "low" }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.prioritizedFixes[0].title, "Site is not served over HTTPS");
  assert.equal(decision.prioritizedFixes[0].blocking, true);
  assert.equal(decision.prioritizedFixes[0].priority, 1);
  // stable, deterministic ordering: running it again produces the same order
  const decision2 = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.deepEqual(
    decision.prioritizedFixes.map((f) => f.title),
    decision2.prioritizedFixes.map((f) => f.title),
  );
});

// ---------------------------------------------------------------------
// 20. "Why ready" explanation
// ---------------------------------------------------------------------
test("why-ready explanation traces to actual per-category findings", () => {
  const issues = [makeIssue({ category: "seo", title: "Missing canonical tag", severity: "medium" })];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.ok(decision.whyReady.some((line) => line.includes("seo") && line.includes("Missing canonical tag")));
});

// ---------------------------------------------------------------------
// 21. "Why not ready" explanation
// ---------------------------------------------------------------------
test("why-not-ready explanation traces to the actual blocker and its evidence", () => {
  const issues = [makeIssue({ category: "security", title: "Site is not served over HTTPS", severity: "critical" })];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.whyNotReady.length, 1);
  assert.match(decision.whyNotReady[0], /Site is not served over HTTPS/);
});

// ---------------------------------------------------------------------
// 22 & 23. Complete scan vs incomplete scan
// ---------------------------------------------------------------------
test("a scan with every roadmap category covered and CWV available is marked complete", () => {
  const decision = evaluateLaunchDecision(
    makeReportInput({ allIssues: [], categoriesNotYetAnalyzed: [], providerStatus: "available" }),
  );
  assert.equal(decision.scanCompleteness.isComplete, true);
});

test("a scan with roadmap categories still unimplemented is marked incomplete, honestly", () => {
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: [] })); // default fixture has categoriesNotYetAnalyzed
  assert.equal(decision.scanCompleteness.isComplete, false);
});

// ---------------------------------------------------------------------
// 24 & 25. Individual category unavailable
// ---------------------------------------------------------------------
test("security category unavailable gets an explicit UNVERIFIED entry, not omission", () => {
  const decision = evaluateLaunchDecision(
    makeReportInput({ categoriesAnalyzed: ["performance", "seo", "accessibility"], categoriesNotYetAnalyzed: [] }),
  );
  const security = decision.categoryReadiness.find((c) => c.category === "security");
  assert.ok(security);
  assert.equal(security!.status, "UNVERIFIED");
});

test("performance category unavailable (CWV provider down) still allows the HTTP-based performance checks to count", () => {
  const issues = [makeIssue({ category: "performance", title: "HTML response is not compressed", severity: "medium" })];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues, providerStatus: "not_configured" }));
  const perf = decision.categoryReadiness.find((c) => c.category === "performance")!;
  assert.equal(perf.warningCount, 1);
  assert.equal(perf.verification, "PARTIALLY_VERIFIED");
});

// ---------------------------------------------------------------------
// 27. Empty report
// ---------------------------------------------------------------------
test("a report with no categories analyzed at all never returns READY, and every real category is still represented as UNVERIFIED", () => {
  const decision = evaluateLaunchDecision(
    makeReportInput({ allIssues: [], categoriesAnalyzed: [], categoriesNotYetAnalyzed: [] }),
  );
  assert.notEqual(decision.status, "READY");
  assert.equal(decision.status, "READY_WITH_WARNINGS");
  assert.equal(decision.categoryReadiness.length, 6);
  assert.ok(decision.categoryReadiness.every((c) => c.status === "UNVERIFIED"));
});

test("evaluateLaunchDecision never throws on a minimal/empty report", () => {
  assert.doesNotThrow(() => {
    evaluateLaunchDecision(makeReportInput({ allIssues: [], categoriesAnalyzed: [], categoriesNotYetAnalyzed: [] }));
  });
});

// ---------------------------------------------------------------------
// 28. Malformed / unknown finding handled safely
// ---------------------------------------------------------------------
test("an issue with an unrecognized category is grouped and reported as a warning, not dropped or thrown", () => {
  const weirdIssue = makeIssue({
    category: "performance",
    title: "Some future finding type",
    severity: "medium",
  });
  // Simulate a malformed/future category value reaching this function at
  // runtime (bypassing the type system, the way an unvalidated JSON
  // payload might) - the engine must not crash on it.
  (weirdIssue as any).category = "unknown-future-category";
  assert.doesNotThrow(() => {
    const decision = evaluateLaunchDecision(makeReportInput({ allIssues: [weirdIssue] }));
    // it is not in any known categoriesAnalyzed entry, so it can't appear
    // in categoryReadiness, but it must not be silently discarded from
    // groupIssues/warnings bookkeeping and must not crash the engine.
    assert.equal(decision.status, "READY_WITH_WARNINGS");
  });
});


test("cross-category correlations are surfaced and affect equal-severity fix priority", () => {
  const issues = [
    makeIssue({ category: "seo", title: "Missing canonical tag", severity: "medium" }),
    makeIssue({ category: "security", title: "Mixed content", severity: "medium", relatedHosts: ["shared.example.com"] }),
    makeIssue({ category: "performance", title: "Significant third-party resource usage", severity: "medium", relatedHosts: ["shared.example.com"] }),
  ];
  const decision = evaluateLaunchDecision(makeReportInput({ allIssues: issues }));
  assert.equal(decision.correlatedFindings.length, 1);
  assert.deepEqual(decision.correlatedFindings[0].categories, ["performance", "security"]);
  assert.equal(decision.prioritizedFixes.find((f) => f.title === "Mixed content")?.correlatedAcrossCategories, 2);
});
