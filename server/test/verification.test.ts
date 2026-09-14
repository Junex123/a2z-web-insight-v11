import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSiteVerificationSummary, buildVerificationSummary } from "../src/analysis/verification.js";
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

const RUNTIME_CATEGORIES = [
  "Keyboard-only interaction",
  "Focus visibility",
  "Focus traps",
  "Modal/dialog focus behavior",
  "JavaScript-driven interaction",
  "Responsive/viewport behavior",
  "Visual layout failures",
  "Runtime interaction failures",
];

test("every runtime category is always reported unverified with the exact required reason", () => {
  const entries = buildVerificationSummary([]);
  for (const category of RUNTIME_CATEGORIES) {
    const entry = entries.find((e) => e.category === category);
    assert.ok(entry, `expected a verification entry for "${category}"`);
    assert.equal(entry!.status, "unverified");
    assert.equal(entry!.reason, "Requires browser/runtime execution; static HTML analysis cannot verify this.");
  }
});

test("a category with zero matching issues is reported verified, not silently omitted", () => {
  const entries = buildVerificationSummary([]);
  const docStructure = entries.find((e) => e.category === "Document language & structure");
  assert.ok(docStructure);
  assert.equal(docStructure!.status, "verified");
});

test("a landmark issue is correctly attributed despite the <main> tag markup in its title", () => {
  const entries = buildVerificationSummary([makeIssue({ category: "accessibility", severity: "medium", title: "No <main> landmark found" })]);
  const docStructure = entries.find((e) => e.category === "Document language & structure");
  assert.ok(docStructure);
  assert.equal(docStructure!.status, "warning");
});

test("a critical or high-severity issue makes its category FAILED, not just a warning", () => {
  const entries = buildVerificationSummary([
    makeIssue({ category: "accessibility", severity: "high", title: "Buttons with no accessible name" }),
  ]);
  const names = entries.find((e) => e.category === "Accessible names (links/buttons/images)");
  assert.ok(names);
  assert.equal(names!.status, "failed");
});

test("a medium/low-severity issue makes its category WARNING, not FAILED", () => {
  const entries = buildVerificationSummary([
    makeIssue({ category: "accessibility", severity: "low", title: "<fieldset> without a <legend>" }),
  ]);
  const forms = entries.find((e) => e.category === "Form labeling & grouping");
  assert.ok(forms);
  assert.equal(forms!.status, "warning");
});

test("issues from an unrelated category (e.g. seo/performance) never affect a11y/ux verification categories", () => {
  const entries = buildVerificationSummary([makeIssue({ category: "seo", severity: "critical", title: "Duplicate meta description" })]);
  for (const entry of entries) {
    if (RUNTIME_CATEGORIES.includes(entry.category) || entry.category === "Site navigation consistency") continue;
    assert.equal(entry.status, "verified", `expected "${entry.category}" to stay verified, got ${entry.status}`);
  }
});

test("single-page verification always marks site navigation consistency not_applicable", () => {
  const entries = buildVerificationSummary([]);
  const nav = entries.find((e) => e.category === "Site navigation consistency");
  assert.ok(nav);
  assert.equal(nav!.status, "not_applicable");
});

test("a dialog-related issue is attributed to the dedicated dialog/modal verification category", () => {
  const entries = buildVerificationSummary([
    makeIssue({ category: "accessibility", severity: "high", title: "Dialog/modal has no accessible name" }),
  ]);
  const dialogEntry = entries.find((e) => e.category === "Dialog/modal semantics (static)");
  assert.ok(dialogEntry);
  assert.equal(dialogEntry!.status, "failed");
});

// ---------------- Session 9: new title-matching regressions ----------------
// These lock down real bugs caught during Session 9 development (a
// case-sensitivity mismatch and two missing matchers) - see
// PROJECT_PROGRESS.md Session 9 for the full story.

test("a capitalized 'Skip-navigation link target...' title still routes to Document language & structure", () => {
  const entries = buildVerificationSummary([
    makeIssue({ category: "accessibility", severity: "medium", title: "Skip-navigation link target does not exist" }),
  ]);
  const entry = entries.find((e) => e.category === "Document language & structure");
  assert.ok(entry);
  assert.equal(entry!.status, "warning");
});

test("a broken label[for] association routes to Form labeling & grouping", () => {
  const entries = buildVerificationSummary([
    makeIssue({ category: "accessibility", severity: "high", title: "<label for=\"...\"> references an id that doesn't exist" }),
  ]);
  const entry = entries.find((e) => e.category === "Form labeling & grouping");
  assert.ok(entry);
  assert.equal(entry!.status, "failed");
});

