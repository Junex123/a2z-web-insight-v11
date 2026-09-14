import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { collectHtml } from "../src/collectors/htmlCollector.js";
import { collectSeoExtras } from "../src/collectors/seoCollector.js";
import { analyzeSite, findUrlVariantGroups, resetSiteSeoIssueIdCounter } from "../src/analysis/siteSeoAnalysis.js";
import type { SitePageInput, SitemapAnalysis } from "../src/types.js";

/**
 * Builds one SitePageInput from REAL HTML run through the real
 * collectHtml/collectSeoExtras collectors (matching the project's
 * existing convention of testing collectors against literal HTML
 * fixtures - see htmlCollector.test.ts). Only the crawl-graph metadata
 * (url, statusCode, internalLinks, redirectTarget) is supplied
 * directly, since there is no crawler yet to produce it - this is
 * exactly the documented SitePageInput integration point.
 */
function page(url: string, html: string, opts: { statusCode?: number; internalLinks?: string[]; redirectTarget?: string | null } = {}): SitePageInput {
  return {
    url,
    statusCode: opts.statusCode ?? 200,
    redirectTarget: opts.redirectTarget ?? null,
    html: collectHtml(html, true),
    seo: collectSeoExtras(html, url, {}),
    internalLinks: opts.internalLinks ?? [],
  };
}

const HOME = "https://example.com/";
const simplePage = (title: string) => `<html><head><title>${title}</title><meta name="description" content="Description for ${title}"></head><body><h1>${title}</h1><p>${"Real content. ".repeat(20)}</p></body></html>`;

beforeEach(() => resetSiteSeoIssueIdCounter());

test("a clean, well-linked multi-page site produces no site-level findings", () => {
  const home = page(HOME, simplePage("Home"), { internalLinks: ["https://example.com/about"] });
  const about = page("https://example.com/about", simplePage("About"), { internalLinks: ["https://example.com/"] });
  const report = analyzeSite({ pages: [home, about], homepageUrl: HOME });

  assert.equal(report.pagesAnalyzed, 2);
  assert.deepEqual(report.duplicateTitles, []);
  assert.deepEqual(report.duplicateDescriptions, []);
  assert.deepEqual(report.canonicalConflicts, []);
  assert.deepEqual(report.orphanPages, []);
  assert.deepEqual(report.brokenInternalLinks, []);
  assert.equal(report.issues.length, 0);
});

test("detects duplicate titles across pages", () => {
  const home = page(HOME, simplePage("Same Title"), { internalLinks: ["https://example.com/about"] });
  const about = page("https://example.com/about", simplePage("Same Title"), { internalLinks: [HOME] });
  const report = analyzeSite({ pages: [home, about], homepageUrl: HOME });

  assert.equal(report.duplicateTitles.length, 1);
  assert.equal(report.duplicateTitles[0].urls.length, 2);
  assert.ok(report.issues.some((i) => i.title.includes("Duplicate <title>")));
});

test("detects duplicate meta descriptions across pages", () => {
  const home: SitePageInput = page(HOME, `<html><head><title>Home</title><meta name="description" content="Same description"></head><body><h1>Home</h1></body></html>`, {
    internalLinks: ["https://example.com/about"],
  });
  const about: SitePageInput = page(
    "https://example.com/about",
    `<html><head><title>About</title><meta name="description" content="Same description"></head><body><h1>About</h1></body></html>`,
    { internalLinks: [HOME] },
  );
  const report = analyzeSite({ pages: [home, about], homepageUrl: HOME });
  assert.equal(report.duplicateDescriptions.length, 1);
});

test("detects an orphan page with zero internal inbound links", () => {
  const home = page(HOME, simplePage("Home"), { internalLinks: ["https://example.com/about"] });
  const about = page("https://example.com/about", simplePage("About"), { internalLinks: [HOME] });
  const orphan = page("https://example.com/orphan", simplePage("Orphan"), { internalLinks: [] }); // nothing links to it
  const report = analyzeSite({ pages: [home, about, orphan], homepageUrl: HOME });

  assert.equal(report.orphanPages.length, 1);
  assert.equal(report.orphanPages[0].url, "https://example.com/orphan");
  assert.equal(report.orphanPages[0].kind, "no-internal-inbound-links");
});

