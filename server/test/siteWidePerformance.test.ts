import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateSitePerformance,
  buildPagePerformanceResult,
  classifyPageHealth,
} from "../src/analysis/siteWidePerformance.js";
import type { CoreWebVitalsReport, Issue, PagePerformanceResult } from "../src/types.js";

let idCounter = 0;
function makeIssue(overrides: Partial<Issue> & Pick<Issue, "title" | "severity">): Issue {
  idCounter += 1;
  return {
    id: `test-${idCounter}`,
    category: "performance",
    affected: "https://example.com/",
    whyItMatters: "why",
    recommendedFix: "fix",
    difficulty: "easy",
    priorityScore: 1,
    source: "measured",
    evidence: [{ type: "computed", label: "x", value: "y" }],
    ...overrides,
  };
}

function emptyCwv(): CoreWebVitalsReport {
  return {
    providerName: "fake",
    providerStatus: "available",
    evidence: null,
    factors: [],
    cached: false,
  };
}

function page(url: string, issues: Issue[]): PagePerformanceResult {
  return buildPagePerformanceResult(url, issues, emptyCwv());
}

// ---------------- classifyPageHealth ----------------

test("a page with no issues is healthy", () => {
  assert.equal(classifyPageHealth([]), "healthy");
});

test("a page with only low-severity performance issues is healthy", () => {
  assert.equal(classifyPageHealth([makeIssue({ title: "minor", severity: "low" })]), "healthy");
});

test("a page with a medium-severity performance issue is a warning", () => {
  assert.equal(classifyPageHealth([makeIssue({ title: "medium thing", severity: "medium" })]), "warning");
});

test("a page with a high-severity performance issue is a warning", () => {
  assert.equal(classifyPageHealth([makeIssue({ title: "high thing", severity: "high" })]), "warning");
});

test("a page with a critical-severity performance issue is critical, even alongside others", () => {
  const issues = [makeIssue({ title: "low thing", severity: "low" }), makeIssue({ title: "critical thing", severity: "critical" })];
  assert.equal(classifyPageHealth(issues), "critical");
});

test("non-performance issues are ignored when classifying page performance health", () => {
  const issues = [makeIssue({ title: "security thing", severity: "critical", category: "security" })];
  assert.equal(classifyPageHealth(issues), "healthy");
});

// ---------------- buildPagePerformanceResult ----------------

test("buildPagePerformanceResult filters to only performance-category issues", () => {
  const issues = [
    makeIssue({ title: "perf issue", severity: "medium", category: "performance" }),
    makeIssue({ title: "seo issue", severity: "critical", category: "seo" }),
  ];
  const result = buildPagePerformanceResult("https://example.com/a", issues, emptyCwv());
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].title, "perf issue");
  assert.equal(result.status, "warning");
});

// ---------------- aggregateSitePerformance ----------------

test("counts healthy/warning/critical pages correctly across a small site", () => {
  const pages = [
    page("https://example.com/1", []),
    page("https://example.com/2", [makeIssue({ title: "slow ttfb", severity: "medium" })]),
    page("https://example.com/3", [makeIssue({ title: "broken lcp", severity: "critical" })]),
  ];
  const summary = aggregateSitePerformance(pages);
  assert.equal(summary.pagesScanned, 3);
  assert.equal(summary.healthy, 1);
  assert.equal(summary.warning, 1);
  assert.equal(summary.critical, 1);
});

test("matches the README example shape: 50 pages -> 45 healthy / 4 warnings / 1 critical", () => {
  const pages: PagePerformanceResult[] = [];
  for (let i = 0; i < 45; i++) pages.push(page(`https://example.com/healthy-${i}`, []));
  for (let i = 0; i < 4; i++) pages.push(page(`https://example.com/warn-${i}`, [makeIssue({ title: "warn", severity: "medium" })]));
  pages.push(page("https://example.com/critical-0", [makeIssue({ title: "crit", severity: "critical" })]));

  const summary = aggregateSitePerformance(pages);
  assert.equal(summary.pagesScanned, 50);
  assert.equal(summary.healthy, 45);
  assert.equal(summary.warning, 4);
  assert.equal(summary.critical, 1);
});

test("a problem affecting many pages is surfaced as ONE site-wide pattern, not N separate findings", () => {
  const pages: PagePerformanceResult[] = [];
  for (let i = 0; i < 40; i++) {
    pages.push(
      page(`https://example.com/p${i}`, [
        makeIssue({ title: "Large JavaScript payload", severity: "high", affected: `https://example.com/p${i}` }),
      ]),
    );
  }
  const summary = aggregateSitePerformance(pages);
  assert.equal(summary.siteWidePatterns.length, 1);
  const pattern = summary.siteWidePatterns[0];
  assert.equal(pattern.title, "Large JavaScript payload");
  assert.equal(pattern.occurrenceCount, 40);
  assert.equal(pattern.affectedUrls.length, 40);
  assert.equal(pattern.pagesScanned, 40);
});

test("a problem on only 1-2 pages (below the site-wide threshold) does not become a site-wide pattern", () => {
  const pages: PagePerformanceResult[] = [
    page("https://example.com/a", [makeIssue({ title: "one-off issue", severity: "medium" })]),
    page("https://example.com/b", [makeIssue({ title: "one-off issue", severity: "medium" })]),
  ];
  // more unaffected pages so the ratio floor is also not met
  for (let i = 0; i < 20; i++) pages.push(page(`https://example.com/clean-${i}`, []));

  const summary = aggregateSitePerformance(pages);
  assert.equal(summary.siteWidePatterns.length, 0);
  // the individual page-level findings are still fully present in pageResults
  assert.equal(summary.pageResults.filter((p) => p.issues.some((i) => i.title === "one-off issue")).length, 2);
});

test("a site-wide pattern's severity is the worst severity seen across its occurrences", () => {
  const pages: PagePerformanceResult[] = [
    page("https://example.com/a", [makeIssue({ title: "shared issue", severity: "medium" })]),
    page("https://example.com/b", [makeIssue({ title: "shared issue", severity: "critical" })]),
    page("https://example.com/c", [makeIssue({ title: "shared issue", severity: "low" })]),
  ];
  const summary = aggregateSitePerformance(pages);
  assert.equal(summary.siteWidePatterns[0].severity, "critical");
});

test("site-wide patterns are sorted by severity then occurrence count", () => {
  const pages: PagePerformanceResult[] = [];
  for (let i = 0; i < 5; i++) pages.push(page(`https://example.com/med-${i}`, [makeIssue({ title: "medium issue", severity: "medium" })]));
  for (let i = 0; i < 3; i++) pages.push(page(`https://example.com/crit-${i}`, [makeIssue({ title: "critical issue", severity: "critical" })]));

  const summary = aggregateSitePerformance(pages);
  assert.equal(summary.siteWidePatterns[0].title, "critical issue");
  assert.equal(summary.siteWidePatterns[1].title, "medium issue");
});

test("an empty page list produces a valid, empty summary rather than throwing", () => {
  const summary = aggregateSitePerformance([]);
  assert.equal(summary.pagesScanned, 0);
  assert.equal(summary.healthy, 0);
  assert.equal(summary.siteWidePatterns.length, 0);
});
