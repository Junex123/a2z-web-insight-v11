import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAccessibilityCoverage,
  detectAccessibilityIssues,
  resetAccessibilityIssueIdCounter,
} from "../src/analysis/accessibilityIssues.js";
import type { AccessibilityAnalysis } from "../src/types.js";

function baseA11y(overrides: Partial<AccessibilityAnalysis> = {}): AccessibilityAnalysis {
  return {
    hasHtmlLangAttr: true,
    htmlLangValue: "en",
    viewportContent: "width=device-width, initial-scale=1",
    viewportDisablesZoom: false,
    headingOutline: [{ level: 1, text: "Title" }, { level: 2, text: "Section" }],
    images: { total: 1, noAltAttribute: 0, emptyAlt: 0, suspiciousDecorative: 0 },
    formControls: { total: 1, unlabeled: 0, unlabeledExamples: [] },
    buttons: { total: 1, withoutAccessibleName: 0, examples: [] },
    links: { total: 1, withoutAccessibleName: 0, examples: [] },
    duplicateIds: [],
    brokenAriaRefs: [],
    invalidAriaRoles: [],
    iframes: { total: 0, missingTitle: 0 },
    tables: { total: 0, withoutHeaders: 0 },
    autoplayMedia: { total: 0, withoutControl: 0 },
    clickableNonInteractive: { count: 0, examples: [] },
    positiveTabindex: { count: 0, examples: [] },
    landmarks: { mainCount: 1, hasSkipLink: true },
    emptyHeadings: { count: 0, examples: [] },
    fieldsetGrouping: { ungroupedRadioCheckboxSets: 0, examples: [], fieldsetsWithoutLegend: 0 },
    errorAssociation: { unassociatedCount: 0, examples: [] },
    disabledStateContradictions: { count: 0, examples: [] },
    ariaWidgetsNotFocusable: { count: 0, examples: [] },
    dialogs: { total: 0, withoutAccessibleName: { count: 0, examples: [] }, withoutFocusableContent: { count: 0, examples: [] } },
    brokenLabelAssociations: { count: 0, examples: [] },
    ariaHiddenFocusable: { count: 0, examples: [] },
    duplicateLandmarks: { ambiguousCount: 0, ambiguousExamples: [], conflictingLabelCount: 0, conflictingLabelExamples: [] },
    redundantAriaRoles: { count: 0, examples: [] },
    ...overrides,
  };
}

test("a fully accessible page produces zero findings", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y(), "https://example.com");
  assert.equal(issues.length, 0);
});

test("missing lang attribute produces a high-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ hasHtmlLangAttr: false, htmlLangValue: null }), "https://example.com");
  const finding = issues.find((i) => i.title.includes("lang"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
  assert.equal(finding!.category, "accessibility");
});

test("images with no alt attribute produce a finding scaled by proportion", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ images: { total: 4, noAltAttribute: 3, emptyAlt: 0, suspiciousDecorative: 0 } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("no alt attribute"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high"); // 3/4 > 0.5
  assert.ok(finding!.evidence[0].value.includes("3/4"));
});

test("images with alt=\"\" (valid decorative marker) do not trigger the missing-alt finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ images: { total: 2, noAltAttribute: 0, emptyAlt: 2, suspiciousDecorative: 0 } }),
    "https://example.com",
  );
  assert.equal(issues.find((i) => i.title.includes("no alt attribute")), undefined);
});

