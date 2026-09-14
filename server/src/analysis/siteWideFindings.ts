import type { Category, CategorySummary, PageCrawlResult, Severity, SiteWideFinding } from "../types.js";

/**
 * General (all-category) version of what analysis/siteWidePerformance.ts
 * already does for performance alone: group identical-titled Issues
 * recurring across enough analyzed pages into ONE finding with every
 * affected URL, instead of N near-duplicate per-page findings. See
 * that module for the original design rationale - this one exists
 * separately (rather than generalizing siteWidePerformance.ts in
 * place) so performance's existing, already-tested function signature
 * and thresholds stay untouched; this module is additive, not a
 * refactor of prior work.
 *
 * Same dual-floor threshold as siteWidePerformance.ts: a problem must
 * recur on at least SITE_WIDE_MIN_OCCURRENCES pages AND at least
 * SITE_WIDE_MIN_RATIO of analyzed pages to be called site-wide.
 */
const SITE_WIDE_MIN_OCCURRENCES = 3;
const SITE_WIDE_MIN_RATIO = 0.15;

const SEVERITY_ORDER: Severity[] = ["low", "medium", "high", "critical"];
function worseSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}

function analyzedPages(pages: PageCrawlResult[]) {
  return pages.filter((p) => p.status === "analyzed" && p.report !== null);
}

/**
 * Groups Issues (across ALL categories) by their title across every
 * successfully analyzed page. Only returns groups that clear the
 * site-wide threshold - individual page-level findings below that
 * threshold remain fully visible on each PageCrawlResult.report, this
 * function only adds the cross-page rollup on top.
 */
export function detectSiteWideFindings(pages: PageCrawlResult[]): SiteWideFinding[] {
  const analyzed = analyzedPages(pages);
  const pagesAnalyzed = analyzed.length;
  if (pagesAnalyzed === 0) return [];

  const groups = new Map<string, { category: Category; severity: Severity; affectedUrls: Set<string> }>();
  for (const page of analyzed) {
    for (const issue of page.report!.allIssues) {
      const key = `${issue.category}::${issue.title}`;
      const existing = groups.get(key);
      if (existing) {
        existing.severity = worseSeverity(existing.severity, issue.severity);
        existing.affectedUrls.add(page.url);
      } else {
        groups.set(key, { category: issue.category, severity: issue.severity, affectedUrls: new Set([page.url]) });
      }
    }
  }

  const minOccurrences = Math.max(SITE_WIDE_MIN_OCCURRENCES, Math.ceil(pagesAnalyzed * SITE_WIDE_MIN_RATIO));

  const findings: SiteWideFinding[] = [];
  for (const [key, group] of groups) {
    const occurrenceCount = group.affectedUrls.size;
    if (occurrenceCount < minOccurrences) continue;
    const title = key.slice(group.category.length + 2);
    findings.push({
      title,
      category: group.category,
      severity: group.severity,
      affectedUrls: [...group.affectedUrls],
      occurrenceCount,
      pagesAnalyzed,
    });
  }

  findings.sort((a, b) => {
    if (a.severity !== b.severity) return SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    return b.occurrenceCount - a.occurrenceCount;
  });
  return findings;
}

const EMPTY_SEVERITY_COUNTS: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
const ALL_CATEGORIES: Category[] = ["performance", "seo", "security", "accessibility", "ux", "responsiveness"];

/** Per-category issue counts/severity breakdown/average score across every successfully analyzed page. */
export function buildCategorySummaries(pages: PageCrawlResult[]): CategorySummary[] {
  const analyzed = analyzedPages(pages);

  return ALL_CATEGORIES.map((category): CategorySummary => {
    let totalIssues = 0;
    const bySeverity = { ...EMPTY_SEVERITY_COUNTS };
    let pagesWithIssues = 0;
    let scoreSum = 0;

    for (const page of analyzed) {
      const report = page.report!;
      const categoryIssues = report.allIssues.filter((i) => i.category === category);
      totalIssues += categoryIssues.length;
      if (categoryIssues.length > 0) pagesWithIssues++;
      for (const issue of categoryIssues) bySeverity[issue.severity]++;
      scoreSum += report.scores[category];
    }

    return {
      category,
      totalIssues,
      bySeverity,
      pagesWithIssues,
      averageScore: analyzed.length > 0 ? Math.round((scoreSum / analyzed.length) * 10) / 10 : 0,
    };
  });
}
