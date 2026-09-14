import assert from "node:assert/strict";
import { test } from "node:test";
import { groupIssuesByAffectedUrl } from "../src/analysis/evidenceGrouping.js";
import type { Issue } from "../src/types.js";

function makeIssue(category: Issue["category"], affected: string, title = "x"): Issue {
  return {
    id: `id-${Math.random()}`,
    category,
    severity: "medium",
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

test("a URL with issues from only one category is omitted entirely", () => {
  const issues = [makeIssue("performance", "https://example.com/a"), makeIssue("performance", "https://example.com/a", "y")];
  assert.deepEqual(groupIssuesByAffectedUrl(issues), []);
});

test("a URL with issues from 2+ distinct categories is grouped, with all its issues included", () => {
  const issues = [
    makeIssue("performance", "https://example.com/a"),
    makeIssue("seo", "https://example.com/a"),
    makeIssue("performance", "https://example.com/b"), // single-category, should not appear
  ];
  const groups = groupIssuesByAffectedUrl(issues);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].affectedUrl, "https://example.com/a");
  assert.deepEqual(groups[0].categories, ["performance", "seo"]);
  assert.equal(groups[0].issues.length, 2);
});

test("categories within a group are deduplicated and sorted", () => {
  const issues = [
    makeIssue("security", "https://example.com/a"),
    makeIssue("security", "https://example.com/a", "another security issue"),
    makeIssue("accessibility", "https://example.com/a"),
  ];
  const groups = groupIssuesByAffectedUrl(issues);
  assert.deepEqual(groups[0].categories, ["accessibility", "security"]);
  assert.equal(groups[0].issues.length, 3);
});

test("groups are sorted by category-count descending, then URL alphabetically", () => {
  const issues = [
    makeIssue("performance", "https://example.com/two-cat"),
    makeIssue("seo", "https://example.com/two-cat"),
    makeIssue("performance", "https://example.com/three-cat"),
    makeIssue("seo", "https://example.com/three-cat"),
    makeIssue("security", "https://example.com/three-cat"),
  ];
  const groups = groupIssuesByAffectedUrl(issues);
  assert.equal(groups[0].affectedUrl, "https://example.com/three-cat");
  assert.equal(groups[1].affectedUrl, "https://example.com/two-cat");
});

test("an empty issue list produces an empty group list, not an error", () => {
  assert.deepEqual(groupIssuesByAffectedUrl([]), []);
});

test("all four categories co-occurring on one URL produces one group with all four", () => {
  const issues = [
    makeIssue("performance", "https://example.com/a"),
    makeIssue("seo", "https://example.com/a"),
    makeIssue("security", "https://example.com/a"),
    makeIssue("accessibility", "https://example.com/a"),
  ];
  const groups = groupIssuesByAffectedUrl(issues);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].categories, ["accessibility", "performance", "security", "seo"]);
});

test("this utility never assigns a severity, priority, or decision - it is purely structural", () => {
  const issues = [makeIssue("performance", "https://example.com/a"), makeIssue("seo", "https://example.com/a")];
  const group = groupIssuesByAffectedUrl(issues)[0];
  assert.deepEqual(Object.keys(group).sort(), ["affectedUrl", "categories", "issues"]);
});
