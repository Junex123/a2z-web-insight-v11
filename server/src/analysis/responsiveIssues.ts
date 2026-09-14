import type {
  DeviceContext,
  Issue,
  ResponsiveAnalysis,
  ResponsiveCheckResult,
  ResponsiveCheckState,
  ResponsiveContextSummary,
  ResponsiveVerificationSummary,
  Severity,
} from "../types.js";
import {
  DESKTOP_FIXED_WIDTH_RISK_PX,
  FIXED_WIDTH_RISK_PX,
  LARGE_FLAT_NAV_LINK_COUNT,
  LARGE_STATIC_IMAGE_WIDTH_PX,
} from "./responsiveThresholds.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `responsiveness-${counter}`;
}
export function resetResponsiveIssueIdCounter() {
  counter = 0;
}

function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  const SEVERITY_WEIGHT = { critical: 100, high: 70, medium: 40, low: 15 } as const;
  return {
    ...input,
    category: "responsiveness",
    id: nextId(),
    priorityScore: SEVERITY_WEIGHT[input.severity],
  };
}

/**
 * DELIBERATE NON-DUPLICATION, following this project's established
 * pattern (see accessibilityIssues.ts's own note on the same subject):
 *   - Missing viewport meta (bare presence): already an SEO finding
 *     (issues.ts) and already contributes to accessibility's zoom
 *     check when present-but-restrictive. This file does not
 *     re-flag bare absence - see viewport-meta-present in the
 *     verification summary below for how it's still represented
 *     structurally (never silently dropped from the mobile picture).
 *   - Viewport disables zoom: already an accessibility finding
 *     ("Viewport meta tag disables pinch-zoom", high severity). Not
 *     duplicated here as a second Issue - represented only in the
 *     verification summary's viewport-disables-zoom check, sourced
 *     from this collector's own independent evidence for structural
 *     completeness of the mobile/desktop picture.
 *   - Empty navigation controls: overlaps with accessibility's
 *     "Links/buttons with no accessible text" findings for the same
 *     underlying elements when they happen to sit inside a <nav>. Not
 *     duplicated as a second Issue - represented only in the
 *     verification summary.
 * Every check below - duplicated into an Issue or not - still appears
 * in the verification summary, because that summary's job (a
 * mobile/desktop pass/warning/fail/unverified picture) is a genuinely
 * different, additive representation from the severity-scored Issue
 * list, not a second copy of it.
 */
