import assert from "node:assert/strict";
import { test } from "node:test";
import { prioritize, scoreAll, scoreCategory } from "../src/analysis/scorer.js";
import type { Issue } from "../src/types.js";

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "test-1",
    category: "performance",
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

test("category with no issues scores 100", () => {
  const result = scoreCategory("seo", []);
  assert.equal(result.score, 100);
});

test("deductions stack per severity and floor at 0", () => {
  const issues = [
    issue({ category: "security", severity: "critical" }),
    issue({ category: "security", severity: "critical" }),
    issue({ category: "security", severity: "critical" }),
    issue({ category: "security", severity: "critical" }),
    issue({ category: "security", severity: "critical" }),
  ];
  const result = scoreCategory("security", issues);
  assert.equal(result.score, 0); // 5 * 25 = 125 deduction, floored at 0
  assert.equal(result.issueCount.critical, 5);
});

test("overall score is the average of all category scores", () => {
  // NOTE: this project now has six scored categories (accessibility, UX, responsiveness)
  // since this test was first written for 3. The averaging behavior
  // itself is unchanged - scoreAll() sums whatever categories exist and
  // divides by the count - only the divisor changed because a real
  // category was added, not because the scoring logic changed.
  const issues = [
    issue({ category: "performance", severity: "critical" }), // perf 75
    issue({ category: "seo", severity: "medium" }), // seo 92
    issue({ category: "accessibility", severity: "high" }), // accessibility 85
    // security: no issues -> 100
  ];
  const { categoryScores, overall } = scoreAll(issues);
  const perf = categoryScores.find((c) => c.category === "performance")!;
  const seo = categoryScores.find((c) => c.category === "seo")!;
  const security = categoryScores.find((c) => c.category === "security")!;
  const accessibility = categoryScores.find((c) => c.category === "accessibility")!;
  assert.equal(perf.score, 75);
  assert.equal(seo.score, 92);
  assert.equal(security.score, 100);
  assert.equal(accessibility.score, 85);
  assert.equal(overall, Math.round((75 + 92 + 100 + 85 + 100 + 100) / 6));
});

test("prioritize sorts by severity weight and respects the limit", () => {
  const issues = [
    issue({ id: "low", severity: "low", priorityScore: 15 }),
    issue({ id: "critical", severity: "critical", priorityScore: 100 }),
    issue({ id: "high", severity: "high", priorityScore: 70 }),
    issue({ id: "medium", severity: "medium", priorityScore: 40 }),
  ];
  const top2 = prioritize(issues, 2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0].id, "critical");
  assert.equal(top2[1].id, "high");
});
