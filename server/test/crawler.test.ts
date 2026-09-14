import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { crawlSite } from "../src/crawler/crawler.js";
import type { PerformanceProvider } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";
delete process.env.PAGESPEED_INSIGHTS_API_KEY;

let mockServer: Server;
let mockPort: number;
let origin: string;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;
  origin = `http://localhost:${mockPort}`;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

// PageSpeed is not configured in tests, so leave it unset (analyzeUrl degrades
// gracefully to a "partial" status) - a fake provider isn't needed here since
// crawler mechanics, not performance evidence, are what's under test.
const fastOptions = { requestTimeoutMs: 5000, concurrency: 3 } as const;

test("crawls the linked site starting from /site/home and analyzes every reachable, allowed page", async () => {
  const { pages, stats } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: true, useSitemap: false });

  const analyzedUrls = pages.filter((p) => p.status === "analyzed").map((p) => p.url);
  assert.ok(analyzedUrls.some((u) => u.endsWith("/site/home")));
  assert.ok(analyzedUrls.some((u) => u.endsWith("/site/about")));
  assert.ok(analyzedUrls.some((u) => u.endsWith("/site/contact")));
  assert.ok(analyzedUrls.some((u) => u.endsWith("/site/deep/level2")));
  assert.equal(stats.seedUrl, `${origin}/site/home`);
});

test("every analyzed page carries a full AnalysisReport identical in shape to a single-page scan", async () => {
  const { pages } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 1, maxDepth: 0 });
  const seedResult = pages.find((p) => p.status === "analyzed")!;
  assert.ok(seedResult.report);
  assert.ok(seedResult.report!.allIssues);
  assert.ok(seedResult.report!.scores);
  assert.ok(seedResult.report!.coreWebVitals);
});

test("mailto/tel/javascript/fragment-only links never become crawl candidates", async () => {
  const { pages } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  const urls = pages.map((p) => p.url);
  assert.ok(!urls.some((u) => u.startsWith("mailto:")));
  assert.ok(!urls.some((u) => u.startsWith("tel:")));
  assert.ok(!urls.some((u) => u.startsWith("javascript:")));
});

test("an external link is never discovered as a crawl candidate at all", async () => {
  const { pages } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  assert.ok(!pages.some((p) => p.url.includes("external-example.test")));
});

test("a trailing-slash duplicate of an already-visited URL is deduplicated, not analyzed twice", async () => {
  const { pages, stats } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  const homeEntries = pages.filter((p) => p.url === `${origin}/site/home`);
  assert.equal(homeEntries.length, 1);
  assert.ok(stats.pagesSkippedDuplicate >= 1);
});

test("maxDepth bounds how far the crawl expands, recording deeper links as skipped_depth_limit", async () => {
  const { pages, stats } = await crawlSite(`${origin}/site/deep/level2`, { ...fastOptions, maxPages: 20, maxDepth: 1, respectRobots: false, useSitemap: false });
  const level2 = pages.find((p) => p.url.endsWith("/deep/level2")); // seed, depth 0
  const level3 = pages.find((p) => p.url.endsWith("/deep/level3")); // depth 1 - within maxDepth
  const level4 = pages.find((p) => p.url.endsWith("/deep/level4")); // depth 2 - beyond maxDepth
  assert.equal(level2!.status, "analyzed");
  assert.equal(level3!.status, "analyzed");
  assert.equal(level4!.status, "skipped_depth_limit");
  assert.equal(stats.maxDepthReached, 1);
});

test("maxDepth=0 analyzes only the seed page", async () => {
  const { pages, stats } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 0, respectRobots: false, useSitemap: false });
  assert.equal(pages.filter((p) => p.status === "analyzed").length, 1);
  assert.equal(stats.maxDepthReached, 0);
});

test("maxPages bounds how many pages are actually analyzed, recording the rest as skipped_page_limit", async () => {
  const { pages, stats } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 1, maxDepth: 5, respectRobots: false, useSitemap: false });
  assert.equal(stats.pagesAnalyzed, 1);
  assert.ok(pages.some((p) => p.status === "skipped_page_limit"));
});

test("robots.txt disallow rules are enforced against discovered links (but not the seed)", async () => {
  const { pages } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: true, useSitemap: false });
  const disallowed = pages.find((p) => p.url.endsWith("/site/disallowed"));
  assert.equal(disallowed!.status, "skipped_robots");
});

