import type { CorrelatedFinding, Issue } from "../types.js";

/**
 * Cross-category root-cause correlation.
 *
 * Most single-page analysis tools report categories in silos: a security
 * panel, a performance panel, an SEO panel, each blind to the others.
 * This module links findings that are DIFFERENT categories but share the
 * SAME underlying resource host - e.g. a third-party script that shows up
 * independently as "Mixed content" under security AND "Significant
 * third-party resource usage" under performance is, in reality, ONE
 * problem with two distinct impacts, not two unrelated ones.
 *
 * STRICT GROUNDING RULE: correlation only ever happens on `Issue.relatedHosts`
 * - a field populated at issue-creation time in issues.ts, directly from
 * already-parsed `URL.hostname` values the code had on hand (a mixed-content
 * resource's real host, a third-party vendor's real host, a cross-domain
 * canonical's real target host). This module never re-parses evidence text,
 * never guesses a host from a title string, and never infers a relationship
 * that isn't a literal, exact hostname match. If two issues merely SOUND
 * related but don't share a `relatedHosts` entry, they are not correlated -
 * false correlation is worse than no correlation, because it would make the
 * report look smarter than the evidence actually supports.
 *
 * Same-host, same-category matches are not useful (that's just the
 * existing per-category finding) - only cross-category matches are
 * surfaced.
 */
export function correlateFindings(issues: Issue[]): CorrelatedFinding[] {
  // host -> the set of issues (from any category) that named that host
  const byHost = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.relatedHosts || issue.relatedHosts.length === 0) continue;
    for (const host of issue.relatedHosts) {
      const existing = byHost.get(host);
      if (existing) {
        existing.push(issue);
      } else {
        byHost.set(host, [issue]);
      }
    }
  }

  const correlations: CorrelatedFinding[] = [];
  for (const [host, hostIssues] of byHost) {
    const categories = [...new Set(hostIssues.map((i) => i.category))].sort();
    // Only a genuine cross-category correlation is useful - one category
    // repeating the same host isn't a new insight.
    if (categories.length < 2) continue;

    const perCategorySummary = categories
      .map((cat) => {
        const titles = [...new Set(hostIssues.filter((i) => i.category === cat).map((i) => i.title))];
        return `${cat}: ${titles.join("; ")}`;
      })
      .join(" | ");

    correlations.push({
      id: `correlated-${host}`,
      host,
      categories,
      issueIds: hostIssues.map((i) => i.id),
      summary: `${host} is the root resource behind findings in ${categories.length} categories - ${perCategorySummary}.`,
    });
  }

  // Deterministic ordering: more categories involved first (broadest root
  // cause), then alphabetical by host for a stable tiebreak.
  correlations.sort((a, b) => b.categories.length - a.categories.length || a.host.localeCompare(b.host));
  return correlations;
}
