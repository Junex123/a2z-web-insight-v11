import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCategorySummaries, detectSiteWideFindings } from "../src/analysis/siteWideFindings.js";
import type { AnalysisReport, CoreWebVitalsReport, Issue, PageCrawlResult, PerformanceVerificationEntry } from "../src/types.js";

function makeIssue(category: Issue["category"], severity: Issue["severity"], title: string, affected: string): Issue {
  return {
    id: `id-${Math.random()}`,
    category,
    severity,
    title,
    affected,
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

function fakeReport(url: string, issues: Issue[], scores: Partial<AnalysisReport["scores"]> = {}): AnalysisReport {
  return {
    reportId: `r-${Math.random()}`,
    url,
    scannedAt: new Date().toISOString(),
    status: "success",
    scores: { performance: 100, seo: 100, security: 100, accessibility: 100, ux: 100, responsiveness: 100, overall: 100, ...scores },
    categoriesAnalyzed: ["performance", "seo", "security", "accessibility"],
    categoriesNotYetAnalyzed: [],
    issueCounts: { critical: 0, high: 0, medium: 0, low: 0, total: issues.length },
    topPriorityIssues: [],
    allIssues: issues,
    coreWebVitals: emptyCwv(),
    fetchQuality: "usable",
    accessibilityCoverage: { checkedAreas: [], notVerifiable: [] },
    performanceVerification: [] as PerformanceVerificationEntry[],
    evidenceLog: { fetch: {} as any, html: {} as any, accessibility: {} as any, seo: {} as any, security: {} as any, ux: {} as any, responsive: {} as any },
  };
}

function analyzedPage(url: string, issues: Issue[], scores: Partial<AnalysisReport["scores"]> = {}): PageCrawlResult {
  return { url, depth: 0, status: "analyzed", report: fakeReport(url, issues, scores), errorMessage: null, discoveredFrom: null };
}

function failedPage(url: string): PageCrawlResult {
  return { url, depth: 0, status: "failed", report: null, errorMessage: "boom", discoveredFrom: null };
}

// ---------------- detectSiteWideFindings ----------------

test("a problem recurring on enough pages becomes ONE site-wide finding with every affected URL", () => {
  const pages: PageCrawlResult[] = [];
  for (let i = 0; i < 5; i++) {
    pages.push(analyzedPage(`https://example.com/p${i}`, [makeIssue("seo", "medium", "Missing meta description", `https://example.com/p${i}`)]));
  }
  const findings = detectSiteWideFindings(pages);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, "Missing meta description");
  assert.equal(findings[0].category, "seo");
  assert.equal(findings[0].occurrenceCount, 5);
  assert.equal(findings[0].affectedUrls.length, 5);
});

test("a problem on too few pages does not become a site-wide finding", () => {
  const pages = [
    analyzedPage("https://example.com/a", [makeIssue("security", "high", "Missing CSP", "https://example.com/a")]),
    analyzedPage("https://example.com/b", [makeIssue("security", "high", "Missing CSP", "https://example.com/b")]),
  ];
  // pad with clean pages so the ratio floor is also not met
  for (let i = 0; i < 20; i++) pages.push(analyzedPage(`https://example.com/clean-${i}`, []));
  assert.equal(detectSiteWideFindings(pages).length, 0);
});

test("different categories with the same title never collide into one finding", () => {
  const pages: PageCrawlResult[] = [];
  for (let i = 0; i < 3; i++) {
    pages.push(
      analyzedPage(`https://example.com/p${i}`, [
        makeIssue("seo", "medium", "Same Title", `https://example.com/p${i}`),
        makeIssue("security", "high", "Same Title", `https://example.com/p${i}`),
      ]),
    );
  }
  const findings = detectSiteWideFindings(pages);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.category).sort(),
    ["security", "seo"],
  );
});

test("failed/skipped pages are excluded from both the occurrence count and pagesAnalyzed", () => {
  const pages: PageCrawlResult[] = [failedPage("https://example.com/broken")];
  for (let i = 0; i < 4; i++) {
    pages.push(analyzedPage(`https://example.com/p${i}`, [makeIssue("performance", "high", "Large JS", `https://example.com/p${i}`)]));
  }
  const findings = detectSiteWideFindings(pages);
  assert.equal(findings[0].pagesAnalyzed, 4);
  assert.ok(!findings[0].affectedUrls.includes("https://example.com/broken"));
});

test("severity of a site-wide finding is the worst severity seen across its occurrences", () => {
  const pages = [
    analyzedPage("https://example.com/a", [makeIssue("accessibility", "low", "Shared", "https://example.com/a")]),
    analyzedPage("https://example.com/b", [makeIssue("accessibility", "critical", "Shared", "https://example.com/b")]),
    analyzedPage("https://example.com/c", [makeIssue("accessibility", "medium", "Shared", "https://example.com/c")]),
  ];
  assert.equal(detectSiteWideFindings(pages)[0].severity, "critical");
});

test("an empty page list produces an empty finding list, not an error", () => {
  assert.deepEqual(detectSiteWideFindings([]), []);
});

test("a crawl with only failed pages (no analyzed pages) produces no findings", () => {
  assert.deepEqual(detectSiteWideFindings([failedPage("https://example.com/a")]), []);
});

// ---------------- buildCategorySummaries ----------------

test("category summaries always include all four categories, even with zero issues", () => {
  const summaries = buildCategorySummaries([analyzedPage("https://example.com/a", [])]);
  assert.equal(summaries.length, 6);
  assert.deepEqual(
    summaries.map((s) => s.category).sort(),
    ["accessibility", "performance", "responsiveness", "security", "seo", "ux"],
  );
});

test("issue counts, severity breakdown, and pagesWithIssues are computed correctly per category", () => {
  const pages = [
    analyzedPage("https://example.com/a", [makeIssue("security", "critical", "x", "https://example.com/a"), makeIssue("security", "low", "y", "https://example.com/a")]),
    analyzedPage("https://example.com/b", []),
  ];
  const security = buildCategorySummaries(pages).find((s) => s.category === "security")!;
  assert.equal(security.totalIssues, 2);
  assert.equal(security.bySeverity.critical, 1);
  assert.equal(security.bySeverity.low, 1);
  assert.equal(security.pagesWithIssues, 1);
});

test("averageScore is the mean of that category's score across analyzed pages", () => {
  const pages = [analyzedPage("https://example.com/a", [], { performance: 80 }), analyzedPage("https://example.com/b", [], { performance: 100 })];
  const performance = buildCategorySummaries(pages).find((s) => s.category === "performance")!;
  assert.equal(performance.averageScore, 90);
});

test("failed pages are excluded from averageScore and issue counts", () => {
  const pages = [analyzedPage("https://example.com/a", [], { seo: 60 }), failedPage("https://example.com/b")];
  const seo = buildCategorySummaries(pages).find((s) => s.category === "seo")!;
  assert.equal(seo.averageScore, 60);
});

test("an empty page list produces zeroed-out summaries, not an error", () => {
  const summaries = buildCategorySummaries([]);
  for (const s of summaries) {
    assert.equal(s.totalIssues, 0);
    assert.equal(s.averageScore, 0);
  }
});
