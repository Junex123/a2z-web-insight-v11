import type { Category, Issue } from "../types.js";

/**
 * Agent 6 (cross-domain correlation + launch decision) prep utility.
 *
 * IMPORTANT - READ BEFORE USING THIS FOR ANYTHING DECISION-RELATED:
 * this module does NOT perform cross-domain correlation in the sense
 * the eventual Agent 6 reasoning layer needs (e.g. "poor LCP + large
 * hero image + late resource discovery -> one root-cause chain").
 * Real correlation requires evidence this codebase does not have yet:
 * browser/runtime timing (when was a resource actually requested
 * relative to LCP), resource discovery order, and cross-domain rules
 * that encode WHY two findings are related, not just THAT they
 * co-occur. Building fake versions of those rules today would produce
 * confident-looking but meaningless output.
 *
 * What this DOES do: groups the Issues that already exist today by
 * their `affected` URL, and reports which distinct categories are
 * present on each URL. That's it. It is a data-shape convenience for
 * a future correlation-rules layer to consume - "these categories
 * co-occur on this page" is a necessary precondition for correlation,
 * not correlation itself. Do not treat co-occurrence on the same URL
 * as evidence of a causal or even a meaningful relationship - two
 * findings can trivially share a URL (e.g. almost every page has BOTH
 * a performance and an SEO finding) without being related at all.
 *
 * A note on rule identity: every Issue's `title` is a fixed literal
 * string per rule (never interpolated with per-instance data - e.g.
 * "Large JavaScript payload", never "Large JavaScript payload on
 * /products/x"), so `title` already functions as a stable, de facto
 * rule identifier today, the same way analysis/siteWidePerformance.ts
 * already groups by it for site-wide pattern detection. No new
 * "ruleId" field was added here - it would duplicate what `title`
 * already provides. Future agents should preserve this invariant
 * (keep titles rule-level, put per-instance detail in `affected`/
 * `estimatedImpact`/`evidence`) so this keeps working after merge.
 */

export interface UrlEvidenceGroup {
  affectedUrl: string;
  /** distinct categories present on this URL, sorted for determinism */
  categories: Category[];
  issues: Issue[];
}

/**
 * Pure function. Groups issues by their exact `affected` URL. Only
 * returns groups where 2+ DISTINCT categories are present - a group
 * with issues from only one category isn't a cross-domain grouping
 * candidate at all, so it's omitted rather than padding the output.
 */
export function groupIssuesByAffectedUrl(issues: Issue[]): UrlEvidenceGroup[] {
  const byUrl = new Map<string, Issue[]>();
  for (const issue of issues) {
    const existing = byUrl.get(issue.affected);
    if (existing) existing.push(issue);
    else byUrl.set(issue.affected, [issue]);
  }

  const groups: UrlEvidenceGroup[] = [];
  for (const [affectedUrl, urlIssues] of byUrl) {
    const categories = [...new Set(urlIssues.map((i) => i.category))].sort();
    if (categories.length < 2) continue;
    groups.push({ affectedUrl, categories, issues: urlIssues });
  }

  groups.sort((a, b) => b.categories.length - a.categories.length || a.affectedUrl.localeCompare(b.affectedUrl));
  return groups;
}
