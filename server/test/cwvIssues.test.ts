import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPerformanceFactors, detectCwvIssues, detectPageSpeedOpportunityIssues, resetCwvIssueIdCounter } from "../src/analysis/cwvIssues.js";
import { DEDUCTION } from "../src/analysis/scorer.js";
import type { CoreWebVitalsEvidence, NormalizedMetricValue } from "../src/types.js";

function metric(value: number | null, status: NormalizedMetricValue["status"], source: NormalizedMetricValue["source"] = "pagespeed-lab", unit: "ms" | "unitless" = "ms"): NormalizedMetricValue {
  return { value, status, source, unit };
}

function baseEvidence(overrides: Partial<CoreWebVitalsEvidence["metrics"]> = {}): CoreWebVitalsEvidence {
  return {
    strategy: "mobile",
    lighthousePerformanceScore: 90,
    metrics: {
      lcp: metric(2000, "good"),
      inp: metric(150, "good"),
      cls: metric(0.05, "good", "pagespeed-lab", "unitless"),
      ttfb: metric(300, "good"),
      fcp: metric(1200, "good"),
      speedIndex: metric(2000, "good"),
      tbt: metric(100, "good"),
      ...overrides,
    },
    opportunities: [],
    coverage: { metricsAvailable: 7, metricsTotal: 7 },
    lcpElement: null,
    layoutShiftElements: [],
  };
}

test("all-good evidence produces zero issues", () => {
  resetCwvIssueIdCounter();
  const issues = detectCwvIssues(baseEvidence(), "https://example.com");
  assert.equal(issues.length, 0);
});

test("poor LCP produces a high-severity performance issue with measured evidence", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ lcp: metric(5200, "poor", "pagespeed-field") });
  const issues = detectCwvIssues(evidence, "https://example.com");
  const lcpIssue = issues.find((i) => i.title.includes("Largest Contentful Paint"));
  assert.ok(lcpIssue);
  assert.equal(lcpIssue!.severity, "high");
  assert.equal(lcpIssue!.category, "performance");
  assert.ok(lcpIssue!.evidence[0].value.includes("5200"));
});

test("needs-improvement CLS produces a medium-severity issue (core metric)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ cls: metric(0.18, "needs-improvement", "pagespeed-lab", "unitless") });
  const issues = detectCwvIssues(evidence, "https://example.com");
  const clsIssue = issues.find((i) => i.title.includes("Cumulative Layout Shift"));
  assert.ok(clsIssue);
  assert.equal(clsIssue!.severity, "medium");
});

test("poor Speed Index (supplementary metric) is scored lower than poor LCP (core metric)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ speedIndex: metric(7000, "poor") });
  const issues = detectCwvIssues(evidence, "https://example.com");
  const siIssue = issues.find((i) => i.title.includes("Speed Index"));
  assert.ok(siIssue);
  assert.equal(siIssue!.severity, "medium"); // supplementary "poor" -> medium, vs core "poor" -> high
});

test("unavailable metrics never produce an issue", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ tbt: metric(null, "unavailable") });
  const issues = detectCwvIssues(evidence, "https://example.com");
  assert.equal(issues.find((i) => i.title.includes("Total Blocking Time")), undefined);
});

test("TTFB never produces a duplicate issue - it's owned by the existing HTTP-based rule", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ ttfb: metric(3000, "poor") });
  const issues = detectCwvIssues(evidence, "https://example.com");
  assert.equal(issues.find((i) => i.title.toLowerCase().includes("time to first byte")), undefined);
});

test("every generated issue carries a finite, non-negative priority score", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({
    lcp: metric(6000, "poor", "pagespeed-field"),
    inp: metric(700, "poor", "pagespeed-field"),
    cls: metric(0.4, "poor", "pagespeed-lab", "unitless"),
    fcp: metric(4000, "poor"),
    speedIndex: metric(9000, "poor"),
    tbt: metric(1000, "poor"),
  });
  const issues = detectCwvIssues(evidence, "https://example.com");
  assert.equal(issues.length, 6); // everything except ttfb
  for (const issue of issues) {
    assert.ok(Number.isFinite(issue.priorityScore));
    assert.ok(issue.priorityScore > 0);
  }
});

