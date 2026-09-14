import { randomUUID } from "node:crypto";
import { collectHtml } from "./collectors/htmlCollector.js";
import { collectHttp } from "./collectors/httpCollector.js";
import { collectAccessibility } from "./collectors/accessibilityCollector.js";
import { collectUx } from "./collectors/uxCollector.js";
import { collectResponsive } from "./collectors/responsiveCollector.js";
import { collectSecurity, type CollectSecurityOptions } from "./collectors/securityCollector.js";
import { collectRuntime, type CollectRuntimeOptions } from "./collectors/browserCollector.js";
import { collectSeoExtras } from "./collectors/seoCollector.js";
import { fetchRobotsTxt, UNAVAILABLE_ROBOTS } from "./collectors/robotsCollector.js";
import { fetchSitemap } from "./collectors/sitemapCollector.js";
import { collectResourceIntelligence } from "./collectors/resourceProbe.js";
import { collectTechnologyIntelligence } from "./collectors/technologyCollector.js";
import { detectIssues } from "./analysis/issues.js";
import { detectAdvancedSeoIssues } from "./analysis/seoIssues.js";
import { detectAiGeneratedSeoFailures } from "./analysis/aiGeneratedSeoIssues.js";
import { buildSeoVerificationSummary } from "./analysis/seoVerification.js";
import { buildAccessibilityCoverage, detectAccessibilityIssues } from "./analysis/accessibilityIssues.js";
import { detectAdvancedSecurityIssues } from "./analysis/securityIssues.js";
import { detectUxIssues } from "./analysis/uxIssues.js";
import { detectCrawlabilityIssues } from "./analysis/robotsIssues.js";
import { buildResponsiveVerification, detectResponsiveIssues } from "./analysis/responsiveIssues.js";
import { detectRuntimeFindings } from "./analysis/runtimeFindings.js";
import { computeLaunchReadiness } from "./analysis/launchReadiness.js";
import { classifyFetchQuality } from "./analysis/fetchQuality.js";
import { buildPerformanceFactors, detectCwvIssues, detectPageSpeedOpportunityIssues } from "./analysis/cwvIssues.js";
import { detectResourceIssues } from "./analysis/resourceIssues.js";
import { detectHtmlPerformanceIssues } from "./analysis/htmlPerformanceIssues.js";
import { buildPerformanceOpportunities, buildPerformanceRootCauseChains } from "./analysis/performanceOpportunities.js";
import { buildPerformanceVerificationSummary } from "./analysis/performanceVerification.js";
import { prioritize, scoreAll } from "./analysis/scorer.js";
import { PageSpeedProvider } from "./providers/pageSpeedProvider.js";
import { CachingPerformanceProvider } from "./providers/cachingPerformanceProvider.js";
import { InMemoryCache } from "./cache/cache.js";
import { logEvent } from "./logging/logger.js";
import { evaluateLaunchDecision } from "./analysis/launchDecision.js";
import type { AnalysisReport, PerformanceProvider, PerformanceProviderResult, SitemapAnalysis, SecurityAnalysis } from "./types.js";

const NOT_YET_ANALYZED = ["content", "business", "competitor-intelligence", "search-visibility"];

const DEFAULT_PAGESPEED_CACHE_TTL_MS = (Number(process.env.PAGESPEED_CACHE_TTL) || 300) * 1000; // default 5 min

// Process-wide cache + provider instance. One cache shared by every scan
// in this process is exactly the point - a second scan of the same URL
// should hit it. Built lazily so tests that always inject their own
// provider never pay for constructing a real PageSpeedProvider.
let sharedCachingProvider: CachingPerformanceProvider | undefined;
function getDefaultPerformanceProvider(): PerformanceProvider {
  if (!sharedCachingProvider) {
    sharedCachingProvider = new CachingPerformanceProvider(
      new PageSpeedProvider(),
      new InMemoryCache<PerformanceProviderResult>(),
      { ttlMs: DEFAULT_PAGESPEED_CACHE_TTL_MS },
    );
  }
  return sharedCachingProvider;
}