test("computes crawl depth and flags an important page buried too deep", () => {
  const home = page(HOME, simplePage("Home"), { internalLinks: ["https://example.com/l1"] });
  const l1 = page("https://example.com/l1", simplePage("L1"), { internalLinks: ["https://example.com/l2"] });
  const l2 = page("https://example.com/l2", simplePage("L2"), { internalLinks: ["https://example.com/l3"] });
  const l3 = page("https://example.com/l3", simplePage("L3"), { internalLinks: [] });
  const report = analyzeSite({ pages: [home, l1, l2, l3], homepageUrl: HOME, importantUrls: ["https://example.com/l3"], deepThreshold: 2 });

  assert.ok(report.crawlDepth);
  assert.equal(report.crawlDepth?.min, 0);
  assert.equal(report.crawlDepth?.max, 3);
  assert.equal(report.crawlDepth?.deepImportantPages.length, 1);
  assert.equal(report.crawlDepth?.deepImportantPages[0].url, "https://example.com/l3");
});

test("detects a canonical pointing to a noindex page as a conflict", () => {
  const noindexHtml = `<html><head><title>Noindex Target</title><meta name="robots" content="noindex"></head><body><h1>Noindex Target</h1></body></html>`;
  const target = page("https://example.com/target", noindexHtml, { internalLinks: [] });
  const sourceHtml = `<html><head><title>Source</title><link rel="canonical" href="https://example.com/target"></head><body><h1>Source</h1></body></html>`;
  const source = page("https://example.com/source", sourceHtml, { internalLinks: ["https://example.com/target"] });
  const home = page(HOME, simplePage("Home"), { internalLinks: ["https://example.com/source", "https://example.com/target"] });

  const report = analyzeSite({ pages: [home, source, target], homepageUrl: HOME });
  assert.equal(report.canonicalConflicts.length, 1);
  assert.match(report.canonicalConflicts[0].reason, /noindex/);
});

test("detects a canonical pointing to a page that redirects", () => {
  const target = page("https://example.com/old", simplePage("Old"), { internalLinks: [], redirectTarget: "https://example.com/new" });
  const sourceHtml = `<html><head><title>Source</title><link rel="canonical" href="https://example.com/old"></head><body><h1>Source</h1></body></html>`;
  const source = page("https://example.com/source", sourceHtml, { internalLinks: ["https://example.com/old"] });
  const home = page(HOME, simplePage("Home"), { internalLinks: ["https://example.com/source", "https://example.com/old"] });

  const report = analyzeSite({ pages: [home, source, target], homepageUrl: HOME });
  assert.equal(report.canonicalConflicts.length, 1);
  assert.match(report.canonicalConflicts[0].reason, /redirects/);
});

test("detects a broken internal link (target returns a 4xx status)", () => {
  const broken = page("https://example.com/gone", simplePage("Gone"), { statusCode: 404, internalLinks: [] });
  const sourceHtml = `<html><head><title>Source</title></head><body><h1>Source</h1></body></html>`;
  const source = page("https://example.com/source", sourceHtml, { internalLinks: ["https://example.com/gone"] });
  const home = page(HOME, simplePage("Home"), { internalLinks: ["https://example.com/source"] });

  const report = analyzeSite({ pages: [home, source, broken], homepageUrl: HOME });
  assert.equal(report.brokenInternalLinks.length, 1);
  assert.equal(report.brokenInternalLinks[0].toUrl, "https://example.com/gone");
});

