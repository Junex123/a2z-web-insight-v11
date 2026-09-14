/**
 * Shared data contracts for the A-to-Z Web Insight measurement pipeline.
 *
 * Pipeline: SCAN -> MEASURE -> NORMALIZE -> ANALYZE -> PRIORITIZE
 *
 * IMPORTANT: every numeric field below is either directly MEASURED
 * (from an HTTP response or parsed HTML) or DERIVED via a documented,
 * deterministic formula from measured data. Nothing here is produced by
 * an LLM. See analysis/scorer.ts and analysis/issues.ts for the rules.
 */

import type { TechnologyIntelligence } from "./technology/types.js";

export type DataSource = "measured" | "derived" | "estimated";

export interface Evidence {
  /** where this evidence came from */
  type: "header" | "html" | "timing" | "computed" | "url";
  /** short human label, e.g. "Content-Encoding header" */
  label: string;
  /** the actual observed value, e.g. "identity" or "742ms" */
  value: string;
}

export type Severity = "critical" | "high" | "medium" | "low";
export type FetchQuality = "usable" | "insufficient" | "empty";
export type Category = "performance" | "seo" | "security" | "accessibility" | "ux" | "responsiveness";

export interface Issue {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  /** the exact page/resource this issue was found on */
  affected: string;
  whyItMatters: string;
  estimatedImpact?: string;
  recommendedFix: string;
  difficulty: "easy" | "moderate" | "hard";
  /** higher = fix first. Derived from severity, not invented. */
  priorityScore: number;
  source: DataSource;
  evidence: Evidence[];
  /** exact hostnames supporting cross-category root-cause correlation; never inferred from prose. */
  relatedHosts?: string[];
}

export interface CorrelatedFinding {
  id: string;
  host: string;
  categories: Category[];
  issueIds: string[];
  summary: string;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  httpsUsed: boolean;
  redirected: boolean;
  redirectCount: number;
  timing: {
    /** ms from request start until response headers were available */
    approxTtfbMs: number;
    /** ms from request start until the full body finished downloading */
    totalDownloadMs: number;
  };
  headers: Record<string, string>;
  bodyBytes: number;
  bodyText: string;
  contentType: string;
  fetchedAt: string;
  setCookieHeaders?: string[];
  redirectChain?: string[];
}

export interface HtmlAnalysis {
  title: string | null;
  titleLength: number;
  /** total <title> elements found (HTML spec allows exactly one; >1 usually
   * signals a templating/build bug - browsers silently use only the first). */
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  /** total meta[name=description] tags found - more than one is a
   * conflicting/duplicate signal search engines resolve unpredictably. */
  metaDescriptionCount: number;
  h1Count: number;
  h1Texts: string[];
  /** total <h1> elements found, INCLUDING ones with empty/whitespace text
   * (h1Count/h1Texts exclude those). Lets callers distinguish "no <h1> tag
   * in the DOM at all" from "an <h1> tag exists but has no text content" -
   * different underlying bugs for a developer to fix. */
  rawH1Count: number;
  canonicalUrl: string | null;
  /** total link[rel=canonical] tags found (canonicalUrl only reflects the
   * first one) - more than one is a conflicting-signal SEO problem. */
  canonicalCount: number;
  /** true when at least one canonical tag exists but its href attribute is
   * empty/whitespace-only - distinct from no canonical tag existing at all. */
  canonicalEmpty: boolean;
  robotsMeta: string | null;
  /** total meta[name=robots] tags found (robotsMeta only reflects the first). */
  robotsMetaCount: number;
  /** distinct, non-empty content values across every robots meta tag found -
   * more than one distinct value means the directives conflict. */
  robotsMetaValues: string[];
  hasViewportMeta: boolean;
  hasCharsetMeta: boolean;
  /** presence (not full validation) of the 4 core Open Graph properties -
   * whether ALL are absent is what SEO rules check (see issues.ts). */
  openGraph: { title: boolean; description: boolean; image: boolean; url: boolean };
  /** whether a twitter:card meta tag exists - unlike other Twitter Card
   * fields, this has no Open Graph fallback, so it's tracked on its own. */
  twitterCardPresent: boolean;
  /** JSON-LD (<script type="application/ld+json">) blocks found. Only
   * syntactic facts are captured - whether each block parses as valid
   * JSON, and whether its (whitespace-normalized) text duplicates an
   * earlier block. No schema/type-specific validation is attempted. */
  structuredData: { totalBlocks: number; malformedBlocks: number; duplicateBlocks: number };
  images: {
    total: number;
    missingAlt: number;
    /** missing a width or height attribute (or both) - a real, static CLS
     * risk signal: the browser can't reserve layout space before the image
     * loads. Does NOT account for a CSS aspect-ratio rule doing the same
     * job, since that can't be determined from static HTML alone. */
    missingDimensions: number;
    /** no loading="lazy" attribute. This is a raw count, not a judgment
     * about which images SHOULD be lazy - the LCP image should NOT be
     * lazy-loaded, and static HTML can't identify which image that is, so
     * this is only used to flag pages with many images and zero lazy
     * hints at all (see issues.ts), never per-image. */
    missingLazyLoading: number;
    /** no srcset attribute - a static signal that the image can't adapt
     * to viewport/DPR, unrelated to whether the file itself is oversized
     * (this project has no way to measure actual image bytes). */
    missingResponsiveSrcset: number;
  };
  scripts: { total: number; blockingInHead: number; asyncOrDefer: number };
  stylesheets: { total: number; blockingInHead: number };
  /** every script/stylesheet/image/iframe resource reference whose host
   * differs from the page's own host, grouped by host with a best-effort
   * vendor category. Counts of references, not bytes transferred - this
   * project doesn't fetch sub-resources, so transfer size is never
   * claimed (see issues.ts). */
  thirdPartyResources: { host: string; category: ThirdPartyCategory; count: number }[];
  insecureResourceRefs: string[]; // http:// urls referenced from an https page
  internalLinks?: string[];
  resourceIntel?: HtmlResourceIntel;
}

export interface HtmlResourceIntel {
  resourceHints: { preload: number; preloadMissingAs: number; prefetch: number; preconnect: number; dnsPrefetch: number; modulepreload: number };
  images: { missingDimensions: number; missingDimensionsExamples: string[]; eagerLikelyBelowFold: number; eagerLikelyBelowFoldExamples: string[] };
  scripts: { duplicateSrcCount: number; duplicateSrcExamples: string[]; inlineScriptBytes: number; devOrLocalhostRefs: string[]; sourceMapRefs: string[] };
  stylesheets: { duplicateHrefCount: number; duplicateHrefExamples: string[]; inlineStyleBytes: number };
  fonts: { linkCount: number; families: { href: string; variantCount: number }[] };
  media: { videoCount: number; audioCount: number; iframeCount: number };
  libraryHints: { keyword: string; src: string }[];
}

export interface CategoryScore {
  category: Category;
  score: number; // 0-100
  issueCount: { critical: number; high: number; medium: number; low: number };
}

/* -------------------------------------------------------------------
 * Mobile + Desktop Responsiveness Intelligence contracts
 * Static HTML/CSS evidence only. No rendered-layout claims are made.
 * ------------------------------------------------------------------- */
export interface ViewportEvidence {
  present: boolean;
  content: string | null;
  hasDeviceWidthToken: boolean;
  hasFixedNumericWidth: boolean;
  fixedWidthValue: number | null;
  disablesZoom: boolean;
}
export interface CssEvidenceSource { source: "inline" | "external"; url: string | null; bytesInspected: number; }
export interface CssResponsiveEvidence {
  inspected: boolean;
  sources: CssEvidenceSource[];
  externalStylesheetsSkipped: number;
  mediaQueryCount: number;
  distinctBreakpointValues: number[];
  fixedWidthDeclarations: { valuePx: number }[];
  viewportUnitFullWidthCount: number;
  fixedPositionRuleCount: number;
  hasResponsiveImagePattern: boolean;
}
export interface ImageResponsivenessEvidence { total: number; withSrcsetOrSizes: number; largeStaticWidthExamples: { src: string; widthPx: number }[]; }
export interface NavigationResponsivenessEvidence { navElementCount: number; duplicateNavRisk: boolean; largestMenuLinkCount: number; emptyControlCount: number; }
export interface ResponsiveAnalysis { viewport: ViewportEvidence; css: CssResponsiveEvidence; images: ImageResponsivenessEvidence; navigation: NavigationResponsivenessEvidence; }
export type DeviceContext = "mobile" | "desktop" | "both";
export type ResponsiveCheckState = "passed" | "warning" | "failed" | "unverified";
export interface ResponsiveCheckResult { id: string; label: string; context: DeviceContext; state: ResponsiveCheckState; detail: string; }
export interface ResponsiveContextSummary { passed: number; warnings: number; failures: number; unverified: number; }
export interface ResponsiveVerificationSummary { mobile: ResponsiveContextSummary; desktop: ResponsiveContextSummary; checks: ResponsiveCheckResult[]; }

