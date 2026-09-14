import type {
  AnalysisReport,
  Category,
  CategoryReadiness,
  CategoryReadinessStatus,
  Issue,
  LaunchBlocker,
  LaunchDecision,
  LaunchFindingGroup,
  LaunchReadinessStatus,
  LaunchWarning,
  PrioritizedFix,
  ScanCompleteness,
  Severity,
  LaunchVerificationState,
} from "../types.js";

import { correlateFindings } from "./correlateFindings.js";
/**
 * Pre-live launch readiness / approval engine.
 *
 * ANSWERS A DIFFERENT QUESTION than the scorer does:
 *   scorer.ts        -> "what is the quantitative score?"
 *   launchDecision.ts -> "should this website go live?"
 *
 * These are deliberately NOT the same computation. A site can score high
 * on every category and still be NOT_READY (one confirmed blocker, e.g.
 * the whole site served over plain HTTP, outweighs a good average). A
 * site can also have a mediocre score with no launch blocker at all, in
 * which case the policy-driven result is READY_WITH_WARNINGS, not
 * NOT_READY - "score low" and "not ready" are not synonyms here.
 *
 * DESIGN PRINCIPLES (see the Agent A task brief this module implements):
 *   1. severity != blocking. Only an explicit, curated rule in
 *      `BLOCKING_RULES` below can produce a launch blocker - "5 critical
 *      findings" never auto-collapses into "score = 0 = NOT_READY" by
 *      itself. Every other finding, regardless of severity, becomes a
 *      warning.
 *   2. Findings are grouped by (category, title) before blocking/warning
 *      rules run, so the same underlying problem found on N pages (or
 *      re-detected by more than one rule) becomes ONE blocker/warning
 *      with an `affected` list, not N independent ones. See
 *      `groupIssues()`.
 *   3. Absence of evidence is never treated as evidence of absence.
 *      A category that could not be verified is reported as
 *      `UNVERIFIED`, never silently folded into "no issues found ->
 *      READY". See `categoryVerification()`.
 *   4. Fully deterministic, pure, no I/O, no AI. Same report in ->
 *      same decision out, every time.
 *
 * CURRENT SCOPE: this project's pipeline today (see PROJECT_PROGRESS.md)
 * analyzes exactly one page per scan (performance/seo/security/
 * accessibility). The multi-page crawler and the runtime/browser,
 * deeper-security, and advanced-SEO collectors described in the wider
 * "Insight" product vision are not integrated into `AnalysisReport` yet.
 * This module is written against the ACTUAL current `AnalysisReport`
 * contract - it does not invent evidence for collectors that don't exist
 * yet (a broken checkout flow, a browser-verified runtime failure, an
 * aggregate "CSP missing on 42/45 pages" finding, etc. are all outside
 * what can be truthfully computed today). Its grouping/blocker/warning
 * machinery is written to extend cleanly once that evidence exists - see
 * `groupIssues()` and the "FUTURE EXTENSION POINTS" note near
 * `BLOCKING_RULES` - but nothing here pretends multi-page or runtime
 * evidence exists before it does.
 */

/** The only part of AnalysisReport this module needs is everything except
 * `launchDecision` itself (which this module computes) - expressed as its
 * own type so the pipeline can call this before the field exists. */
type ReportInput = Omit<AnalysisReport, "launchDecision" | "launchReadiness">;

/* -------------------------------------------------------------------
 * Finding grouping - dedup / double-penalty protection
 * ------------------------------------------------------------------- */

function severityRank(s: Severity): number {
  return { critical: 3, high: 2, medium: 1, low: 0 }[s];
}

/** Highest of two severities. */
function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/**
 * Groups issues that represent the SAME underlying rule (same category +
 * title) so a problem found on several pages, or re-affirmed by more
 * than one evidence source under one rule, is represented once with a
 * full `affected` page list - never as N independent blockers/warnings.
 *
 * Deliberately keyed on (category, title) rather than a looser
 * text-similarity match: this project has documented, deliberate cases
 * where two DIFFERENT rules legitimately overlap on the same underlying
 * fact (e.g. SEO's and Accessibility's separate, differently-defined
 * "missing alt text" checks - see accessibilityIssues.ts's module doc).
 * Those are intentionally distinct findings, not duplicates, and must
 * stay separate. A same-category-and-title match is never a
 * false-positive merge because `title` is rule-authored, constant text
 * (see issues.ts/accessibilityIssues.ts/cwvIssues.ts) - not derived from
 * scanned content that could coincidentally collide.
 */