test("buildPerformanceFactors returns one row per metric, including good ones at 0 impact", () => {
  const factors = buildPerformanceFactors(baseEvidence());
  assert.equal(factors.length, 7);
  for (const f of factors) {
    assert.equal(f.scoreImpact, 0);
    assert.equal(f.status, "good");
  }
});

test("buildPerformanceFactors score impact exactly matches the shared DEDUCTION table", () => {
  const evidence = baseEvidence({ lcp: metric(5200, "poor", "pagespeed-field") });
  const factors = buildPerformanceFactors(evidence);
  const lcpFactor = factors.find((f) => f.metric === "lcp")!;
  assert.equal(lcpFactor.scoreImpact, -DEDUCTION.high);
});

test("buildPerformanceFactors never produces NaN or Infinity", () => {
  const evidence = baseEvidence({ lcp: metric(null, "unavailable"), cls: metric(0.4, "poor", "pagespeed-lab", "unitless") });
  const factors = buildPerformanceFactors(evidence);
  for (const f of factors) {
    if (f.value !== null) assert.ok(Number.isFinite(f.value));
    assert.ok(Number.isFinite(f.scoreImpact));
  }
});

test("buildPerformanceFactors returns an empty array when there is no evidence at all", () => {
  assert.deepEqual(buildPerformanceFactors(null), []);
});

// ---------------- detectPageSpeedOpportunityIssues ----------------

test("a materially-sized Lighthouse opportunity becomes an Issue", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence();
  evidence.opportunities = [{ id: "render-blocking-resources", title: "Eliminate render-blocking resources", estimatedSavingsMs: 800 }];
  const issues = detectPageSpeedOpportunityIssues(evidence, "https://example.com");
  const found = issues.find((i) => i.title === "Eliminate render-blocking resources");
  assert.ok(found);
  assert.equal(found?.severity, "medium");
  assert.equal(found?.category, "performance");
});

test("a very high estimated savings opportunity is high severity", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence();
  evidence.opportunities = [{ id: "unused-javascript", title: "Remove unused JavaScript", estimatedSavingsMs: 1500 }];
  const issues = detectPageSpeedOpportunityIssues(evidence, "https://example.com");
  assert.equal(issues[0].severity, "high");
});

test("trivial estimated savings are not surfaced as findings", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence();
  evidence.opportunities = [{ id: "uses-rel-preconnect", title: "Preconnect to required origins", estimatedSavingsMs: 40 }];
  const issues = detectPageSpeedOpportunityIssues(evidence, "https://example.com");
  assert.equal(issues.length, 0);
});

test("an opportunity with no estimated savings figure is not surfaced", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence();
  evidence.opportunities = [{ id: "some-audit", title: "Some audit", estimatedSavingsMs: null }];
  const issues = detectPageSpeedOpportunityIssues(evidence, "https://example.com");
  assert.equal(issues.length, 0);
});

test("no opportunities means no findings", () => {
  resetCwvIssueIdCounter();
  const issues = detectPageSpeedOpportunityIssues(baseEvidence(), "https://example.com");
  assert.equal(issues.length, 0);
});

test("opportunity issue ids do not collide with metric-threshold issue ids", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ lcp: metric(5200, "poor", "pagespeed-field") });
  evidence.opportunities = [{ id: "render-blocking-resources", title: "Eliminate render-blocking resources", estimatedSavingsMs: 800 }];
  const metricIssues = detectCwvIssues(evidence, "https://example.com");
  const oppIssues = detectPageSpeedOpportunityIssues(evidence, "https://example.com");
  const ids = new Set([...metricIssues.map((i) => i.id), ...oppIssues.map((i) => i.id)]);
  assert.equal(ids.size, metricIssues.length + oppIssues.length);
});

// ---------------- LCP root-cause correlation (Session 12) ----------------

function resourceIntelWith(url: string, contentLength: number | null) {
  return {
    entries: [{ url, kind: "image" as const, origin: "example.com", isThirdParty: false, probed: true, statusCode: 200, contentLength, contentType: "image/jpeg", cacheControl: null, contentEncoding: null, etag: null, probeError: null }],
    totalsByKind: {
      script: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
      stylesheet: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
      image: { count: 1, sizeKnownCount: contentLength !== null ? 1 : 0, knownBytes: contentLength ?? 0 },
      font: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
      other: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    },
    thirdParty: { originCount: 0, requestCount: 0, knownBytes: 0, origins: [] },
    truncated: false,
    candidateCount: 1,
    probedCount: 1,
  };
}

