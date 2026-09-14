import { analyzeUrl } from "../pipeline.js";
import { CollectorError } from "../collectors/httpCollector.js";
import { normalizeCrawlUrl } from "../cache/urlNormalize.js";
import { isAllowedByRobots, loadRobotsPolicy } from "./robots.js";
import { discoverSitemapUrls } from "./sitemap.js";
import type { CrawlOptions, CrawlStats, PageCrawlResult, PerformanceProvider } from "../types.js";

/**
 * SITE-WIDE CRAWLER ARCHITECTURE
 * ==============================
 *
 * This module does ONE thing: given a seed URL, discover and analyze
 * up to `maxPages` same-origin pages, breadth-first, and return a flat
 * list of what happened to every URL it became aware of. It does NOT
 * duplicate any collector or analysis rule - every single page is
 * analyzed via the exact same analyzeUrl() a single-page scan uses, so
 * SEO/security/accessibility/performance evidence for a crawled page
 * is byte-for-byte identical to what /api/analyze would produce for
 * that same URL in isolation. If a future agent adds a new collector
 * or rule to analyzeUrl(), the crawler picks it up automatically with
 * zero changes here.
 *
 * FLOW (per wave, one wave per crawl depth):
 *   1. Take the current wave's candidate URLs, dedup against `visited`.
 *   2. Check robots.txt for each (except the seed, which is always
 *      attempted - the user explicitly asked for that exact URL).
 *   3. Cap the remaining candidates to the remaining page budget;
 *      anything over budget is recorded as skipped_page_limit.
 *   4. Analyze the batch with bounded concurrency (mapWithConcurrency).
 *   5. Extract each analyzed page's already-computed same-origin
 *      internal links (HtmlAnalysis.internalLinks, computed once
 *      inside collectHtml during that same analyzeUrl() call - NOT a
 *      second fetch) to build the next wave.
 *   6. If this was the last permitted depth, record newly-found links
 *      as skipped_depth_limit instead of expanding further.
 *
 * WHAT "SAME-ORIGIN BY DEFAULT" ACTUALLY MEANS HERE: HtmlAnalysis.
 * internalLinks (see collectors/htmlCollector.ts) only ever contains
 * links whose origin matches the PAGE'S OWN origin. Since every
 * crawled page is itself same-origin-as-seed (this module never
 * enqueues a cross-origin URL to begin with), external links are
 * filtered out at the source and never become crawl candidates at
 * all - there is no separate "we found it but rejected it" step to
 * observe, which is why CrawlStats.pagesSkippedExternal is currently
 * always 0 (kept in the contract for a future configurable-origin
 * mode, not fabricated as nonzero today).
 *
 * DUPLICATE HANDLING: a URL is only ever recorded once in the
 * returned `pages` list. Every subsequent discovery of an
 * already-visited URL increments CrawlStats.pagesSkippedDuplicate but
 * does not add a second entry - the first (real) outcome for that URL
 * is the only one that matters.
 */

export const DEFAULT_CRAWL_OPTIONS: CrawlOptions = {
  maxPages: 25,
  maxDepth: 3,
  concurrency: 3,
  requestTimeoutMs: 10_000,
  respectRobots: true,
  useSitemap: true,
};

export interface CrawlSiteRunOptions extends Partial<CrawlOptions> {
  /** passed through to every analyzeUrl() call, same as a single-page scan */
  performanceProvider?: PerformanceProvider;
}

export interface CrawlSiteResult {
  options: CrawlOptions;
  pages: PageCrawlResult[];
  stats: CrawlStats;
}