test("decorative image contradiction is flagged at low severity", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ images: { total: 1, noAltAttribute: 0, emptyAlt: 1, suspiciousDecorative: 1 } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("decorative"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("unlabeled form controls are flagged, correctly labeled ones are not", () => {
  resetAccessibilityIssueIdCounter();
  const noIssues = detectAccessibilityIssues(baseA11y(), "https://example.com");
  assert.equal(noIssues.find((i) => i.title.toLowerCase().includes("form control")), undefined);

  resetAccessibilityIssueIdCounter();
  const withIssue = detectAccessibilityIssues(
    baseA11y({ formControls: { total: 2, unlabeled: 2, unlabeledExamples: ["input[type=text]", "input[type=email]"] } }),
    "https://example.com",
  );
  const finding = withIssue.find((i) => i.title.toLowerCase().includes("form control"));
  assert.ok(finding);
  assert.equal(finding!.severity, "critical"); // 2/2 = 100% unlabeled
  assert.equal(finding!.evidence.length, 2);
});

test("buttons without accessible names are flagged at high severity", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ buttons: { total: 2, withoutAccessibleName: 1, examples: ["button (no identifying attribute)"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("button"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("links without accessible names are flagged", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ links: { total: 3, withoutAccessibleName: 1, examples: ["a[href=/x]"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("link"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("heading hierarchy skips are detected", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ headingOutline: [{ level: 1, text: "Title" }, { level: 4, text: "Deep" }] }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("heading"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
  assert.ok(finding!.evidence[0].value.includes("H1"));
  assert.ok(finding!.evidence[0].value.includes("H4"));
});

test("a normal, non-skipping heading sequence produces no finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ headingOutline: [{ level: 1, text: "A" }, { level: 2, text: "B" }, { level: 3, text: "C" }, { level: 2, text: "D" }] }),
    "https://example.com",
  );
  assert.equal(issues.find((i) => i.title.toLowerCase().includes("heading")), undefined);
});

test("duplicate ids are flagged with the exact duplicated values as evidence", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ duplicateIds: ["main", "nav"] }), "https://example.com");
  const finding = issues.find((i) => i.title.toLowerCase().includes("duplicate"));
  assert.ok(finding);
  assert.equal(finding!.evidence.length, 2);
  assert.ok(finding!.evidence.some((e) => e.value === "main"));
});

test("broken ARIA references are flagged", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ brokenAriaRefs: [{ element: "input", attr: "aria-labelledby", value: "ghost-id" }] }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("aria"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("invalid ARIA role values are flagged", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ invalidAriaRoles: [{ element: "div", role: "not-a-real-role" }] }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("role"));
  assert.ok(finding);
});

test("a viewport that disables zoom is flagged at high severity with the exact content string as evidence", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ viewportDisablesZoom: true, viewportContent: "width=device-width, user-scalable=no" }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("zoom"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
  assert.equal(finding!.evidence[0].value, "width=device-width, user-scalable=no");
});

test("tables without headers are flagged", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ tables: { total: 2, withoutHeaders: 1 } }), "https://example.com");
  assert.ok(issues.find((i) => i.title.toLowerCase().includes("table")));
});

test("iframes missing a title are flagged", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ iframes: { total: 2, missingTitle: 1 } }), "https://example.com");
  assert.ok(issues.find((i) => i.title.toLowerCase().includes("iframe")));
});

test("autoplaying media without control is flagged at high severity", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ autoplayMedia: { total: 1, withoutControl: 1 } }), "https://example.com");
  const finding = issues.find((i) => i.title.toLowerCase().includes("autoplay"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("clickable non-interactive elements are flagged", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ clickableNonInteractive: { count: 1, examples: ["div (no identifying attribute)"] } }),
    "https://example.com",
  );
  assert.ok(issues.find((i) => i.title.toLowerCase().includes("keyboard accessible")));
});