test("a lowercase 'aria-hidden' title routes to ARIA & keyboard-reachability, not silently uncategorized", () => {
  const entries = buildVerificationSummary([
    makeIssue({ category: "accessibility", severity: "high", title: 'aria-hidden="true" hides focusable/interactive content' }),
  ]);
  const entry = entries.find((e) => e.category === "ARIA & keyboard-reachability (static)");
  assert.ok(entry);
  assert.equal(entry!.status, "failed");
});

test("a duplicate nav link label (UX) title routes to Document language & structure alongside a11y nav findings", () => {
  const entries = buildVerificationSummary([
    makeIssue({ category: "ux", severity: "medium", title: "Duplicate navigation link text pointing at different destinations" }),
  ]);
  const entry = entries.find((e) => e.category === "Document language & structure");
  assert.ok(entry);
  assert.equal(entry!.status, "warning");
});

// ---------------- site-level ----------------

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

test("site-level verification resolves nav consistency as verified when 2+ pages agree and nothing flagged it", () => {
  const pages = [makePage({ url: "https://example.com/a" }), makePage({ url: "https://example.com/b" })];
  const entries = buildSiteVerificationSummary(pages, []);
  const nav = entries.find((e) => e.category === "Site navigation consistency");
  assert.ok(nav);
  assert.equal(nav!.status, "verified");
});

test("site-level verification resolves nav consistency as warning when a nav-inconsistency site finding exists", () => {
  const pages = [makePage({ url: "https://example.com/a" }), makePage({ url: "https://example.com/b" })];
  const entries = buildSiteVerificationSummary(pages, [
    {
      key: "nav-inconsistency",
      category: "ux",
      severity: "medium",
      title: "Primary navigation differs on 1 of 2 scanned page(s)",
      whyItMatters: "x",
      recommendedFix: "y",
      affectedUrls: ["https://example.com/b"],
      affectedPageCount: 1,
    },
  ]);
  const nav = entries.find((e) => e.category === "Site navigation consistency");
  assert.ok(nav);
  assert.equal(nav!.status, "warning");
});

test("site-level verification marks nav consistency not_applicable with fewer than 2 scanned pages", () => {
  const entries = buildSiteVerificationSummary([makePage({ url: "https://example.com/a" })], []);
  const nav = entries.find((e) => e.category === "Site navigation consistency");
  assert.ok(nav);
  assert.equal(nav!.status, "not_applicable");
});

test("a page that failed to load produces a 'Full-site coverage' warning entry, never silently ignored", () => {
  const pages = [
    makePage({ url: "https://example.com/a" }),
    makePage({ url: "https://example.com/b", outcome: "error", errorMessage: "unreachable" }),
  ];
  const entries = buildSiteVerificationSummary(pages, []);
  const coverage = entries.find((e) => e.category === "Full-site coverage");
  assert.ok(coverage);
  assert.equal(coverage!.status, "warning");
  assert.ok(coverage!.reason.includes("1 of 2"));
});

test("a fully successful site scan has no 'Full-site coverage' entry at all", () => {
  const pages = [makePage({ url: "https://example.com/a" }), makePage({ url: "https://example.com/b" })];
  const entries = buildSiteVerificationSummary(pages, []);
  assert.equal(entries.find((e) => e.category === "Full-site coverage"), undefined);
});

test("site-level static categories aggregate issues across every scanned page, not just the first", () => {
  const pages = [
    makePage({ url: "https://example.com/a", issues: [] }),
    makePage({
      url: "https://example.com/b",
      issues: [makeIssue({ category: "accessibility", severity: "critical", title: "Buttons with no accessible name", affected: "https://example.com/b" })],
    }),
  ];
  const entries = buildSiteVerificationSummary(pages, []);
  const names = entries.find((e) => e.category === "Accessible names (links/buttons/images)");
  assert.ok(names);
  assert.equal(names!.status, "failed");
  assert.ok(names!.reason.includes("1 of 2"));
});

test("site-level verification also includes the fixed runtime-unverified categories", () => {
  const entries = buildSiteVerificationSummary([makePage()], []);
  for (const category of RUNTIME_CATEGORIES) {
    const entry = entries.find((e) => e.category === category);
    assert.ok(entry);
    assert.equal(entry!.status, "unverified");
  }
});