export function detectResponsiveIssues(responsive: ResponsiveAnalysis, affectedUrl: string): Issue[] {
  const issues: Issue[] = [];

  // ---------------- suspicious fixed-width viewport ----------------
  if (responsive.viewport.present && responsive.viewport.hasFixedNumericWidth && !responsive.viewport.hasDeviceWidthToken) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Viewport meta uses a hardcoded pixel width instead of device-width",
        affected: affectedUrl,
        whyItMatters:
          "A fixed numeric viewport width (e.g. width=980) forces every device - phone or tablet - to render at that width and then scale the result, rather than laying out natively at the device's own width. Potential mobile layout risk.",
        estimatedImpact: `Current viewport content: "${responsive.viewport.content}".`,
        recommendedFix: 'Use <meta name="viewport" content="width=device-width, initial-scale=1"> instead of a fixed pixel width.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "meta[name=viewport] content", value: responsive.viewport.content ?? "" }],
      }),
    );
  }

  // ---------------- large images without responsive attributes ----------------
  const largeCount = responsive.images.largeStaticWidthExamples.length;
  if (largeCount > 0) {
    issues.push(
      makeIssue({
        severity: largeCount > 2 ? "medium" : "low",
        title: "Large images with no srcset/sizes for responsive delivery",
        affected: affectedUrl,
        whyItMatters:
          "An image with a large fixed width attribute and no srcset/sizes is served at the same full size to every device, including phones on constrained connections. Potential mobile performance and layout risk - not a confirmed rendering measurement.",
        estimatedImpact: `${largeCount} image(s) found with a static width of ${LARGE_STATIC_IMAGE_WIDTH_PX}px or more and no srcset/sizes, e.g. ${responsive.images.largeStaticWidthExamples[0].src} (${responsive.images.largeStaticWidthExamples[0].widthPx}px).`,
        recommendedFix: "Add a srcset with multiple resolutions (and a sizes attribute) so the browser can choose an appropriately-sized image per device.",
        difficulty: "moderate",
        source: "measured",
        evidence: responsive.images.largeStaticWidthExamples.map((ex) => ({
          type: "html" as const,
          label: "Large static-width image",
          value: `${ex.src} (${ex.widthPx}px)`,
        })),
      }),
    );
  }

  // ---------------- fixed-width CSS risk (mobile) ----------------
  const riskyFixedWidths = responsive.css.fixedWidthDeclarations.filter((d) => d.valuePx >= FIXED_WIDTH_RISK_PX);
  if (responsive.css.inspected && riskyFixedWidths.length > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Fixed-width CSS declarations found that may not adapt to narrow screens",
        affected: affectedUrl,
        whyItMatters:
          "A hardcoded pixel width at or above common phone-screen widths can force horizontal scrolling on narrower devices. This is a static-CSS signal, not a confirmed rendered measurement - potential mobile layout risk.",
        estimatedImpact: `${riskyFixedWidths.length} fixed-width declaration(s) of ${FIXED_WIDTH_RISK_PX}px or more found in the inspected CSS (${responsive.css.sources.length} source(s): ${responsive.css.sources.map((s) => s.source).join(", ")}).`,
        recommendedFix: "Replace fixed pixel widths on layout containers with relative units (%, max-width, clamp()) or add a matching media query.",
        difficulty: "moderate",
        source: "measured",
        evidence: riskyFixedWidths.slice(0, 5).map((d) => ({ type: "computed" as const, label: "Fixed-width declaration", value: `${d.valuePx}px` })),
      }),
    );
  }

  // ---------------- 100vw overflow risk (mobile) ----------------
  if (responsive.css.inspected && responsive.css.viewportUnitFullWidthCount > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "CSS uses 100vw, a common source of horizontal scroll on mobile",
        affected: affectedUrl,
        whyItMatters:
          "100vw includes the width of the scrollbar on many browsers/platforms, so an element sized with 100vw can be wider than the visible viewport and trigger unwanted horizontal scrolling. Potential mobile layout risk, not a confirmed overflow measurement (that requires rendering).",
        estimatedImpact: `${responsive.css.viewportUnitFullWidthCount} usage(s) of "100vw" found in the inspected CSS.`,
        recommendedFix: "Use 100% instead of 100vw for full-width elements, or pair 100vw with `overflow-x: hidden` on a wrapping container.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "computed", label: "100vw usages", value: String(responsive.css.viewportUnitFullWidthCount) }],
      }),
    );
  }

  // ---------------- large flat mobile nav menu ----------------
  if (responsive.navigation.largestMenuLinkCount > LARGE_FLAT_NAV_LINK_COUNT) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Navigation menu has many top-level links with no detected collapse pattern",
        affected: affectedUrl,
        whyItMatters:
          "A large flat list of navigation links that isn't collapsed behind a menu control tends to overwhelm small screens. This is a structural signal (link count), not a rendered-layout measurement - potential mobile navigation risk.",
        estimatedImpact: `Largest <nav> has ${responsive.navigation.largestMenuLinkCount} links (threshold: ${LARGE_FLAT_NAV_LINK_COUNT}).`,
        recommendedFix: "Consider a collapsible/hamburger navigation pattern for smaller viewports, or group links into a submenu.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "computed", label: "Largest nav link count", value: String(responsive.navigation.largestMenuLinkCount) }],
      }),
    );
  }

  // ---------------- duplicate navigation structures ----------------
  if (responsive.navigation.duplicateNavRisk) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Multiple navigation elements appear to duplicate the same links",
        affected: affectedUrl,
        whyItMatters:
          "Two or more <nav> elements exposing largely the same set of links is a common sign of a leftover desktop-only or mobile-only navigation block that was never removed - it can confuse screen reader users (duplicate landmarks) and often means only one of the two is actually shown/working per device.",
        estimatedImpact: `${responsive.navigation.navElementCount} <nav> element(s) found on the page, with substantial link overlap between at least two of them.`,
        recommendedFix: "Consolidate into a single navigation structure that adapts responsively, rather than maintaining separate near-duplicate nav blocks.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: "Total <nav> elements", value: String(responsive.navigation.navElementCount) }],
      }),
    );
  }

  // ---------------- excessive desktop fixed width ----------------
  const desktopRiskyWidths = responsive.css.fixedWidthDeclarations.filter((d) => d.valuePx >= DESKTOP_FIXED_WIDTH_RISK_PX);
  if (responsive.css.inspected && desktopRiskyWidths.length > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Very large fixed-width CSS declarations found",
        affected: affectedUrl,
        whyItMatters:
          "An element hardcoded wider than most desktop viewports either gets clipped/scrolled on smaller desktop windows or leaves unused space on larger ones - static evidence only, not a rendered-layout measurement.",
        estimatedImpact: `${desktopRiskyWidths.length} fixed-width declaration(s) of ${DESKTOP_FIXED_WIDTH_RISK_PX}px or more found.`,
        recommendedFix: "Cap large fixed-width containers with a max-width and let them shrink below that on smaller viewports.",
        difficulty: "moderate",
        source: "measured",
        evidence: desktopRiskyWidths.slice(0, 5).map((d) => ({ type: "computed" as const, label: "Large fixed-width declaration", value: `${d.valuePx}px` })),
      }),
    );
  }

  return issues;
}