test("positive tabindex values are flagged", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ positiveTabindex: { count: 2, examples: ["div#a", "div#b"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("tabindex"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("multiple distinct findings can occur on one page simultaneously", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({
      hasHtmlLangAttr: false,
      htmlLangValue: null,
      images: { total: 2, noAltAttribute: 2, emptyAlt: 0, suspiciousDecorative: 0 },
      duplicateIds: ["x"],
    }),
    "https://example.com",
  );
  assert.ok(issues.length >= 3);
  const titles = new Set(issues.map((i) => i.title));
  assert.equal(titles.size, issues.length, "each finding should be distinct, not repeated");
});

test("every finding carries the accessibility category and at least one piece of evidence", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({
      hasHtmlLangAttr: false,
      htmlLangValue: null,
      images: { total: 2, noAltAttribute: 2, emptyAlt: 0, suspiciousDecorative: 0 },
      formControls: { total: 2, unlabeled: 2, unlabeledExamples: ["input"] },
      buttons: { total: 1, withoutAccessibleName: 1, examples: ["button"] },
      links: { total: 1, withoutAccessibleName: 1, examples: ["a"] },
      duplicateIds: ["x"],
      brokenAriaRefs: [{ element: "input", attr: "aria-labelledby", value: "ghost" }],
      invalidAriaRoles: [{ element: "div", role: "bogus" }],
      iframes: { total: 1, missingTitle: 1 },
      tables: { total: 1, withoutHeaders: 1 },
      autoplayMedia: { total: 1, withoutControl: 1 },
      clickableNonInteractive: { count: 1, examples: ["div"] },
      positiveTabindex: { count: 1, examples: ["div"] },
      viewportDisablesZoom: true,
      headingOutline: [{ level: 1, text: "a" }, { level: 4, text: "b" }],
    }),
    "https://example.com",
  );
  assert.ok(issues.length >= 14, `expected many findings, got ${issues.length}`);
  for (const issue of issues) {
    assert.equal(issue.category, "accessibility");
    assert.ok(issue.evidence.length > 0, `issue "${issue.title}" has no evidence`);
  }
});

test("finding IDs are stable and reproducible for identical input (counter reset)", () => {
  resetAccessibilityIssueIdCounter();
  const first = detectAccessibilityIssues(baseA11y({ hasHtmlLangAttr: false, htmlLangValue: null }), "https://example.com");
  resetAccessibilityIssueIdCounter();
  const second = detectAccessibilityIssues(baseA11y({ hasHtmlLangAttr: false, htmlLangValue: null }), "https://example.com");
  assert.deepEqual(
    first.map((i) => i.id),
    second.map((i) => i.id),
  );
});

test("buildAccessibilityCoverage lists checked areas and explicitly discloses what cannot be verified", () => {
  const coverage = buildAccessibilityCoverage();
  assert.ok(coverage.checkedAreas.length > 0);
  assert.ok(coverage.notVerifiable.length > 0);
  assert.ok(coverage.notVerifiable.some((n) => n.toLowerCase().includes("contrast")));
  assert.ok(coverage.notVerifiable.some((n) => n.toLowerCase().includes("keyboard trap")));
});

// ---------------- Phase 2 additions ----------------

