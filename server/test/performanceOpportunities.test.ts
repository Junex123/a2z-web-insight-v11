import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPerformanceOpportunities,
  buildPerformanceRootCauseChains,
  buildSiteWidePerformanceOpportunities,
  buildSiteWideRootCauseChains,
  classifyPerformanceTitle,
} from "../src/analysis/performanceOpportunities.js";
import type { Issue, SiteWideFinding } from "../src/types.js";

let idCounter = 0;
function makeIssue(overrides: Partial<Issue> & Pick<Issue, "title" | "severity">): Issue {
  idCounter += 1;
  return {
    id: `issue-${idCounter}`,
    category: "performance",
    affected: "https://example.com/",
    whyItMatters: "why",
    estimatedImpact: `Evidence for ${overrides.title}`,
    recommendedFix: "fix",
    difficulty: "easy",
    priorityScore: 1,
    source: "measured",
    evidence: [],
    ...overrides,
  };
}

// ---------------- classifyPerformanceTitle ----------------

test("exact-match titles classify into the correct opportunity category", () => {
  assert.equal(classifyPerformanceTitle("Large total image payload"), "image-delivery");
  assert.equal(classifyPerformanceTitle("Large JavaScript payload"), "javascript-delivery");
  assert.equal(classifyPerformanceTitle("Large CSS payload"), "css-delivery");
  assert.equal(classifyPerformanceTitle("Large font payload"), "font-delivery");
  assert.equal(classifyPerformanceTitle("Static assets have a short or missing cache lifetime"), "caching-and-compression");
  assert.equal(classifyPerformanceTitle("Server response time is slow"), "server-response");
  assert.equal(classifyPerformanceTitle("Excessive DOM size"), "rendering-and-interactivity");
  assert.equal(classifyPerformanceTitle("Development/localhost resource referenced in production HTML"), "production-build-quality");
});

test("interpolated Core Web Vitals titles ('X is poor'/'X is needs improvement') are pattern-matched", () => {
  assert.equal(classifyPerformanceTitle("LCP is poor"), "core-web-vitals");
  assert.equal(classifyPerformanceTitle("INP is needs improvement"), "core-web-vitals");
  assert.equal(classifyPerformanceTitle("CLS is poor"), "core-web-vitals");
});

test("interpolated third-party titles are pattern-matched regardless of the entity name", () => {
  assert.equal(classifyPerformanceTitle('Third-party resource "Stripe" (payments) has a measurable performance cost'), "third-party-overhead");
  assert.equal(classifyPerformanceTitle('Third-party resource "Mystery Vendor" has a measurable performance cost'), "third-party-overhead");
});

test("an unrecognized title falls back to other-performance rather than being dropped", () => {
  assert.equal(classifyPerformanceTitle("Some brand new rule nobody mapped yet"), "other-performance");
});

// ---------------- buildPerformanceOpportunities ----------------

test("groups multiple issues from the same opportunity into one entry with all evidence preserved", () => {
  const issues = [
    makeIssue({ title: "Large total image payload", severity: "high" }),
    makeIssue({ title: "Images missing explicit width/height", severity: "medium" }),
    makeIssue({ title: "Below-the-fold images are not deferred", severity: "medium" }),
  ];
  const opportunities = buildPerformanceOpportunities(issues);
  assert.equal(opportunities.length, 1);
  const img = opportunities[0];
  assert.equal(img.category, "image-delivery");
  assert.equal(img.issueCount, 3);
  assert.equal(img.affectedIssueIds.length, 3);
  assert.equal(img.evidenceSummary.length, 3);
  assert.ok(img.evidenceSummary.every((e) => e.startsWith("Evidence for")));
});

test("opportunity severity is the worst severity among its grouped issues", () => {
  const issues = [
    makeIssue({ title: "Large CSS payload", severity: "low" }),
    makeIssue({ title: "Unminified CSS", severity: "critical" }),
  ];
  assert.equal(buildPerformanceOpportunities(issues)[0].severity, "critical");
});

test("non-performance issues are excluded entirely", () => {
  const issues = [makeIssue({ title: "Missing canonical tag", severity: "low", category: "seo" })];
  assert.deepEqual(buildPerformanceOpportunities(issues), []);
});

test("every input issue's id appears in exactly one opportunity's affectedIssueIds", () => {
  const issues = [
    makeIssue({ title: "Large JavaScript payload", severity: "high" }),
    makeIssue({ title: "Large CSS payload", severity: "medium" }),
    makeIssue({ title: "LCP is poor", severity: "high" }),
  ];
  const opportunities = buildPerformanceOpportunities(issues);
  const allIds = opportunities.flatMap((o) => o.affectedIssueIds);
  assert.deepEqual(allIds.sort(), issues.map((i) => i.id).sort());
});