export function groupIssues(issues: Issue[]): LaunchFindingGroup[] {
  const groups = new Map<string, LaunchFindingGroup>();
  for (const issue of issues) {
    const key = `${issue.category}::${issue.title}`;
    const existing = groups.get(key);
    if (existing) {
      existing.severity = maxSeverity(existing.severity, issue.severity);
      if (!existing.affected.includes(issue.affected)) existing.affected.push(issue.affected);
      existing.issueIds.push(issue.id);
    } else {
      groups.set(key, {
        id: `group-${key}`,
        title: issue.title,
        category: issue.category,
        severity: issue.severity,
        affected: [issue.affected],
        issueIds: [issue.id],
      });
    }
  }
  return [...groups.values()];
}

/* -------------------------------------------------------------------
 * Blocking rules - explicit, curated, defensible. NOT "any critical
 * finding". Each rule states the product reason it clears the bar for
 * "would clearly undermine the site's purpose to launch with this."
 *
 * FUTURE EXTENSION POINTS (do not implement speculatively - see module
 * doc): once runtime/browser evidence exists, a rule for a confirmed
 * broken primary page or a critical conversion-control failure belongs
 * here. Once deeper security evidence exists, a rule for a confirmed
 * severe/exploitable finding (vs. a missing best-practice header)
 * belongs here. Adding a rule is intentionally a one-line change to
 * this list, not a redesign of this module.
 * ------------------------------------------------------------------- */

interface BlockingRule {
  category: Category;
  title: string;
  reason: (group: LaunchFindingGroup) => string;
}

const BLOCKING_RULES: BlockingRule[] = [
  {
    category: "security",
    title: "Site is not served over HTTPS",
    reason: (g) =>
      `The site is served over plain HTTP on ${g.affected.length} page(s) checked. Launching without HTTPS exposes every visitor to eavesdropping/tampering and browsers actively flag the site as "Not Secure".`,
  },
  {
    category: "seo",
    title: "Page is set to noindex",
    reason: (g) =>
      `A noindex directive is present on ${g.affected.length} page(s) checked, which tells search engines to exclude the site from results entirely - launching like this would clearly undermine the site's purpose unless the directive is deliberate (e.g. a staging environment).`,
  },
];

function isBlocking(group: LaunchFindingGroup): boolean {
  return BLOCKING_RULES.some((r) => r.category === group.category && r.title === group.title);
}

function blockingReason(group: LaunchFindingGroup): string {
  const rule = BLOCKING_RULES.find((r) => r.category === group.category && r.title === group.title);
  return rule ? rule.reason(group) : "";
}

/* -------------------------------------------------------------------
 * Verification / confidence
 * ------------------------------------------------------------------- */

const VERIFICATION_RANK: Record<LaunchVerificationState, number> = {
  SCAN_FAILED: 0,
  UNVERIFIED: 1,
  PARTIALLY_VERIFIED: 2,
  STRONGLY_SUPPORTED: 3,
  VERIFIED: 4,
};

function weakest(states: LaunchVerificationState[]): LaunchVerificationState {
  return states.reduce((worst, s) => (VERIFICATION_RANK[s] < VERIFICATION_RANK[worst] ? s : worst));
}

/**
 * Per-category verification state, honest about what actually ran.
 * - security / seo: derived directly from the single HTTP+HTML fetch
 *   that always completes before a report exists at all -> VERIFIED.
 * - accessibility: static-HTML analysis only. `accessibilityCoverage`
 *   always discloses real WCAG concerns (contrast, focus order,
 *   keyboard traps, etc.) it structurally cannot check - so it is never
 *   presented as fully VERIFIED, only PARTIALLY_VERIFIED, matching this
 *   project's own "never implies proof of compliance" principle.
 * - performance: the HTTP-based checks (TTFB, compression, blocking
 *   resources) always run, but the Core Web Vitals lab data depends on
 *   an external provider that can fail independently. `unavailable`/
 *   `rate_limited`/`timeout`/`error`/`not_configured` all mean "some
 *   real evidence exists, but a meaningful slice is missing" ->
 *   PARTIALLY_VERIFIED. `available` -> VERIFIED.
 */
