import type { AnalysisReport, Category, Issue, VerificationStatus } from "../types.js";

/**
 * Agent 6 (cross-domain correlation + launch decision) prep utility.
 *
 * This does NOT make any launch-readiness judgment. It answers a much
 * narrower, purely factual question: "for this one scanned page, what
 * evidence do we actually have per domain, and how was it produced?"
 * A future launch-decision layer needs this to avoid treating a
 * domain with zero issues as "verified clean" when it may really mean
 * "this domain has no dedicated verification model yet."
 *
 * CURRENT REALITY (as of this inspection - re-check against the real
 * repo before trusting this after any merge):
 * - performance: has both baseline rules (analysis/issues.ts) AND a
 *   dedicated verification model (AnalysisReport.performanceVerification,
 *   explicit verified/failed/warning/unverified/not_applicable per area).
 * - accessibility: has both baseline rules (analysis/accessibilityIssues.ts)
 *   AND a coverage model (AnalysisReport.accessibilityCoverage -
 *   checkedAreas/notVerifiable), but NOT the five-state verification
 *   model performance has.
 * - security: has REAL baseline rules in analysis/issues.ts (HTTPS,
 *   HSTS, mixed content, X-Content-Type-Options, clickjacking
 *   protection, CSP, Referrer-Policy) - this is genuine evidence, not
 *   fabricated - but NO dedicated verification/coverage model at all.
 *   An empty security issue list for a page is NOT distinguishable
 *   here from "nothing was ever checked" vs "everything checked out" -
 *   in practice every one of the ~7 baseline rules always runs, so it
 *   currently does mean "checked out", but there is no structural
 *   guarantee of that the way performanceVerification provides.
 * - seo: same situation as security - real baseline rules exist
 *   (title, meta description, H1, canonical, robots/noindex, viewport,
 *   image alt text) but no dedicated coverage/verification model.
 *
 * A future Agent 6 should NOT assume "no issues in category X" means
 * "verified clean" for security/seo the way it more safely can for
 * performance (which has an explicit verification entry) - it should
 * check whether a domain has a dedicated verification/coverage
 * structure before treating silence as a pass. That's exactly what
 * `hasDedicatedVerificationModel` below is for.
 */

export interface DomainEvidenceCoverage {
  category: Category;
  issueCount: number;
  bySeverity: Record<"critical" | "high" | "medium" | "low", number>;
  /**
   * true only when this AnalysisReport carries a structured
   * verification/coverage object for this domain beyond just an Issue
   * list (today: performance via performanceVerification, accessibility
   * via accessibilityCoverage). false means an empty issue list for
   * this domain is evidence of "the baseline rules that exist all
   * passed" at best - NOT a structural guarantee of full coverage.
   */
  hasDedicatedVerificationModel: boolean;
  /** only present for performance today - see AnalysisReport.performanceVerification */
  verificationStates: VerificationStatus[] | null;
  /** only present for accessibility today - see AnalysisReport.accessibilityCoverage.notVerifiable */
  notVerifiable: string[] | null;
}

export interface EvidenceCoverageSummary {
  scannedUrl: string;
  domains: DomainEvidenceCoverage[];
  domainsWithDedicatedVerificationModel: Category[];
  /** domains where an empty Issue list should NOT yet be read as a strong "verified clean" signal */
  domainsWithBaselineRulesOnly: Category[];
}

const ALL_CATEGORIES: Category[] = ["performance", "seo", "security", "accessibility", "ux", "responsiveness"];

function bySeverityCounts(issues: Issue[]): Record<"critical" | "high" | "medium" | "low", number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}

/**
 * Pure function - takes a single-page AnalysisReport (from
 * pipeline.ts's analyzeUrl()) and reports what evidence actually
 * exists per domain, with no interpretation, scoring, or decision
 * logic. Safe to call today; does not assume any missing domain.
 */
export function summarizeEvidenceCoverage(report: AnalysisReport): EvidenceCoverageSummary {
  const domains: DomainEvidenceCoverage[] = ALL_CATEGORIES.map((category) => {
    const categoryIssues = report.allIssues.filter((i) => i.category === category);
    if (category === "performance") {
      return {
        category,
        issueCount: categoryIssues.length,
        bySeverity: bySeverityCounts(categoryIssues),
        hasDedicatedVerificationModel: true,
        verificationStates: report.performanceVerification?.map((e) => e.state) ?? [],
        notVerifiable: null,
      };
    }
    if (category === "accessibility") {
      return {
        category,
        issueCount: categoryIssues.length,
        bySeverity: bySeverityCounts(categoryIssues),
        hasDedicatedVerificationModel: true,
        verificationStates: null,
        notVerifiable: report.accessibilityCoverage.notVerifiable,
      };
    }
    if (category === "responsiveness") {
      return {
        category,
        issueCount: categoryIssues.length,
        bySeverity: bySeverityCounts(categoryIssues),
        hasDedicatedVerificationModel: true,
        verificationStates: null,
        notVerifiable: report.responsiveVerification.checks.filter((c) => c.state === "unverified").map((c) => c.label),
      };
    }
    // ux, security, seo: real baseline Issue-producing rules exist (see module doc
    // comment above for the exact list), but no dedicated verification/coverage
    // structure - deliberately reported as such, not glossed over.
    return {
      category,
      issueCount: categoryIssues.length,
      bySeverity: bySeverityCounts(categoryIssues),
      hasDedicatedVerificationModel: false,
      verificationStates: null,
      notVerifiable: null,
    };
  });

  return {
    scannedUrl: report.url,
    domains,
    domainsWithDedicatedVerificationModel: domains.filter((d) => d.hasDedicatedVerificationModel).map((d) => d.category),
    domainsWithBaselineRulesOnly: domains.filter((d) => !d.hasDedicatedVerificationModel).map((d) => d.category),
  };
}