test("the problem statement never fabricates a figure - it only states the issue count", () => {
  const issues = [makeIssue({ title: "Large total image payload", severity: "high" })];
  const opportunity = buildPerformanceOpportunities(issues)[0];
  assert.ok(opportunity.problem.includes("1"));
  // no injected byte/ms figures beyond what's already in the issue's own estimatedImpact (evidenceSummary)
  assert.ok(!/\d+(KB|MB|ms)/.test(opportunity.problem));
});

test("opportunities are sorted by severity (worst first), then by issue count", () => {
  const issues = [
    makeIssue({ title: "Large CSS payload", severity: "low" }),
    makeIssue({ title: "Large font payload", severity: "critical" }),
    makeIssue({ title: "Large JavaScript payload", severity: "high" }),
  ];
  const opportunities = buildPerformanceOpportunities(issues);
  assert.equal(opportunities[0].category, "font-delivery");
  assert.equal(opportunities[1].category, "javascript-delivery");
  assert.equal(opportunities[2].category, "css-delivery");
});

test("an empty issue list produces an empty opportunity list", () => {
  assert.deepEqual(buildPerformanceOpportunities([]), []);
});

test("a title that falls back to other-performance is still surfaced, not silently dropped", () => {
  const issues = [makeIssue({ title: "Some brand new rule nobody mapped yet", severity: "medium" })];
  const opportunities = buildPerformanceOpportunities(issues);
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].category, "other-performance");
});

// ---------------- buildSiteWidePerformanceOpportunities ----------------

function makeFinding(overrides: Partial<SiteWideFinding> & Pick<SiteWideFinding, "title" | "severity">): SiteWideFinding {
  return {
    category: "performance",
    affectedUrls: ["https://example.com/a", "https://example.com/b"],
    occurrenceCount: 2,
    pagesAnalyzed: 10,
    ...overrides,
  };
}

test("site-wide opportunities group SiteWideFindings the same way single-page issues are grouped", () => {
  const findings = [makeFinding({ title: "Large total image payload", severity: "high", occurrenceCount: 31, pagesAnalyzed: 42 })];
  const opportunities = buildSiteWidePerformanceOpportunities(findings);
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].category, "image-delivery");
  assert.equal(opportunities[0].pagesAnalyzed, 42);
  assert.ok(opportunities[0].evidenceSummary[0].includes("31 of 42"));
});

test("non-performance SiteWideFindings are excluded", () => {
  const findings = [makeFinding({ title: "Missing canonical tag", severity: "low", category: "seo" })];
  assert.deepEqual(buildSiteWidePerformanceOpportunities(findings), []);
});

test("an empty finding list produces an empty opportunity list", () => {
  assert.deepEqual(buildSiteWidePerformanceOpportunities([]), []);
});

test("multiple site-wide findings in the same category are grouped into one opportunity", () => {
  const findings = [
    makeFinding({ title: "Large JavaScript payload", severity: "high" }),
    makeFinding({ title: "Significant unused JavaScript", severity: "medium" }),
  ];
  const opportunities = buildSiteWidePerformanceOpportunities(findings);
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].category, "javascript-delivery");
  assert.equal(opportunities[0].evidenceSummary.length, 2);
});

test("evidence bullets include the real, computed affected-page percentage", () => {
  const findings = [makeFinding({ title: "Large total image payload", severity: "high", occurrenceCount: 21, pagesAnalyzed: 42 })];
  const opportunity = buildSiteWidePerformanceOpportunities(findings)[0];
  assert.ok(opportunity.evidenceSummary[0].includes("(50%)"));
});

test("a finding affecting >=50% of pages gets a template-leverage note", () => {
  const findings = [makeFinding({ title: "Large total image payload", severity: "high", occurrenceCount: 31, pagesAnalyzed: 42 })];
  const opportunity = buildSiteWidePerformanceOpportunities(findings)[0];
  assert.ok(opportunity.evidenceSummary[0].includes("shared template/component"));
});

test("a finding affecting <50% of pages does NOT get a template-leverage note", () => {
  const findings = [makeFinding({ title: "Large total image payload", severity: "high", occurrenceCount: 3, pagesAnalyzed: 42 })];
  const opportunity = buildSiteWidePerformanceOpportunities(findings)[0];
  assert.ok(!opportunity.evidenceSummary[0].includes("shared template/component"));
});

// ---------------- buildSiteWideRootCauseChains ----------------