test("detects an internal link pointing to a redirect", () => {
  const redirectPage = page("https://example.com/old", simplePage("Old"), { internalLinks: [], redirectTarget: "https://example.com/new" });
  const sourceHtml = `<html><head><title>Source</title></head><body><h1>Source</h1></body></html>`;
  const source = page("https://example.com/source", sourceHtml, { internalLinks: ["https://example.com/old"] });
  const home = page(HOME, simplePage("Home"), { internalLinks: ["https://example.com/source"] });

  const report = analyzeSite({ pages: [home, source, redirectPage], homepageUrl: HOME });
  assert.equal(report.internalLinksToRedirects.length, 1);
});

test("sitemap reconciliation: reports sitemap-only and discovered-only URLs", () => {
  const home = page(HOME, simplePage("Home"), { internalLinks: [] });
  const sitemap: SitemapAnalysis = {
    fetched: true,
    available: true,
    sitemapUrl: "https://example.com/sitemap.xml",
    isSitemapIndex: false,
    childSitemapUrls: [],
    urls: [
      { loc: "https://example.com/", lastmod: null, isWellFormedUrl: true },
      { loc: "https://example.com/only-in-sitemap", lastmod: null, isWellFormedUrl: true },
    ],
    malformedUrlCount: 0,
    duplicateUrlCount: 0,
    parseError: null,
  };
  const report = analyzeSite({ pages: [home], homepageUrl: HOME, sitemap });

  assert.ok(report.sitemap);
  assert.equal(report.sitemap?.sitemapOnly.length, 1);
  assert.equal(report.sitemap?.sitemapOnly[0], "https://example.com/only-in-sitemap");
  assert.equal(report.orphanPages.some((o) => o.kind === "sitemap-only"), true);
});

test("sitemap URL returning a 404 is flagged", () => {
  const home = page(HOME, simplePage("Home"), { internalLinks: [] });
  const broken = page("https://example.com/broken", simplePage("Broken"), { statusCode: 404, internalLinks: [] });
  const sitemap: SitemapAnalysis = {
    fetched: true,
    available: true,
    sitemapUrl: "https://example.com/sitemap.xml",
    isSitemapIndex: false,
    childSitemapUrls: [],
    urls: [{ loc: "https://example.com/broken", lastmod: null, isWellFormedUrl: true }],
    malformedUrlCount: 0,
    duplicateUrlCount: 0,
    parseError: null,
  };
  const report = analyzeSite({ pages: [home, broken], homepageUrl: HOME, sitemap });
  assert.ok(report.issues.some((i) => i.title.includes("Sitemap URL returns an error status")));
});

test("detects inconsistent URL variants (trailing slash / www)", () => {
  const groups = findUrlVariantGroups(["https://example.com/page", "https://example.com/page/", "https://www.example.com/page"]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].variants.length, 3);
});

test("does not flag URLs that are already consistent", () => {
  const groups = findUrlVariantGroups(["https://example.com/a", "https://example.com/b"]);
  assert.equal(groups.length, 0);
});

test("site-wide aggregation counts structured-data issues across pages", () => {
  const malformedHtml = `<html><head><title>Bad JSON-LD</title><script type="application/ld+json">{ invalid </script></head><body><h1>Bad JSON-LD</h1></body></html>`;
  const home = page(HOME, malformedHtml, { internalLinks: [] });
  const report = analyzeSite({ pages: [home], homepageUrl: HOME });
  assert.ok(report.structuredDataIssueCount >= 1);
});

test("every site-level issue carries evidence, a fix, and an explanation", () => {
  const home = page(HOME, simplePage("Same"), { internalLinks: ["https://example.com/about"] });
  const about = page("https://example.com/about", simplePage("Same"), { internalLinks: [HOME] });
  const report = analyzeSite({ pages: [home, about], homepageUrl: HOME });
  assert.ok(report.issues.length > 0);
  for (const issue of report.issues) {
    assert.ok(issue.evidence.length > 0);
    assert.ok(issue.recommendedFix.length > 0);
    assert.ok(issue.whyItMatters.length > 0);
    assert.equal(issue.category, "seo");
  }
});