/* -------------------------------------------------------------------
 * Advanced SEO contracts
 *
 * These extend (not replace) HtmlAnalysis above, which stays exactly
 * as-is for backward compatibility. collectors/seoCollector.ts derives
 * these facts from the same raw HTML + the page's final URL + response
 * headers; analysis/seoIssues.ts turns them into Issues, same
 * MEASURE/ANALYZE split as every other category. See
 * analysis/siteSeoAnalysis.ts for the site-wide (multi-page) layer,
 * which is the documented integration point for the future crawler.
 * ------------------------------------------------------------------- */

/** Parsed robots-directive tokens, from either a meta tag or an X-Robots-Tag header. */
export interface RobotsDirectives {
  raw: string | null;
  noindex: boolean;
  nofollow: boolean;
  none: boolean; // shorthand for noindex+nofollow
  noarchive: boolean;
  nosnippet: boolean;
  /** any recognized-but-uncommon token, kept for evidence/display */
  otherTokens: string[];
}

export interface IndexabilitySignals {
  metaRobots: RobotsDirectives;
  xRobotsTag: RobotsDirectives;
  /** true only if nothing measured tells search engines not to index this page */
  isIndexable: boolean;
  isFollowable: boolean;
  /** meta robots and X-Robots-Tag disagree on index/follow */
  conflicting: boolean;
}

export interface CanonicalAnalysis {
  rawHref: string | null;
  /** resolved against the page's final URL; null if rawHref is missing/unresolvable */
  resolvedUrl: string | null;
  isAbsolute: boolean;
  /** the resolved canonical URL could not be parsed as a valid URL at all */
  isMalformed: boolean;
  /** canonical resolves to a different registrable host than the page itself */
  pointsToDifferentDomain: boolean;
  /** normalized resolved canonical === normalized page URL */
  isSelfReferencing: boolean;
  /** more than one <link rel="canonical"> tag found on the page */
  duplicateDeclarations: number;
}

export interface OpenGraphAnalysis {
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogUrl: string | null;
  ogType: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  /** og:url present but doesn't match the canonical / page URL */
  ogUrlInconsistentWithCanonical: boolean;
}

export interface HreflangEntry {
  lang: string;
  href: string;
  /** the href, resolved against the page's final URL */
  resolvedHref: string | null;
}

export interface HreflangAnalysis {
  entries: HreflangEntry[];
  hasXDefault: boolean;
  /** a self-referencing hreflang entry (pointing back at this page) exists */
  hasSelfReference: boolean;
  /** entries whose lang code doesn't look like a valid BCP-47 language[-REGION] tag */
  malformedLangCodes: string[];
}

export interface StructuredDataMalformedEntry {
  index: number;
  error: string;
  /** truncated raw snippet for evidence, never the full block */
  snippet: string;
}

export interface StructuredDataItem {
  index: number;
  types: string[];
  /** the parsed JSON-LD object (or one entry of an @graph/array) */
  data: Record<string, unknown>;
}

export interface StructuredDataMismatch {
  itemIndex: number;
  schemaType: string;
  property: string;
  schemaValue: string;
  observedPageValue: string;
  note: string;
}

export interface StructuredDataConflict {
  type: string;
  property: string;
  values: { itemIndex: number; value: string }[];
}

export interface StructuredDataAnalysis {
  items: StructuredDataItem[];
  malformed: StructuredDataMalformedEntry[];
  typesFound: string[];
  duplicateBlocks: { types: string[]; indexes: number[] }[];
  /** required-property gaps found for high-value schema types we validate */
  incompleteItems: { itemIndex: number; types: string[]; missingProperties: string[] }[];
  /** deterministic comparisons against visible page content (see structuredData.ts) */
  contentMismatches: StructuredDataMismatch[];
  /** two same-type entities on this page disagreeing on an identifying property */
  conflicts?: StructuredDataConflict[];
}

export interface ImageSeoFact {
  src: string;
  hasAlt: boolean;
  hasDimensions: boolean;
  genericFilename: boolean;
}

export interface ContentDiscoverability {
  /** visible text length (script/style/noscript stripped), a rough proxy only */
  visibleTextLength: number;
  isThinContent: boolean;
  looksLikePlaceholder: boolean;
}

/**
 * Links found on THIS single page only - not a crawl graph. `internal`
 * is deduped, resolved-absolute, same-site (www-insensitive) hrefs;
 * `externalCount` counts distinct external hosts linked to. This is
 * intentionally shallow (no fetching, no graph) - see
 * analysis/siteSeoAnalysis.ts for actual multi-page graph analysis,
 * which is fed by the future crawler. A future crawler MAY reuse
 * `internal` directly as the `internalLinks` field of `SitePageInput`
 * instead of re-parsing the page for links.
 */
export interface GenericAnchorExample {
  text: string;
  href: string;
}

export interface PaginationFacts {
  nextHref: string | null;
  nextResolvedHref: string | null;
  prevHref: string | null;
  prevResolvedHref: string | null;
}

export interface PageLinkFacts {
  internal: string[];
  externalCount: number;
  /** generic internal-link anchor text pattern; optional for backward-compatible fixtures */
  genericAnchorCount?: number;
  genericAnchorExamples?: GenericAnchorExample[];
}

/** Extended SEO facts, additive alongside the existing HtmlAnalysis. */
export interface SeoExtendedAnalysis {
  indexability: IndexabilitySignals;
  canonical: CanonicalAnalysis;
  openGraph: OpenGraphAnalysis;
  hreflang: HreflangAnalysis;
  structuredData: StructuredDataAnalysis;
  images: ImageSeoFact[];
  content: ContentDiscoverability;
  links: PageLinkFacts;
  /** rel=next/prev facts; optional for backward-compatible fixtures */
  pagination?: PaginationFacts;
}

/* -------------------------------------------------------------------
 * robots.txt / XML sitemap contracts
 * ------------------------------------------------------------------- */

export interface RobotsTxtGroup {
  userAgents: string[];
  disallow: string[];
  allow: string[];
  crawlDelay: number | null;
}

export interface RobotsTxtAnalysis {
  fetched: boolean;
  statusCode: number | null;
  /** true only when a resource was actually retrieved and parsed */
  available: boolean;
  raw: string | null;
  groups: RobotsTxtGroup[];
  sitemapUrls: string[];
  malformedSitemapRefs: string[];
  syntaxWarnings: string[];
  fetchError?: string;
}

/** Does `path` match any Disallow rule that applies to `userAgent` (or `*`)? */
export interface RobotsPathCheck {
  blocked: boolean;
  matchedRule: string | null;
  matchedGroup: string | null;
}

export interface SitemapUrlEntry {
  loc: string;
  lastmod: string | null;
  isWellFormedUrl: boolean;
}

export interface SitemapAnalysis {
  fetched: boolean;
  available: boolean;
  sitemapUrl: string | null;
  isSitemapIndex: boolean;
  childSitemapUrls: string[];
  urls: SitemapUrlEntry[];
  malformedUrlCount: number;
  duplicateUrlCount: number;
  parseError: string | null;
  fetchError?: string;
}

/* -------------------------------------------------------------------
 * Site-level (multi-page) SEO contracts.
 *
 * `SitePageInput` is the CRAWLER INTEGRATION POINT: analysis/
 * siteSeoAnalysis.ts's analyzeSite() is a pure function over an array
 * of these - it does no fetching/crawling itself. Main Claude's
 * multi-page crawler is expected to fetch each page (collectHttp),
 * parse it (collectHtml + collectSeoExtras), extract absolute internal
 * link hrefs, and pass the results in this shape. See
 * analysis/siteSeoAnalysis.ts for full documentation.
 * ------------------------------------------------------------------- */

export interface SitePageInput {
  /** the page's final (post-redirect) URL, used as its identity in the graph */
  url: string;
  statusCode: number;
  /** if this page itself is a redirect, the resolved target URL */
  redirectTarget?: string | null;
  html: HtmlAnalysis;
  seo: SeoExtendedAnalysis;
  /** absolute URLs of every internal (same-site) link discovered in this page's HTML */
  internalLinks: string[];
  /** optional: crawl depth from the homepage, if the crawler already computed it (BFS shortest path in hops) */
  depth?: number;
}

export interface DuplicateGroup {
  value: string;
  urls: string[];
}

export interface CanonicalConflict {
  url: string;
  canonicalTarget: string;
  reason: string;
}

export interface OrphanPage {
  url: string;
  kind: "no-internal-inbound-links" | "sitemap-only";
}

export interface CrawlDepthStats {
  min: number;
  max: number;
  average: number;
  deepImportantPages: { url: string; depth: number }[];
}

