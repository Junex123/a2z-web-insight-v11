import type { RobotsPathCheck, RobotsTxtAnalysis, RobotsTxtGroup } from "../types.js";
import { fetchTextResource } from "./resourceFetcher.js";

/**
 * Parses robots.txt content into user-agent groups. This is a pure
 * function (MEASURE step) - no judgment about whether a Disallow rule
 * is "correct" happens here; analysis/seoIssues.ts decides that using
 * context (which paths were actually discovered/important).
 *
 * Supports the practically-universal subset of the robots.txt de-facto
 * standard: User-agent, Disallow, Allow, Crawl-delay, Sitemap, and `#`
 * comments. Does not implement full RFC 9309 pattern matching nuance
 * (e.g. `$` end-anchors are treated literally as part of the path
 * prefix) - documented as a known limitation rather than silently
 * guessed at.
 */
export function parseRobotsTxt(raw: string): RobotsTxtAnalysis {
  const lines = raw.split(/\r\n|\r|\n/);
  const groups: RobotsTxtGroup[] = [];
  const sitemapUrls: string[] = [];
  const malformedSitemapRefs: string[] = [];
  const syntaxWarnings: string[] = [];

  let current: RobotsTxtGroup | null = null;
  let sawAnyDirectiveSinceLastUserAgent = true; // allows the very first group to start cleanly

  for (const rawLine of lines) {
    const withoutComment = rawLine.split("#")[0];
    const line = withoutComment.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      syntaxWarnings.push(`Line without a ":" separator: "${line.slice(0, 80)}"`);
      continue;
    }

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    switch (field) {
      case "user-agent": {
        if (current && !sawAnyDirectiveSinceLastUserAgent) {
          // consecutive User-agent lines belong to the same group
          current.userAgents.push(value);
        } else {
          current = { userAgents: [value], disallow: [], allow: [], crawlDelay: null };
          groups.push(current);
        }
        sawAnyDirectiveSinceLastUserAgent = false;
        break;
      }
      case "disallow": {
        if (!current) {
          syntaxWarnings.push(`Disallow directive found before any User-agent line: "${value}"`);
          break;
        }
        current.disallow.push(value);
        sawAnyDirectiveSinceLastUserAgent = true;
        break;
      }
      case "allow": {
        if (!current) {
          syntaxWarnings.push(`Allow directive found before any User-agent line: "${value}"`);
          break;
        }
        current.allow.push(value);
        sawAnyDirectiveSinceLastUserAgent = true;
        break;
      }
      case "crawl-delay": {
        const n = Number(value);
        if (current) current.crawlDelay = Number.isFinite(n) ? n : null;
        sawAnyDirectiveSinceLastUserAgent = true;
        break;
      }
      case "sitemap": {
        try {
          const u = new URL(value);
          sitemapUrls.push(u.href);
        } catch {
          malformedSitemapRefs.push(value);
        }
        break;
      }
      default:
        // unrecognized directive - not necessarily an error (host,
        // clean-param, etc. are engine-specific extensions), so no warning.
        sawAnyDirectiveSinceLastUserAgent = true;
        break;
    }
  }

  return {
    fetched: true,
    statusCode: 200,
    available: true,
    raw,
    groups,
    sitemapUrls: [...new Set(sitemapUrls)],
    malformedSitemapRefs,
    syntaxWarnings,
  };
}

export const UNAVAILABLE_ROBOTS: RobotsTxtAnalysis = {
  fetched: false,
  statusCode: null,
  available: false,
  raw: null,
  groups: [],
  sitemapUrls: [],
  malformedSitemapRefs: [],
  syntaxWarnings: [],
};

/**
 * Fetches and parses robots.txt for the origin of `pageUrl`. Never
 * throws - a missing/unreachable robots.txt is a normal, common
 * condition (it simply means "no restrictions declared"), not a scan
 * failure, so this resolves to an `available: false` result instead.
 */
export async function fetchRobotsTxt(pageUrl: string): Promise<RobotsTxtAnalysis> {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return { ...UNAVAILABLE_ROBOTS, fetchError: "Invalid page URL" };
  }

  const result = await fetchTextResource(`${origin}/robots.txt`);
  if (!result.ok || result.bodyText === null) {
    return {
      ...UNAVAILABLE_ROBOTS,
      fetched: result.statusCode !== null,
      statusCode: result.statusCode,
      fetchError: result.error,
    };
  }
  return { ...parseRobotsTxt(result.bodyText), statusCode: result.statusCode };
}

/**
 * Normalizes a URL path the same way robots.txt matching expects
 * (path + query, no scheme/host/fragment).
 */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * Detects the specific catastrophic misconfiguration of `Disallow: /`
 * under a `User-agent: *` group - i.e. the entire site is blocked from
 * all crawlers with no exceptions. Deliberately narrow: this is NOT
 * "any broad Disallow rule" (blocking `/admin/` or even `/app/` is
 * common and often correct) - only an exact root-path block with no
 * narrower Allow carving out anything.
 */
export function isSiteWideBlocked(robots: RobotsTxtAnalysis): boolean {
  if (!robots.available) return false;
  const wildcardGroups = robots.groups.filter((g) => g.userAgents.includes("*"));
  return wildcardGroups.some((g) => g.disallow.includes("/") && g.allow.length === 0);
}

/**
 * Checks whether `url` is blocked by robots.txt for `userAgent`
 * (defaulting to matching only the wildcard "*" group, since that is
 * what applies to a generic/unnamed crawler). Uses the longest-matching-
 * rule-wins convention (the de-facto standard most engines follow):
 * the most specific (longest) Allow/Disallow prefix match takes
 * precedence; ties favor Allow.
 */
export function checkRobotsPath(robots: RobotsTxtAnalysis, url: string, userAgent = "*"): RobotsPathCheck {
  if (!robots.available) return { blocked: false, matchedRule: null, matchedGroup: null };

  const path = pathOf(url);
  const applicableGroups = robots.groups.filter((g) =>
    g.userAgents.some((ua) => ua === "*" || ua.toLowerCase() === userAgent.toLowerCase()),
  );
  // prefer an exact named-agent group over the wildcard group, per convention
  const named = applicableGroups.filter((g) => g.userAgents.some((ua) => ua.toLowerCase() === userAgent.toLowerCase() && ua !== "*"));
  const groups = named.length > 0 ? named : applicableGroups;

  let best: { len: number; type: "allow" | "disallow"; rule: string; group: RobotsTxtGroup } | null = null;
  for (const g of groups) {
    for (const rule of g.disallow) {
      if (rule === "") continue; // empty Disallow means "allow everything"
      if (path.startsWith(rule) && (!best || rule.length > best.len)) {
        best = { len: rule.length, type: "disallow", rule, group: g };
      }
    }
    for (const rule of g.allow) {
      if (path.startsWith(rule) && (!best || rule.length >= best.len)) {
        best = { len: rule.length, type: "allow", rule, group: g };
      }
    }
  }

  if (!best || best.type === "allow") return { blocked: false, matchedRule: best?.rule ?? null, matchedGroup: best ? best.group.userAgents.join(",") : null };
  return { blocked: true, matchedRule: best.rule, matchedGroup: best.group.userAgents.join(",") };
}
