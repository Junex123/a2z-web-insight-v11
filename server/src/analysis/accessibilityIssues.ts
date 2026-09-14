import type { AccessibilityAnalysis, AccessibilityCoverage, Issue } from "../types.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `accessibility-${counter}`;
}
export function resetAccessibilityIssueIdCounter() {
  counter = 0;
}

function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  const SEVERITY_WEIGHT = { critical: 100, high: 70, medium: 40, low: 15 } as const;
  return {
    ...input,
    category: "accessibility",
    id: nextId(),
    priorityScore: SEVERITY_WEIGHT[input.severity],
  };
}

/**
 * Deterministic, evidence-backed accessibility rules against the facts
 * collectAccessibility() already gathered - this function does not touch
 * the DOM itself, matching the MEASURE/ANALYZE split used by
 * analysis/issues.ts and analysis/cwvIssues.ts.
 *
 * DELIBERATE NON-DUPLICATION, matching real-world convention (Lighthouse
 * categorizes these the same way) and this project's own TTFB precedent
 * (see cwvIssues.ts) of not double-scoring one underlying fact twice:
 *   - Missing/empty <title>: already a critical SEO finding (issues.ts).
 *     No distinct accessibility-specific angle exists beyond "screen
 *     readers use it too," so it is NOT duplicated here.
 *   - Missing H1 / multiple H1: already SEO findings (issues.ts). Not
 *     duplicated here either.
 *   - Missing viewport meta (bare presence): already an SEO finding.
 *     This file only adds the DISTINCT, accessibility-specific
 *     zoom-disabled check, which SEO does not cover at all.
 *   - Images missing alt: SEO already flags this too, but that is
 *     legitimate intentional overlap (Lighthouse does the same - image
 *     alt text is audited under both SEO and Accessibility, for
 *     different audiences). This file uses its OWN, stricter,
 *     accessibility-correct definition of "missing" (alt attribute
 *     absent entirely) rather than the SEO layer's broader definition
 *     (which also treats alt="" as missing, since alt="" is a
 *     perfectly valid decorative marker for accessibility purposes even
 *     though it gives search engines nothing to index).
 */
