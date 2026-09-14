import assert from "node:assert/strict";
import { test } from "node:test";
import { detectUxIssues, resetUxIssueIdCounter } from "../src/analysis/uxIssues.js";
import type { UxAnalysis } from "../src/types.js";

function baseUx(overrides: Partial<UxAnalysis> = {}): UxAnalysis {
  return {
    hasPrimaryNav: true,
    navLinkCount: 3,
    wordCount: 200,
    emptySections: { count: 0, examples: [] },
    hasPlaceholderText: false,
    placeholderExamples: [],
    hasComingSoonText: false,
    comingSoonExamples: [],
    links: {
      internalCount: 3,
      externalCount: 0,
      mailto: { count: 0, malformed: 0, malformedExamples: [] },
      tel: { count: 0, malformed: 0, malformedExamples: [] },
    },
    navLinkHrefs: ["/about", "/contact"],
    deadLinkCandidates: { count: 0, examples: [] },
    emptyForms: { count: 0, examples: [] },
    formsWithPlaceholderAction: { count: 0, examples: [] },
    duplicateNavLabels: { count: 0, examples: [] },
    ...overrides,
  };
}

test("a healthy page with plenty of content and navigation produces zero findings", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(baseUx(), "https://example.com");
  assert.equal(issues.length, 0);
});

test("lorem ipsum placeholder text produces a high-severity finding", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({ hasPlaceholderText: true, placeholderExamples: ["lorem ipsum"] }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("placeholder"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
  assert.equal(finding!.category, "ux");
});

test("coming-soon language produces a high-severity finding", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({ hasComingSoonText: true, comingSoonExamples: ["coming soon"] }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("coming soon"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("extremely thin content (under 15 words) is flagged medium severity", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(baseUx({ wordCount: 5 }), "https://example.com");
  const finding = issues.find((i) => i.title.toLowerCase().includes("little visible text"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("moderately thin content (15-39 words) is flagged low severity", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(baseUx({ wordCount: 25 }), "https://example.com");
  const finding = issues.find((i) => i.title.toLowerCase().includes("little visible text"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("content at or above the thin-content threshold is not flagged", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(baseUx({ wordCount: 40 }), "https://example.com");
  assert.equal(issues.find((i) => i.title.toLowerCase().includes("little visible text")), undefined);
});

test("empty structural sections produce a low-severity finding", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({ emptySections: { count: 2, examples: ["section (no identifying attribute)"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("empty"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("missing navigation on a page that otherwise has links is flagged medium severity", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(baseUx({ hasPrimaryNav: false, navLinkCount: 0 }), "https://example.com");
  const finding = issues.find((i) => i.title.toLowerCase().includes("navigation"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("a page with zero outbound links of any kind and no nav is a dead end", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({
      hasPrimaryNav: false,
      navLinkCount: 0,
      links: {
        internalCount: 0,
        externalCount: 0,
        mailto: { count: 0, malformed: 0, malformedExamples: [] },
        tel: { count: 0, malformed: 0, malformedExamples: [] },
      },
    }),
    "https://example.com",
  );
  const deadEnd = issues.find((i) => i.title.toLowerCase().includes("dead-end"));
  assert.ok(deadEnd);
  // missing-navigation should NOT ALSO fire here - dead-end already covers this exact case
  const missingNav = issues.find((i) => i.title.toLowerCase().includes("no primary navigation"));
  assert.equal(missingNav, undefined);
});

test("a malformed mailto: link produces a low-severity finding with the count", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({
      links: {
        internalCount: 1,
        externalCount: 0,
        mailto: { count: 2, malformed: 1, malformedExamples: ["a[href=\"mailto:bad\"]"] },
        tel: { count: 0, malformed: 0, malformedExamples: [] },
      },
    }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("mailto"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
  assert.ok(finding!.estimatedImpact?.includes("1 of 2"));
});

test("every finding carries evidence, a why-it-matters, and a recommended fix", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({ hasPlaceholderText: true, placeholderExamples: ["lorem ipsum"], wordCount: 5 }),
    "https://example.com",
  );
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.ok(issue.whyItMatters.length > 0);
    assert.ok(issue.recommendedFix.length > 0);
    assert.equal(issue.category, "ux");
    assert.equal(issue.affected, "https://example.com");
  }
});

// ---------------- Phase 2 additions ----------------

test("dead-link candidates produce a medium-severity, advisory-framed finding", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(baseUx({ deadLinkCandidates: { count: 1, examples: ['a[href="#"]'] } }), "https://example.com");
  const finding = issues.find((i) => i.title.toLowerCase().includes("placeholder destination"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
  assert.ok(finding!.whyItMatters.toLowerCase().includes("static analysis"));
});

test("empty forms produce a medium-severity finding", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(baseUx({ emptyForms: { count: 1, examples: ["form (no identifying attribute)"] } }), "https://example.com");
  const finding = issues.find((i) => i.title.toLowerCase().includes("no real input fields"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("forms with a placeholder action produce a low-severity finding", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({ formsWithPlaceholderAction: { count: 1, examples: ["form (no identifying attribute)"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("placeholder value"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("duplicate nav link labels produce a medium-severity finding", () => {
  resetUxIssueIdCounter();
  const issues = detectUxIssues(
    baseUx({ duplicateNavLabels: { count: 1, examples: ['"read more" links to 2 different destinations in the same nav'] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("duplicate navigation link text"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});
