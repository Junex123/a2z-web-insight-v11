import type {
  AccessibilityCoverage,
  AnalysisReport,
  Category,
  CoreWebVitalsReport,
  Issue,
  ProviderStatus,
  ScanStatus,
  Severity,
} from "../../src/types.js";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function resetFixtureIdCounter() {
  idCounter = 0;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 70, medium: 40, low: 15 };

export function makeIssue(overrides: Partial<Issue> & Pick<Issue, "category" | "title" | "severity">): Issue {
  return {
    id: nextId(overrides.category),
    affected: "https://example.com/",
    whyItMatters: "test fixture issue",
    recommendedFix: "fix it",
    difficulty: "easy",
    priorityScore: SEVERITY_WEIGHT[overrides.severity],
    source: "measured",
    evidence: [],
    ...overrides,
  };
}

const DEFAULT_ACCESSIBILITY_COVERAGE: AccessibilityCoverage = {
  checkedAreas: ["headings", "images", "forms", "aria"],
  notVerifiable: ["color contrast", "keyboard trap detection", "focus order correctness"],
};

const DEFAULT_CWV: CoreWebVitalsReport = {
  providerName: "test-provider",
  providerStatus: "available",
  evidence: null,
  factors: [],
  cached: false,
};

/**
 * Builds a minimal, valid `Omit<AnalysisReport, "launchDecision">` fixture
 * (the exact input `evaluateLaunchDecision()` takes) with sensible
 * defaults, so each test only needs to override what it cares about.
 * Scores/issueCounts are NOT auto-derived from `allIssues` here on
 * purpose - most tests only care about `allIssues`/`categoriesAnalyzed`/
 * `status`/`coreWebVitals`, which is everything the policy actually
 * reads (see launchDecision.ts's `ReportInput`).
 */
export function makeReportInput(overrides: {
  allIssues?: Issue[];
  categoriesAnalyzed?: Category[];
  categoriesNotYetAnalyzed?: string[];
  status?: ScanStatus;
  providerStatus?: ProviderStatus;
  accessibilityCoverage?: AccessibilityCoverage;
} = {}): Omit<AnalysisReport, "launchDecision"> {
  const allIssues = overrides.allIssues ?? [];
  return {
    reportId: "test-report",
    url: "https://example.com/",
    scannedAt: new Date(0).toISOString(),
    status: overrides.status ?? "success",
    scores: { performance: 100, seo: 100, security: 100, accessibility: 100, ux: 100, responsiveness: 100, overall: 100 },
    categoriesAnalyzed: overrides.categoriesAnalyzed ?? ["performance", "seo", "security", "accessibility"],
    categoriesNotYetAnalyzed: overrides.categoriesNotYetAnalyzed ?? ["content", "ux"],
    issueCounts: {
      critical: allIssues.filter((i) => i.severity === "critical").length,
      high: allIssues.filter((i) => i.severity === "high").length,
      medium: allIssues.filter((i) => i.severity === "medium").length,
      low: allIssues.filter((i) => i.severity === "low").length,
      total: allIssues.length,
    },
    topPriorityIssues: allIssues.slice(0, 5),
    allIssues,
    coreWebVitals: { ...DEFAULT_CWV, providerStatus: overrides.providerStatus ?? "available" },
    fetchQuality: "usable",
    accessibilityCoverage: overrides.accessibilityCoverage ?? DEFAULT_ACCESSIBILITY_COVERAGE,
    responsiveVerification: { mobile: { passed: 0, warnings: 0, failures: 0, unverified: 0 }, desktop: { passed: 0, warnings: 0, failures: 0, unverified: 0 }, checks: [] },
    evidenceLog: {
      fetch: {
        requestedUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        statusCode: 200,
        httpsUsed: true,
        redirected: false,
        redirectCount: 0,
        timing: { approxTtfbMs: 100, totalDownloadMs: 200 },
        headers: {},
        bodyBytes: 1000,
        contentType: "text/html",
        fetchedAt: new Date(0).toISOString(),
      },
      html: {
        title: "Example",
        titleLength: 7,
        titleCount: 1,
        metaDescription: "desc",
        metaDescriptionLength: 4,
        metaDescriptionCount: 1,
        h1Count: 1,
        h1Texts: ["Example"],
        rawH1Count: 1,
        canonicalUrl: "https://example.com/",
        canonicalCount: 1,
        canonicalEmpty: false,
        robotsMeta: null,
        robotsMetaCount: 0,
        robotsMetaValues: [],
        hasViewportMeta: true,
        hasCharsetMeta: true,
        openGraph: { title: true, description: true, image: true, url: true },
        twitterCardPresent: true,
        structuredData: { totalBlocks: 0, malformedBlocks: 0, duplicateBlocks: 0 },
        images: { total: 0, missingAlt: 0, missingDimensions: 0, missingLazyLoading: 0, missingResponsiveSrcset: 0 },
        scripts: { total: 0, blockingInHead: 0, asyncOrDefer: 0 },
        stylesheets: { total: 0, blockingInHead: 0 },
        thirdPartyResources: [],
        insecureResourceRefs: [],
      },
      accessibility: {
        hasHtmlLangAttr: true,
        htmlLangValue: "en",
        viewportContent: "width=device-width, initial-scale=1",
        viewportDisablesZoom: false,
        headingOutline: [{ level: 1, text: "Example" }],
        images: { total: 0, noAltAttribute: 0, emptyAlt: 0, suspiciousDecorative: 0 },
        formControls: { total: 0, unlabeled: 0, unlabeledExamples: [] },
        buttons: { total: 0, withoutAccessibleName: 0, examples: [] },
        links: { total: 0, withoutAccessibleName: 0, examples: [] },
        duplicateIds: [],
        brokenAriaRefs: [],
        invalidAriaRoles: [],
        iframes: { total: 0, missingTitle: 0 },
        tables: { total: 0, withoutHeaders: 0 },
        autoplayMedia: { total: 0, withoutControl: 0 },
        clickableNonInteractive: { count: 0, examples: [] },
        positiveTabindex: { count: 0, examples: [] },
      },
      seo: {} as any,
      security: {} as any,
      ux: {} as any,
      responsive: {} as any,
    },
  };
}