export interface SitemapReconciliation {
  sitemapCount: number;
  discoveredCount: number;
  sitemapOnly: string[];
  discoveredOnly: string[];
  overlapCount: number;
}

export interface UrlVariantGroup {
  normalized: string;
  variants: string[];
}

export interface SiteSeoReport {
  pagesAnalyzed: number;
  duplicateTitles: DuplicateGroup[];
  duplicateDescriptions: DuplicateGroup[];
  canonicalConflicts: CanonicalConflict[];
  orphanPages: OrphanPage[];
  crawlDepth: CrawlDepthStats | null;
  sitemap: SitemapReconciliation | null;
  brokenInternalLinks: { fromUrl: string; toUrl: string }[];
  internalLinksToRedirects: { fromUrl: string; toUrl: string; redirectsTo: string }[];
  internalLinksToNoindexPages: { fromUrl: string; toUrl: string }[];
  urlVariantGroups: UrlVariantGroup[];
  structuredDataIssueCount: number;
  issues: Issue[];
}

/* -------------------------------------------------------------------
 * Verification-state model (additive).
 *
 * Deliberately NOT a change to `Issue`/`Severity` - those stay exactly
 * as they are for every category. This is a separate, small, additive
 * reporting structure specifically for the question "was this actually
 * checked, and with what result" - independent of whether a checked
 * item happened to also produce an Issue. A check can be VERIFIED and
 * still have produced zero Issues (e.g. "robots.txt was fetched and
 * parsed, and it does not block anything" is VERIFIED + no issue).
 * The rule this exists to enforce: something not checked must never be
 * reported as if it passed.
 *
 * `VerificationState` itself is shared (originally added for SEO,
 * Session 7; reused as-is for Performance, Session 8 - same five
 * states, same meaning, no changes needed). Each category that wants
 * this gets its OWN `<Category>VerificationCheck`/`Summary` pair and
 * its own field on `AnalysisReport` (`seoVerification`,
 * `performanceVerification`) rather than one shared checks array -
 * that keeps each category's check ids/labels independently
 * documented and avoids one giant untyped bag. If a future session
 * wants this for Security/Accessibility too, follow the same pattern:
 * new `<Category>VerificationCheck` type, new field, no change here.
 * ------------------------------------------------------------------- */

export type VerificationState = "verified" | "failed" | "warning" | "unverified" | "not_applicable";

export interface SeoVerificationCheck {
  /** short stable identifier, e.g. "robots_txt", "sitemap", "canonical", "structured_data" */
  check: string;
  /** human label for display, e.g. "robots.txt" */
  label: string;
  state: VerificationState;
  /** why this state was reached - never generic, always evidence-specific */
  detail: string;
}

export interface SeoVerificationSummary {
  checks: SeoVerificationCheck[];
}

/* -------------------------------------------------------------------
 * Sub-resource intelligence (additive, Session 8).
 *
 * The main document's own HTTP response was already fully measured
 * (FetchResult) - this is about the SCRIPTS/STYLESHEETS/IMAGES/FONTS
 * that document references. Nothing here is fabricated or estimated:
 * every byte count, header, and status comes from an actual bounded
 * HEAD request this scan made (see collectors/resourceProbe.ts). A
 * resource we didn't probe (cap reached) or that didn't answer with a
 * usable Content-Length is `sizeKnown: false` - never defaulted to 0
 * or guessed. This is deliberately HTTP-only, no browser: it cannot
 * see whether a resource actually blocks rendering, was requested by
 * runtime JS, or was served from a warm cache on a real visit - see
 * ResourceIntelligence.probeLimitation for the exact, stated scope.
 * ------------------------------------------------------------------- */

export type ResourceKind = "script" | "stylesheet" | "image" | "font" | "other";

export interface ResourceProbeEntry {
  url: string;
  kind: ResourceKind;
  origin: string;
  isThirdParty: boolean;
  /** true only if a real HTTP response (any status) was received for this URL */
  probed: boolean;
  statusCode: number | null;
  /** from the Content-Length header of the actual response - null if absent/unprobed, never guessed */
  contentLength: number | null;
  contentType: string | null;
  cacheControl: string | null;
  contentEncoding: string | null;
  etag: string | null;
  /** set when the probe itself failed (timeout, network error, blocked host) - distinct from a normal HTTP error status */
  probeError: string | null;
}

export interface ResourceKindTotals {
  count: number;
  /** how many of `count` actually have a known Content-Length */
  sizeKnownCount: number;
  /** sum of contentLength across entries where it's known - a floor, not a total, when sizeKnownCount < count */
  knownBytes: number;
}

export interface ResourceIntelligence {
  entries: ResourceProbeEntry[];
  totalsByKind: Record<ResourceKind, ResourceKindTotals>;
  thirdParty: { originCount: number; requestCount: number; knownBytes: number; origins: ThirdPartyOriginInfo[] };
  /** true if the page referenced more candidate resources than the probe cap - totals above are a partial, stated sample, not the whole page */
  truncated: boolean;
  candidateCount: number;
  probedCount: number;
}

/* -------------------------------------------------------------------
 * Third-party categorization (additive, Session 9).
 *
 * Categorization is ONLY ever produced by matching an origin against a
 * small, curated, hand-maintained list of well-known domains
 * (collectors/thirdPartyCatalog.ts) - never inferred or guessed from a
 * domain's name/shape. An origin not on the list is simply
 * uncategorized; it is never labeled "likely analytics" or similar.
 * ------------------------------------------------------------------- */
export type ThirdPartyCategory = "analytics" | "advertising" | "tag-manager" | "social" | "fonts" | "cdn" | "chat" | "video" | "payment" | "monitoring" | "payments" | "maps" | "library" | "font" | "other" | "uncategorized";

export interface ThirdPartyOriginInfo {
  origin: string;
  requestCount: number;
  knownBytes: number;
  /** null when the origin isn't on the curated known-vendor list - never guessed */
  category: ThirdPartyCategory | null;
  /** display name when known (e.g. "Google Analytics"), otherwise null */
  vendorLabel: string | null;
}

/**
 * Per-image HTML-attribute facts (loading/srcset/declared dimensions) -
 * pure HTML parsing, no HTTP involved. `domOrder` is this image's
 * position among all <img> tags on the page (0-based), used as a
 * (deliberately rough) above-the-fold heuristic: only images beyond
 * the first few are considered lazy-load candidates, since eagerly
 * loading the first visible images is usually correct, not a bug.
 */
export interface ImageAttributeFacts {
  src: string;
  domOrder: number;
  hasWidth: boolean;
  hasHeight: boolean;
  loading: string | null;
  hasSrcset: boolean;
}

export interface PerformanceVerificationCheck {
  check: string;
  label: string;
  state: VerificationState;
  detail: string;
}

export interface PerformanceVerificationSummary {
  checks: PerformanceVerificationCheck[];
}

/* -------------------------------------------------------------------
 * Accessibility contracts
 *
 * Static-HTML-only analysis, same MEASURE/ANALYZE split as everything
 * else: accessibilityCollector.ts collects these facts with zero
 * judgment calls; analysis/accessibilityIssues.ts turns them into
 * Issues. Several real WCAG concerns (color contrast, focus-order
 * correctness, keyboard traps, screen-reader announcement behavior,
 * semantic-but-wrong ARIA usage) cannot be determined from static HTML
 * at all - see AccessibilityCoverage.notVerifiable, which the report
 * surfaces explicitly so a clean scan is never presented as "proven
 * accessible."
 * ------------------------------------------------------------------- */