test("respectRobots=false ignores robots.txt entirely", async () => {
  const { pages } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  const disallowed = pages.find((p) => p.url.endsWith("/site/disallowed"));
  assert.equal(disallowed!.status, "analyzed");
});

test("the seed URL is always analyzed even if robots.txt would disallow it", async () => {
  const { pages } = await crawlSite(`${origin}/site/disallowed`, { ...fastOptions, maxPages: 5, maxDepth: 0, respectRobots: true, useSitemap: false });
  const seed = pages.find((p) => p.url.endsWith("/site/disallowed"));
  assert.equal(seed!.status, "analyzed");
});

test("useSitemap=true discovers a page reachable only via sitemap.xml", async () => {
  const { pages } = await crawlSite(`${origin}/site/contact`, { ...fastOptions, maxPages: 20, maxDepth: 2, respectRobots: true, useSitemap: true });
  const onlyInSitemap = pages.find((p) => p.url.endsWith("/site/only-in-sitemap"));
  assert.ok(onlyInSitemap);
  assert.equal(onlyInSitemap!.status, "analyzed");
});

test("useSitemap=false never discovers the sitemap-only page", async () => {
  const { pages } = await crawlSite(`${origin}/site/contact`, { ...fastOptions, maxPages: 20, maxDepth: 2, respectRobots: true, useSitemap: false });
  assert.ok(!pages.some((p) => p.url.endsWith("/site/only-in-sitemap")));
});

test("a page that fails (non-HTML response) is isolated - the rest of the crawl still completes", async () => {
  const { pages, stats } = await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  const broken = pages.find((p) => p.url.endsWith("/site/broken"));
  assert.equal(broken!.status, "skipped_non_html");
  assert.ok(broken!.errorMessage);
  // and the rest of the site was still analyzed despite /site/broken failing
  assert.ok(pages.some((p) => p.url.endsWith("/site/about") && p.status === "analyzed"));
  assert.ok(pages.some((p) => p.url.endsWith("/site/contact") && p.status === "analyzed"));
  assert.equal(stats.pagesSkippedNonHtml, 1);
});

test("concurrency=1 and concurrency=5 discover the exact same set of pages", async () => {
  const runA = await crawlSite(`${origin}/site/home`, { ...fastOptions, concurrency: 1, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  const runB = await crawlSite(`${origin}/site/home`, { ...fastOptions, concurrency: 5, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  const urlsA = runA.pages.map((p) => p.url).sort();
  const urlsB = runB.pages.map((p) => p.url).sort();
  assert.deepEqual(urlsA, urlsB);
});

test("an isolated dead-end page (no outbound links) does not error and just contributes nothing new to the frontier", async () => {
  const { pages } = await crawlSite(`${origin}/site/contact`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].status, "analyzed");
});

test("a clean, small site produces a fully-analyzed result with zero failures", async () => {
  const { pages, stats } = await crawlSite(`${origin}/site/deep/level2`, { ...fastOptions, maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false });
  assert.equal(stats.pagesFailed, 0);
  assert.ok(pages.every((p) => p.status === "analyzed"));
});

test("an invalid seed URL throws, same as a single-page scan would", async () => {
  await assert.rejects(() => crawlSite("not a url", fastOptions));
});

test("pages analyzed as part of a crawl report site-wide-performance-patterns as verified, not not_applicable", async () => {
  const { pages } = await crawlSite(`${origin}/site/contact`, { ...fastOptions, maxPages: 1, maxDepth: 0 });
  const seedResult = pages.find((p) => p.status === "analyzed")!;
  const entry = seedResult.report!.performanceVerification.find((e) => e.area === "site-wide-performance-patterns")!;
  assert.equal(entry.state, "verified");
});

test("performanceProvider is passed through to every page's analysis", async () => {
  let calls = 0;
  const fakeProvider: PerformanceProvider = {
    name: "fake",
    analyze: async () => {
      calls++;
      return { status: "available", evidence: null };
    },
  };
  await crawlSite(`${origin}/site/home`, { ...fastOptions, maxPages: 3, maxDepth: 1, respectRobots: false, useSitemap: false, performanceProvider: fakeProvider });
  assert.ok(calls >= 1);
});