interface FrontierItem {
  url: string;
  depth: number;
  discoveredFrom: string | null;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. Order of results matches `items`. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function crawlSite(seedUrl: string, runOptions: CrawlSiteRunOptions = {}): Promise<CrawlSiteResult> {
  const { performanceProvider, ...overrides } = runOptions;
  const options: CrawlOptions = { ...DEFAULT_CRAWL_OPTIONS, ...overrides };
  const startedAt = new Date();

  // Let an invalid seed URL throw here, same as analyzeUrl() would for
  // a single-page scan - the route layer already knows how to turn
  // that into a 400. Everything past this point is error-isolated.
  const seedNormalized = normalizeCrawlUrl(seedUrl);
  const seedOrigin = new URL(seedNormalized).origin;

  const robotsPolicy = await loadRobotsPolicy(seedOrigin, options.respectRobots, { timeoutMs: options.requestTimeoutMs });

  const pages: PageCrawlResult[] = [];
  const visited = new Set<string>();
  let pagesAnalyzed = 0;
  let pagesFailed = 0;
  let pagesSkippedRobots = 0;
  let pagesSkippedDuplicate = 0;
  let pagesSkippedDepthLimit = 0;
  let pagesSkippedPageLimit = 0;
  let pagesSkippedNonHtml = 0;
  let maxDepthReached = 0;

  // Sitemap-discovered URLs are treated as depth-1 candidates (one
  // conceptual hop from the site root via the sitemap, not literally
  // linked from the seed page) - collected up front, merged into the
  // frontier once the seed (depth 0) wave has been processed.
  let sitemapSeededUrls: string[] = [];
  if (options.useSitemap && options.maxDepth >= 1 && robotsPolicy.sitemapUrls.length > 0) {
    const seen = new Set<string>();
    for (const sitemapUrl of robotsPolicy.sitemapUrls.slice(0, 3)) {
      // bounded: at most 3 sitemap files inspected, no recursive sitemap-index expansion - see sitemap.ts
      const found = await discoverSitemapUrls(sitemapUrl, seedOrigin, { timeoutMs: options.requestTimeoutMs });
      for (const u of found) seen.add(u);
    }
    sitemapSeededUrls = [...seen];
  }

  let frontier: FrontierItem[] = [{ url: seedNormalized, depth: 0, discoveredFrom: null }];
  let depth = 0;

  while (frontier.length > 0 && depth <= options.maxDepth && pagesAnalyzed < options.maxPages) {
    // De-dup this wave against everything already visited. The seed's
    // very first occurrence (wave 0, `visited` still empty) always
    // passes through here uniformly with everything else - any LATER
    // rediscovery of the same URL (including the seed itself via a
    // self-link, e.g. a trailing-slash variant linking back to it) is
    // correctly caught as a duplicate instead of being re-analyzed.
    const waveCandidates: FrontierItem[] = [];
    for (const item of frontier) {
      if (visited.has(item.url)) {
        pagesSkippedDuplicate++;
        continue;
      }
      visited.add(item.url);
      waveCandidates.push(item);
    }
    if (waveCandidates.length === 0) break;
    maxDepthReached = Math.max(maxDepthReached, depth);

    // robots.txt - the seed is always attempted regardless of policy status.
    const toFetch: FrontierItem[] = [];
    for (const item of waveCandidates) {
      const isSeed = item.url === seedNormalized;
      const path = new URL(item.url).pathname;
      if (!isSeed && !isAllowedByRobots(robotsPolicy, path)) {
        pages.push({ url: item.url, depth: item.depth, status: "skipped_robots", report: null, errorMessage: null, discoveredFrom: item.discoveredFrom });
        pagesSkippedRobots++;
        continue;
      }
      toFetch.push(item);
    }

    // page budget
    const remainingBudget = Math.max(0, options.maxPages - pagesAnalyzed);
    const batch = toFetch.slice(0, remainingBudget);
    for (const item of toFetch.slice(batch.length)) {
      pages.push({ url: item.url, depth: item.depth, status: "skipped_page_limit", report: null, errorMessage: null, discoveredFrom: item.discoveredFrom });
      pagesSkippedPageLimit++;
    }

    const batchResults = await mapWithConcurrency(batch, options.concurrency, async (item) => {
      try {
        const report = await analyzeUrl(item.url, { performanceProvider, targetFetchTimeoutMs: options.requestTimeoutMs, isPartOfSiteWideScan: true });
        return { item, report, errorMessage: null as string | null, nonHtml: false };
      } catch (err) {
        const nonHtml = err instanceof CollectorError && err.code === "NON_HTML";
        return { item, report: null, errorMessage: err instanceof Error ? err.message : "Unknown error during crawl", nonHtml };
      }
    });

    let nextFrontier: FrontierItem[] = [];
    for (const { item, report, errorMessage, nonHtml } of batchResults) {
      if (report) {
        pages.push({ url: item.url, depth: item.depth, status: "analyzed", report, errorMessage: null, discoveredFrom: item.discoveredFrom });
        pagesAnalyzed++;
        for (const link of report.evidenceLog.html.internalLinks ?? []) {
          nextFrontier.push({ url: link, depth: item.depth + 1, discoveredFrom: item.url });
        }
      } else if (nonHtml) {
        pages.push({ url: item.url, depth: item.depth, status: "skipped_non_html", report: null, errorMessage, discoveredFrom: item.discoveredFrom });
        pagesSkippedNonHtml++;
      } else {
        pages.push({ url: item.url, depth: item.depth, status: "failed", report: null, errorMessage, discoveredFrom: item.discoveredFrom });
        pagesFailed++;
      }
    }

    // merge the sitemap-seeded URLs in as soon as we're about to move to depth 1
    if (depth === 0 && sitemapSeededUrls.length > 0) {
      for (const u of sitemapSeededUrls) {
        if (!visited.has(u)) nextFrontier.push({ url: u, depth: 1, discoveredFrom: null });
      }
    }

    if (depth === options.maxDepth) {
      for (const nf of nextFrontier) {
        if (!visited.has(nf.url)) {
          visited.add(nf.url);
          pages.push({ url: nf.url, depth: nf.depth, status: "skipped_depth_limit", report: null, errorMessage: null, discoveredFrom: nf.discoveredFrom });
          pagesSkippedDepthLimit++;
        }
      }
      break;
    }
    if (pagesAnalyzed >= options.maxPages) {
      for (const nf of nextFrontier) {
        if (!visited.has(nf.url)) {
          visited.add(nf.url);
          pages.push({ url: nf.url, depth: nf.depth, status: "skipped_page_limit", report: null, errorMessage: null, discoveredFrom: nf.discoveredFrom });
          pagesSkippedPageLimit++;
        }
      }
      break;
    }

    frontier = nextFrontier;
    depth++;
  }

  const finishedAt = new Date();
  const stats: CrawlStats = {
    seedUrl: seedNormalized,
    pagesDiscovered: pages.length,
    pagesAnalyzed,
    pagesFailed,
    pagesSkippedRobots,
    pagesSkippedDuplicate,
    pagesSkippedDepthLimit,
    pagesSkippedPageLimit,
    pagesSkippedNonHtml,
    pagesSkippedExternal: 0, // see module doc comment
    maxDepthReached,
    robotsTxtStatus: robotsPolicy.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  return { options, pages, stats };
}
