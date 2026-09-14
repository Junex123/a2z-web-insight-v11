import { randomUUID } from "node:crypto";
import { crawlSite, type CrawlSiteRunOptions } from "./crawler/crawler.js";
import { buildCategorySummaries, detectSiteWideFindings } from "./analysis/siteWideFindings.js";
import { buildSiteWidePerformanceOpportunities, buildSiteWideRootCauseChains } from "./analysis/performanceOpportunities.js";
import type { SiteAnalysisReport } from "./types.js";
import { aggregateSiteTechnology } from "./technology/site/coverage.js";

/**
 * Full CRAWL -> ANALYZE (per page, via pipeline.ts) -> AGGREGATE
 * pipeline for an entire site, mirroring pipeline.ts's role for a
 * single page. Throws CollectorError only for a genuinely invalid seed
 * URL (same as analyzeUrl()) - once the seed URL itself is valid,
 * every per-page failure is isolated and represented in the returned
 * report rather than thrown (see crawler/crawler.ts).
 */
export async function analyzeSite(seedUrl: string, options: CrawlSiteRunOptions = {}): Promise<SiteAnalysisReport> {
  const { options: crawlOptions, pages, stats } = await crawlSite(seedUrl, options);
  const siteWideFindings = detectSiteWideFindings(pages);

  return {
    siteReportId: randomUUID(),
    seedUrl: stats.seedUrl,
    scannedAt: stats.finishedAt,
    crawlOptions,
    stats,
    pages,
    siteWideFindings,
    sitePerformanceOpportunities: buildSiteWidePerformanceOpportunities(siteWideFindings),
    siteWideRootCauseChains: buildSiteWideRootCauseChains(siteWideFindings),
    categorySummaries: buildCategorySummaries(pages),
    siteTechnology: aggregateSiteTechnology(
      pages
        .filter((p) => p.status === "analyzed" && !!p.report?.technology)
        .map((p) => ({ url: p.url, intelligence: p.report!.technology! })),
    ),
  };
}