test("enriches the LCP finding with the specific image when it cross-verifies against probed resource evidence", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ lcp: metric(4500, "poor", "pagespeed-field") });
  evidence.lcpElement = { nodeSnippet: '<img src="https://example.com/hero.jpg">', selector: "img.hero", imageUrl: "https://example.com/hero.jpg" };
  const resourceIntelligence = resourceIntelWith("https://example.com/hero.jpg", 620_000);

  const issues = detectCwvIssues(evidence, "https://example.com/", resourceIntelligence as any);
  const lcpIssue = issues.find((i) => i.title.includes("Largest Contentful Paint"));
  assert.ok(lcpIssue);
  assert.match(lcpIssue!.estimatedImpact!, /hero\.jpg/);
  assert.match(lcpIssue!.recommendedFix, /hero\.jpg/);
  assert.ok(lcpIssue!.evidence.some((e) => e.label.includes("LCP element")));
});

test("does NOT create a second issue for the cross-verified LCP root cause (avoids double-counting)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ lcp: metric(4500, "poor", "pagespeed-field") });
  evidence.lcpElement = { nodeSnippet: '<img src="https://example.com/hero.jpg">', selector: "img.hero", imageUrl: "https://example.com/hero.jpg" };
  const resourceIntelligence = resourceIntelWith("https://example.com/hero.jpg", 620_000);

  const issues = detectCwvIssues(evidence, "https://example.com/", resourceIntelligence as any);
  const lcpIssues = issues.filter((i) => i.title.includes("Largest Contentful Paint"));
  assert.equal(lcpIssues.length, 1);
});

test("does not enrich the LCP finding when the LCP element can't be cross-verified against probed resources", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ lcp: metric(4500, "poor", "pagespeed-field") });
  evidence.lcpElement = { nodeSnippet: '<img src="https://example.com/not-probed.jpg">', selector: "img.hero", imageUrl: "https://example.com/not-probed.jpg" };
  const resourceIntelligence = resourceIntelWith("https://example.com/hero.jpg", 620_000); // different URL - no match

  const issues = detectCwvIssues(evidence, "https://example.com/", resourceIntelligence as any);
  const lcpIssue = issues.find((i) => i.title.includes("Largest Contentful Paint"));
  assert.ok(lcpIssue);
  assert.ok(!lcpIssue!.evidence.some((e) => e.label.includes("cross-verified")));
  assert.ok(!lcpIssue!.estimatedImpact!.includes("not-probed.jpg"));
});

test("does not enrich when the matched resource's size is unknown (never fabricates a size)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ lcp: metric(4500, "poor", "pagespeed-field") });
  evidence.lcpElement = { nodeSnippet: '<img src="https://example.com/hero.jpg">', selector: "img.hero", imageUrl: "https://example.com/hero.jpg" };
  const resourceIntelligence = resourceIntelWith("https://example.com/hero.jpg", null); // matched URL, but size unknown

  const issues = detectCwvIssues(evidence, "https://example.com/", resourceIntelligence as any);
  const lcpIssue = issues.find((i) => i.title.includes("Largest Contentful Paint"));
  assert.ok(!lcpIssue!.evidence.some((e) => e.label.includes("cross-verified")));
});

test("does not enrich when no resourceIntelligence is supplied at all (backward compatible)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ lcp: metric(4500, "poor", "pagespeed-field") });
  evidence.lcpElement = { nodeSnippet: '<img src="https://example.com/hero.jpg">', selector: "img.hero", imageUrl: "https://example.com/hero.jpg" };

  const issues = detectCwvIssues(evidence, "https://example.com/");
  const lcpIssue = issues.find((i) => i.title.includes("Largest Contentful Paint"));
  assert.ok(lcpIssue);
  assert.ok(!lcpIssue!.evidence.some((e) => e.label.includes("cross-verified")));
});