test("image-delivery + LCP fires the site-wide image-to-LCP chain", () => {
  const findings = [
    makeFinding({ title: "Large total image payload", severity: "high" }),
    makeFinding({ title: "LCP is poor", severity: "high" }),
  ];
  const chains = buildSiteWideRootCauseChains(findings);
  const chain = chains.find((c) => c.id === "image-delivery-to-lcp");
  assert.ok(chain);
  assert.ok(chain!.supportingFindingTitles.includes("Large total image payload"));
  assert.ok(chain!.supportingFindingTitles.includes("LCP is poor"));
  assert.equal(chain!.confidence, "medium");
  assert.equal(chain!.pagesAnalyzed, 10);
});

test("site-wide chains never claim high confidence or proven causality", () => {
  const findings = [
    makeFinding({ title: "Large total image payload", severity: "high" }),
    makeFinding({ title: "LCP is poor", severity: "high" }),
  ];
  for (const chain of buildSiteWideRootCauseChains(findings)) {
    assert.notEqual(chain.confidence, "high");
    assert.ok(!/\bcauses\b|\bproven\b|\bguaranteed\b/i.test(chain.headline));
  }
});

test("no site-wide chains fire when findings don't co-occur", () => {
  const findings = [makeFinding({ title: "Large total image payload", severity: "high" })];
  assert.ok(!buildSiteWideRootCauseChains(findings).some((c) => c.id === "image-delivery-to-lcp"));
});

test("an empty finding list produces an empty site-wide chain list", () => {
  assert.deepEqual(buildSiteWideRootCauseChains([]), []);
});

test("non-performance findings never contribute to a site-wide root-cause chain", () => {
  const findings = [
    makeFinding({ title: "Large total image payload", severity: "high", category: "seo" }),
    makeFinding({ title: "LCP is poor", severity: "high" }),
  ];
  assert.ok(!buildSiteWideRootCauseChains(findings).some((c) => c.id === "image-delivery-to-lcp"));
});

// ---------------- fix-priority (impact/effort) classification ----------------

test("a high-severity, easy-to-fix opportunity is classified as a quick win, ranked first", () => {
  const issues = [makeIssue({ title: "Large font payload", severity: "high", difficulty: "easy" })];
  const opportunities = buildPerformanceOpportunities(issues);
  assert.equal(opportunities[0].fixPriority, "quick-win");
  assert.equal(opportunities[0].fixPriorityRank, 1);
  assert.equal(opportunities[0].dominantDifficulty, "easy");
});

test("a high-severity, hard-to-fix opportunity is classified as a major project", () => {
  const issues = [makeIssue({ title: "Excessive DOM size", severity: "critical", difficulty: "hard" })];
  assert.equal(buildPerformanceOpportunities(issues)[0].fixPriority, "major-project");
});

test("a low-severity, easy-to-fix opportunity is classified as a fill-in", () => {
  const issues = [makeIssue({ title: "The same stylesheet is referenced more than once", severity: "low", difficulty: "easy" })];
  assert.equal(buildPerformanceOpportunities(issues)[0].fixPriority, "fill-in");
});

test("a low-severity, hard-to-fix opportunity is classified as reconsider", () => {
  const issues = [makeIssue({ title: "Server response time is slow", severity: "medium", difficulty: "hard" })];
  assert.equal(buildPerformanceOpportunities(issues)[0].fixPriority, "reconsider");
});

test("quick wins are always ranked before major projects, even when the major project is more severe", () => {
  const issues = [
    makeIssue({ title: "Excessive DOM size", severity: "critical", difficulty: "hard" }), // major-project
    makeIssue({ title: "Large font payload", severity: "high", difficulty: "easy" }), // quick-win
  ];
  const opportunities = buildPerformanceOpportunities(issues);
  assert.equal(opportunities[0].fixPriority, "quick-win");
  assert.equal(opportunities[0].fixPriorityRank, 1);
  assert.equal(opportunities[1].fixPriority, "major-project");
  assert.equal(opportunities[1].fixPriorityRank, 2);
});

test("dominantDifficulty is the mode across a group's issues", () => {
  const issues = [
    makeIssue({ title: "Large total image payload", severity: "high", difficulty: "moderate" }),
    makeIssue({ title: "Images missing explicit width/height", severity: "medium", difficulty: "easy" }),
    makeIssue({ title: "Below-the-fold images are not deferred", severity: "low", difficulty: "easy" }),
  ];
  assert.equal(buildPerformanceOpportunities(issues)[0].dominantDifficulty, "easy");
});

test("fixPriorityRank is a contiguous 1-based sequence across the full returned array", () => {
  const issues = [
    makeIssue({ title: "Large font payload", severity: "high", difficulty: "easy" }),
    makeIssue({ title: "Excessive DOM size", severity: "critical", difficulty: "hard" }),
    makeIssue({ title: "The same stylesheet is referenced more than once", severity: "low", difficulty: "easy" }),
  ];
  const ranks = buildPerformanceOpportunities(issues).map((o) => o.fixPriorityRank);
  assert.deepEqual(ranks, [1, 2, 3]);
});

