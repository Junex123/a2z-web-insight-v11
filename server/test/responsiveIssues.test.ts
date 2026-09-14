import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResponsiveVerification, detectResponsiveIssues, resetResponsiveIssueIdCounter } from "../src/analysis/responsiveIssues.js";
import type { ResponsiveAnalysis } from "../src/types.js";

function baseResponsive(overrides: Partial<ResponsiveAnalysis> = {}): ResponsiveAnalysis {
  return {
    viewport: { present: true, content: "width=device-width, initial-scale=1", hasDeviceWidthToken: true, hasFixedNumericWidth: false, fixedWidthValue: null, disablesZoom: false },
    css: {
      inspected: true,
      sources: [{ source: "inline", url: null, bytesInspected: 100 }],
      externalStylesheetsSkipped: 0,
      mediaQueryCount: 1,
      distinctBreakpointValues: [768],
      fixedWidthDeclarations: [],
      viewportUnitFullWidthCount: 0,
      fixedPositionRuleCount: 0,
      hasResponsiveImagePattern: true,
    },
    images: { total: 1, withSrcsetOrSizes: 1, largeStaticWidthExamples: [] },
    navigation: { navElementCount: 1, duplicateNavRisk: false, largestMenuLinkCount: 3, emptyControlCount: 0 },
    ...overrides,
  };
}

// ---------------- Issue generation ----------------

test("a fully clean responsive page produces zero issues", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(baseResponsive(), "https://example.com");
  assert.equal(issues.length, 0);
});