export function detectAccessibilityIssues(a11y: AccessibilityAnalysis, affectedUrl: string): Issue[] {
  const issues: Issue[] = [];

  // ---------------- 1. missing lang attribute ----------------
  if (!a11y.hasHtmlLangAttr) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Missing lang attribute on <html>",
        affected: affectedUrl,
        whyItMatters: "Without a lang attribute, screen readers cannot reliably choose the correct pronunciation/voice, and browser translation tools cannot detect the page's language.",
        recommendedFix: 'Add a lang attribute to the <html> tag, e.g. <html lang="en">.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "html[lang]", value: "not found" }],
      }),
    );
  }

  // ---------------- images missing alt (accessibility-specific: excludes valid alt="") ----------------
  if (a11y.images.total > 0 && a11y.images.noAltAttribute > 0) {
    const severity = a11y.images.noAltAttribute / a11y.images.total > 0.5 ? "high" : "medium";
    issues.push(
      makeIssue({
        severity,
        title: "Images with no alt attribute at all",
        affected: affectedUrl,
        whyItMatters: "Screen reader users get no information about these images - not even a signal that they're decorative. This is different from alt=\"\", which is a valid way to mark an image as decorative.",
        estimatedImpact: `${a11y.images.noAltAttribute} of ${a11y.images.total} <img> tags have no alt attribute at all.`,
        recommendedFix: "Add a descriptive alt attribute to every meaningful image. For purely decorative images, add alt=\"\" explicitly (not simply omitting the attribute).",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Images with no alt attribute", value: `${a11y.images.noAltAttribute}/${a11y.images.total}` }],
      }),
    );
  }

  // ---------------- decorative-image contradiction ----------------
  if (a11y.images.suspiciousDecorative > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: 'Images marked decorative (alt="") but also given an accessible name or content role',
        affected: affectedUrl,
        whyItMatters: "An image with alt=\"\" tells assistive tech to skip it entirely, but an aria-label or a non-presentation role on the same element says the opposite - the announced behavior is inconsistent across browsers/screen readers.",
        estimatedImpact: `${a11y.images.suspiciousDecorative} image(s) have this contradiction.`,
        recommendedFix: 'Pick one: either give the image real alt text (if it conveys information), or remove the aria-label/role and leave alt="" if it is truly decorative.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Contradictory decorative images", value: String(a11y.images.suspiciousDecorative) }],
      }),
    );
  }

  // ---------------- form controls without accessible names ----------------
  if (a11y.formControls.unlabeled > 0) {
    const severity = a11y.formControls.unlabeled / Math.max(a11y.formControls.total, 1) > 0.5 ? "critical" : "high";
    issues.push(
      makeIssue({
        severity,
        title: "Form controls without an associated accessible name",
        affected: affectedUrl,
        whyItMatters: "Screen reader users hear only 'edit text' or 'checkbox' with no indication of what the field is for, making forms unusable without sight.",
        estimatedImpact: `${a11y.formControls.unlabeled} of ${a11y.formControls.total} form control(s) have no <label>, aria-label, aria-labelledby, or title. e.g. ${a11y.formControls.unlabeledExamples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: 'Associate a <label for="..."> with each control\'s id, wrap the control in a <label>, or add an aria-label.',
        difficulty: "easy",
        source: "measured",
        evidence: a11y.formControls.unlabeledExamples.map((ex) => ({ type: "html" as const, label: "Unlabeled form control", value: ex })),
      }),
    );
  }

  // ---------------- buttons without accessible names ----------------
  if (a11y.buttons.withoutAccessibleName > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Buttons with no accessible name",
        affected: affectedUrl,
        whyItMatters: "A button announced only as 'button' with no name gives screen reader and voice-control users no idea what it does.",
        estimatedImpact: `${a11y.buttons.withoutAccessibleName} of ${a11y.buttons.total} button(s) have no text content, value, aria-label, or title. e.g. ${a11y.buttons.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Add visible text inside the button, or an aria-label if the button is icon-only.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.buttons.examples.map((ex) => ({ type: "html" as const, label: "Unnamed button", value: ex })),
      }),
    );
  }

  // ---------------- links without accessible names ----------------
  if (a11y.links.withoutAccessibleName > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Links with no accessible text",
        affected: affectedUrl,
        whyItMatters: "A link with no text (and no aria-label or alt text on an inner image) is announced as just 'link', giving no clue where it goes - and is invisible to users who navigate by jumping between links.",
        estimatedImpact: `${a11y.links.withoutAccessibleName} of ${a11y.links.total} link(s) have no accessible text. e.g. ${a11y.links.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Add descriptive link text, or an aria-label for icon-only links.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.links.examples.map((ex) => ({ type: "html" as const, label: "Unnamed link", value: ex })),
      }),
    );
  }

  // ---------------- heading hierarchy skips ----------------
  const skips = findHeadingSkips(a11y.headingOutline);
  if (skips.length > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Heading levels are skipped",
        affected: affectedUrl,
        whyItMatters: "Screen reader users often navigate by heading level; skipping levels (e.g. H2 straight to H4) makes the page's structure confusing to follow non-visually.",
        estimatedImpact: `${skips.length} skip(s) found, e.g. ${skips[0]}.`,
        recommendedFix: "Use heading levels in order, without skipping - restructure so each heading is at most one level deeper than the previous one.",
        difficulty: "moderate",
        source: "measured",
        evidence: skips.slice(0, MAX_EVIDENCE).map((s) => ({ type: "html" as const, label: "Heading level skip", value: s })),
      }),
    );
  }

  // ---------------- duplicate IDs ----------------
  if (a11y.duplicateIds.length > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Duplicate id attributes",
        affected: affectedUrl,
        whyItMatters: "IDs must be unique. Duplicates break label-for associations, aria-labelledby/describedby references, and in-page fragment links - assistive tech may bind to the wrong element.",
        estimatedImpact: `${a11y.duplicateIds.length} duplicated id value(s): ${a11y.duplicateIds.slice(0, 5).join(", ")}.`,
        recommendedFix: "Make every id attribute unique across the page.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.duplicateIds.slice(0, MAX_EVIDENCE).map((id) => ({ type: "html" as const, label: "Duplicate id", value: id })),
      }),
    );
  }

  // ---------------- broken ARIA references ----------------
  if (a11y.brokenAriaRefs.length > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "ARIA attributes reference an id that doesn't exist",
        affected: affectedUrl,
        whyItMatters: "aria-labelledby/describedby/controls/owns must point at a real id on the page; a broken reference means assistive tech announces nothing where a label or description was intended.",
        estimatedImpact: `${a11y.brokenAriaRefs.length} broken reference(s) found.`,
        recommendedFix: "Fix the referenced id to match an existing element, or remove the ARIA attribute if it's no longer needed.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.brokenAriaRefs
          .slice(0, MAX_EVIDENCE)
          .map((ref) => ({ type: "html" as const, label: `${ref.element} ${ref.attr}`, value: `missing id "${ref.value}"` })),
      }),
    );
  }

  // ---------------- invalid ARIA roles ----------------
  // Deliberately narrow: only flags role values that don't exist in the
  // WAI-ARIA role taxonomy at all (a typo/nonexistent role). Judging
  // whether a VALID role is semantically appropriate for its element
  // (e.g. "should this <div> really be role=button") is exactly the
  // kind of thing static analysis cannot reliably determine - see
  // accessibilityCoverage.notVerifiable.
  if (a11y.invalidAriaRoles.length > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Invalid ARIA role value",
        affected: affectedUrl,
        whyItMatters: "A role that doesn't exist in the ARIA specification is ignored by assistive tech, silently falling back to the element's default (or no) semantics.",
        estimatedImpact: `${a11y.invalidAriaRoles.length} invalid role value(s) found, e.g. ${a11y.invalidAriaRoles[0].element} has role="${a11y.invalidAriaRoles[0].role}".`,
        recommendedFix: "Use a valid WAI-ARIA role, or remove the role attribute if none applies.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.invalidAriaRoles.slice(0, MAX_EVIDENCE).map((r) => ({ type: "html" as const, label: r.element, value: `role="${r.role}"` })),
      }),
    );
  }

  // ---------------- viewport disables zoom ----------------
  if (a11y.viewportDisablesZoom) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Viewport meta tag disables pinch-zoom",
        affected: affectedUrl,
        whyItMatters: "Low-vision users rely on pinch-zoom to read content. Disabling it (user-scalable=no or a maximum-scale near 1) is a WCAG 1.4.4 (Resize Text) failure.",
        estimatedImpact: `Current viewport content: "${a11y.viewportContent}".`,
        recommendedFix: "Remove user-scalable=no and any maximum-scale restriction from the viewport meta tag.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "meta[name=viewport] content", value: a11y.viewportContent ?? "" }],
      }),
    );
  }

  // ---------------- tables missing header structure ----------------
  if (a11y.tables.withoutHeaders > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Data tables without header cells",
        affected: affectedUrl,
        whyItMatters: "Without <th> header cells, screen reader users navigating cell-by-cell lose track of which column/row they're in.",
        estimatedImpact: `${a11y.tables.withoutHeaders} of ${a11y.tables.total} table(s) with multiple rows/columns have no <th> anywhere.`,
        recommendedFix: "Mark header cells with <th> (and scope=\"col\"/\"row\" for more complex tables) instead of plain <td>.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: "Tables without headers", value: `${a11y.tables.withoutHeaders}/${a11y.tables.total}` }],
      }),
    );
  }

  // ---------------- iframes missing title ----------------
  if (a11y.iframes.missingTitle > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Iframes missing a title attribute",
        affected: affectedUrl,
        whyItMatters: "Screen readers announce an iframe's title so users know what embedded content to expect before entering it; without one, it's just announced as 'frame'.",
        estimatedImpact: `${a11y.iframes.missingTitle} of ${a11y.iframes.total} <iframe> element(s) have no title.`,
        recommendedFix: 'Add a descriptive title attribute to every iframe, e.g. <iframe title="Customer support chat">.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Iframes missing title", value: `${a11y.iframes.missingTitle}/${a11y.iframes.total}` }],
      }),
    );
  }

  // ---------------- autoplaying media without user control ----------------
  if (a11y.autoplayMedia.withoutControl > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Autoplaying media with no way to pause or mute it",
        affected: affectedUrl,
        whyItMatters: "Autoplaying audio/video without controls or a muted default can drown out screen readers and disorient users - WCAG 1.4.2 requires a way to pause/stop/control volume.",
        estimatedImpact: `${a11y.autoplayMedia.withoutControl} of ${a11y.autoplayMedia.total} autoplaying media element(s) have neither controls nor muted.`,
        recommendedFix: "Add the controls attribute, or default to muted, on any autoplaying <video>/<audio>.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Uncontrolled autoplay media", value: `${a11y.autoplayMedia.withoutControl}/${a11y.autoplayMedia.total}` }],
      }),
    );
  }

  // ---------------- non-interactive elements made clickable without keyboard support ----------------
  if (a11y.clickableNonInteractive.count > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Clickable elements that aren't keyboard accessible",
        affected: affectedUrl,
        whyItMatters: "An onclick handler on a <div>/<span>/etc. with no role and no tabindex is invisible to keyboard-only and screen reader users - it can never receive focus or be activated without a mouse.",
        estimatedImpact: `${a11y.clickableNonInteractive.count} element(s) found, e.g. ${a11y.clickableNonInteractive.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Use a real <button> (or <a href> for navigation) instead, or add role=\"button\" tabindex=\"0\" plus a matching keydown handler if you must keep the custom element.",
        difficulty: "moderate",
        source: "measured",
        evidence: a11y.clickableNonInteractive.examples.map((ex) => ({ type: "html" as const, label: "Clickable, not keyboard-reachable", value: ex })),
      }),
    );
  }

  // ---------------- positive tabindex ----------------
  if (a11y.positiveTabindex.count > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Positive tabindex values found",
        affected: affectedUrl,
        whyItMatters: "A tabindex greater than 0 pulls an element out of the natural DOM tab order and ahead of everything else, which almost always creates a confusing, unpredictable keyboard navigation path.",
        estimatedImpact: `${a11y.positiveTabindex.count} element(s) with tabindex > 0, e.g. ${a11y.positiveTabindex.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Use tabindex=\"0\" (natural order) or restructure the DOM order instead of a positive tabindex.",
        difficulty: "moderate",
        source: "measured",
        evidence: a11y.positiveTabindex.examples.map((ex) => ({ type: "html" as const, label: "Positive tabindex", value: ex })),
      }),
    );
  }

  // ---------------- landmark structure (Phase 2) ----------------
  if (a11y.landmarks.mainCount === 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "No <main> landmark found",
        affected: affectedUrl,
        whyItMatters: "Without a main landmark, screen reader users have no fast way to jump past repeated navigation/header content straight to the page's actual content.",
        recommendedFix: 'Wrap the page\'s primary content in a <main> element (or add role="main" to the equivalent container).',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "main / role=main landmarks found", value: "0" }],
      }),
    );
  } else if (a11y.landmarks.mainCount > 1) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Multiple <main> landmarks found",
        affected: affectedUrl,
        whyItMatters: "Assistive tech expects at most one main landmark per page; more than one makes 'jump to main content' navigation ambiguous.",
        estimatedImpact: `${a11y.landmarks.mainCount} main/role="main" elements found.`,
        recommendedFix: "Keep exactly one <main> element per page.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "main / role=main landmarks found", value: String(a11y.landmarks.mainCount) }],
      }),
    );
  }

  // ---------------- skip-navigation link (Phase 2) ----------------
  if (!a11y.landmarks.hasSkipLink) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "No skip-navigation link found",
        affected: affectedUrl,
        whyItMatters: "Without a 'skip to content' link, keyboard users must tab through every navigation link on every single page load before reaching the actual content.",
        recommendedFix: 'Add a link near the top of <body> (e.g. <a href="#main">Skip to content</a>) targeting the main content landmark.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Skip-navigation link found", value: "no" }],
      }),
    );
  }

  // ---------------- empty headings (Phase 2) ----------------
  if (a11y.emptyHeadings.count > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Heading element(s) with no accessible name",
        affected: affectedUrl,
        whyItMatters: "A screen reader announces 'heading level N' with nothing after it - worse than no heading at all, since it interrupts navigation without conveying anything.",
        estimatedImpact: `${a11y.emptyHeadings.count} empty heading(s) found, e.g. ${a11y.emptyHeadings.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Add real text content to the heading, or remove it if it isn't needed.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.emptyHeadings.examples.map((ex) => ({ type: "html" as const, label: "Empty heading", value: ex })),
      }),
    );
  }

  // ---------------- fieldset/legend grouping (Phase 2) ----------------
  if (a11y.fieldsetGrouping.ungroupedRadioCheckboxSets > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Related radio/checkbox controls not grouped with fieldset/legend",
        affected: affectedUrl,
        whyItMatters: "Without a <fieldset><legend>, a screen reader announces each option's own label (e.g. 'Blue', 'Red') with no indication of what the whole group of options is FOR (e.g. 'Favorite color').",
        estimatedImpact: `${a11y.fieldsetGrouping.ungroupedRadioCheckboxSets} group(s) of related controls found ungrouped, e.g. ${a11y.fieldsetGrouping.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Wrap each related set of radio buttons or checkboxes in a <fieldset> with a <legend> describing the group.",
        difficulty: "moderate",
        source: "measured",
        evidence: a11y.fieldsetGrouping.examples.map((ex) => ({ type: "html" as const, label: "Ungrouped control set", value: ex })),
      }),
    );
  }
  if (a11y.fieldsetGrouping.fieldsetsWithoutLegend > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "<fieldset> without a <legend>",
        affected: affectedUrl,
        whyItMatters: "A fieldset with no legend gives screen reader users a grouping boundary but no description of what the group represents.",
        estimatedImpact: `${a11y.fieldsetGrouping.fieldsetsWithoutLegend} fieldset(s) with no legend.`,
        recommendedFix: "Add a <legend> as the first child of every <fieldset>.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Fieldsets without legend", value: String(a11y.fieldsetGrouping.fieldsetsWithoutLegend) }],
      }),
    );
  }

  // ---------------- error-message association (Phase 2) ----------------
  if (a11y.errorAssociation.unassociatedCount > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Invalid form control(s) not associated with an error message",
        affected: affectedUrl,
        whyItMatters: "aria-invalid tells assistive tech something is wrong with this field, but with no aria-describedby pointing at real error text, the user is never told WHAT is wrong or how to fix it.",
        estimatedImpact: `${a11y.errorAssociation.unassociatedCount} control(s) found, e.g. ${a11y.errorAssociation.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Add aria-describedby on the control pointing at the id of its visible error message.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.errorAssociation.examples.map((ex) => ({ type: "html" as const, label: "Unassociated invalid control", value: ex })),
      }),
    );
  }

  // ---------------- disabled-state contradictions (Phase 2) ----------------
  if (a11y.disabledStateContradictions.count > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: 'Element has both disabled and aria-disabled="false"',
        affected: affectedUrl,
        whyItMatters: "The native disabled attribute already removes the element from the tab order and blocks interaction; aria-disabled=\"false\" on the same element claims the opposite, which is inconsistent, generated-looking markup.",
        estimatedImpact: `${a11y.disabledStateContradictions.count} element(s) found, e.g. ${a11y.disabledStateContradictions.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Remove one of the two contradictory attributes - keep disabled if the control should truly be non-interactive, or aria-disabled=\"false\" if it shouldn't.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.disabledStateContradictions.examples.map((ex) => ({ type: "html" as const, label: "Disabled/aria-disabled contradiction", value: ex })),
      }),
    );
  }

  // ---------------- ARIA interactive-widget roles without keyboard focusability (Phase 2) ----------------
  if (a11y.ariaWidgetsNotFocusable.count > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "ARIA interactive-widget role on an element with no tabindex",
        affected: affectedUrl,
        whyItMatters: "role=\"button\"/\"tab\"/\"checkbox\"/etc. tells assistive tech this element is operable, but with no tabindex it can never actually receive keyboard focus - the promise the role makes is broken.",
        estimatedImpact: `${a11y.ariaWidgetsNotFocusable.count} element(s) found, e.g. ${a11y.ariaWidgetsNotFocusable.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: 'Add tabindex="0" (or use a native interactive element like <button> instead of a custom role).',
        difficulty: "moderate",
        source: "measured",
        evidence: a11y.ariaWidgetsNotFocusable.examples.map((ex) => ({ type: "html" as const, label: "ARIA widget not focusable", value: ex })),
      }),
    );
  }

  // ---------------- dialog/modal static markup (Session 8) ----------------
  if (a11y.dialogs.withoutAccessibleName.count > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Dialog/modal has no accessible name",
        affected: affectedUrl,
        whyItMatters: "Without aria-label, aria-labelledby, or a title, a screen reader announces a dialog opening with no indication of what it's for - the ARIA dialog role's accessible name must come from one of these, not from arbitrary text the dialog happens to contain.",
        estimatedImpact: `${a11y.dialogs.withoutAccessibleName.count} of ${a11y.dialogs.total} dialog(s) found without a name, e.g. ${a11y.dialogs.withoutAccessibleName.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Add aria-label (or aria-labelledby pointing at the dialog's visible heading) to every dialog/modal.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.dialogs.withoutAccessibleName.examples.map((ex) => ({ type: "html" as const, label: "Unnamed dialog", value: ex })),
      }),
    );
  }
  if (a11y.dialogs.withoutFocusableContent.count > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Dialog/modal markup contains no focusable/interactive content",
        affected: affectedUrl,
        whyItMatters: "A dialog with no button, link, or input inside its markup has no apparent way for a keyboard or screen reader user to close or act on it. This is static evidence only - content may be inserted by JavaScript after the dialog opens, which this scan cannot see; treat this as a lead to verify at runtime, not a confirmed dead end.",
        estimatedImpact: `${a11y.dialogs.withoutFocusableContent.count} of ${a11y.dialogs.total} dialog(s) found, e.g. ${a11y.dialogs.withoutFocusableContent.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Confirm the dialog's real (possibly JS-inserted) content includes a way to close or act on it - e.g. a close button - and that it's reachable by keyboard.",
        difficulty: "moderate",
        source: "measured",
        evidence: a11y.dialogs.withoutFocusableContent.examples.map((ex) => ({ type: "html" as const, label: "Dialog with no focusable content in markup", value: ex })),
      }),
    );
  }

  // ---------------- skip-link target resolution / hidden target (Session 9) ----------------
  if (a11y.landmarks.hasSkipLink && a11y.landmarks.skipLinkTargetMissing) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Skip-navigation link target does not exist",
        affected: affectedUrl,
        whyItMatters: "A skip link pointing at an id nobody has goes nowhere when activated - keyboard users following it land right back where they started, worse than if the link didn't exist since it looks like it should work.",
        recommendedFix: "Point the skip link's href at the id of the real main-content landmark, and make sure that id exists on the page.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Skip-link target resolves to a real element", value: "no" }],
      }),
    );
  }
  if (a11y.landmarks.hasSkipLink && a11y.landmarks.skipLinkTargetHidden) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Skip-navigation link target is hidden",
        affected: affectedUrl,
        whyItMatters: "The skip link's target (or an ancestor of it) has hidden or aria-hidden=\"true\" set, which defeats the purpose of the skip link even though the id technically exists.",
        recommendedFix: "Make sure the skip link's target is not itself hidden or nested inside a hidden ancestor.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Skip-link target is hidden", value: "yes" }],
      }),
    );
  }

  // ---------------- broken label[for] associations (Session 9) ----------------
  if (a11y.brokenLabelAssociations.count > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "<label for=\"...\"> references an id that doesn't exist",
        affected: affectedUrl,
        whyItMatters: "A label pointing at a nonexistent id is not associated with anything - the control it was meant to label is effectively unlabeled, and the label text itself becomes an orphaned, unclickable piece of text.",
        estimatedImpact: `${a11y.brokenLabelAssociations.count} broken label(s) found, e.g. ${a11y.brokenLabelAssociations.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Fix the label's for attribute to match the real id of the control it's meant to label (or wrap the control directly in the <label>).",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.brokenLabelAssociations.examples.map((ex) => ({ type: "html" as const, label: "Broken label association", value: ex })),
      }),
    );
  }

  // ---------------- aria-hidden hiding focusable content (Session 9) ----------------
  if (a11y.ariaHiddenFocusable.count > 0) {
    issues.push(
      makeIssue({
        severity: "high",
        title: 'aria-hidden="true" hides focusable/interactive content',
        affected: affectedUrl,
        whyItMatters: "aria-hidden removes an element from the accessibility tree but does NOT remove it from the keyboard tab order - a keyboard user can still tab into a control that a screen reader will never announce, a confusing and genuinely broken state.",
        estimatedImpact: `${a11y.ariaHiddenFocusable.count} element(s) found, e.g. ${a11y.ariaHiddenFocusable.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Either remove aria-hidden from the element, or also remove its focusable content from the tab order (e.g. tabindex=\"-1\" on every focusable descendant) so the two stay consistent.",
        difficulty: "moderate",
        source: "measured",
        evidence: a11y.ariaHiddenFocusable.examples.map((ex) => ({ type: "html" as const, label: "aria-hidden hiding focusable content", value: ex })),
      }),
    );
  }

  // ---------------- duplicate/conflicting landmark labels (Session 9) ----------------
  if (a11y.duplicateLandmarks.ambiguousCount > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Multiple landmarks of the same type with no distinguishing label",
        affected: affectedUrl,
        whyItMatters: "When a page has more than one landmark of the same type (e.g. two <nav> elements), assistive tech announces them identically unless each has its own aria-label - users can't tell which is which when jumping between landmarks.",
        estimatedImpact: `${a11y.duplicateLandmarks.ambiguousCount} group(s) found, e.g. ${a11y.duplicateLandmarks.ambiguousExamples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: 'Add a distinguishing aria-label to each landmark of the same type (e.g. aria-label="Main" / aria-label="Footer").',
        difficulty: "easy",
        source: "measured",
        evidence: a11y.duplicateLandmarks.ambiguousExamples.map((ex) => ({ type: "html" as const, label: "Ambiguous duplicate landmark", value: ex })),
      }),
    );
  }
  if (a11y.duplicateLandmarks.conflictingLabelCount > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Different landmarks share an identical label",
        affected: affectedUrl,
        whyItMatters: "Two different landmarks of the same type both claiming the exact same aria-label is worse than no label at all - it actively tells assistive tech they're the same thing when they aren't.",
        estimatedImpact: `${a11y.duplicateLandmarks.conflictingLabelCount} conflict(s) found, e.g. ${a11y.duplicateLandmarks.conflictingLabelExamples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Give each landmark of the same type a unique, distinguishing label.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.duplicateLandmarks.conflictingLabelExamples.map((ex) => ({ type: "html" as const, label: "Conflicting landmark labels", value: ex })),
      }),
    );
  }

  // ---------------- redundant ARIA role matching native implicit role (Session 10) ----------------
  if (a11y.redundantAriaRoles.count > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Redundant ARIA role matches the element's native role",
        affected: affectedUrl,
        whyItMatters: "An explicit role that duplicates an element's built-in native role adds nothing for assistive tech, and in older or buggy assistive-tech implementations can occasionally conflict with the native semantics instead of reinforcing them.",
        estimatedImpact: `${a11y.redundantAriaRoles.count} redundant role(s) found, e.g. ${a11y.redundantAriaRoles.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Remove the redundant role attribute - the element already has that role natively.",
        difficulty: "easy",
        source: "measured",
        evidence: a11y.redundantAriaRoles.examples.map((ex) => ({ type: "html" as const, label: "Redundant ARIA role", value: ex })),
      }),
    );
  }

  return issues;
}

const MAX_EVIDENCE = 5;

/** Finds places where the heading level jumps by more than 1 (e.g. H2 -> H4), in document order. */
function findHeadingSkips(outline: { level: number; text: string }[]): string[] {
  const skips: string[] = [];
  for (let i = 1; i < outline.length; i++) {
    const prev = outline[i - 1];
    const curr = outline[i];
    if (curr.level > prev.level + 1) {
      skips.push(`H${prev.level} ("${truncate(prev.text)}") -> H${curr.level} ("${truncate(curr.text)}")`);
    }
  }
  return skips;
}

function truncate(text: string): string {
  return text.length > 30 ? `${text.slice(0, 30)}…` : text || "(empty)";
}

/**
 * What this MVP does and does not verify - always attached to the
 * report so a clean/low-issue-count scan is never mistaken for a
 * verified WCAG-compliant page. Static HTML analysis fundamentally
 * cannot execute JS, render layout, or observe real assistive-tech
 * behavior.
 */
export function buildAccessibilityCoverage(): AccessibilityCoverage {
  return {
    checkedAreas: [
      "html lang attribute",
      "image alt text (missing vs. empty vs. contradictory)",
      "form control labels",
      "button and link accessible names",
      "heading level hierarchy",
      "duplicate id attributes",
      "ARIA reference integrity (labelledby/describedby/controls/owns)",
      "ARIA role validity (unrecognized role values only)",
      "viewport zoom restriction",
      "table header structure",
      "iframe titles",
      "autoplaying media controls",
      "non-interactive elements with click handlers but no keyboard support",
      "positive tabindex values",
      "main landmark presence/count",
      "skip-navigation link presence",
      "empty heading elements (no accessible name)",
      "related radio/checkbox controls grouped with fieldset/legend",
      "aria-invalid controls associated with an error message (aria-describedby)",
      "disabled / aria-disabled contradictions",
      "ARIA interactive-widget roles missing keyboard focusability",
      "dialog/modal accessible name (aria-label/aria-labelledby/title)",
      "dialog/modal markup containing at least one focusable/interactive element",
      "skip-navigation link target existence and visibility",
      "label[for] pointing at a real element id",
      "aria-hidden=\"true\" hiding focusable/interactive content",
      "duplicate landmarks of the same type sharing no/identical labels",
      "redundant ARIA roles that duplicate native element semantics",
    ],
    notVerifiable: [
      "color contrast (requires rendering, not just markup)",
      "keyboard trap detection (requires executing JS)",
      "focus order correctness (requires rendering + layout)",
      "focus visibility (requires rendering + layout)",
      "modal/dialog focus containment, focus entry on open, and focus restoration on close (requires executing JS)",
      "screen reader announcement order and behavior (requires a real assistive-tech test)",
      "whether a semantically-valid ARIA role is the RIGHT role for its context",
      "dynamic/JS-driven content and interaction states (this scanner does not execute JavaScript)",
      "responsive/viewport layout failures such as overflow or clipping (requires rendering)",
      "captions/transcripts for audio or video content",
      "whether a skip-link target (or anything else) is hidden via a stylesheet's display:none/visibility:hidden (only inline hidden/aria-hidden attributes are checked - CSS-driven hiding requires rendering)",
    ],
  };
}
