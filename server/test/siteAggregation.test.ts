import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateSitePages, classifyPageOutcome, summarizePages } from "../src/analysis/siteAggregation.js";
import type { Issue, SitePageResult } from "../src/types.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "test-1",
    category: "accessibility",
    severity: "high",
    title: "Missing lang attribute on <html>",
    affected: "https://example.com",
    whyItMatters: "because",
    recommendedFix: "fix it",
    difficulty: "easy",
    priorityScore: 70,
    source: "measured",
    evidence: [],
    ...overrides,
  };
}

function makePage(overrides: Partial<SitePageResult> = {}): SitePageResult {
  return {
    url: "https://example.com/page",
    outcome: "clean",
    title: "A Page",
    h1Texts: ["A Page"],
    issueCounts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    issues: [],
    ...overrides,
  };
}

test("classifyPageOutcome: no issues is clean", () => {
  assert.equal(classifyPageOutcome([]), "clean");
});

test("classifyPageOutcome: only low/medium issues is warnings, not critical", () => {
  assert.equal(classifyPageOutcome([makeIssue({ severity: "low" }), makeIssue({ severity: "medium" })]), "warnings");
});

test("classifyPageOutcome: any high or critical issue makes the whole page critical", () => {
  assert.equal(classifyPageOutcome([makeIssue({ severity: "low" }), makeIssue({ severity: "high" })]), "critical");
});

test("summarizePages counts each outcome bucket, including error", () => {
  const pages = [
    makePage({ outcome: "clean" }),
    makePage({ outcome: "clean" }),
    makePage({ outcome: "warnings" }),
    makePage({ outcome: "critical" }),
    makePage({ outcome: "error", errorMessage: "unreachable" }),
  ];
  const summary = summarizePages(pages);
  assert.deepEqual(summary, { clean: 2, warnings: 1, critical: 1, error: 1 });
});

test("a failed page is never counted as clean", () => {
  const summary = summarizePages([makePage({ outcome: "error" })]);
  assert.equal(summary.clean, 0);
  assert.equal(summary.error, 1);
});

test("detects a duplicate <title> shared across two or more pages", () => {
  const pages = [
    makePage({ url: "https://example.com/a", title: "Our Site" }),
    makePage({ url: "https://example.com/b", title: "Our Site" }),
    makePage({ url: "https://example.com/c", title: "A Different Page" }),
  ];
  const findings = aggregateSitePages(pages);
  const dup = findings.find((f) => f.key.startsWith("duplicate-title:"));
  assert.ok(dup);
  assert.equal(dup!.affectedPageCount, 2);
  assert.deepEqual(dup!.affectedUrls.sort(), ["https://example.com/a", "https://example.com/b"]);
});

test("does not flag a title that only appears once", () => {
  const pages = [
    makePage({ url: "https://example.com/a", title: "Unique A" }),
    makePage({ url: "https://example.com/b", title: "Unique B" }),
  ];
  const findings = aggregateSitePages(pages);
  assert.equal(findings.find((f) => f.key.startsWith("duplicate-title:")), undefined);
});

test("pages with a null/missing title never trigger a duplicate-title finding against each other", () => {
  const pages = [
    makePage({ url: "https://example.com/a", title: null }),
    makePage({ url: "https://example.com/b", title: null }),
  ];
  const findings = aggregateSitePages(pages);
  assert.equal(findings.find((f) => f.key.startsWith("duplicate-title:")), undefined);
});

test("detects a duplicate H1 shared across two or more pages", () => {
  const pages = [
    makePage({ url: "https://example.com/a", title: "Page A", h1Texts: ["Welcome"] }),
    makePage({ url: "https://example.com/b", title: "Page B", h1Texts: ["Welcome"] }),
  ];
  const findings = aggregateSitePages(pages);
  const dup = findings.find((f) => f.key.startsWith("duplicate-h1:"));
  assert.ok(dup);
  assert.equal(dup!.affectedPageCount, 2);
});

test("a template-level issue repeated on 2+ pages collapses into one site-level finding with affected URLs", () => {
  const pages = [
    makePage({
      url: "https://example.com/a",
      issues: [makeIssue({ affected: "https://example.com/a" })],
    }),
    makePage({
      url: "https://example.com/b",
      issues: [makeIssue({ affected: "https://example.com/b" })],
    }),
    makePage({
      url: "https://example.com/c",
      issues: [],
    }),
  ];
  const findings = aggregateSitePages(pages);
  const repeated = findings.find((f) => f.key.startsWith("repeated:"));
  assert.ok(repeated);
  assert.equal(repeated!.affectedPageCount, 2);
  assert.equal(repeated!.category, "accessibility");
  assert.equal(repeated!.severity, "high");
  assert.deepEqual(repeated!.affectedUrls.sort(), ["https://example.com/a", "https://example.com/b"]);
  assert.ok(repeated!.title.includes("repeated across 2 pages"));
});

test("an issue found on only one page does not become a site-level repeated finding", () => {
  const pages = [
    makePage({ url: "https://example.com/a", issues: [makeIssue({ affected: "https://example.com/a" })] }),
    makePage({ url: "https://example.com/b", issues: [] }),
  ];
  const findings = aggregateSitePages(pages);
  assert.equal(findings.find((f) => f.key.startsWith("repeated:")), undefined);
});

test("a genuinely clean multi-page site produces zero site-level findings", () => {
  const pages = [
    makePage({ url: "https://example.com/a", title: "Home", h1Texts: ["Home"] }),
    makePage({ url: "https://example.com/b", title: "About", h1Texts: ["About Us"] }),
    makePage({ url: "https://example.com/c", title: "Contact", h1Texts: ["Get In Touch"] }),
  ];
  const findings = aggregateSitePages(pages);
  assert.equal(findings.length, 0);
});
