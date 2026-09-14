import { fetchTextResource, type CollectHttpOptions } from "../collectors/httpCollector.js";
import type { RobotsTxtStatus } from "../types.js";

/**
 * SCOPE / KNOWN LIMITATION (stated up front, not buried): this is a
 * minimal, deliberately partial robots.txt implementation. It honors
 * ONLY the `User-agent: *` group - directives under a specific product
 * token (e.g. `User-agent: Googlebot`) are parsed but ignored, since
 * this crawler doesn't register a distinct, documented bot identity
 * for site owners to target. It supports `Disallow`/`Allow` with `*`
 * wildcards and a trailing `$` end-anchor, using a longest-match-wins
 * heuristic with Allow winning ties - a common, widely-implemented
 * approximation of the (non-standardized) de facto convention, not a
 * certified RFC 9309 implementation. `Crawl-delay` is parsed out of
 * courtesy for forward compatibility but currently has no effect - the
 * crawler's own `concurrency`/`maxPages` bounds are its real throttle.
 * Do not present this as a complete robots.txt implementation anywhere
 * downstream.
 */

export interface RobotsRules {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
}

export function parseRobotsTxt(bodyText: string): RobotsRules {
  const disallow: string[] = [];
  const allow: string[] = [];
  const sitemaps: string[] = [];
  let inWildcardGroup = false;

  for (const rawLine of bodyText.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      inWildcardGroup = value === "*";
      continue;
    }
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!inWildcardGroup) continue; // only the * group is honored - see module doc comment
    if (field === "disallow" && value) disallow.push(value);
    else if (field === "allow" && value) allow.push(value);
    // Crawl-delay and any other field: intentionally ignored (see doc comment)
  }

  return { disallow, allow, sitemaps };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathMatchesRule(path: string, rule: string): boolean {
  const endAnchor = rule.endsWith("$");
  const rulePath = endAnchor ? rule.slice(0, -1) : rule;
  const pattern = "^" + rulePath.split("*").map(escapeRegExp).join(".*") + (endAnchor ? "$" : "");
  return new RegExp(pattern).test(path);
}

/**
 * Longest-matching-rule-wins, with Allow winning exact-length ties -
 * see the module doc comment for why this is an approximation, not a
 * certified implementation. No applicable rule at all => allowed
 * (correct default per the spec: absence of a matching rule permits
 * crawling).
 */
export function isPathAllowedByRobots(path: string, rules: RobotsRules): boolean {
  let bestLen = -1;
  let allowed = true;
  for (const rule of rules.disallow) {
    if (rule.length > bestLen && pathMatchesRule(path, rule)) {
      bestLen = rule.length;
      allowed = false;
    }
  }
  for (const rule of rules.allow) {
    if (rule.length >= bestLen && pathMatchesRule(path, rule)) {
      bestLen = rule.length;
      allowed = true;
    }
  }
  return allowed;
}

export interface RobotsPolicy {
  status: RobotsTxtStatus;
  rules: RobotsRules | null;
  sitemapUrls: string[];
}

/**
 * Fetches and parses robots.txt for the given origin.
 * - respectRobots=false => status "disabled", nothing fetched.
 * - genuine 404 => status "missing" - per spec, a missing robots.txt
 *   means everything is allowed.
 * - network failure / timeout / non-2xx-non-404 => status
 *   "unavailable" - the CALLER decides how conservative to be about
 *   this (see crawler.ts: the seed URL is always attempted regardless,
 *   since the user explicitly asked for that exact URL; discovered
 *   URLs are treated as disallowed when robots.txt is unavailable,
 *   erring toward not hammering a site whose robots.txt we simply
 *   couldn't read).
 */
export async function loadRobotsPolicy(
  originUrl: string,
  respectRobots: boolean,
  fetchOptions: CollectHttpOptions = {},
): Promise<RobotsPolicy> {
  if (!respectRobots) return { status: "disabled", rules: null, sitemapUrls: [] };

  const robotsUrl = new URL("/robots.txt", originUrl).href;
  const result = await fetchTextResource(robotsUrl, fetchOptions);
  if (!result) return { status: "unavailable", rules: null, sitemapUrls: [] };
  if (result.statusCode === 404) return { status: "missing", rules: null, sitemapUrls: [] };
  if (!result.ok) return { status: "unavailable", rules: null, sitemapUrls: [] };

  const rules = parseRobotsTxt(result.bodyText);
  return { status: "fetched", rules, sitemapUrls: rules.sitemaps };
}

/** See loadRobotsPolicy's doc comment for the "unavailable" conservative-default policy. */
export function isAllowedByRobots(policy: RobotsPolicy, path: string): boolean {
  if (policy.status === "fetched" && policy.rules) return isPathAllowedByRobots(path, policy.rules);
  if (policy.status === "missing" || policy.status === "disabled") return true;
  return false; // "unavailable" - conservative default
}
