import type { Issue, SiteFinding, SitePageResult, VerificationEntry, VerificationStatus } from "../types.js";

/**
 * Builds the explicit VERIFIED/FAILED/WARNING/UNVERIFIED/NOT_APPLICABLE
 * state list this project's Phase 2 brief requires: every major UX/
 * accessibility category must say whether it was actually tested, never
 * let "not detected" read as "verified good".
 *
 * STATIC categories below are computed from the actual accessibility/ux
 * Issues already produced by detectAccessibilityIssues()/detectUxIssues()
 * for this page - this module does not re-inspect the DOM itself, it
 * only classifies findings that already exist (same MEASURE/ANALYZE/
 * VERIFY layering as the rest of the pipeline).
 *
 * RUNTIME categories (keyboard interaction, focus, modals, responsive
 * layout, visual failures, JS-driven interaction) are always reported as
 * "unverified" with a fixed, explicit reason - this scanner has no
 * browser/runtime execution capability. That capability belongs to
 * Agent 1/Fambruh in this project's multi-agent plan and is NOT built,
 * duplicated, or simulated here.
 */

const RUNTIME_UNVERIFIED_REASON = "Requires browser/runtime execution; static HTML analysis cannot verify this.";

const RUNTIME_CATEGORIES = [
  "Keyboard-only interaction",
  "Focus visibility",
  "Focus traps",
  "Modal/dialog focus behavior",
  "JavaScript-driven interaction",
  "Responsive/viewport behavior",
  "Visual layout failures",
  "Runtime interaction failures",
] as const;

function runtimeEntries(): VerificationEntry[] {
  return RUNTIME_CATEGORIES.map((category) => ({ category, status: "unverified" as const, reason: RUNTIME_UNVERIFIED_REASON }));
}

interface StaticCategoryDef {
  category: string;
  /** matches an Issue by (substring of) title - kept as substring matches so wording tweaks in accessibilityIssues.ts/uxIssues.ts don't silently desync this table */
  matchesTitle: (title: string) => boolean;
}

const STATIC_CATEGORIES: StaticCategoryDef[] = [
  {
    category: "Document language & structure",
    matchesTitle: (t) =>
      t.includes("lang attribute") ||
      t.includes("landmark") ||
      t.toLowerCase().includes("skip-navigation link") ||
      t.includes("Heading levels are skipped") ||
      t.includes("Duplicate navigation link") ||
      (t.includes("no accessible name") && t.toLowerCase().includes("heading")),
  },
  {
    category: "Accessible names (links/buttons/images)",
    matchesTitle: (t) =>
      t.includes("alt attribute") || t.includes("decorative") || t.includes("Buttons with no accessible name") || t.includes("Links with no accessible text"),
  },
  {
    category: "Form labeling & grouping",
    matchesTitle: (t) =>
      t.includes("Form controls without an associated accessible name") ||
      t.includes("fieldset") ||
      t.includes("Related radio/checkbox controls") ||
      t.includes("not associated with an error message") ||
      t.includes("references an id that doesn't exist"),
  },
  {
    category: "ARIA & keyboard-reachability (static)",
    matchesTitle: (t) =>
      t.includes("ARIA") ||
      t.includes("aria-hidden") ||
      t.includes("Duplicate id attributes") ||
      t.includes("keyboard accessible") ||
      t.includes("tabindex") ||
      t.includes("disabled and aria-disabled"),
  },
  {
    category: "Content authenticity (placeholder/dead patterns)",
    matchesTitle: (t) =>
      t.includes("Placeholder") ||
      t.includes("lorem ipsum") ||
      t.toLowerCase().includes("coming soon") ||
      t.includes("placeholder destination") ||
      t.includes("real input fields") ||
      t.includes("placeholder value") ||
      t.includes("Dead-end page") ||
      t.includes("primary navigation structure"),
  },
  {
    category: "Dialog/modal semantics (static)",
    matchesTitle: (t) => t.toLowerCase().includes("dialog"),
  },
];

const SEVERITY_RANK: Record<Issue["severity"], number> = { low: 0, medium: 1, high: 2, critical: 3 };

function statusForMatchedIssues(matched: Issue[]): { status: VerificationStatus; reason: string } {
  if (matched.length === 0) return { status: "verified", reason: "Checked - no issues found in this category." };
  const worst = matched.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
  const status: VerificationStatus = worst.severity === "critical" || worst.severity === "high" ? "failed" : "warning";
  const summary = matched.length === 1 ? matched[0].title : `${matched.length} related issue(s) found, most severe: "${worst.title}"`;
  return { status, reason: summary };
}

/** Per-page verification summary. `issues` should be that page's full accessibility+ux issue list (other categories are ignored). */
export function buildVerificationSummary(issues: Issue[]): VerificationEntry[] {
  const relevant = issues.filter((i) => i.category === "accessibility" || i.category === "ux");

  const staticEntries: VerificationEntry[] = STATIC_CATEGORIES.map(({ category, matchesTitle }) => {
    const matched = relevant.filter((i) => matchesTitle(i.title));
    const { status, reason } = statusForMatchedIssues(matched);
    return { category, status, reason };
  });

  // Nav consistency across pages can only ever be established with
  // multi-page data - a single page's scan genuinely cannot answer it.
  staticEntries.push({
    category: "Site navigation consistency",
    status: "not_applicable",
    reason: "Single-page scan - navigation consistency can only be checked when scanning multiple pages of the same site (see POST /api/analyze-site).",
  });

  return [...staticEntries, ...runtimeEntries()];
}

/**
 * Site-level verification summary: recomputes each static category
 * across every successfully-scanned page (not just page 1), and
 * additionally resolves "Site navigation consistency" for real using the
 * site findings - only meaningful with multi-page data, so it's left
 * not_applicable at the single-page level above.
 */
export function buildSiteVerificationSummary(pages: SitePageResult[], siteFindings: SiteFinding[]): VerificationEntry[] {
  const scannedPages = pages.filter((p) => p.outcome !== "error");

  const staticEntries: VerificationEntry[] = STATIC_CATEGORIES.map(({ category, matchesTitle }) => {
    const matched = scannedPages.flatMap((p) => p.issues.filter((i) => (i.category === "accessibility" || i.category === "ux") && matchesTitle(i.title)));
    const { status, reason } = statusForMatchedIssues(matched);
    const pageNote = matched.length > 0 ? ` Affects ${new Set(matched.map((m) => m.affected)).size} of ${scannedPages.length} scanned page(s).` : "";
    return { category, status, reason: reason + pageNote };
  });

  const navFinding = siteFindings.find((f) => f.key === "nav-inconsistency");
  staticEntries.push(
    navFinding
      ? { category: "Site navigation consistency", status: "warning", reason: navFinding.title }
      : scannedPages.length >= 2
        ? { category: "Site navigation consistency", status: "verified", reason: "Checked across all scanned pages - primary navigation is consistent." }
        : { category: "Site navigation consistency", status: "not_applicable", reason: "Fewer than 2 successfully-scanned pages - nothing to compare." },
  );

  if (pages.some((p) => p.outcome === "error")) {
    const errorCount = pages.filter((p) => p.outcome === "error").length;
    staticEntries.push({
      category: "Full-site coverage",
      status: "warning",
      reason: `${errorCount} of ${pages.length} requested page(s) could not be reached and were not analyzed - see each page's errorMessage.`,
    });
  }

  return [...staticEntries, ...runtimeEntries()];
}