function categoryVerification(report: ReportInput, category: Category): LaunchVerificationState {
  // `status: "failed"` is reserved for a future batch/crawl mode where a
  // report object can exist even though the underlying fetch never
  // completed (see types.ts's ScanStatus doc) - if that ever happens,
  // nothing was actually measured, so every category is SCAN_FAILED
  // rather than silently defaulting to VERIFIED/PARTIALLY_VERIFIED.
  if (report.status === "failed") return "SCAN_FAILED";
  if (category === "accessibility") return "PARTIALLY_VERIFIED";
  if (category === "responsiveness") return "PARTIALLY_VERIFIED";
  if (category === "performance") {
    return report.coreWebVitals.providerStatus === "available" ? "VERIFIED" : "PARTIALLY_VERIFIED";
  }
  // security, seo: always backed by the completed HTTP+HTML fetch.
  return "VERIFIED";
}

/* -------------------------------------------------------------------
 * Category readiness
 * ------------------------------------------------------------------- */

/** Every real `Category` this product's contract can score - kept as an
 * explicit runtime list (mirroring scorer.ts's own `CATEGORIES` const)
 * because `Category` is a string union with no runtime representation.
 * Used only to detect a category that is completely absent from
 * `categoriesAnalyzed` - see the bugfix note on `buildCategoryReadiness`. */
const ALL_CATEGORIES: Category[] = ["performance", "seo", "security", "accessibility", "ux", "responsiveness"];

function categoryStatus(
  verification: LaunchVerificationState,
  blockerCount: number,
  warningCount: number,
): CategoryReadinessStatus {
  if (verification === "UNVERIFIED" || verification === "SCAN_FAILED") return "UNVERIFIED";
  if (blockerCount > 0) return "NOT_READY";
  if (warningCount > 0) return "READY_WITH_WARNINGS";
  return "READY";
}

/**
 * BUGFIX (found this session): this function used to map only over
 * `report.categoriesAnalyzed`, so a real `Category` that is completely
 * absent from that list (e.g. security never ran at all) produced NO
 * `CategoryReadiness` entry whatsoever - it simply vanished. Since
 * `evaluateLaunchDecision`'s status computation is driven by
 * `categoryReadiness`, a fully-unscanned category silently could not
 * contribute anything, and the overall decision could come back as a
 * clean `READY` with security never having been checked at all. That
 * directly violates this module's own core rule ("absence of evidence
 * is never treated as evidence of absence") - reproduced and fixed
 * this session, see `launchDecision.test.ts`'s "a Category completely
 * absent..." tests.
 *
 * Fix: any `ALL_CATEGORIES` entry missing from `categoriesAnalyzed` now
 * gets an explicit `CategoryReadiness` entry with verification
 * `UNVERIFIED` (not `SCAN_FAILED` - the rest of the scan may have
 * completed fine; this one category specifically never ran), so it
 * participates in `evaluateLaunchDecision`'s status computation exactly
 * like every other category instead of disappearing.
 */
function buildCategoryReadiness(
  report: ReportInput,
  groups: LaunchFindingGroup[],
): CategoryReadiness[] {
  const analyzed = report.categoriesAnalyzed.map((category) => {
    const inCategory = groups.filter((g) => g.category === category);
    const blockerGroups = inCategory.filter(isBlocking);
    const warningGroups = inCategory.filter((g) => !isBlocking(g));
    const verification = categoryVerification(report, category);
    const affectedPages = [...new Set(inCategory.flatMap((g) => g.affected))];
    const score = report.scores[category];
    return {
      category,
      status: categoryStatus(verification, blockerGroups.length, warningGroups.length),
      score,
      verification,
      blockerCount: blockerGroups.length,
      warningCount: warningGroups.length,
      affectedPages,
    };
  });

  const missing: CategoryReadiness[] = ALL_CATEGORIES.filter(
    (category) => !report.categoriesAnalyzed.includes(category),
  ).map((category) => ({
    category,
    status: "UNVERIFIED",
    score: report.scores[category],
    verification: "UNVERIFIED",
    blockerCount: 0,
    warningCount: 0,
    affectedPages: [],
  }));

  return [...analyzed, ...missing];
}

/* -------------------------------------------------------------------
 * Scan completeness
 * ------------------------------------------------------------------- */

function buildScanCompleteness(report: ReportInput): ScanCompleteness {
  if (report.status === "failed") {
    return {
      pagesDiscovered: 1,
      pagesAnalyzed: 0,
      pagesFailed: 1,
      categoriesAnalyzed: report.categoriesAnalyzed,
      categoriesUnavailable: [...report.categoriesAnalyzed, ...report.categoriesNotYetAnalyzed],
      isComplete: false,
    };
  }
  const providerIncomplete = report.coreWebVitals.providerStatus !== "available";
  const categoriesUnavailable = [
    ...report.categoriesNotYetAnalyzed,
    ...(providerIncomplete ? ["performance (Core Web Vitals lab data)"] : []),
  ];
  return {
    pagesDiscovered: 1,
    pagesAnalyzed: 1,
    pagesFailed: 0,
    categoriesAnalyzed: report.categoriesAnalyzed,
    categoriesUnavailable,
    isComplete: categoriesUnavailable.length === 0 && report.status === "success",
  };
}

