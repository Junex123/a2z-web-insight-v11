import type { Issue, PageOutcome, SiteFinding, SitePageResult } from "../types.js";

/**
 * Turns a set of already-collected per-page results into one site-level
 * report: a clean/warnings/critical/error breakdown, plus cross-page
 * findings (duplicate titles, duplicate H1s, and any issue that repeats
 * across several pages collapsed into ONE finding with an affected-URL
 * list instead of N near-identical entries - see README Part 10 "A
 * problem repeated across 40 pages should not appear as 40 unrelated
 * mysteries").
 *
 * SCOPE: this is the AGGREGATION layer only. It does not fetch pages,
 * discover links, or crawl anything - see the SCOPE NOTE on
 * SiteAnalysisReport in types.ts and sitePipeline.ts for why.
 */

/** A finding repeated on this many or more pages becomes one site-level finding instead of N page-level duplicates. */
export const SITE_FINDING_REPEAT_THRESHOLD = 2;

export function classifyPageOutcome(issues: Issue[]): PageOutcome {
  if (issues.some((i) => i.severity === "critical" || i.severity === "high")) return "critical";
  if (issues.length > 0) return "warnings";
  return "clean";
}

export function summarizePages(pages: SitePageResult[]): { clean: number; warnings: number; critical: number; error: number } {
  const summary = { clean: 0, warnings: 0, critical: 0, error: 0 };
  for (const page of pages) summary[page.outcome]++;
  return summary;
}

/** Groups pages by a non-null field value, returning only groups with 2+ members (i.e. actual duplicates). */
function findDuplicateGroups(pages: SitePageResult[], getValue: (p: SitePageResult) => string | null): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    const value = getValue(page);
    if (!value) continue; // missing title/H1 is its own (already-reported) page-level finding, not a duplication signal
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)!.push(page.url);
  }
  for (const [key, urls] of groups) {
    if (urls.length < 2) groups.delete(key);
  }
  return groups;
}

function buildDuplicateFinding(
  key: string,
  title: string,
  whyItMatters: string,
  recommendedFix: string,
  affectedUrls: string[],
): SiteFinding {
  return {
    key,
    category: "seo",
    severity: "medium",
    title,
    whyItMatters,
    recommendedFix,
    affectedUrls,
    affectedPageCount: affectedUrls.length,
  };
}

export function aggregateSitePages(pages: SitePageResult[]): SiteFinding[] {
  const findings: SiteFinding[] = [];

  // ---------------- duplicate <title> across pages ----------------
  for (const [value, urls] of findDuplicateGroups(pages, (p) => p.title)) {
    findings.push(
      buildDuplicateFinding(
        `duplicate-title:${value}`,
        `Duplicate page title used on ${urls.length} pages: "${value}"`,
        "Identical <title> tags across different pages make it hard for search engines and users (browser tabs, bookmarks, screen reader page-list navigation) to tell the pages apart.",
        "Give each page a unique, descriptive <title> that reflects its specific content.",
        urls,
      ),
    );
  }

  // ---------------- duplicate H1 (first H1 text) across pages ----------------
  for (const [value, urls] of findDuplicateGroups(pages, (p) => p.h1Texts[0]?.trim() || null)) {
    findings.push(
      buildDuplicateFinding(
        `duplicate-h1:${value}`,
        `Duplicate H1 heading used on ${urls.length} pages: "${value}"`,
        "Identical top-level headings across different pages make each page's unique purpose unclear to both users and search engines.",
        "Give each page a unique H1 that describes that specific page's content.",
        urls,
      ),
    );
  }

  // ---------------- repeated page-level issues -> one template-level finding ----------------
  // Group every page-level Issue by (category + title) - the same stable
  // key a truly identical finding would share across pages (e.g. "Missing
  // lang attribute on <html>" appearing on 40 pages because it's a
  // template-level problem, not 40 independent ones).
  const repeated = new Map<string, { sample: Issue; urls: Set<string> }>();
  for (const page of pages) {
    for (const issue of page.issues) {
      const key = `${issue.category}:${issue.title}`;
      if (!repeated.has(key)) repeated.set(key, { sample: issue, urls: new Set() });
      repeated.get(key)!.urls.add(page.url);
    }
  }
  for (const [key, { sample, urls }] of repeated) {
    if (urls.size < SITE_FINDING_REPEAT_THRESHOLD) continue;
    findings.push({
      key: `repeated:${key}`,
      category: sample.category,
      severity: sample.severity,
      title: `${sample.title} (repeated across ${urls.size} pages)`,
      whyItMatters: sample.whyItMatters,
      recommendedFix: `${sample.recommendedFix} This appears to be a template-level issue rather than a one-off - fixing the shared template/component will likely resolve it on every affected page at once.`,
      affectedUrls: [...urls],
      affectedPageCount: urls.size,
    });
  }

  return findings;
}