export interface AccessibilityAnalysis {
  hasHtmlLangAttr: boolean;
  htmlLangValue: string | null;
  viewportContent: string | null;
  /** true if the viewport meta explicitly blocks/limits pinch-zoom (user-scalable=no or maximum-scale<=1) */
  viewportDisablesZoom: boolean;
  headingOutline: { level: number; text: string }[];
  images: {
    total: number;
    /** alt attribute entirely absent - genuinely ambiguous/likely-missing, unlike alt="" */
    noAltAttribute: number;
    /** alt="" - a valid, intentional "decorative, skip me" marker on its own */
    emptyAlt: number;
    /** alt="" but ALSO has aria-label or a non-presentation role - a real contradiction */
    suspiciousDecorative: number;
  };
  formControls: { total: number; unlabeled: number; unlabeledExamples: string[] };
  buttons: { total: number; withoutAccessibleName: number; examples: string[] };
  links: { total: number; withoutAccessibleName: number; examples: string[] };
  duplicateIds: string[];
  brokenAriaRefs: { element: string; attr: string; value: string }[];
  invalidAriaRoles: { element: string; role: string }[];
  iframes: { total: number; missingTitle: number };
  tables: { total: number; withoutHeaders: number };
  autoplayMedia: { total: number; withoutControl: number };
  clickableNonInteractive: { count: number; examples: string[] };
  positiveTabindex: { count: number; examples: string[] };
  /** landmark/skip-nav/heading additions - see accessibilityCollector.ts Phase 2 section */
  landmarks: {
    mainCount: number;
    hasSkipLink: boolean;
    /** only meaningful when hasSkipLink is true. Optional so existing literal fixtures/tests built before Session 9 stay valid without every call site being updated. */
    skipLinkTargetMissing?: boolean;
    skipLinkTargetHidden?: boolean;
  };
  emptyHeadings: { count: number; examples: string[] };
  fieldsetGrouping: { ungroupedRadioCheckboxSets: number; examples: string[]; fieldsetsWithoutLegend: number };
  errorAssociation: { unassociatedCount: number; examples: string[] };
  disabledStateContradictions: { count: number; examples: string[] };
  ariaWidgetsNotFocusable: { count: number; examples: string[] };
  /** static dialog/modal markup checks - see accessibilityCollector.ts Session 8 section. Runtime dialog behavior (focus containment/restoration, Escape handling) is NEVER inferred here - see VerificationEntry's "Modal/dialog focus behavior" category, always unverified. */
  dialogs: {
    total: number;
    withoutAccessibleName: { count: number; examples: string[] };
    withoutFocusableContent: { count: number; examples: string[] };
  };
  /** label[for] pointing at an id that doesn't exist anywhere on the page - a broken association distinct from "no label at all" (Session 9) */
  brokenLabelAssociations: { count: number; examples: string[] };
  /** aria-hidden="true" on an element that IS, or CONTAINS, focusable content - hides it from assistive tech while leaving it keyboard-operable, a well-known real WCAG failure (Session 9) */
  ariaHiddenFocusable: { count: number; examples: string[] };
  /** two-or-more landmarks sharing the same implicit role (e.g. multiple <nav>) with no distinguishing label, or sharing an identical label (Session 9) */
  duplicateLandmarks: {
    ambiguousCount: number;
    ambiguousExamples: string[];
    conflictingLabelCount: number;
    conflictingLabelExamples: string[];
  };
  /** explicit ARIA role exactly duplicates the element's native implicit role (Session 10) */
  redundantAriaRoles: { count: number; examples: string[] };
}

export interface AccessibilityCoverage {
  /** what this MVP actually checks, in plain language, for display in the UI */
  checkedAreas: string[];
  /** real WCAG concerns static HTML analysis cannot determine - never silently implied as "passing" */
  notVerifiable: string[];
}

/* -------------------------------------------------------------------
 * Performance provider contracts (Core Web Vitals / Lighthouse)
 *
 * These types are the STABLE INTERNAL REPRESENTATION the rest of the
 * app depends on. Nothing outside src/providers/ should ever read a
 * raw Google PageSpeed Insights response directly - everything goes
 * through this normalized shape so a second/alternate provider could
 * be swapped in later without touching the scorer or the dashboard.
 * ------------------------------------------------------------------- */

export type MetricStatus = "good" | "needs-improvement" | "poor" | "unavailable";

/** Where a normalized metric's number actually came from. */
export type MetricSource = "pagespeed-field" | "pagespeed-lab" | "unavailable";

export interface NormalizedMetricValue {
  /** null = genuinely unavailable. NEVER coerced to 0. */
  value: number | null;
  unit: "ms" | "unitless";
  status: MetricStatus;
  source: MetricSource;
}

export type CwvMetricKey = "lcp" | "inp" | "cls" | "ttfb" | "fcp" | "speedIndex" | "tbt";

export interface LcpElementInfo {
  nodeSnippet: string | null;
  selector: string | null;
  imageUrl: string | null;
}

export interface LayoutShiftElementInfo {
  nodeSnippet: string | null;
  selector: string | null;
  imageUrl: string | null;
  hasDeclaredDimensions: boolean | null;
  scoreContribution: number | null;
}

export interface CoreWebVitalsEvidence {
  strategy: "mobile" | "desktop";
  /** 0-100, scaled from Lighthouse's 0-1 category score. null if unavailable. */
  lighthousePerformanceScore: number | null;
  metrics: Record<CwvMetricKey, NormalizedMetricValue>;
  opportunities: { id: string; title: string; estimatedSavingsMs: number | null }[];
  /** how much of the metric set we actually got data for */
  coverage: { metricsAvailable: number; metricsTotal: number };
  /** Lighthouse's identified LCP candidate, when the audit is present and recognizable. */
  lcpElement?: LcpElementInfo | null;
  layoutShiftElements: LayoutShiftElementInfo[];
}

export type ProviderStatus = "available" | "unavailable" | "rate_limited" | "timeout" | "error" | "not_configured";

export interface CspFinding {
  directive: string;
  /** short machine-readable reason code, e.g. "unsafe-inline" */
  issue: string;
  /** human-readable explanation of why this specific pattern is weak */
  detail: string;
}

export type CookieSameSite = "Strict" | "Lax" | "None" | "not set";

export interface CookieFinding {
  /** cookie NAME only - never the value (see FetchResult.setCookieHeaders doc) */
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  /** heuristic based on the cookie NAME only (e.g. contains "session", "auth", "token") */
  looksSensitive: boolean;
  /** raw Domain attribute value, if present - safe metadata (a scope, not a secret) */
  domain?: string | null;
  /** raw Path attribute value, if present */
  path?: string | null;
  /** Domain attribute looks unusually broad (e.g. a bare single-label value like ".com") */
  overlyBroadDomain?: boolean;
}

export type MixedContentResourceType = "script" | "stylesheet" | "image" | "iframe" | "font" | "media";

export interface MixedContentFinding {
  resourceType: MixedContentResourceType;
  url: string;
  /**
   * "active" (script/iframe - can execute code or otherwise take over
   * page behavior) vs "passive" (stylesheet/image/font/media - display-
   * only). This is a STATIC classification of resource type, not a
   * browser-observed fact about whether the resource was actually
   * blocked - Insight Web has no browser/runtime execution layer, so it
   * cannot distinguish "blocked by the browser" from "loaded" the way a
   * real browser console would. See securityCollector.ts.
   */
  content: "active" | "passive";
}

export interface InfoDisclosureFinding {
  /** the path checked, e.g. "/.env" - always same-origin, from a small fixed list */
  path: string;
  statusCode: number;
  contentType: string | null;
  note: string;
}

/**
 * A likely-hardcoded credential/API-key pattern found in publicly served
 * content (the page HTML itself, or a same-origin script - see
 * securityCollector.ts's scanForSecrets/scanSameOriginScripts). The
 * VALUE is never included anywhere in this type or downstream - only a
 * redacted preview (first/last few characters), the pattern that
 * matched, where it was found, and a confidence level. This is a
 * pattern-match heuristic, not proof a credential is live/valid.
 */
export interface SecretFinding {
  /** which pattern matched, e.g. "AWS Access Key ID" - never the matched text itself */
  patternName: string;
  /** where this was found, e.g. "page HTML (inline content)" or a same-origin script path */
  location: string;
  /** redacted preview only, e.g. "AKIA********************1234" - NEVER the full value */
  redactedPreview: string;
  confidence: "high" | "medium";
}

/**
 * A localhost/loopback/staging-looking URL referenced from publicly
 * served content - a common leftover from AI-generated or hastily
 * deployed sites. Not a secret (these are plain URLs, not credentials),
 * so the full URL is safe to include as-is.
 */
export interface DevUrlFinding {
  url: string;
  kind: "localhost" | "loopback-ip" | "staging-subdomain";
  /** where this was found, e.g. "page HTML (inline content)" or a same-origin script path */
  location: string;
}

/**
 * A password-collecting form on an HTTPS page that submits to an
 * explicit, absolute http:// action - credentials would be sent
 * unencrypted. Only flagged for an explicit http:// action; a missing/
 * relative/same-origin action is safe by construction (it inherits the
 * page's own https:// scheme) and is never flagged.
 */
export interface FormSecurityFinding {
  /** the action attribute exactly as written in the HTML, e.g. "http://example.com/login" */
  formAction: string;
  /** the action resolved to an absolute URL against the page's own URL */
  resolvedAction: string;
}

/**
 * A target="_blank" link without an explicit noopener/noreferrer relation.
 * Kept as measured HTML evidence; modern browsers mitigate much of the historical
 * risk automatically, but the explicit attribute remains best practice.
 */
export interface TabnabbingFinding {
  url: string;
  linkText: string;
}

export type VerificationStatus = "verified" | "unverified" | "not_applicable";

/**
 * Which broad area a given SecurityAnalysis field's status covers, for
 * the `verification` summary below. Deliberately a small, fixed set of
 * named areas (not a per-issue status) - this is an additive summary
 * layered on top of the existing severity/Issue model, not a
 * replacement for it. See securityCollector.ts's computeVerification().
 */