test("missing main landmark produces a medium-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ landmarks: { mainCount: 0, hasSkipLink: true } }), "https://example.com");
  const finding = issues.find((i) => i.title.includes("No <main> landmark"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("multiple main landmarks produce a low-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ landmarks: { mainCount: 2, hasSkipLink: true } }), "https://example.com");
  const finding = issues.find((i) => i.title.includes("Multiple <main> landmarks"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("missing skip-navigation link produces a low-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(baseA11y({ landmarks: { mainCount: 1, hasSkipLink: false } }), "https://example.com");
  const finding = issues.find((i) => i.title.includes("skip-navigation link"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("empty headings produce a medium-severity finding with evidence", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ emptyHeadings: { count: 1, examples: ["h1 (no identifying attribute)"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("no accessible name"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
  assert.ok(finding!.evidence.length > 0);
});

test("ungrouped radio/checkbox sets produce a medium-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ fieldsetGrouping: { ungroupedRadioCheckboxSets: 1, examples: ['name="color" (2 controls)'], fieldsetsWithoutLegend: 0 } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("not grouped with fieldset/legend"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("fieldset without legend produces a low-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ fieldsetGrouping: { ungroupedRadioCheckboxSets: 0, examples: [], fieldsetsWithoutLegend: 1 } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("without a <legend>"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("unassociated invalid form controls produce a high-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ errorAssociation: { unassociatedCount: 1, examples: ["input#email"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("not associated with an error message"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("disabled/aria-disabled contradiction produces a low-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ disabledStateContradictions: { count: 1, examples: ["button#save"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("aria-disabled"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("ARIA widget without keyboard focusability produces a high-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ ariaWidgetsNotFocusable: { count: 1, examples: ['div[role="button"]'] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("no tabindex"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

// ---------------- Session 8: dialog/modal static markup ----------------

test("an unnamed dialog produces a high-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ dialogs: { total: 1, withoutAccessibleName: { count: 1, examples: ['div[role="dialog"]'] }, withoutFocusableContent: { count: 0, examples: [] } } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("no accessible name"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("a dialog with no focusable content produces a medium-severity, caveated finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ dialogs: { total: 1, withoutAccessibleName: { count: 0, examples: [] }, withoutFocusableContent: { count: 1, examples: ['div[role="dialog"]'] } } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("no focusable"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
  assert.ok(finding!.whyItMatters.toLowerCase().includes("javascript"));
});

test("a dialog with a name and focusable content produces no dialog findings", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ dialogs: { total: 1, withoutAccessibleName: { count: 0, examples: [] }, withoutFocusableContent: { count: 0, examples: [] } } }),
    "https://example.com",
  );
  assert.equal(issues.find((i) => i.title.toLowerCase().includes("dialog")), undefined);
});

// ---------------- Session 9 ----------------

test("a missing skip-link target produces a medium-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ landmarks: { mainCount: 1, hasSkipLink: true, skipLinkTargetMissing: true, skipLinkTargetHidden: false } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("target does not exist"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("a hidden skip-link target produces a medium-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ landmarks: { mainCount: 1, hasSkipLink: true, skipLinkTargetMissing: false, skipLinkTargetHidden: true } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("target is hidden"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});

test("skip-link target findings never fire when there is no skip link at all", () => {
  resetAccessibilityIssueIdCounter();
  // hasSkipLink: false but the fields happen to be true - should never surface,
  // since these fields are only meaningful conditional on hasSkipLink
  const issues = detectAccessibilityIssues(
    baseA11y({ landmarks: { mainCount: 1, hasSkipLink: false, skipLinkTargetMissing: true, skipLinkTargetHidden: true } }),
    "https://example.com",
  );
  assert.equal(issues.find((i) => i.title.includes("Skip-navigation link target")), undefined);
});

test("a broken label association produces a high-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ brokenLabelAssociations: { count: 1, examples: ["label (\"Email\")"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("references an id that doesn't exist"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("aria-hidden hiding focusable content produces a high-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ ariaHiddenFocusable: { count: 1, examples: ["button (no identifying attribute)"] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.toLowerCase().includes("aria-hidden"));
  assert.ok(finding);
  assert.equal(finding!.severity, "high");
});

test("ambiguous duplicate landmarks produce a low-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ duplicateLandmarks: { ambiguousCount: 1, ambiguousExamples: ["navigation landmark with no distinguishing label (2 found)"], conflictingLabelCount: 0, conflictingLabelExamples: [] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("no distinguishing label"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});

test("conflicting landmark labels produce a medium-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ duplicateLandmarks: { ambiguousCount: 0, ambiguousExamples: [], conflictingLabelCount: 1, conflictingLabelExamples: ['2 "navigation" landmarks all labeled "Menu"'] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("share an identical label"));
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
});


test("redundant native ARIA roles produce a low-severity finding", () => {
  resetAccessibilityIssueIdCounter();
  const issues = detectAccessibilityIssues(
    baseA11y({ redundantAriaRoles: { count: 1, examples: ['<button> has role="button" (already its native implicit role)'] } }),
    "https://example.com",
  );
  const finding = issues.find((i) => i.title.includes("Redundant ARIA role"));
  assert.ok(finding);
  assert.equal(finding!.severity, "low");
});
