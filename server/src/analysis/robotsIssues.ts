import type { Issue, RobotsTxtAnalysis, SitemapAnalysis } from "../types.js";
import { checkRobotsPath, isSiteWideBlocked } from "../collectors/robotsCollector.js";

let counter = 0;
export function resetCrawlabilityIssueIdCounter(): void { counter = 0; }
function nextId(): string { counter += 1; return `crawl-${counter}`; }

const SEVERITY_WEIGHT = { critical: 100, high: 70, medium: 40, low: 15 } as const;
function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  return { ...input, category: "seo", id: nextId(), priorityScore: SEVERITY_WEIGHT[input.severity] };
}

/**
 * Adds explicit, evidence-backed crawlability findings on top of the
 * existing robots/sitemap collectors. This intentionally reuses their
 * established data model rather than replacing the collector architecture.
 */
export function detectCrawlabilityIssues(
  robots: RobotsTxtAnalysis,
  sitemap: SitemapAnalysis,
  pageUrl: string,
): Issue[] {
  const issues: Issue[] = [];

  if (robots.available && isSiteWideBlocked(robots)) {
    issues.push(makeIssue({
      severity: "critical",
      title: "robots.txt blocks all crawlers from the entire site",
      affected: robots.raw ? new URL(pageUrl).origin + "/robots.txt" : pageUrl,
      whyItMatters: 'A wildcard User-agent group with Disallow: / prevents compliant search crawlers from accessing the site.',
      estimatedImpact: 'The wildcard (*) group disallows "/" without an Allow exception.',
      recommendedFix: 'If intentional, leave it. Otherwise remove or narrow the wildcard Disallow: / rule.',
      difficulty: "easy",
      source: "measured",
      evidence: [{ type: "url", label: "robots.txt", value: new URL(pageUrl).origin + "/robots.txt" }],
    }));
  } else if (robots.available) {
    const pageCheck = checkRobotsPath(robots, pageUrl);
    if (pageCheck.blocked) {
      issues.push(makeIssue({
        severity: "high",
        title: "This page is blocked from crawling by robots.txt",
        affected: pageUrl,
        whyItMatters: "Search engines that respect robots.txt may not crawl this page, so its content cannot be discovered through normal crawling.",
        estimatedImpact: pageCheck.matchedRule ? `Matched rule: ${pageCheck.matchedRule}` : undefined,
        recommendedFix: "If this page should be discoverable, adjust the matching Allow/Disallow rules for this path.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "url", label: "robots.txt", value: new URL(pageUrl).origin + "/robots.txt" }],
      }));
    }
  } else if (!robots.fetched && robots.fetchError) {
    issues.push(makeIssue({
      severity: "low",
      title: "Could not verify robots.txt",
      affected: `${new URL(pageUrl).origin}/robots.txt`,
      whyItMatters: "The scan could not determine whether crawl-blocking rules exist, so this area remains unverified.",
      estimatedImpact: robots.fetchError,
      recommendedFix: "Confirm robots.txt is reachable and returns a normal response.",
      difficulty: "moderate",
      source: "measured",
      evidence: [{ type: "url", label: "robots.txt fetch error", value: robots.fetchError }],
    }));
  }

  if (robots.available && robots.malformedSitemapRefs.length > 0) {
    issues.push(makeIssue({
      severity: "low",
      title: "robots.txt contains malformed Sitemap references",
      affected: `${new URL(pageUrl).origin}/robots.txt`,
      whyItMatters: "Malformed Sitemap directives cannot reliably identify the sitemap URL to crawlers.",
      estimatedImpact: `${robots.malformedSitemapRefs.length} malformed Sitemap reference(s).`,
      recommendedFix: "Use fully-qualified absolute HTTP(S) URLs in Sitemap directives.",
      difficulty: "easy",
      source: "measured",
      evidence: robots.malformedSitemapRefs.slice(0, 5).map((value) => ({ type: "url" as const, label: "Malformed Sitemap reference", value })),
    }));
  }

  if (sitemap.available && sitemap.parseError) {
    issues.push(makeIssue({
      severity: "high",
      title: "Sitemap could not be parsed",
      affected: sitemap.sitemapUrl ?? pageUrl,
      whyItMatters: "A sitemap that cannot be parsed cannot reliably provide URL discovery information to search engines.",
      estimatedImpact: sitemap.parseError,
      recommendedFix: "Fix the sitemap XML structure and ensure it contains a valid urlset or sitemapindex.",
      difficulty: "moderate",
      source: "measured",
      evidence: [{ type: "url", label: "Sitemap", value: sitemap.sitemapUrl ?? "unknown" }],
    }));
  }

  if (sitemap.available && !sitemap.parseError && !sitemap.isSitemapIndex && sitemap.urls.length === 0) {
    issues.push(makeIssue({
      severity: "medium",
      title: "Sitemap contains no URLs",
      affected: sitemap.sitemapUrl ?? pageUrl,
      whyItMatters: "An empty sitemap provides search engines with no URLs to discover from it.",
      recommendedFix: "Populate the sitemap with the site's canonical, indexable URLs.",
      difficulty: "moderate",
      source: "measured",
      evidence: [{ type: "url", label: "Sitemap", value: sitemap.sitemapUrl ?? "unknown" }],
    }));
  }

  if (sitemap.available && sitemap.malformedUrlCount > 0) {
    issues.push(makeIssue({
      severity: "medium",
      title: "Sitemap contains malformed URL entries",
      affected: sitemap.sitemapUrl ?? pageUrl,
      whyItMatters: "Malformed <loc> entries may be skipped by search engines and reduce the sitemap's usefulness.",
      estimatedImpact: `${sitemap.malformedUrlCount} malformed URL entries.`,
      recommendedFix: "Fix or remove malformed <loc> entries and ensure every URL is absolute.",
      difficulty: "easy",
      source: "measured",
      evidence: [{ type: "computed", label: "Malformed sitemap entries", value: String(sitemap.malformedUrlCount) }],
    }));
  }

  if (!sitemap.available && sitemap.parseError) {
    issues.push(makeIssue({
      severity: "high",
      title: "Sitemap was found but could not be parsed",
      affected: sitemap.sitemapUrl ?? pageUrl,
      whyItMatters: "A discovered sitemap that cannot be parsed cannot provide reliable crawl-discovery information.",
      estimatedImpact: sitemap.parseError,
      recommendedFix: "Fix the sitemap and ensure it is valid XML with a recognized sitemap root.",
      difficulty: "moderate",
      source: "measured",
      evidence: [{ type: "url", label: "Sitemap", value: sitemap.sitemapUrl ?? "unknown" }],
    }));
  }

  if (!sitemap.available && !sitemap.parseError && sitemap.fetchError) {
    issues.push(makeIssue({
      severity: "low",
      title: "Could not verify sitemap",
      affected: sitemap.sitemapUrl ?? pageUrl,
      whyItMatters: "The scan could not verify the sitemap contents, so this area remains unverified rather than being treated as a confirmed defect.",
      estimatedImpact: sitemap.fetchError,
      recommendedFix: "Confirm the sitemap URL is reachable and returns a valid sitemap response.",
      difficulty: "moderate",
      source: "measured",
      evidence: [{ type: "url", label: "Sitemap fetch error", value: sitemap.fetchError }],
    }));
  }

  return issues;
}