export type SecurityCheckArea =
  | "https"
  | "headers"
  | "csp"
  | "clickjacking"
  | "cookies"
  | "cors"
  | "infoDisclosure"
  | "debugExposure"
  | "redirectSecurity"
  | "crossOriginPolicies"
  | "secretExposure"
  | "devUrlExposure"
  | "permissionsPolicy"
  | "httpMethods"
  | "hsts"
  | "referrerPolicy"
  | "insecureFormSubmission"
  | "tlsCertificate"
  | "caaRecords"
  | "subresourceIntegrity"
  | "reverseTabnabbing";

export interface SriFinding {
  tag: "script" | "link";
  url: string;
}

/**
 * A cross-origin script or stylesheet without Subresource Integrity.
 * Same-origin resources are intentionally excluded.
 */
export interface SecurityAnalysis {
  csp: {
    present: boolean;
    raw: string | null;
    weaknesses: CspFinding[];
  };
  clickjacking: {
    protected: boolean;
    hasXFrameOptions: boolean;
    hasCspFrameAncestors: boolean;
    /** XFO and CSP frame-ancestors both present but disagree in permissiveness */
    conflicting: boolean;
  };
  mixedContent: MixedContentFinding[];
  cookies: {
    /** false when the response had zero Set-Cookie headers - "checked" state, not "skipped" */
    observed: boolean;
    findings: CookieFinding[];
  };
  cors: {
    /** "checked" = probe ran and returned a response; "unreachable"/"blocked"/"error" = ran but inconclusive; "not_applicable" = same-origin scan target had nothing to probe against */
    probeStatus: "checked" | "unreachable" | "blocked" | "error";
    allowOriginHeader: string | null;
    allowCredentials: boolean;
    /** server echoed back an arbitrary, unrecognized Origin we sent - a strong signal of a permissive reflection config */
    reflectsArbitraryOrigin: boolean;
    wildcardWithCredentialsAttempt: boolean;
  };
  infoDisclosure: {
    probeStatus: "checked" | "blocked" | "error";
    checkedPaths: number;
    findings: InfoDisclosureFinding[];
  };
  debugExposure: {
    /** short evidence strings (a matched pattern name + short context), never a full stack-trace dump */
    indicators: string[];
  };
  redirectSecurity: {
    /** hop-by-hop hosts actually visited, capped */
    hostChain: string[];
    crossHostRedirect: boolean;
    /** result of a best-effort, single-hop probe of the plain-http:// version of this same host+path, only run when the scanned page itself was https */
    httpProbe: {
      status: "checked" | "unreachable" | "not_applicable";
      redirectsToHttps: boolean | null;
    };
  };
  /**
   * Cross-origin isolation headers - observed values only, no probe
   * (read directly from the already-fetched response headers).
   */
  crossOriginPolicies: {
    /** Cross-Origin-Opener-Policy */
    coop: string | null;
    /** Cross-Origin-Resource-Policy */
    corp: string | null;
    /** Cross-Origin-Embedder-Policy */
    coep: string | null;
  };
  /**
   * Permissions-Policy header - observed value only, no probe.
   */
  permissionsPolicy: {
    present: boolean;
    raw: string | null;
    /** sensitive features explicitly wildcarded to any origin */
    wildcardFeatures: string[];
  };
  /**
   * A single, safe, same-origin OPTIONS request to the page's own URL,
   * checking the Allow (or Access-Control-Allow-Methods) response
   * header for unusually risky methods (TRACE/TRACK/CONNECT - the
   * classic cross-site-tracing/proxying surface). OPTIONS is a safe,
   * standard, non-destructive method - the same kind of request a
   * browser CORS preflight already makes.
   */
  httpMethods: {
    probeStatus: "checked" | "blocked" | "error";
    /** every method the server reported via Allow/Access-Control-Allow-Methods, if any */
    allowedMethods: string[];
    /** the subset of allowedMethods considered unusually risky to expose (TRACE/TRACK/CONNECT) */
    riskyMethodsExposed: string[];
  };
  /**
   * HSTS *quality* - presence alone is already checked in issues.ts;
   * this is the max-age/includeSubDomains value analysis, same
   * presence-vs-quality split as csp above. Pure read of the
   * already-fetched header, no probe.
   */
  hsts: {
    present: boolean;
    raw: string | null;
    maxAgeSeconds: number | null;
    includesSubDomains: boolean;
    /** present but maxAgeSeconds is below a meaningful threshold (180 days) - too short to provide durable protection */
    maxAgeTooShort: boolean;
  };
  /**
   * Referrer-Policy *quality* - presence alone is already checked in
   * issues.ts; this flags the one specifically dangerous value
   * ("unsafe-url", which always sends the full URL including any
   * sensitive query-string content, even on an HTTPS-to-HTTP
   * downgrade). Pure read of the already-fetched header, no probe.
   */
  referrerPolicy: {
    raw: string | null;
    /** true only for the specific "unsafe-url" value - deliberately narrow to avoid flagging merely-legacy-but-not-dangerous values */
    weak: boolean;
  };
  /**
   * Password-collecting forms on an HTTPS page whose action submits to
   * an explicit, absolute http:// URL. Pure HTML analysis of the
   * already-fetched page body, no probe.
   */
  insecureFormSubmission: {
    findings: FormSecurityFinding[];
  };
  /**
   * Real TLS handshake evidence for HTTPS targets.
   */
  tlsCertificate: {
    probeStatus: "checked" | "blocked" | "unreachable" | "error" | "not_applicable";
    protocol: string | null;
    cipherName: string | null;
    authorized: boolean | null;
    authorizationError: string | null;
    validTo: string | null;
    daysUntilExpiry: number | null;
    publicKeyBits: number | null;
    publicKeyIsRsa: boolean;
  };
  /** Real DNS CAA query result. */
  caaRecords: {
    probeStatus: "checked" | "error";
    present: boolean;
    records: string[];
  };
  /** Cross-origin scripts/stylesheets without SRI. */
  subresourceIntegrity: {
    findings: SriFinding[];
  };
  /**
   * target="_blank" links without explicit noopener/noreferrer.
   * Pure HTML analysis; modern browsers mitigate much of the historical risk,
   * but explicit protection remains best practice.
   */
  reverseTabnabbing: {
    findings: TabnabbingFinding[];
  };
  /**
   * Hardcoded-looking credential/API-key patterns found in the page
   * itself plus a small, bounded number of same-origin scripts. See
   * SecretFinding's doc - values are never exposed, only redacted
   * previews.
   */
  secretExposure: {
    probeStatus: "checked" | "blocked" | "error";
    /** how many locations were actually scanned (1 = just the page HTML; more = same-origin scripts were also fetched and scanned) */
    scannedLocations: number;
    findings: SecretFinding[];
  };
  /**
   * localhost/loopback/staging URL references found in the page itself
   * plus the same bounded set of same-origin scripts used for
   * secretExposure above.
   */
  devUrlExposure: {
    findings: DevUrlFinding[];
  };
  /**
   * Additive verification-status summary - does NOT replace or feed the
   * severity/Issue/scoring model above. "verified" means this area's
   * check actually ran and produced a real observation (including a
   * clean/negative one - e.g. "verified: zero cookies observed" is
   * "verified", not "unverified"); "unverified" means the underlying
   * probe could not run (blocked host, network error, timeout);
   * "not_applicable" means the check genuinely doesn't apply here (e.g.
   * the HTTP-to-HTTPS probe when the page itself is already plain HTTP).
   * The point: a report must never imply "safe" for something that was
   * actually never checked.
   */
  verification: Record<SecurityCheckArea, VerificationStatus>;
}

/* -------------------------------------------------------------------
 * Performance provider contracts (Core Web Vitals / Lighthouse)
 *
 * These types are the STABLE INTERNAL REPRESENTATION the rest of the
 * app depends on. Nothing outside src/providers/ should ever read a
 * raw Google PageSpeed Insights response directly - everything goes
 * through this normalized shape so a second/alternate provider could
 * be swapped in later without touching the scorer or the dashboard.
 * ------------------------------------------------------------------- */

export interface PerformanceProviderResult {
  status: ProviderStatus;
  evidence: CoreWebVitalsEvidence | null;
  /** user-safe message; never a raw stack trace */
  errorMessage?: string;
  /** present only when a caching decorator served this result from cache */
  cache?: { hit: boolean; ageMs: number };
}

export interface PerformanceProvider {
  name: string;
  analyze(url: string): Promise<PerformanceProviderResult>;
}

/** One line of the "why did Performance score X" breakdown shown in the UI. */
export interface PerformanceFactor {
  metric: CwvMetricKey;
  label: string;
  value: number | null;
  unit: "ms" | "unitless";
  status: MetricStatus;
  /** points subtracted from the Performance score because of this metric; 0 if good/unavailable */
  scoreImpact: number;
  source: MetricSource;
}