test("does not enrich when LCP is good (nothing to explain)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence(); // lcp: good
  evidence.lcpElement = { nodeSnippet: '<img src="https://example.com/hero.jpg">', selector: "img.hero", imageUrl: "https://example.com/hero.jpg" };
  const resourceIntelligence = resourceIntelWith("https://example.com/hero.jpg", 620_000);

  const issues = detectCwvIssues(evidence, "https://example.com/", resourceIntelligence as any);
  assert.ok(!issues.some((i) => i.title.includes("Largest Contentful Paint")));
});


test("enriches the CLS finding with specific shift-contributing elements", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ cls: metric(0.35, "poor", "pagespeed-lab") });
  evidence.layoutShiftElements = [
    { nodeSnippet: '<img src="https://example.com/banner.jpg">', selector: "div.promo > img", imageUrl: "https://example.com/banner.jpg", hasDeclaredDimensions: false, scoreContribution: 0.2 },
  ];

  const issues = detectCwvIssues(evidence, "https://example.com/");
  const clsIssue = issues.find((i) => i.title.includes("Cumulative Layout Shift"));
  assert.ok(clsIssue);
  assert.match(clsIssue!.estimatedImpact!, /shift-contributing element/);
  assert.ok(clsIssue!.evidence.some((e) => e.label === "Layout-shift contributor"));
});

test("recommends adding explicit dimensions specifically to elements missing them", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ cls: metric(0.3, "poor", "pagespeed-lab") });
  evidence.layoutShiftElements = [
    { nodeSnippet: null, selector: "div.promo > img", imageUrl: null, hasDeclaredDimensions: false, scoreContribution: 0.2 },
  ];

  const issues = detectCwvIssues(evidence, "https://example.com/");
  const clsIssue = issues.find((i) => i.title.includes("Cumulative Layout Shift"));
  assert.match(clsIssue!.recommendedFix, /div\.promo > img/);
  assert.match(clsIssue!.recommendedFix, /width\/height/);
});

test("does not claim a missing-dimensions fix when the contributing elements DO have declared dimensions", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ cls: metric(0.3, "poor", "pagespeed-lab") });
  evidence.layoutShiftElements = [
    { nodeSnippet: null, selector: "div.ad-slot", imageUrl: null, hasDeclaredDimensions: true, scoreContribution: 0.15 },
  ];

  const issues = detectCwvIssues(evidence, "https://example.com/");
  const clsIssue = issues.find((i) => i.title.includes("Cumulative Layout Shift"));
  assert.ok(!clsIssue!.recommendedFix.includes("Add explicit width/height"));
});

test("adds a bonus size figure to the CLS evidence when the shifting element is also a probed image", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ cls: metric(0.3, "poor", "pagespeed-lab") });
  evidence.layoutShiftElements = [
    { nodeSnippet: null, selector: "img.banner", imageUrl: "https://example.com/banner.jpg", hasDeclaredDimensions: false, scoreContribution: 0.2 },
  ];
  const resourceIntelligence = resourceIntelWith("https://example.com/banner.jpg", 340_000);

  const issues = detectCwvIssues(evidence, "https://example.com/", resourceIntelligence as any);
  const clsIssue = issues.find((i) => i.title.includes("Cumulative Layout Shift"));
  assert.ok(clsIssue!.evidence.some((e) => e.value.includes("332KB") || e.value.includes("KB")));
});

test("does not create a second issue for the CLS root cause (avoids double-counting)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ cls: metric(0.3, "poor", "pagespeed-lab") });
  evidence.layoutShiftElements = [{ nodeSnippet: null, selector: "div.promo", imageUrl: null, hasDeclaredDimensions: false, scoreContribution: 0.2 }];

  const issues = detectCwvIssues(evidence, "https://example.com/");
  const clsIssues = issues.filter((i) => i.title.includes("Cumulative Layout Shift"));
  assert.equal(clsIssues.length, 1);
});

test("does not enrich CLS when layoutShiftElements is empty (backward compatible, no fabrication)", () => {
  resetCwvIssueIdCounter();
  const evidence = baseEvidence({ cls: metric(0.3, "poor", "pagespeed-lab") });
  const issues = detectCwvIssues(evidence, "https://example.com/");
  const clsIssue = issues.find((i) => i.title.includes("Cumulative Layout Shift"));
  assert.ok(clsIssue);
  assert.ok(!clsIssue!.evidence.some((e) => e.label === "Layout-shift contributor"));
});