// ---------------- performance root-cause chains ----------------

test("image-delivery + LCP fires the image-to-LCP chain, with both sides' issue ids as support", () => {
  const imageIssue = makeIssue({ title: "Large total image payload", severity: "high" });
  const lcpIssue = makeIssue({ title: "LCP is poor", severity: "high" });
  const chains = buildPerformanceRootCauseChains([imageIssue, lcpIssue]);
  const chain = chains.find((c) => c.id === "image-delivery-to-lcp");
  assert.ok(chain);
  assert.ok(chain!.supportingIssueIds.includes(imageIssue.id));
  assert.ok(chain!.supportingIssueIds.includes(lcpIssue.id));
  assert.equal(chain!.confidence, "medium");
});

test("image-delivery alone (no LCP issue) does not fire the image-to-LCP chain", () => {
  const chains = buildPerformanceRootCauseChains([makeIssue({ title: "Large total image payload", severity: "high" })]);
  assert.ok(!chains.some((c) => c.id === "image-delivery-to-lcp"));
});

test("an LCP issue alone (no image-delivery issue) does not fire the image-to-LCP chain", () => {
  const chains = buildPerformanceRootCauseChains([makeIssue({ title: "LCP is poor", severity: "high" })]);
  assert.ok(!chains.some((c) => c.id === "image-delivery-to-lcp"));
});

test("JS payload + INP fires the js-and-main-thread-to-inp chain", () => {
  const chains = buildPerformanceRootCauseChains([
    makeIssue({ title: "Large JavaScript payload", severity: "high" }),
    makeIssue({ title: "INP is needs improvement", severity: "medium" }),
  ]);
  assert.ok(chains.some((c) => c.id === "js-and-main-thread-to-inp"));
});

test("excessive DOM size + INP also fires the js-and-main-thread-to-inp chain (rendering-and-interactivity counts too)", () => {
  const chains = buildPerformanceRootCauseChains([
    makeIssue({ title: "Excessive DOM size", severity: "medium" }),
    makeIssue({ title: "INP is poor", severity: "high" }),
  ]);
  assert.ok(chains.some((c) => c.id === "js-and-main-thread-to-inp"));
});

test("render-blocking resources + LCP fires the render-blocking-to-paint-timing chain and names the actual metric", () => {
  const chains = buildPerformanceRootCauseChains([
    makeIssue({ title: "Render-blocking resources delay first paint", severity: "high" }),
    makeIssue({ title: "LCP is poor", severity: "high" }),
  ]);
  const chain = chains.find((c) => c.id === "render-blocking-to-paint-timing");
  assert.ok(chain);
  assert.ok(chain!.chain.some((step) => step.includes("LCP")));
});

test("font-display + CLS fires the font-display-to-cls chain at low confidence", () => {
  const chains = buildPerformanceRootCauseChains([
    makeIssue({ title: "Fonts missing an effective font-display", severity: "medium" }),
    makeIssue({ title: "CLS is poor", severity: "high" }),
  ]);
  const chain = chains.find((c) => c.id === "font-display-to-cls");
  assert.ok(chain);
  assert.equal(chain!.confidence, "low");
});

test("caching issues + document-weight issues fire the caching-compounds-page-weight chain", () => {
  const chains = buildPerformanceRootCauseChains([
    makeIssue({ title: "Some text-based resources are not compressed", severity: "medium" }),
    makeIssue({ title: "Total page weight is large", severity: "high" }),
  ]);
  assert.ok(chains.some((c) => c.id === "caching-compounds-page-weight"));
});

test("no chains fire for a clean page with no performance issues", () => {
  assert.deepEqual(buildPerformanceRootCauseChains([]), []);
});

test("chain language stays conservative - never claims proven/direct causality", () => {
  const chains = buildPerformanceRootCauseChains([
    makeIssue({ title: "Large total image payload", severity: "high" }),
    makeIssue({ title: "LCP is poor", severity: "high" }),
  ]);
  for (const chain of chains) {
    assert.ok(!/\bcauses\b|\bproven\b|\bguaranteed\b/i.test(chain.headline));
    assert.notEqual(chain.confidence, "high");
  }
});

test("non-performance issues never contribute to a root-cause chain", () => {
  const chains = buildPerformanceRootCauseChains([
    makeIssue({ title: "Large total image payload", severity: "high", category: "seo" }),
    makeIssue({ title: "LCP is poor", severity: "high" }),
  ]);
  assert.ok(!chains.some((c) => c.id === "image-delivery-to-lcp"));
});