export interface CoreWebVitalsReport {
  providerName: string;
  providerStatus: ProviderStatus;
  errorMessage?: string;
  evidence: CoreWebVitalsEvidence | null;
  factors: PerformanceFactor[];
  /** true if this result was served from cache rather than a fresh PageSpeed call */
  cached: boolean;
  /** age of the cached result in ms, when cached is true */
  cacheAgeMs?: number;
}

export type RuntimeJsErrorSource = "pageerror" | "console-error";

export interface RuntimeJsError {
  message: string;
  /** capped length; null when the browser didn't provide one (e.g. a console.error with no stack) */
  stack: string | null;
  source: RuntimeJsErrorSource;
}

export type ConsoleLevel = "error" | "warning" | "log" | "info" | "debug";

export interface RuntimeConsoleMessage {
  level: ConsoleLevel;
  /** capped length - never a full unbounded console dump */
  text: string;
}

export type RuntimeRequestOutcome = "success" | "failed";

export interface RuntimeNetworkRequest {
  url: string;
  /** Playwright's resourceType: "document" | "stylesheet" | "image" | "script" | "xhr" | "fetch" | "font" | "media" | "websocket" | "other" | ... */
  resourceType: string;
  method: string;
  /** true if this request's hostname matches the final navigated page's hostname */
  isFirstParty: boolean;
  status: number | null;
  ok: boolean | null;
  /** Playwright's request.failure()?.errorText, or our own SSRF guard's rejection reason, when applicable */
  failureReason: string | null;
  outcome: RuntimeRequestOutcome;
}

export interface RuntimeFormInfo {
  /** resolved absolute action URL, or null if the form has no action attribute and the page URL itself couldn't be resolved */
  action: string | null;
  method: string;
  isHttpsPage: boolean;
  /** true only when isHttpsPage is true AND the resolved action is an absolute http:// URL */
  actionIsInsecureHttp: boolean;
  hasSubmitControl: boolean;
}

export interface RuntimeDomSnapshot {
  visibleTextLength: number;
  /** capped sample of document.body.innerText, not the full page - see BROWSER_MAX_DOM_TEXT_CHARS */
  visibleTextSample: string;
  elementCount: number;
  /** heuristic: any non-whitespace visible text, or at least one media/graphics element */
  hasBodyContent: boolean;
}

export interface RuntimeContentComparison {
  /** visible text length of the RAW (pre-JS) HTML body, when supplied for comparison - see CollectRuntimeOptions.rawHtmlForComparison */
  rawHtmlVisibleTextLength: number;
  renderedVisibleTextLength: number;
  /** raw HTML was sparse but the rendered page has real content - informational, NOT itself a problem */
  likelyJsDependentContent: boolean;
}

export interface RuntimeScreenshot {
  enabled: boolean;
  /** base64-encoded PNG; omitted when disabled or when capture itself failed */
  base64Png?: string;
  viewport: { width: number; height: number };
}

export interface RuntimeVerificationEvidence {
  /** bounded browser markers used by technology intelligence; never contains page secrets */
  runtimeTechnology?: {
    globals: string[];
    domMarkers: string[];
    versions: Record<string, string>;
    /** allowlisted technology DOM selectors and JS properties observed by the browser layer */
    presentSelectors?: string[];
    presentJsProperties?: Record<string, string | boolean>;
  };
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  /** true if the final navigation response was a non-error (<400) status */
  navigationOk: boolean;
  jsErrors: RuntimeJsError[];
  consoleMessages: RuntimeConsoleMessage[];
  requests: RuntimeNetworkRequest[];
  forms: RuntimeFormInfo[];
  domSnapshot: RuntimeDomSnapshot;
  /** null when no raw HTML was supplied for comparison (see CollectRuntimeOptions.rawHtmlForComparison) */
  contentComparison: RuntimeContentComparison | null;
  screenshot: RuntimeScreenshot | null;
  timing: { navigationMs: number; totalMs: number };
  viewport: { width: number; height: number };
  engine: "chromium";
  fetchedAt: string;
}

/** Mirrors Issue's shape (see the note above this section for why it's a distinct type). */
export interface RuntimeFinding {
  id: string;
  severity: Severity;
  title: string;
  affected: string;
  whyItMatters: string;
  estimatedImpact?: string;
  recommendedFix: string;
  difficulty: "easy" | "moderate" | "hard";
  source: DataSource;
  evidence: Evidence[];
}

export type RuntimeVerificationStatus = "completed" | "error";

export interface RuntimeVerificationReport {
  status: RuntimeVerificationStatus;
  /** user-safe message; never a raw stack trace */
  errorMessage?: string;
  /** a CollectorErrorCode value (see collectors/httpCollector.ts) when status is "error"; kept as a plain string here so types.ts has no dependency on collectors/ */
  errorCode?: string;
  evidence: RuntimeVerificationEvidence | null;
  findings: RuntimeFinding[];
}

export type ScanStatus = "success" | "partial" | "failed";

export interface CrawlOptions {
  /** hard cap on pages actually analyzed (not counting robots/duplicate/depth-limit skips) */
  maxPages: number;
  /** 0 = seed page only, 1 = seed + pages it directly links to, etc. */
  maxDepth: number;
  /** how many pages are analyzed in parallel */
  concurrency: number;
  /** per-page fetch timeout, passed through to analyzeUrl/collectHttp */
  requestTimeoutMs: number;
  respectRobots: boolean;
  /** if true, also seed the crawl frontier from Sitemap: entries in robots.txt (depth 1) */
  useSitemap: boolean;
}

/**
 * Every state a discovered URL can end up in. Deliberately distinct
 * from "not discovered at all" (which simply never appears in
 * `pages`) - see CrawlStats for the difference between "not crawled"
 * and "crawled and {passed,failed}".
 */
export type PageCrawlStatus =
  | "analyzed"
  | "failed"
  | "skipped_robots"
  | "skipped_duplicate"
  | "skipped_depth_limit"
  | "skipped_page_limit"
  | "skipped_non_html"
  | "skipped_external";

export interface PageCrawlResult {
  url: string;
  depth: number;
  status: PageCrawlStatus;
  /** present only when status === "analyzed" - the exact same AnalysisReport a single-page scan would produce */
  report: AnalysisReport | null;
  /** present only when status === "failed" or "skipped_non_html" */
  errorMessage: string | null;
  /** the page this URL was discovered on, or null for the seed URL / a sitemap-discovered URL */
  discoveredFrom: string | null;
}

export type RobotsTxtStatus = "fetched" | "missing" | "unavailable" | "disabled";