/* -------------------------------------------------------------------
 * Prioritized fix list - deterministic ordering:
 *   1. blocking before non-blocking
 *   2. higher affected-page scope first
 *   3. higher confidence first (more trustworthy evidence fixed first)
 *   4. higher severity first
 *   5. stable tiebreak: category name, then title (alphabetical) - never
 *      arbitrary iteration order.
 * ------------------------------------------------------------------- */

function prioritizeFixes(
  groups: LaunchFindingGroup[],
  verificationByCategory: Map<Category, LaunchVerificationState>,
  correlatedFindings: import("../types.js").CorrelatedFinding[] = [],
): PrioritizedFix[] {
  const correlationSpanByIssueId = new Map<string, number>();
  for (const c of correlatedFindings) {
    for (const issueId of c.issueIds) {
      const existing = correlationSpanByIssueId.get(issueId) ?? 0;
      if (c.categories.length > existing) correlationSpanByIssueId.set(issueId, c.categories.length);
    }
  }
  const groupCorrelationSpan = (g: LaunchFindingGroup): number =>
    Math.max(0, ...g.issueIds.map((id) => correlationSpanByIssueId.get(id) ?? 0));

  const sorted = [...groups].sort((a, b) => {
    const aBlocking = isBlocking(a);
    const bBlocking = isBlocking(b);
    if (aBlocking !== bBlocking) return aBlocking ? -1 : 1;

    if (a.affected.length !== b.affected.length) return b.affected.length - a.affected.length;

    const aConf = VERIFICATION_RANK[verificationByCategory.get(a.category) ?? "UNVERIFIED"];
    const bConf = VERIFICATION_RANK[verificationByCategory.get(b.category) ?? "UNVERIFIED"];
    if (aConf !== bConf) return bConf - aConf;

    const aSpan = groupCorrelationSpan(a);
    const bSpan = groupCorrelationSpan(b);
    if (aSpan !== bSpan) return bSpan - aSpan;

    if (severityRank(a.severity) !== severityRank(b.severity)) return severityRank(b.severity) - severityRank(a.severity);

    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.title.localeCompare(b.title);
  });

  return sorted.map((g, i) => {
    const span = groupCorrelationSpan(g);
    return {
      priority: i + 1,
      title: g.title,
      category: g.category,
      blocking: isBlocking(g),
      severity: g.severity,
      affectedPageCount: g.affected.length,
      confidence: verificationByCategory.get(g.category) ?? "UNVERIFIED",
      issueIds: g.issueIds,
      ...(span > 0 ? { correlatedAcrossCategories: span } : {}),
    };
  });
}

/* -------------------------------------------------------------------
 * "Why ready" / "why not ready" - deterministic, evidence-traced
 * explanation text. Every line here traces back to an actual blocker,
 * warning group, or disclosed verification gap computed above - never
 * generic AI-style prose.
 * ------------------------------------------------------------------- */

function summarizeGroup(g: LaunchFindingGroup): string {
  const scope = g.affected.length > 1 ? ` (${g.affected.length} pages checked)` : ` (${g.affected[0]})`;
  return `${g.title}${scope}`;
}

function buildWhyNotReady(blockers: LaunchBlocker[], categoryReadiness: CategoryReadiness[]): string[] {
  const lines = blockers.map((b, i) => `${i + 1}. ${b.title} - ${b.reason}`);
  const failedCategories = categoryReadiness.filter((c) => c.verification === "SCAN_FAILED");
  for (const c of failedCategories) {
    lines.push(
      `${lines.length + 1}. ${c.category} could not be scanned. A category with no evidence at all cannot be certified ready - this is treated as blocking readiness, not as "no problems found".`,
    );
  }
  return lines;
}

function buildWhyReady(
  status: LaunchReadinessStatus,
  categoryReadiness: CategoryReadiness[],
  warnings: LaunchWarning[],
): string[] {
  const lines: string[] = [
    status === "READY"
      ? "No launch blockers and no findings at all were detected across every category this scan analyzed."
      : "No launch blockers were detected across every category this scan analyzed.",
  ];
  for (const cat of categoryReadiness) {
    const catWarnings = warnings.filter((w) => w.category === cat.category);
    if (cat.status === "UNVERIFIED") {
      lines.push(`${cat.category}: could not be verified this scan - see notVerified.`);
    } else if (catWarnings.length === 0) {
      lines.push(`${cat.category}: no issues found.`);
    } else {
      lines.push(`${cat.category}: ${catWarnings.length} non-blocking finding(s) remain (${catWarnings.map(summarizeGroup).join("; ")}).`);
    }
  }
  return lines;
}

