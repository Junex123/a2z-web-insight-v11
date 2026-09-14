import type {
  CoreWebVitalsReport,
  Issue,
  PageHealthStatus,
  PagePerformanceResult,
  Severity,
  SitePerformanceSummary,
  SiteWidePerformancePattern,
} from "../types.js";

/**
 * A problem must recur on at least this many pages AND at least this
 * fraction of scanned pages to be called "site-wide" (e.g. template-
 * level) rather than a handful of unrelated per-page findings. Two
 * separate floors, both must be met - a fixed minimum-page-count floor
 * so a 3-page site doesn't need a fraction that rounds to zero, and a
 * ratio floor so a problem on 3 of 400 pages isn't mislabeled
 * "site-wide". Deliberately conservative and documented here as the
 * single source of truth, same pattern as the other threshold files.
 */
const SITE_WIDE_MIN_OCCURRENCES = 3;
const SITE_WIDE_MIN_RATIO = 0.15;

/**
 * A page is "critical" if it has any critical-severity performance
 * issue, "warning" if it has any high/medium (but no critical), and
 * "healthy" otherwise (no issues, or only low-severity ones). This
 * mirrors the existing severity scale (analysis/scorer.ts) rather than
 * inventing a second one.
 */
export function classifyPageHealth(issues: Issue[]): PageHealthStatus {
  const perfIssues = issues.filter((i) => i.category === "performance");
  if (perfIssues.some((i) => i.severity === "critical")) return "critical";
  if (perfIssues.some((i) => i.severity === "high" || i.severity === "medium")) return "warning";
  return "healthy";
}

/**
 * Builds one page's performance result from evidence the caller
 * already collected (e.g. via the existing single-page pipeline's
 * analyzeUrl()). This function does no fetching of its own - it's the
 * integration seam between "however pages get discovered/measured"
 * and the whole-site aggregation below.
 */
export function buildPagePerformanceResult(
  url: string,
  allIssues: Issue[],
  coreWebVitals: CoreWebVitalsReport,
): PagePerformanceResult {
  const issues = allIssues.filter((i) => i.category === "performance");
  return { url, status: classifyPageHealth(issues), issues, coreWebVitals };
}

const SEVERITY_ORDER: Severity[] = ["low", "medium", "high", "critical"];
function worseSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}

/**
 * Groups identical-titled performance findings across pages into
 * site-wide patterns (e.g. "the same render-blocking third-party
 * script on every templated page" becomes ONE finding with every
 * affected URL, not N near-duplicate findings) - see README goal #3,
 * "Performance consistency". Pages/issues below the site-wide
 * threshold are still fully visible via pageResults; this only adds
 * the cross-page rollup on top.
 */
export function aggregateSitePerformance(pages: PagePerformanceResult[]): SitePerformanceSummary {
  const pagesScanned = pages.length;

  let healthy = 0;
  let warning = 0;
  let critical = 0;
  for (const p of pages) {
    if (p.status === "healthy") healthy++;
    else if (p.status === "warning") warning++;
    else critical++;
  }

  const groups = new Map<
    string,
    { severity: Severity; affectedUrls: Set<string>; whyItMatters: string; recommendedFix: string; evidenceExample: Issue["evidence"] }
  >();

  for (const page of pages) {
    for (const issue of page.issues) {
      const existing = groups.get(issue.title);
      if (existing) {
        existing.severity = worseSeverity(existing.severity, issue.severity);
        existing.affectedUrls.add(page.url);
      } else {
        groups.set(issue.title, {
          severity: issue.severity,
          affectedUrls: new Set([page.url]),
          whyItMatters: issue.whyItMatters,
          recommendedFix: issue.recommendedFix,
          evidenceExample: issue.evidence,
        });
      }
    }
  }

  const minOccurrences = Math.max(SITE_WIDE_MIN_OCCURRENCES, Math.ceil(pagesScanned * SITE_WIDE_MIN_RATIO));

  const siteWidePatterns: SiteWidePerformancePattern[] = [];
  for (const [title, group] of groups) {
    const occurrenceCount = group.affectedUrls.size;
    if (occurrenceCount < minOccurrences) continue;
    siteWidePatterns.push({
      title,
      severity: group.severity,
      category: "performance",
      affectedUrls: [...group.affectedUrls],
      occurrenceCount,
      pagesScanned,
      whyItMatters: group.whyItMatters,
      recommendedFix: group.recommendedFix,
      evidenceExample: group.evidenceExample,
    });
  }

  siteWidePatterns.sort((a, b) => {
    if (a.severity !== b.severity) return SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    return b.occurrenceCount - a.occurrenceCount;
  });

  return { pagesScanned, healthy, warning, critical, siteWidePatterns, pageResults: pages };
}