/* -------------------------------------------------------------------
 * Mobile / desktop verification summary
 *
 * A structurally different representation from the Issue list above:
 * every check gets a state (passed/warning/failed/unverified) whether
 * or not it produced a scored Issue, and checks that fundamentally
 * require a real browser/renderer are always "unverified" - never
 * defaulted to "passed" just because no evidence contradicts them.
 * ------------------------------------------------------------------- */

function check(id: string, label: string, context: DeviceContext, state: ResponsiveCheckState, detail: string): ResponsiveCheckResult {
  return { id, label, context, state, detail };
}

export function buildResponsiveVerification(responsive: ResponsiveAnalysis): ResponsiveVerificationSummary {
  const checks: ResponsiveCheckResult[] = [];
  const v = responsive.viewport;
  const c = responsive.css;

  // 1. viewport meta present
  checks.push(
    check(
      "viewport-meta-present",
      "Viewport meta tag present",
      "mobile",
      v.present ? "passed" : "failed",
      v.present ? `Found: "${v.content}".` : "No <meta name=\"viewport\"> tag found.",
    ),
  );

  // 2. viewport uses device-width (only meaningful when present at all)
  if (v.present) {
    checks.push(
      check(
        "viewport-uses-device-width",
        "Viewport scales to device width",
        "mobile",
        v.hasFixedNumericWidth && !v.hasDeviceWidthToken ? "warning" : "passed",
        v.hasFixedNumericWidth && !v.hasDeviceWidthToken
          ? `Hardcoded width=${v.fixedWidthValue} found instead of device-width. Potential mobile layout risk.`
          : "Uses device-width (or no fixed numeric width was found).",
      ),
    );
  }

  // 3. viewport disables zoom - cross-references accessibility's own finding; see note above detectResponsiveIssues
  if (v.present) {
    checks.push(
      check(
        "viewport-disables-zoom",
        "Pinch-zoom not disabled",
        "mobile",
        v.disablesZoom ? "failed" : "passed",
        v.disablesZoom
          ? "Viewport meta restricts zoom (user-scalable=no or maximum-scale<=1) - also reported under Accessibility."
          : "No zoom restriction found in the viewport meta tag.",
      ),
    );
  }

  // 4. responsive images
  if (responsive.images.total === 0) {
    checks.push(check("responsive-image-attributes", "Images use responsive sizing attributes", "mobile", "unverified", "No <img> elements found on this page."));
  } else {
    const large = responsive.images.largeStaticWidthExamples.length;
    checks.push(
      check(
        "responsive-image-attributes",
        "Images use responsive sizing attributes",
        "mobile",
        large > 0 ? "warning" : "passed",
        large > 0
          ? `${large} large image(s) found with a static width and no srcset/sizes. Potential mobile layout/performance risk.`
          : `${responsive.images.withSrcsetOrSizes} of ${responsive.images.total} image(s) use srcset/sizes, and no oversized static images were found.`,
      ),
    );
  }

  // 5. CSS breakpoint evidence - honest "unverified" when no CSS could be inspected at all
  if (!c.inspected) {
    checks.push(
      check(
        "css-breakpoint-evidence",
        "Responsive CSS breakpoints detected",
        "both",
        "unverified",
        "No inline or successfully-fetched external CSS was available to inspect.",
      ),
    );
  } else {
    // Deliberately NOT "no media query = not responsive" - only warn when there is
    // BOTH no media-query evidence AND no other positive responsive signal.
    const hasPositiveSignal = c.mediaQueryCount > 0 || c.hasResponsiveImagePattern || v.hasDeviceWidthToken;
    checks.push(
      check(
        "css-breakpoint-evidence",
        "Responsive CSS breakpoints detected",
        "both",
        hasPositiveSignal ? "passed" : "warning",
        c.mediaQueryCount > 0
          ? `${c.mediaQueryCount} @media rule(s) found, ${c.distinctBreakpointValues.length} distinct breakpoint value(s): ${c.distinctBreakpointValues.join(", ") || "n/a"}.`
          : "No @media rules found in the inspected CSS, and no other responsive signal (device-width viewport, responsive-image CSS pattern) detected either. Modern layouts can be responsive without traditional breakpoints, so this is not conclusive - potential mobile/desktop layout risk.",
      ),
    );
  }

  // 6. fixed-width CSS risk (mobile)
  checks.push(
    buildCssRiskCheck(
      c,
      "fixed-width-css-risk",
      "No risky fixed-width CSS found",
      "mobile",
      c.fixedWidthDeclarations.filter((d) => d.valuePx >= FIXED_WIDTH_RISK_PX).length,
      (n) => `${n} fixed-width declaration(s) of ${FIXED_WIDTH_RISK_PX}px+ found. Potential mobile layout risk.`,
    ),
  );

  // 7. viewport-unit overflow risk (mobile)
  checks.push(
    buildCssRiskCheck(
      c,
      "viewport-unit-overflow-risk",
      "No 100vw usage found",
      "mobile",
      c.viewportUnitFullWidthCount,
      (n) => `${n} usage(s) of "100vw" found. Potential horizontal-overflow risk on mobile.`,
    ),
  );

  // 8. excessive desktop fixed width
  checks.push(
    buildCssRiskCheck(
      c,
      "desktop-fixed-width-risk",
      "No excessively wide fixed-width CSS found",
      "desktop",
      c.fixedWidthDeclarations.filter((d) => d.valuePx >= DESKTOP_FIXED_WIDTH_RISK_PX).length,
      (n) => `${n} fixed-width declaration(s) of ${DESKTOP_FIXED_WIDTH_RISK_PX}px+ found. Potential desktop layout risk.`,
    ),
  );

  // 9. mobile nav menu size
  checks.push(
    check(
      "mobile-navigation-menu-size",
      "Navigation menu size is mobile-reasonable",
      "mobile",
      responsive.navigation.largestMenuLinkCount > LARGE_FLAT_NAV_LINK_COUNT ? "warning" : "passed",
      `Largest <nav> has ${responsive.navigation.largestMenuLinkCount} link(s) (threshold: ${LARGE_FLAT_NAV_LINK_COUNT}).`,
    ),
  );

  // 10. duplicate nav structures
  checks.push(
    check(
      "duplicate-navigation-structures",
      "No duplicate navigation structures",
      "both",
      responsive.navigation.duplicateNavRisk ? "warning" : "passed",
      responsive.navigation.duplicateNavRisk
        ? `${responsive.navigation.navElementCount} <nav> elements found with substantial link overlap.`
        : `${responsive.navigation.navElementCount} <nav> element(s) found, no substantial overlap detected.`,
    ),
  );

  // 11. empty nav controls - cross-references accessibility's own finding
  checks.push(
    check(
      "empty-navigation-controls",
      "Navigation controls have accessible text",
      "both",
      responsive.navigation.emptyControlCount > 0 ? "warning" : "passed",
      responsive.navigation.emptyControlCount > 0
        ? `${responsive.navigation.emptyControlCount} control(s) inside <nav> with no visible text or aria-label - also reported under Accessibility.`
        : "All navigation controls have visible text or an aria-label.",
    ),
  );

  // 12-15. structurally always-unverified checks - this project has no headless
  // browser/rendering engine anywhere, so these can never be anything but honest
  // "unverified" placeholders. Listed explicitly rather than omitted, per the
  // brief: absence of a check must never be mistaken for a passing check.
  checks.push(
    check("rendered-overflow-verification", "Actual rendered horizontal overflow", "mobile", "unverified", "Requires a real browser/rendering engine - not available in this project."),
    check("touch-target-sizing", "Touch target hit-box sizes", "mobile", "unverified", "Requires rendered element geometry - not available in this project."),
    check("rendered-layout-desktop", "Actual rendered desktop layout", "desktop", "unverified", "Requires a real browser/rendering engine - not available in this project."),
    check(
      "device-specific-lighthouse-scores",
      "Separate mobile/desktop Lighthouse performance scores",
      "both",
      "unverified",
      "This project's PageSpeed Insights integration only requests the \"mobile\" strategy; a genuine desktop Lighthouse run does not exist in this codebase.",
    ),
  );

  const mobile = summarize(checks, "mobile");
  const desktop = summarize(checks, "desktop");
  return { mobile, desktop, checks };
}

function buildCssRiskCheck(
  css: ResponsiveAnalysis["css"],
  id: string,
  passLabel: string,
  context: DeviceContext,
  riskyCount: number,
  detailFn: (n: number) => string,
): ResponsiveCheckResult {
  if (!css.inspected) {
    return check(id, passLabel, context, "unverified", "No inline or successfully-fetched external CSS was available to inspect.");
  }
  return check(id, passLabel, context, riskyCount > 0 ? "warning" : "passed", riskyCount > 0 ? detailFn(riskyCount) : "None found in the inspected CSS.");
}

function summarize(checks: ResponsiveCheckResult[], context: "mobile" | "desktop"): ResponsiveContextSummary {
  const relevant = checks.filter((c) => c.context === context || c.context === "both");
  const summary: ResponsiveContextSummary = { passed: 0, warnings: 0, failures: 0, unverified: 0 };
  for (const c of relevant) {
    if (c.state === "passed") summary.passed++;
    else if (c.state === "warning") summary.warnings++;
    else if (c.state === "failed") summary.failures++;
    else summary.unverified++;
  }
  return summary;
}
