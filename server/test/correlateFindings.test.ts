import assert from "node:assert/strict";
import { test } from "node:test";
import { correlateFindings } from "../src/analysis/correlateFindings.js";
import type { Issue } from "../src/types.js";

let idCounter = 0;
function issue(overrides: Partial<Issue> & Pick<Issue, "category" | "title">): Issue {
  idCounter += 1;
  return {
    id: `test-${idCounter}`,
    severity: "medium",
    affected: "https://example.com/",
    whyItMatters: "test",
    recommendedFix: "test",
    difficulty: "easy",
    priorityScore: 50,
    source: "measured",
    evidence: [],
    ...overrides,
  };
}

test("two different-category issues sharing a host are correlated", () => {
  const issues = [
    issue({ category: "security", title: "Mixed content", relatedHosts: ["ads.example.net"] }),
    issue({ category: "performance", title: "Significant third-party resource usage", relatedHosts: ["ads.example.net"] }),
  ];
  const result = correlateFindings(issues);
  assert.equal(result.length, 1);
  assert.equal(result[0].host, "ads.example.net");
  assert.deepEqual(result[0].categories, ["performance", "security"]);
  assert.equal(result[0].issueIds.length, 2);
});

test("issues in the SAME category sharing a host are not correlated (not a new insight)", () => {
  const issues = [
    issue({ category: "seo", title: "Finding A", relatedHosts: ["cdn.example.com"] }),
    issue({ category: "seo", title: "Finding B", relatedHosts: ["cdn.example.com"] }),
  ];
  assert.deepEqual(correlateFindings(issues), []);
});

test("issues with no relatedHosts at all produce no correlations and never throw", () => {
  const issues = [
    issue({ category: "seo", title: "Missing canonical tag" }),
    issue({ category: "security", title: "No HSTS header" }),
  ];
  assert.deepEqual(correlateFindings(issues), []);
});

test("issues with different hosts are never correlated, even across categories", () => {
  const issues = [
    issue({ category: "security", title: "Mixed content", relatedHosts: ["a.example.com"] }),
    issue({ category: "performance", title: "Third-party usage", relatedHosts: ["b.example.com"] }),
  ];
  assert.deepEqual(correlateFindings(issues), []);
});

test("three categories sharing one host produce one correlation listing all three", () => {
  const issues = [
    issue({ category: "security", title: "Mixed content", relatedHosts: ["shared.example.com"] }),
    issue({ category: "performance", title: "Third-party usage", relatedHosts: ["shared.example.com"] }),
    issue({ category: "seo", title: "Cross-domain canonical", relatedHosts: ["shared.example.com"] }),
  ];
  const result = correlateFindings(issues);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].categories, ["performance", "security", "seo"].sort());
});

test("a host shared across categories is deterministically ordered before a 2-category host (broadest root cause first)", () => {
  const issues = [
    issue({ category: "security", title: "A", relatedHosts: ["two-cat.example.com"] }),
    issue({ category: "performance", title: "B", relatedHosts: ["two-cat.example.com"] }),
    issue({ category: "security", title: "C", relatedHosts: ["three-cat.example.com"] }),
    issue({ category: "performance", title: "D", relatedHosts: ["three-cat.example.com"] }),
    issue({ category: "seo", title: "E", relatedHosts: ["three-cat.example.com"] }),
  ];
  const result = correlateFindings(issues);
  assert.equal(result[0].host, "three-cat.example.com");
  assert.equal(result[1].host, "two-cat.example.com");
});

test("every issueId in a correlation traces back to a real input issue", () => {
  const a = issue({ category: "security", title: "Mixed content", relatedHosts: ["x.example.com"] });
  const b = issue({ category: "seo", title: "Cross-domain canonical", relatedHosts: ["x.example.com"] });
  const result = correlateFindings([a, b]);
  assert.deepEqual(new Set(result[0].issueIds), new Set([a.id, b.id]));
});

test("the summary text is built only from real category/title data, not speculative prose", () => {
  const issues = [
    issue({ category: "security", title: "Mixed content", relatedHosts: ["x.example.com"] }),
    issue({ category: "performance", title: "Significant third-party resource usage", relatedHosts: ["x.example.com"] }),
  ];
  const result = correlateFindings(issues);
  assert.match(result[0].summary, /x\.example\.com/);
  assert.match(result[0].summary, /Mixed content/);
  assert.match(result[0].summary, /Significant third-party resource usage/);
});

test("an issue naming multiple hosts can appear in more than one correlation", () => {
  const issues = [
    issue({ category: "security", title: "Mixed content", relatedHosts: ["host-a.example.com", "host-b.example.com"] }),
    issue({ category: "performance", title: "Third-party A", relatedHosts: ["host-a.example.com"] }),
    issue({ category: "seo", title: "Third-party B", relatedHosts: ["host-b.example.com"] }),
  ];
  const result = correlateFindings(issues);
  assert.equal(result.length, 2);
});

test("an empty issue list produces no correlations", () => {
  assert.deepEqual(correlateFindings([]), []);
});