export interface CrawlStats {
  seedUrl: string;
  /** every distinct URL the crawler became aware of, regardless of what happened to it - equals pages.length */
  pagesDiscovered: number;
  pagesAnalyzed: number;
  pagesFailed: number;
  pagesSkippedRobots: number;
  pagesSkippedDuplicate: number;
  pagesSkippedDepthLimit: number;
  pagesSkippedPageLimit: number;
  pagesSkippedNonHtml: number;
  pagesSkippedExternal: number;
  maxDepthReached: number;
  robotsTxtStatus: RobotsTxtStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/**
 * A single Issue title recurring across enough analyzed pages to be
 * worth surfacing as ONE site-wide finding rather than N near-
 * duplicates - the general, all-categories version of what
 * analysis/siteWidePerformance.ts already does for performance alone.
 * See analysis/siteWideFindings.ts for the exact threshold logic.
 */
export interface SiteWideFinding {
  title: string;
  category: Category;
  severity: Severity;
  affectedUrls: string[];
  occurrenceCount: number;
  pagesAnalyzed: number;
}

export interface UxAnalysis {
  hasPrimaryNav: boolean;
  navLinkCount: number;
  /** approximate visible-text word count (script/style/noscript content excluded) */
  wordCount: number;
  /** <main>/<article>/<section> elements with no meaningful text and no images/media inside */
  emptySections: { count: number; examples: string[] };
  /** literal "lorem ipsum" (or common variants) found in visible text */
  hasPlaceholderText: boolean;
  placeholderExamples: string[];
  /** "coming soon" / "under construction" / template-demo remnants found in visible text */
  hasComingSoonText: boolean;
  comingSoonExamples: string[];
  links: {
    internalCount: number;
    externalCount: number;
    mailto: { count: number; malformed: number; malformedExamples: string[] };
    tel: { count: number; malformed: number; malformedExamples: string[] };
  };
  /** normalized nav link hrefs, in document order - used for cross-page nav-consistency comparison (site aggregation only) */
  navLinkHrefs: string[];
  /** two or more links within the SAME nav sharing identical visible text but pointing at different destinations - ambiguous link labeling (Session 9) */
  duplicateNavLabels: { count: number; examples: string[] };
  /** href="#"/""/javascript:void(0)-style links with no onclick attribute - a HEURISTIC signal only, since real behavior may be attached via JS at runtime (unverifiable statically) */
  deadLinkCandidates: { count: number; examples: string[] };
  /** <form> elements with no real input/select/textarea (excluding hidden fields) - likely non-functional */
  emptyForms: { count: number; examples: string[] };
  /** <form> elements whose action is empty/"#"/javascript: - may not actually submit anywhere */
  formsWithPlaceholderAction: { count: number; examples: string[] };
}

export type PageOutcome = "clean" | "warnings" | "critical" | "error";

export interface SitePageResult {
  url: string;
  outcome: PageOutcome;
  /** present only when outcome === "error" - the page could not be measured at all */
  errorMessage?: string;
  title: string | null;
  h1Texts: string[];
  issueCounts: { critical: number; high: number; medium: number; low: number; total: number };
  accessibility?: AccessibilityAnalysis;
  ux?: UxAnalysis;
  issues: Issue[];
}

export interface SiteFinding {
  /** stable key: category + issue title, used to group identical findings across pages */
  key: string;
  category: Category;
  severity: Severity;
  title: string;
  whyItMatters: string;
  recommendedFix: string;
  affectedUrls: string[];
  /** how many of the scanned pages this finding appears on */
  affectedPageCount: number;
}

export type LaunchReadinessStatus = "READY" | "READY_WITH_WARNINGS" | "NOT_READY";

/**
 * How much confidence the evidence behind a category/finding actually
 * supports, independent of severity. Never inferred upward just because
 * a scan produced many findings, and never silently treated as "clean"
 * when evidence is missing (see `evaluateLaunchDecision`'s handling of
 * `UNVERIFIED` / `SCAN_FAILED`).
 */
export type LaunchVerificationState =
  | "VERIFIED"
  | "STRONGLY_SUPPORTED"
  | "PARTIALLY_VERIFIED"
  | "UNVERIFIED"
  | "SCAN_FAILED";

export type CategoryReadinessStatus = "READY" | "READY_WITH_WARNINGS" | "NOT_READY" | "UNVERIFIED";

/** A group of one or more underlying Issues that share the same rule and
 * category (e.g. the same site-wide problem found on several pages) -
 * see `groupIssues()` in analysis/launchDecision.ts. This is how the
 * engine avoids double-counting the same underlying problem as multiple
 * independent blockers/warnings. */
export interface LaunchFindingGroup {
  id: string;
  title: string;
  category: Category;
  /** highest severity among the grouped issues */
  severity: Severity;
  /** every distinct page/resource this group's issues were found on */
  affected: string[];
  /** underlying Issue ids rolled into this group, for full traceability */
  issueIds: string[];
}

export interface LaunchBlocker extends LaunchFindingGroup {
  /** deterministic, evidence-traceable explanation of why this blocks launch */
  reason: string;
}

export interface LaunchWarning extends LaunchFindingGroup {}

export interface CategoryReadiness {
  category: Category;
  status: CategoryReadinessStatus;
  /** the existing quantitative score for this category, for reference only - never the sole driver of `status` */
  score: number;
  verification: LaunchVerificationState;
  blockerCount: number;
  warningCount: number;
  affectedPages: string[];
}

export interface ScanCompleteness {
  pagesDiscovered: number;
  pagesAnalyzed: number;
  pagesFailed: number;
  categoriesAnalyzed: Category[];
  /** categories that exist on the product roadmap but were not run/available for this scan
   * (e.g. not-yet-built categories, or a provider that failed) - never silently dropped */
  categoriesUnavailable: string[];
  /** true only when every roadmap category ran and every discovered page was analyzed */
  isComplete: boolean;
}

export interface PrioritizedFix {
  priority: number;
  title: string;
  category: Category;
  blocking: boolean;
  severity: Severity;
  affectedPageCount: number;
  confidence: LaunchVerificationState;
  issueIds: string[];
  /** number of distinct categories this fix's underlying issues span, when correlated */
  correlatedAcrossCategories?: number;
}

export interface LaunchDecision {
  status: LaunchReadinessStatus;
  /** one-line deterministic summary, safe to render as a headline */
  summary: string;
  blockers: LaunchBlocker[];
  warnings: LaunchWarning[];
  categoryReadiness: CategoryReadiness[];
  scanCompleteness: ScanCompleteness;
  /** deterministic "fix these first" ordering - see analysis/launchDecision.ts prioritizeFixes() */
  prioritizedFixes: PrioritizedFix[];
  /** human-readable, evidence-traced reasons - populated whenever there are no blockers */
  whyReady: string[];
  /** human-readable, evidence-traced reasons - populated only when status is NOT_READY */
  whyNotReady: string[];
  /** deterministic disclosure of everything this scan could NOT verify - never omitted to look cleaner */
  notVerified: string[];
  /** the most conservative (weakest) verification state across every analyzed category */
  /** cross-category root-cause correlations grounded in exact shared hostnames */
  correlatedFindings: CorrelatedFinding[];
  overallVerification: LaunchVerificationState;
}


export interface VerificationEntry {
  /** human-readable category name, e.g. "Form labeling & grouping" or "Keyboard-only interaction" */
  category: string;
  status: VerificationStatus;
  /** why this status was reached - e.g. "2 form controls missing accessible names" or the fixed
   *  runtime-boundary reason "Requires browser/runtime execution; static HTML analysis cannot verify this." */
  reason: string;
}

/* -------------------------------------------------------------------
 * UX / content-usability contracts
 *
 * Same MEASURE/ANALYZE split as everything else (see accessibility
 * above): uxCollector.ts collects these facts from static HTML with
 * zero judgment calls, analysis/uxIssues.ts turns them into Issues.
 * Deliberately narrow to objective, evidence-backed conditions (e.g.
 * literal "lorem ipsum" text, a <nav>-less page, zero visible words) -
 * never a subjective "does this page feel good" judgment, which would
 * require an LLM this project's architecture explicitly forbids in the
 * deterministic analysis layer.
 * ------------------------------------------------------------------- */

export interface SiteAnalysisReport {
  scannedAt: string;
  pagesRequested: number;
  pagesScanned: number;
  /** true if pagesRequested was truncated to the configured page-count limit */
  truncated: boolean;
  pageLimit: number;
  summary: {
    clean: number;
    warnings: number;
    critical: number;
    error: number;
  };
  pages: SitePageResult[];
  /** cross-page findings (duplicate titles/H1s, template-level repeated failures, etc.) */
  siteFindings: SiteFinding[];
  /** site-level VERIFIED/FAILED/WARNING/UNVERIFIED/NOT_APPLICABLE states, including cross-page-only categories (e.g. nav consistency) */
  verification: VerificationEntry[];
  /** site-wide performance opportunities derived from existing site findings */
  sitePerformanceOpportunities?: SiteWidePerformanceOpportunity[];
  /** conservative site-wide performance root-cause chains */
  siteWideRootCauseChains?: SiteWideRootCauseChain[];
  /** site-wide technology coverage and neutral variance observations */
  siteTechnology?: SiteTechnologyIntelligence;
}

/* -------------------------------------------------------------------
 * Performance provider contracts (Core Web Vitals / Lighthouse)
 *
 * These types are the STABLE INTERNAL REPRESENTATION the rest of the
 * app depends on. Nothing outside src/providers/ should ever read a
 * raw Google PageSpeed Insights response directly - everything goes
 * through this normalized shape so a second/alternate provider could
 * be swapped in later without touching the scorer or the dashboard.
 * ------------------------------------------------------------------- */


export type ReadinessVerdict = "ready" | "almost_ready" | "not_ready";

/** Derived directly from Severity - see analysis/launchReadiness.ts's priorityFor(). */
export type FindingPriority = "must_fix" | "important" | "improvement";

export interface PrioritizedFinding {
  priority: FindingPriority;
  /** "runtime" for a browser/runtime finding (RuntimeFinding has no Category of its own - see types.ts's note on that type) */
  category: Category | "runtime";
  /** the original, unmodified finding - all technical evidence (evidence[], difficulty, source, etc.) is preserved, never stripped for the human-readable view */
  issue: Issue | RuntimeFinding;
}

export interface UnverifiedArea {
  /** human label for what could not be checked, e.g. "Core Web Vitals (real-user performance metrics)" */
  area: string;
  /** why - e.g. "Not requested for this scan" or a provider error message. Never blank - an unverified area always says why. */
  reason: string;
}

export interface LaunchReadinessReport {
  verdict: ReadinessVerdict;
  /** emoji-prefixed one-line headline, e.g. "🔴 Your website isn't ready yet" */
  headline: string;
  /** one supporting sentence, e.g. "We found 3 things you must fix before launch." */
  summary: string;
  mustFix: PrioritizedFinding[];
  important: PrioritizedFinding[];
  improvements: PrioritizedFinding[];
  /** categories with zero findings at all */
  passedCategories: Category[];
  unverifiedAreas: UnverifiedArea[];
}

export type PageHealthStatus = "healthy" | "warning" | "critical";


export interface PagePerformanceResult {
  url: string;
  status: PageHealthStatus;
  /** performance-category issues found on this specific page */
  issues: Issue[];
  coreWebVitals: CoreWebVitalsReport;
}

/**
 * A performance problem that recurs across multiple pages - e.g. the
 * same render-blocking third-party script on every template-rendered
 * page - surfaced as ONE finding with every affected URL, instead of
 * N separate identical-looking findings.
 */

export interface SiteWidePerformancePattern {
  /** matches the underlying per-page Issue title this pattern groups */
  title: string;
  severity: Severity;
  category: "performance";
  affectedUrls: string[];
  occurrenceCount: number;
  pagesScanned: number;
  whyItMatters: string;
  recommendedFix: string;
  /** one representative evidence snippet from one of the affected pages */
  evidenceExample: Evidence[];
}


export interface SitePerformanceSummary {
  pagesScanned: number;
  healthy: number;
  warning: number;
  critical: number;
  /** issues that recur across enough pages to be a site-wide/template-level problem */
  siteWidePatterns: SiteWidePerformancePattern[];
  /** the full per-page detail this summary was built from */
  pageResults: PagePerformanceResult[];
}


export interface CategorySummary {
  category: Category;
  totalIssues: number;
  bySeverity: Record<Severity, number>;
  /** how many analyzed pages had at least one issue in this category */
  pagesWithIssues: number;
  /** average category score across analyzed pages (same 0-100 scale as AnalysisReport.scores) */
  averageScore: number;
}


export interface AnalysisReport {
  reportId: string;
  url: string;
  scannedAt: string;
  /**
   * "success"  - HTTP measurement + PageSpeed (if configured) both completed.
   * "partial"  - HTTP measurement completed but PageSpeed did not (still a
   *              fully usable report - Performance/SEO/Security scores are
   *              unaffected, Core Web Vitals are simply unavailable).
   * "failed"   - reserved for future use; today a failed target fetch throws
   *              a CollectorError before a report is ever constructed, so
   *              this pipeline never itself returns "failed" - the HTTP
   *              layer (routes/analyze.ts) turns that throw into an error
   *              response instead. Kept in the type for callers that may
   *              want to represent it (e.g. a future batch/crawl mode).
   */
  status: ScanStatus;
  scores: {
    performance: number;
    seo: number;
    security: number;
    accessibility: number;
    ux: number;
    responsiveness: number;
    overall: number;
  };
  categoriesAnalyzed: Category[];
  categoriesNotYetAnalyzed: string[];
  issueCounts: { critical: number; high: number; medium: number; low: number; total: number };
  topPriorityIssues: Issue[];
  allIssues: Issue[];
  coreWebVitals: CoreWebVitalsReport;
  accessibilityCoverage: AccessibilityCoverage;
  /** robots.txt for this page's origin, fetched best-effort - see collectors/robotsCollector.ts */
  robotsTxt: RobotsTxtAnalysis;
  /**
   * XML sitemap fetched best-effort: robots.txt's declared Sitemap: URL
   * if present, else a single conventional "/sitemap.xml" guess as a
   * fallback (NOT a crawl/discovery process). `available: false` is a
   * normal, common outcome, not an error - see collectors/sitemapCollector.ts.
   */
  sitemap: SitemapAnalysis;
  /** SEO-only VERIFIED/FAILED/WARNING/UNVERIFIED/NOT_APPLICABLE summary - see the type's doc comment in types.ts */
  seoVerification: SeoVerificationSummary;
  /** real, bounded HEAD-probed sub-resource facts (script/stylesheet/image/font bytes, caching, compression) - see ResourceIntelligence's doc comment */
  resourceIntelligence: ResourceIntelligence;
  /** performance-only VERIFIED/FAILED/WARNING/UNVERIFIED/NOT_APPLICABLE summary */
  performanceVerification: PerformanceVerificationSummary;
  /** Quality gate for the static HTML fetch; content-derived findings are unverified when this is not usable. */
  fetchQuality: FetchQuality;
  runtimeVerification?: RuntimeVerificationReport;
  responsiveVerification: ResponsiveVerificationSummary;
  /** deterministic technology stack detection derived from measured page evidence */
  technology?: TechnologyIntelligence;
  /** grouped performance opportunities derived from existing performance Issues */
  performanceOpportunities?: PerformanceOpportunity[];
  /** conservative within-performance root-cause links */
  performanceRootCauseChains?: PerformanceRootCauseChain[];
  launchDecision: LaunchDecision;
  launchReadiness: LaunchReadinessReport;
  evidenceLog: {
    fetch: Omit<FetchResult, "bodyText">;
    html: HtmlAnalysis;
    accessibility: AccessibilityAnalysis;
    seo: SeoExtendedAnalysis;
    security: SecurityAnalysis;
    ux: UxAnalysis;
    responsive: ResponsiveAnalysis;
  };
}


/* Incremental performance opportunity types */
export type PerformanceOpportunityCategory =
  | "core-web-vitals"
  | "image-delivery"
  | "javascript-delivery"
  | "css-delivery"
  | "font-delivery"
  | "third-party-overhead"
  | "render-blocking-and-network"
  | "caching-and-compression"
  | "server-response"
  | "document-weight"
  | "rendering-and-interactivity"
  | "production-build-quality"
  | "other-performance";

export interface PerformanceOpportunity {
  category: PerformanceOpportunityCategory;
  /** human-readable label, e.g. "Image delivery" */
  title: string;
  /** worst severity among the grouped issues */
  severity: Severity;
  /** a category-level statement of the problem - never a fabricated figure; specific numbers live in evidenceSummary */
  problem: string;
  whyItMatters: string;
  /** the real, already-computed estimatedImpact/title text from each grouped Issue - nothing re-derived */
  evidenceSummary: string[];
  recommendedFix: string;
  /** links back to the full-detail Issue objects this opportunity summarizes */
  affectedIssueIds: string[];
  issueCount: number;
  /**
   * Impact/effort classification for prioritization - "what should the
   * owner fix first", not just "what's most severe". Computed purely
   * from the grouped issues' own severity/difficulty fields - no new
   * evidence, no invented numbers. See analysis/performanceOpportunities.ts.
   */
  fixPriority: "quick-win" | "major-project" | "fill-in" | "reconsider";
  /** 1 = fix first, across the full returned array (quick wins first, then major projects, then fill-ins, then reconsider) */
  fixPriorityRank: number;
  /** the most common Issue.difficulty among this opportunity's grouped issues */
  dominantDifficulty: "easy" | "moderate" | "hard";
}

/**
 * A conservative, evidence-gated statement that two co-occurring
 * performance opportunities on the SAME page plausibly share a root
 * cause - e.g. large render-blocking JavaScript commonly contributing
 * to a slow LCP. Deliberately uses "contributes to"/"commonly"
 * language, never asserts direct causality, and only fires when both
 * sides of the chain have real, present evidence (never inferred from
 * one side alone). See buildPerformanceRootCauseChains() for the exact,
 * small, hand-reviewed list of chains and why each one is defensible.
 */
export interface PerformanceRootCauseChain {
  id: string;
  headline: string;
  /** ordered factor -> outcome narrative, e.g. ["Large render-blocking JavaScript bundle", "delays first paint", "contributes to a slow LCP"] */
  chain: string[];
  /** "medium" only when both sides are independently well-evidenced; "low" for a weaker/single-signal link. Never "high" - that would require runtime confirmation this codebase doesn't have. */
  confidence: "low" | "medium";
  supportingIssueIds: string[];
}

/** Site-wide counterpart, built from SiteWideFinding[] (analysis/siteWideFindings.ts) - reuses the crawler's existing aggregation, does not re-crawl or re-derive anything. */
export interface SiteWidePerformanceOpportunity {
  category: PerformanceOpportunityCategory;
  title: string;
  severity: Severity;
  problem: string;
  whyItMatters: string;
  /** e.g. "'Large total image payload' recurs on 31 of 42 analyzed pages (74% - likely a shared template/component)." - built only from real SiteWideFinding counts */
  evidenceSummary: string[];
  recommendedFix: string;
  pagesAnalyzed: number;
}

/**
 * Site-wide counterpart to PerformanceRootCauseChain - same five
 * conservative, evidence-gated links, built from SiteWideFinding[]
 * instead of per-page Issue[]. See
 * analysis/performanceOpportunities.ts's buildSiteWideRootCauseChains().
 */
export interface SiteWideRootCauseChain {
  id: string;
  headline: string;
  chain: string[];
  confidence: "low" | "medium";
  /** the underlying SiteWideFinding titles that support this chain */
  supportingFindingTitles: string[];
  pagesAnalyzed: number;
}