function buildNotVerified(report: ReportInput, categoryReadiness: CategoryReadiness[]): string[] {
  const lines: string[] = [];
  for (const c of categoryReadiness) {
    if (c.status === "UNVERIFIED") lines.push(`${c.category}: not verified this scan.`);
  }
  if (report.coreWebVitals.providerStatus !== "available") {
    lines.push(
      `Core Web Vitals lab data unavailable (provider status: ${report.coreWebVitals.providerStatus}${
        report.coreWebVitals.errorMessage ? ` - ${report.coreWebVitals.errorMessage}` : ""
      }). Performance findings from direct HTTP measurement are still complete and unaffected.`,
    );
  }
  for (const notVerifiable of report.accessibilityCoverage.notVerifiable) {
    lines.push(`Accessibility: ${notVerifiable} cannot be verified by static analysis.`);
  }
  for (const roadmapCategory of report.categoriesNotYetAnalyzed) {
    lines.push(`${roadmapCategory}: not yet part of this scan (roadmap category, not implemented yet).`);
  }
  return lines;
}

/* -------------------------------------------------------------------
 * Main entry point
 * ------------------------------------------------------------------- */

export function evaluateLaunchDecision(report: ReportInput): LaunchDecision {
  const groups = groupIssues(report.allIssues);
  const blockerGroups = groups.filter(isBlocking);
  const warningGroups = groups.filter((g) => !isBlocking(g));

  const blockers: LaunchBlocker[] = blockerGroups.map((g) => ({ ...g, reason: blockingReason(g) }));
  const warnings: LaunchWarning[] = warningGroups.map((g) => ({ ...g }));

  const categoryReadiness = buildCategoryReadiness(report, groups);
  const verificationByCategory = new Map(categoryReadiness.map((c) => [c.category, c.verification] as const));

  // Rule: unverified/failed evidence is never treated as "no problem
  // found". A category with no evidence at all (SCAN_FAILED) blocks
  // certification the same way a confirmed blocker does; a category that
  // is only partially unverified (UNVERIFIED, without a full scan
  // failure) can never be reported as a clean READY - it forces at least
  // READY_WITH_WARNINGS.
  const hasScanFailure = categoryReadiness.some((c) => c.verification === "SCAN_FAILED");
  const hasUnverifiedCategory = categoryReadiness.some((c) => c.verification === "UNVERIFIED");

  let status: LaunchReadinessStatus;
  if (blockers.length > 0 || hasScanFailure) {
    status = "NOT_READY";
  } else if (warnings.length > 0 || hasUnverifiedCategory) {
    status = "READY_WITH_WARNINGS";
  } else {
    status = "READY";
  }

  const scanCompleteness = buildScanCompleteness(report);
  const correlatedFindings = correlateFindings(report.allIssues);
  const prioritizedFixes = prioritizeFixes(groups, verificationByCategory, correlatedFindings);
  const notVerified = buildNotVerified(report, categoryReadiness);

  const overallVerification = weakest(categoryReadiness.map((c) => c.verification));

  const whyNotReady = status === "NOT_READY" ? buildWhyNotReady(blockers, categoryReadiness) : [];
  const whyReady = status !== "NOT_READY" ? buildWhyReady(status, categoryReadiness, warnings) : [];

  const summary =
    status === "NOT_READY"
      ? blockers.length > 0
        ? `NOT READY - ${blockers.length} launch blocker(s) found. Fix these first.`
        : "NOT READY - one or more categories could not be scanned, so readiness cannot be certified."
      : status === "READY_WITH_WARNINGS"
        ? hasUnverifiedCategory && warnings.length === 0
          ? "READY WITH WARNINGS - no launch blockers, but one or more categories were not verified this scan."
          : `READY WITH WARNINGS - no launch blockers, but ${warnings.length} finding(s) remain.`
        : "READY - no launch blockers or findings detected across every category this scan analyzed.";

  return {
    status,
    summary,
    blockers,
    warnings,
    categoryReadiness,
    scanCompleteness,
    prioritizedFixes,
    whyReady,
    whyNotReady,
    notVerified,
    overallVerification,
    correlatedFindings,
  };
}