export interface AnalyzeUrlOptions {
  /** injectable for tests; defaults to a shared, caching PageSpeedProvider reading env vars */
  performanceProvider?: PerformanceProvider;
  /** injectable for tests - overrides the target-fetch timeout */
  targetFetchTimeoutMs?: number;
  securityCollectorOptions?: CollectSecurityOptions;
  isPartOfSiteWideScan?: boolean;
  includeBrowserVerification?: boolean;
  browserVerificationOptions?: CollectRuntimeOptions;
}

/**
 * Full SCAN -> MEASURE -> NORMALIZE -> ANALYZE -> PRIORITIZE pipeline
 * for a single URL. Throws CollectorError (see httpCollector) on
 * invalid/unreachable/blocked targets - callers should catch and map
 * to an HTTP error response. A thrown CollectorError means no report
 * could be built at all (the "failed" scan case); once past that point,
 * this function always returns a complete report.
 *
 * The Core Web Vitals provider call is deliberately isolated: if it
 * fails for ANY reason, the rest of the scan still completes and
 * returns a full report with status "partial" instead of throwing.
 */
export async function analyzeUrl(rawUrl: string, options: AnalyzeUrlOptions = {}): Promise<AnalysisReport> {
  const reportId = randomUUID();
  const performanceProvider = options.performanceProvider ?? getDefaultPerformanceProvider();
  const startedAt = Date.now();

  logEvent("scan_started", { reportId, url: rawUrl });

  let fetchResult;
  try {
    fetchResult = await collectHttp(rawUrl, { timeoutMs: options.targetFetchTimeoutMs });
  } catch (err) {
    logEvent("scan_failed", {
      reportId,
      url: rawUrl,
      reason: err instanceof Error ? err.message : "unknown error",
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }

  const html = collectHtml(fetchResult.bodyText, fetchResult.httpsUsed, fetchResult.finalUrl);
  const fetchQuality = classifyFetchQuality(fetchResult, html);
  const accessibility = collectAccessibility(fetchResult.bodyText);
  const ux = collectUx(fetchResult.bodyText);
  const seo = collectSeoExtras(fetchResult.bodyText, fetchResult.finalUrl, fetchResult.headers);

  const providerResult = await safeAnalyzePerformance(performanceProvider, fetchResult.finalUrl);
  const robotsTxt = await safeFetchRobotsTxt(fetchResult.finalUrl);
  const sitemap = await safeFetchSitemap(fetchResult.finalUrl, robotsTxt);
  const resourceIntelligence = await safeCollectResourceIntelligence(fetchResult.bodyText, fetchResult.finalUrl);
  const security = await safeCollectSecurity(fetchResult, options.securityCollectorOptions);
  const runtimeVerification = options.includeBrowserVerification
    ? await safeCollectRuntime(fetchResult.finalUrl, { ...(options.browserVerificationOptions ?? {}), rawHtmlForComparison: fetchResult.bodyText })
    : undefined;
  const responsive = await safeCollectResponsive(fetchResult.bodyText, fetchResult.finalUrl);
  const technology = collectTechnologyIntelligence(fetchResult, runtimeVerification?.evidence, resourceIntelligence, robotsTxt);

  const httpIssues = detectIssues(fetchResult, html);
  const cwvIssues = providerResult.evidence ? detectCwvIssues(providerResult.evidence, fetchResult.finalUrl, resourceIntelligence) : [];
  const pageSpeedOpportunityIssues = providerResult.evidence ? detectPageSpeedOpportunityIssues(providerResult.evidence, fetchResult.finalUrl) : [];
  const alreadyExplainedImageUrls = new Set<string>();
  const lcpImageUrl = providerResult.evidence?.lcpElement?.imageUrl;
  if (lcpImageUrl) {
    try {
      alreadyExplainedImageUrls.add(new URL(lcpImageUrl, fetchResult.finalUrl).href);
    } catch {
      // Keep the evidence conservative: an unresolvable LCP image is not excluded.
    }
  }
  const resourceIssues = detectResourceIssues(resourceIntelligence, fetchResult.bodyText, fetchResult.finalUrl, alreadyExplainedImageUrls);
  const htmlPerformanceIssues = detectHtmlPerformanceIssues(html, fetchResult.finalUrl);
  const accessibilityIssues = detectAccessibilityIssues(accessibility, fetchResult.finalUrl);
  const advancedSeoIssues = detectAdvancedSeoIssues(fetchResult, html, seo, robotsTxt.available ? robotsTxt : null);
  const aiGeneratedSeoIssues = detectAiGeneratedSeoFailures(fetchResult, html, seo, robotsTxt.available ? robotsTxt : null, sitemap.available ? sitemap : null);
  const advancedSecurityIssues = detectAdvancedSecurityIssues(security, fetchResult.finalUrl);
  const responsiveIssues = detectResponsiveIssues(responsive, fetchResult.finalUrl);
  const uxIssues = detectUxIssues(ux, fetchResult.finalUrl);
  const crawlabilityIssues = detectCrawlabilityIssues(robotsTxt, sitemap, fetchResult.finalUrl);
  const issues = [
    ...httpIssues,
    ...cwvIssues,
    ...pageSpeedOpportunityIssues,
    ...resourceIssues,
    ...htmlPerformanceIssues,
    ...accessibilityIssues,
    ...advancedSeoIssues,
    ...aiGeneratedSeoIssues,
    ...advancedSecurityIssues,
    ...uxIssues,
    ...responsiveIssues,
    ...crawlabilityIssues,
  ];

  const { categoryScores, overall } = scoreAll(issues);
  const topPriorityIssues = prioritize(issues, 5);
  const performanceOpportunities = buildPerformanceOpportunities(issues);
  const performanceRootCauseChains = buildPerformanceRootCauseChains(issues);

  const issueCounts = {
    critical: issues.filter((i) => i.severity === "critical").length,
    high: issues.filter((i) => i.severity === "high").length,
    medium: issues.filter((i) => i.severity === "medium").length,
    low: issues.filter((i) => i.severity === "low").length,
    total: issues.length,
  };

  const { bodyText, setCookieHeaders, ...fetchWithoutBody } = fetchResult;

  const scanStatus = providerResult.status === "available" ? "success" : "partial";

  const reportWithoutLaunchDecision: Omit<AnalysisReport, "launchDecision" | "launchReadiness"> = {
    reportId,
    url: fetchResult.finalUrl,
    scannedAt: fetchResult.fetchedAt,
    status: scanStatus,
    scores: {
      performance: categoryScores.find((c) => c.category === "performance")!.score,
      seo: categoryScores.find((c) => c.category === "seo")!.score,
      security: categoryScores.find((c) => c.category === "security")!.score,
      accessibility: categoryScores.find((c) => c.category === "accessibility")!.score,
      ux: categoryScores.find((c) => c.category === "ux")!.score,
      responsiveness: categoryScores.find((c) => c.category === "responsiveness")!.score,
      overall,
    },
    categoriesAnalyzed: ["performance", "seo", "security", "accessibility", "ux", "responsiveness"],
    categoriesNotYetAnalyzed: NOT_YET_ANALYZED,
    issueCounts,
    topPriorityIssues,
    allIssues: issues,
    coreWebVitals: {
      providerName: performanceProvider.name,
      providerStatus: providerResult.status,
      errorMessage: providerResult.errorMessage,
      evidence: providerResult.evidence,
      factors: buildPerformanceFactors(providerResult.evidence),
      cached: providerResult.cache?.hit ?? false,
      cacheAgeMs: providerResult.cache?.hit ? providerResult.cache.ageMs : undefined,
    },
    accessibilityCoverage: buildAccessibilityCoverage(),
    robotsTxt,
    sitemap,
    seoVerification: buildSeoVerificationSummary(html, seo, robotsTxt, sitemap),
    resourceIntelligence,
    performanceVerification: buildPerformanceVerificationSummary(providerResult, resourceIntelligence),
    fetchQuality,
    runtimeVerification,
    responsiveVerification: buildResponsiveVerification(responsive),
    technology,
    performanceOpportunities,
    performanceRootCauseChains,
    evidenceLog: {
      fetch: fetchWithoutBody,
      html,
      accessibility,
      seo,
      security,
      ux,
      responsive,
    },
  };

  const report: AnalysisReport = {
    ...reportWithoutLaunchDecision,
    launchDecision: evaluateLaunchDecision(reportWithoutLaunchDecision),
    launchReadiness: computeLaunchReadiness({
      allIssues: issues,
      coreWebVitals: reportWithoutLaunchDecision.coreWebVitals,
      runtimeVerification,
      accessibilityCoverage: reportWithoutLaunchDecision.accessibilityCoverage,
      fetchQuality,
    }),
  };

  logEvent("scan_completed", {
    reportId,
    url: report.url,
    status: report.status,
    durationMs: Date.now() - startedAt,
    overallScore: report.scores.overall,
  });

  return report;
}

/**
 * Belt-and-suspenders: PageSpeedProvider (and the caching decorator)
 * already catch their own errors and return a status object instead of
 * throwing, but if a future provider implementation (or an unexpected
 * bug) throws anyway, we still must not let that take down the whole scan.
 */
async function safeAnalyzePerformance(provider: PerformanceProvider, url: string): Promise<PerformanceProviderResult> {
  try {
    return await provider.analyze(url);
  } catch {
    return {
      status: "error",
      evidence: null,
      errorMessage: "The performance provider failed unexpectedly.",
    };
  }
}

/**
 * robots.txt is a best-effort, non-critical fetch (most sites don't even
 * have one) - it must never fail the whole scan. fetchRobotsTxt() already
 * resolves to `available: false` on any failure, but this wrapper is a
 * final safety net matching safeAnalyzePerformance's pattern above.
 */
async function safeFetchRobotsTxt(pageUrl: string): Promise<import("./types.js").RobotsTxtAnalysis> {
  try {
    return await fetchRobotsTxt(pageUrl);
  } catch {
    return UNAVAILABLE_ROBOTS;
  }
}

const UNAVAILABLE_SITEMAP: SitemapAnalysis = {
  fetched: false,
  available: false,
  sitemapUrl: null,
  isSitemapIndex: false,
  childSitemapUrls: [],
  urls: [],
  malformedUrlCount: 0,
  duplicateUrlCount: 0,
  parseError: null,
};

/**
 * Best-effort sitemap fetch: uses robots.txt's declared Sitemap: URL if
 * one was found, otherwise falls back to a single conventional
 * "/sitemap.xml" guess. This is NOT a crawl or discovery process - it
 * tries exactly one URL - so a miss here means "not found at the one
 * place we checked," not "confirmed absent" (see analysis/
 * seoVerification.ts, which reports this distinction explicitly rather
 * than treating a miss as a pass). Never throws; sitemap absence is
 * normal, not a scan failure.
 */
async function safeFetchSitemap(pageUrl: string, robots: import("./types.js").RobotsTxtAnalysis): Promise<SitemapAnalysis> {
  try {
    const declared = robots.available ? robots.sitemapUrls[0] : undefined;
    const candidate = declared ?? `${new URL(pageUrl).origin}/sitemap.xml`;
    return await fetchSitemap(candidate);
  } catch {
    return UNAVAILABLE_SITEMAP;
  }
}

const EMPTY_RESOURCE_INTELLIGENCE: import("./types.js").ResourceIntelligence = {
  entries: [],
  totalsByKind: {
    script: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    stylesheet: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    image: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    font: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    other: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
  },
  thirdParty: { originCount: 0, requestCount: 0, knownBytes: 0, origins: [] },
  truncated: false,
  candidateCount: 0,
  probedCount: 0,
};

/**
 * Sub-resource probing (collectors/resourceProbe.ts) makes real, bounded
 * network calls of its own - same "never let this take down the whole
 * scan" treatment as the performance provider and robots.txt/sitemap
 * fetches above, even though the collector itself is already designed
 * not to throw on individual resource failures.
 */
async function safeCollectRuntime(rawUrl: string, options: CollectRuntimeOptions): Promise<import("./types.js").RuntimeVerificationReport> {
  try {
    const evidence = await collectRuntime(rawUrl, options);
    return { status: "completed", evidence, findings: detectRuntimeFindings(evidence) };
  } catch (err) {
    return { status: "error", errorMessage: err instanceof Error ? err.message : "Browser verification failed.", evidence: null, findings: [] };
  }
}

async function safeCollectSecurity(fetchResult: Parameters<typeof collectSecurity>[0], options?: CollectSecurityOptions): Promise<SecurityAnalysis> {
  try {
    return await collectSecurity(fetchResult, options);
  } catch {
    return {
      csp: { present: false, raw: null, weaknesses: [] },
      clickjacking: { protected: false, hasXFrameOptions: false, hasCspFrameAncestors: false, conflicting: false },
      mixedContent: [],
      cookies: { observed: false, findings: [] },
      cors: { probeStatus: "error" as const, allowOriginHeader: null, allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false },
      infoDisclosure: { probeStatus: "error" as const, checkedPaths: 0, findings: [] },
      debugExposure: { indicators: [] },
      redirectSecurity: { hostChain: [], crossHostRedirect: false, httpProbe: { status: "unreachable" as const, redirectsToHttps: null } },
      crossOriginPolicies: { coop: null, corp: null, coep: null },
      permissionsPolicy: { present: false, raw: null, wildcardFeatures: [] },
      secretExposure: { probeStatus: "error" as const, scannedLocations: 0, findings: [] },
      devUrlExposure: { findings: [] },
      httpMethods: { probeStatus: "error" as const, allowedMethods: [], riskyMethodsExposed: [] },
      hsts: { present: false, raw: null, maxAgeSeconds: null, includesSubDomains: false, maxAgeTooShort: false },
      referrerPolicy: { raw: null, weak: false },
      insecureFormSubmission: { findings: [] },
      tlsCertificate: { probeStatus: "error" as const, protocol: null, cipherName: null, authorized: null, authorizationError: null, validTo: null, daysUntilExpiry: null },
      caaRecords: { probeStatus: "error" as const, present: false, records: [] },
      subresourceIntegrity: { findings: [] },
      reverseTabnabbing: { findings: [] },
      verification: {
        https: "unverified",
        headers: "unverified",
        csp: "unverified",
        clickjacking: "unverified",
        cookies: "unverified",
        cors: "unverified",
        infoDisclosure: "unverified",
        debugExposure: "unverified",
        redirectSecurity: "unverified",
        crossOriginPolicies: "unverified",
        secretExposure: "unverified",
        devUrlExposure: "unverified",
        permissionsPolicy: "unverified",
        httpMethods: "unverified",
        hsts: "unverified",
        referrerPolicy: "unverified",
        insecureFormSubmission: "unverified",
        tlsCertificate: "unverified",
        caaRecords: "unverified",
        subresourceIntegrity: "unverified",
      },
    };
  }
}

async function safeCollectResponsive(bodyText: string, pageUrl: string): Promise<import("./types.js").ResponsiveAnalysis> {
  try {
    return await collectResponsive(bodyText, pageUrl);
  } catch {
    return {
      viewport: { present: false, content: null, hasDeviceWidthToken: false, hasFixedNumericWidth: false, fixedWidthValue: null, disablesZoom: false },
      css: { inspected: false, sources: [], externalStylesheetsSkipped: 0, mediaQueryCount: 0, distinctBreakpointValues: [], fixedWidthDeclarations: [], viewportUnitFullWidthCount: 0, fixedPositionRuleCount: 0, hasResponsiveImagePattern: false },
      images: { total: 0, withSrcsetOrSizes: 0, largeStaticWidthExamples: [] },
      navigation: { navElementCount: 0, duplicateNavRisk: false, largestMenuLinkCount: 0, emptyControlCount: 0 },
    };
  }
}

async function safeCollectResourceIntelligence(bodyText: string, pageUrl: string): Promise<import("./types.js").ResourceIntelligence> {
  try {
    return await collectResourceIntelligence(bodyText, pageUrl);
  } catch {
    return EMPTY_RESOURCE_INTELLIGENCE;
  }
}
