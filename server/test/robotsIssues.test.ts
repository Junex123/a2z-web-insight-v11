import assert from "node:assert/strict";
import { test } from "node:test";
import { detectCrawlabilityIssues, resetCrawlabilityIssueIdCounter } from "../src/analysis/robotsIssues.js";
import type { RobotsTxtAnalysis, SitemapAnalysis } from "../src/types.js";

const robotsBase = (overrides: Partial<RobotsTxtAnalysis> = {}): RobotsTxtAnalysis => ({
  fetched: true, statusCode: 200, available: true, raw: "User-agent: *\nDisallow:", groups: [{ userAgents: ["*"], allow: [], disallow: [""], crawlDelay: null }], sitemapUrls: [], malformedSitemapRefs: [], syntaxWarnings: [], ...overrides,
});
const sitemapBase = (overrides: Partial<SitemapAnalysis> = {}): SitemapAnalysis => ({
  fetched: true, available: true, sitemapUrl: "https://example.com/sitemap.xml", isSitemapIndex: false, childSitemapUrls: [], urls: [{ loc: "https://example.com/", lastmod: null, isWellFormedUrl: true }], malformedUrlCount: 0, duplicateUrlCount: 0, parseError: null, ...overrides,
});

test("wildcard Disallow / is a critical site-wide crawlability finding", () => {
  resetCrawlabilityIssueIdCounter();
  const issues = detectCrawlabilityIssues(robotsBase({ groups: [{ userAgents: ["*"], allow: [], disallow: ["/"], crawlDelay: null }] }), sitemapBase(), "https://example.com/");
  assert.equal(issues[0].severity, "critical");
});

test("page-specific robots block is high severity", () => {
  resetCrawlabilityIssueIdCounter();
  const robots = robotsBase({ groups: [{ userAgents: ["*"], allow: [], disallow: ["/private"], crawlDelay: null }] });
  const issues = detectCrawlabilityIssues(robots, sitemapBase(), "https://example.com/private");
  assert.equal(issues[0].severity, "high");
  assert.equal(issues[0].affected, "https://example.com/private");
});

test("healthy robots and sitemap produce no crawlability issue", () => {
  resetCrawlabilityIssueIdCounter();
  const issues = detectCrawlabilityIssues(robotsBase(), sitemapBase(), "https://example.com/");
  assert.equal(issues.length, 0);
});

test("sitemap malformed entries are surfaced", () => {
  resetCrawlabilityIssueIdCounter();
  const issues = detectCrawlabilityIssues(robotsBase(), sitemapBase({ malformedUrlCount: 2 }), "https://example.com/");
  assert.equal(issues.some((i) => i.title.includes("malformed URL entries")), true);
});