test("suspicious fixed-width viewport produces a medium-severity issue", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(
    baseResponsive({ viewport: { present: true, content: "width=980", hasDeviceWidthToken: false, hasFixedNumericWidth: true, fixedWidthValue: 980, disablesZoom: false } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("hardcoded pixel width"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
  assert.equal(finding!.category, "responsiveness");
});

test("missing viewport (bare absence) does NOT produce a duplicate issue - already owned by SEO", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(
    baseResponsive({ viewport: { present: false, content: null, hasDeviceWidthToken: false, hasFixedNumericWidth: false, fixedWidthValue: null, disablesZoom: false } }),
    "https://example.com",
  );
  assert.equal(issues.find((i) => i.title.toLowerCase().includes("viewport")), undefined);
});

test("viewport disabling zoom does NOT produce a duplicate issue - already owned by Accessibility", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(
    baseResponsive({ viewport: { present: true, content: "width=device-width, user-scalable=no", hasDeviceWidthToken: true, hasFixedNumericWidth: false, fixedWidthValue: null, disablesZoom: true } }),
    "https://example.com",
  );
  assert.equal(issues.find((i) => i.title.toLowerCase().includes("zoom")), undefined);
});

test("large images without responsive attributes produce a finding whose severity scales with count", () => {
  resetResponsiveIssueIdCounter();
  const fewIssues = detectResponsiveIssues(
    baseResponsive({ images: { total: 2, withSrcsetOrSizes: 0, largeStaticWidthExamples: [{ src: "a.jpg", widthPx: 1600 }] } }),
    "https://example.com",
  );
  const fewFinding = fewIssues.find((i) => i.title.toLowerCase().includes("srcset"));
  assert.ok(fewFinding);
  assert.equal(fewFinding!.severity, "low");

  resetResponsiveIssueIdCounter();
  const manyIssues = detectResponsiveIssues(
    baseResponsive({
      images: {
        total: 5,
        withSrcsetOrSizes: 0,
        largeStaticWidthExamples: [
          { src: "a.jpg", widthPx: 1600 },
          { src: "b.jpg", widthPx: 1600 },
          { src: "c.jpg", widthPx: 1600 },
        ],
      },
    }),
    "https://example.com",
  );
  const manyFinding = manyIssues.find((i) => i.title.toLowerCase().includes("srcset"));
  assert.equal(manyFinding!.severity, "medium");
});

test("fixed-width CSS risk is only flagged when CSS evidence actually exists", () => {
  resetResponsiveIssueIdCounter();
  const noEvidence = detectResponsiveIssues(
    baseResponsive({
      css: {
        inspected: false,
        sources: [],
        externalStylesheetsSkipped: 1,
        mediaQueryCount: 0,
        distinctBreakpointValues: [],
        fixedWidthDeclarations: [{ valuePx: 900 }],
        viewportUnitFullWidthCount: 0,
        fixedPositionRuleCount: 0,
        hasResponsiveImagePattern: false,
      },
    }),
    "https://example.com",
  );
  // even though fixedWidthDeclarations has an entry, inspected:false means we
  // don't trust it enough to raise a finding - this combination shouldn't occur
  // from the real collector, but the issue-detector must not crash or misreport
  assert.equal(noEvidence.find((i) => i.title.toLowerCase().includes("fixed-width")), undefined);
});

test("fixed-width CSS declarations above the mobile risk threshold produce a low-severity finding", () => {
  resetResponsiveIssueIdCounter();
  const base = baseResponsive();
  const issues = detectResponsiveIssues(
    baseResponsive({ css: { ...base.css, fixedWidthDeclarations: [{ valuePx: 980 }] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("fixed-width css"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("100vw usage produces a low-severity finding", () => {
  resetResponsiveIssueIdCounter();
  const base = baseResponsive();
  const issues = detectResponsiveIssues(
    baseResponsive({ css: { ...base.css, viewportUnitFullWidthCount: 2 } }),
    "https://example.com",
  );
  assert.ok(issues.find((i) => i.title.includes("100vw")));
});

test("a large flat nav menu produces a finding", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(
    baseResponsive({ navigation: { navElementCount: 1, duplicateNavRisk: false, largestMenuLinkCount: 15, emptyControlCount: 0 } }),
    "https://example.com",
  );
  assert.ok(issues.find((i) => i.title.toLowerCase().includes("many top-level links")));
});

test("duplicate navigation structures produce a medium-severity finding", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(
    baseResponsive({ navigation: { navElementCount: 2, duplicateNavRisk: true, largestMenuLinkCount: 3, emptyControlCount: 0 } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("duplicate"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("empty navigation controls do NOT produce a duplicate issue - overlaps with Accessibility", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(
    baseResponsive({ navigation: { navElementCount: 1, duplicateNavRisk: false, largestMenuLinkCount: 3, emptyControlCount: 2 } }),
    "https://example.com",
  );
  assert.equal(issues.find((i) => i.title.toLowerCase().includes("empty")), undefined);
});

test("excessive desktop fixed width produces a low-severity finding", () => {
  resetResponsiveIssueIdCounter();
  const base = baseResponsive();
  const issues = detectResponsiveIssues(
    baseResponsive({ css: { ...base.css, fixedWidthDeclarations: [{ valuePx: 2000 }] } }),
    "https://example.com",
  );
  assert.ok(issues.find((i) => i.title.toLowerCase().includes("very large fixed-width")));
});

test("every generated issue carries evidence and is never critical severity (heuristic-based category)", () => {
  resetResponsiveIssueIdCounter();
  const issues = detectResponsiveIssues(
    baseResponsive({
      viewport: { present: true, content: "width=980", hasDeviceWidthToken: false, hasFixedNumericWidth: true, fixedWidthValue: 980, disablesZoom: false },
      images: { total: 3, withSrcsetOrSizes: 0, largeStaticWidthExamples: [{ src: "a.jpg", widthPx: 1600 }] },
      css: {
        inspected: true,
        sources: [{ source: "inline", url: null, bytesInspected: 10 }],
        externalStylesheetsSkipped: 0,
        mediaQueryCount: 0,
        distinctBreakpointValues: [],
        fixedWidthDeclarations: [{ valuePx: 2000 }],
        viewportUnitFullWidthCount: 3,
        fixedPositionRuleCount: 0,
        hasResponsiveImagePattern: false,
      },
      navigation: { navElementCount: 2, duplicateNavRisk: true, largestMenuLinkCount: 20, emptyControlCount: 0 },
    }),
    "https://example.com",
  );
  assert.ok(issues.length >= 6);
  for (const issue of issues) {
    assert.ok(issue.evidence.length > 0, `issue "${issue.title}" has no evidence`);
    assert.notEqual(issue.severity, "critical", `"${issue.title}" should never be critical - this is a heuristic, static-evidence-limited category`);
  }
});

test("stable finding IDs for identical input (counter reset)", () => {
  resetResponsiveIssueIdCounter();
  const first = detectResponsiveIssues(
    baseResponsive({ navigation: { navElementCount: 2, duplicateNavRisk: true, largestMenuLinkCount: 3, emptyControlCount: 0 } }),
    "https://example.com",
  );
  resetResponsiveIssueIdCounter();
  const second = detectResponsiveIssues(
    baseResponsive({ navigation: { navElementCount: 2, duplicateNavRisk: true, largestMenuLinkCount: 3, emptyControlCount: 0 } }),
    "https://example.com",
  );
  assert.deepEqual(
    first.map((i) => i.id),
    second.map((i) => i.id),
  );
});

// ---------------- Mobile/Desktop verification summary ----------------

test("verification summary: a clean page has zero warnings/failures and only the structural unverified checks", () => {
  const summary = buildResponsiveVerification(baseResponsive());
  assert.equal(summary.mobile.failures, 0);
  assert.equal(summary.mobile.warnings, 0);
  assert.equal(summary.desktop.failures, 0);
  assert.equal(summary.desktop.warnings, 0);
  assert.ok(summary.mobile.unverified >= 2);
  assert.ok(summary.desktop.unverified >= 1);
});

test("verification summary: missing viewport is a mobile failure", () => {
  const summary = buildResponsiveVerification(
    baseResponsive({ viewport: { present: false, content: null, hasDeviceWidthToken: false, hasFixedNumericWidth: false, fixedWidthValue: null, disablesZoom: false } }),
  );
  const check = summary.checks.find((c) => c.id === "viewport-meta-present")!;
  assert.equal(check.state, "failed");
  assert.equal(check.context, "mobile");
  assert.equal(summary.mobile.failures, 1);
});

test("verification summary: a 'both' context check counts toward BOTH mobile and desktop tallies, not duplicated as two entries", () => {
  const summary = buildResponsiveVerification(
    baseResponsive({ navigation: { navElementCount: 2, duplicateNavRisk: true, largestMenuLinkCount: 3, emptyControlCount: 0 } }),
  );
  const matchingChecks = summary.checks.filter((c) => c.id === "duplicate-navigation-structures");
  assert.equal(matchingChecks.length, 1, "a device-independent check must appear once in the checks list, not twice");
  assert.equal(matchingChecks[0].context, "both");
  assert.ok(summary.mobile.warnings >= 1);
  assert.ok(summary.desktop.warnings >= 1);
});

test("verification summary: no CSS evidence produces 'unverified', never a false 'passed'", () => {
  const summary = buildResponsiveVerification(
    baseResponsive({
      css: {
        inspected: false,
        sources: [],
        externalStylesheetsSkipped: 1,
        mediaQueryCount: 0,
        distinctBreakpointValues: [],
        fixedWidthDeclarations: [],
        viewportUnitFullWidthCount: 0,
        fixedPositionRuleCount: 0,
        hasResponsiveImagePattern: false,
      },
    }),
  );
  const breakpointCheck = summary.checks.find((c) => c.id === "css-breakpoint-evidence")!;
  assert.equal(breakpointCheck.state, "unverified");
  const fixedWidthCheck = summary.checks.find((c) => c.id === "fixed-width-css-risk")!;
  assert.equal(fixedWidthCheck.state, "unverified");
});

test("verification summary: no media queries but a positive responsive signal is still 'passed', not penalized", () => {
  const summary = buildResponsiveVerification(
    baseResponsive({
      css: {
        inspected: true,
        sources: [{ source: "inline", url: null, bytesInspected: 10 }],
        externalStylesheetsSkipped: 0,
        mediaQueryCount: 0,
        distinctBreakpointValues: [],
        fixedWidthDeclarations: [],
        viewportUnitFullWidthCount: 0,
        fixedPositionRuleCount: 0,
        hasResponsiveImagePattern: true,
      },
    }),
  );
  const check = summary.checks.find((c) => c.id === "css-breakpoint-evidence")!;
  assert.equal(check.state, "passed");
});

test("verification summary: no media queries AND no other positive signal is a warning, never asserted as a definite failure", () => {
  const summary = buildResponsiveVerification(
    baseResponsive({
      viewport: { present: true, content: "width=980", hasDeviceWidthToken: false, hasFixedNumericWidth: true, fixedWidthValue: 980, disablesZoom: false },
      css: {
        inspected: true,
        sources: [{ source: "inline", url: null, bytesInspected: 10 }],
        externalStylesheetsSkipped: 0,
        mediaQueryCount: 0,
        distinctBreakpointValues: [],
        fixedWidthDeclarations: [],
        viewportUnitFullWidthCount: 0,
        fixedPositionRuleCount: 0,
        hasResponsiveImagePattern: false,
      },
    }),
  );
  const check = summary.checks.find((c) => c.id === "css-breakpoint-evidence")!;
  assert.equal(check.state, "warning", "must never be 'failed' - the brief explicitly forbids treating this as a definite result");
});

test("verification summary always includes the structurally-unverified runtime checks, never omits them", () => {
  const summary = buildResponsiveVerification(baseResponsive());
  const ids = summary.checks.map((c) => c.id);
  assert.ok(ids.includes("rendered-overflow-verification"));
  assert.ok(ids.includes("touch-target-sizing"));
  assert.ok(ids.includes("rendered-layout-desktop"));
  assert.ok(ids.includes("device-specific-lighthouse-scores"));
  for (const id of ["rendered-overflow-verification", "touch-target-sizing", "rendered-layout-desktop", "device-specific-lighthouse-scores"]) {
    assert.equal(summary.checks.find((c) => c.id === id)!.state, "unverified");
  }
});

test("summary counts are internally consistent with the checks array", () => {
  const summary = buildResponsiveVerification(
    baseResponsive({
      viewport: { present: false, content: null, hasDeviceWidthToken: false, hasFixedNumericWidth: false, fixedWidthValue: null, disablesZoom: false },
      navigation: { navElementCount: 2, duplicateNavRisk: true, largestMenuLinkCount: 20, emptyControlCount: 1 },
    }),
  );
  for (const [context, tally] of [
    ["mobile", summary.mobile],
    ["desktop", summary.desktop],
  ] as const) {
    const relevant = summary.checks.filter((c) => c.context === context || c.context === "both");
    const total = tally.passed + tally.warnings + tally.failures + tally.unverified;
    assert.equal(total, relevant.length, `${context} tally total should match the number of relevant checks`);
  }
});
