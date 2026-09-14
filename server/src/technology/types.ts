/* ── PRESERVED FROM V10 ─────────────────────────────────────────────
   Existing fields are unchanged. Every addition below is optional, so
   existing producers and consumers keep compiling and behaving as-is.
   ──────────────────────────────────────────────────────────────────── */

export type TechnologyConfidence = 'high' | 'medium' | 'low';

/** EXTENDED: new category ids appended. Existing ids unchanged. */
export type TechnologyCategoryId =
  | 'cms' | 'framework' | 'analytics' | 'ecommerce' | 'payments'
  | 'infrastructure' | 'other'
  // ── new ──
  | 'marketing' | 'security' | 'fonts' | 'consent' | 'search'
  | 'forms' | 'media' | 'plugin';

/** EXTENDED: new signal surfaces appended. Existing values unchanged. */
export type SignalType =
  | 'meta-generator' | 'response-header' | 'cookie-name' | 'script-url'
  | 'stylesheet-url' | 'resource-url' | 'request-host' | 'html-marker'
  | 'runtime-global' | 'dom-attribute' | 'class-fingerprint' | 'implied-by'
  // ── new ──
  | 'dom-selector'      // browser-resolved selector presence
  | 'js-property'       // browser-resolved global property path
  | 'css-rule'          // stylesheet text fingerprint
  | 'robots-txt'        // robots.txt body fingerprint
  | 'url-pattern'       // page URL path fingerprint
  | 'xhr-host'          // observed XHR/fetch destination
  | 'cert-issuer'       // TLS certificate issuer
  | 'inline-script'     // inline <script> body fingerprint
  | 'probe'             // bounded, V10-executed URL probe
  | 'required-by';      // detector-generated relationship evidence

/** NEW: distinguishes independent observation from inference. */
export type EvidenceRole = 'direct' | 'corroborating' | 'inferred';

export interface TechnologyEvidence {
  signalType: SignalType;
  source: string;
  matched: string;
  confidence: TechnologyConfidence;
  capturedVersion?: string;
  /** NEW. Absent on evidence produced by the V10 base detector. */
  role?: EvidenceRole;
  /** NEW. Page URL this signal was observed on (site-wide traceability). */
  observedOn?: string;
}

/** NEW: version provenance. */
export interface VersionEvidence {
  version: string;
  source: string;
  signalType: SignalType;
}

export type VersionConfidence = 'high' | 'medium' | 'conflicting' | 'none';

/** NEW: relationship edges for a detection. */
export interface TechnologyRelationships {
  implies: string[];
  impliedBy: string[];
  requires: string[];
  requiredBy: string[];
  excludes: string[];
}

/** NEW: deterministic, evidence-backed audit linkage only. */
export interface TechnologyAuditRelevance {
  categories: string[];
  reason: string;
  /** Evidence indices within the detection that justify this linkage. */
  evidenceRefs: number[];
}

/** NEW: observational risk metadata. Never asserts "outdated". */
export interface TechnologyRisk {
  versionKnown: boolean;
  /** Stays 'unknown' until an authoritative lifecycle source exists. */
  outdatedRisk: 'unknown' | 'possible';
  exposedVersion: boolean;
}

/** NEW: maintainable descriptive metadata. */
export interface TechnologyMetadata {
  description?: string;
  vendor?: string;
  openSource?: boolean;
  saas?: boolean;
  ecosystem?: string;
  aliases?: string[];
}

export interface TechnologyDetection {
  slug: string;
  name: string;
  category: TechnologyCategoryId;
  icon: string;
  homepage: string;
  version?: string;
  confidence: TechnologyConfidence;
  evidence: TechnologyEvidence[];
  implied: boolean;
  // ── new, all optional ──
  explanation?: string;
  versionEvidence?: VersionEvidence[];
  versionConfidence?: VersionConfidence;
  relationships?: TechnologyRelationships;
  auditRelevance?: TechnologyAuditRelevance;
  technologyRisk?: TechnologyRisk;
  metadata?: TechnologyMetadata;
  /** Set when `excludes` suppressed this detection. */
  suppressedBy?: string;
  /** Set when `requires`/`requiresCategory` was unmet. */
  unmetDependency?: string;
}

/** NEW: per-detection evidence-role tally for the UI. */
export interface EvidenceBreakdown {
  direct: number;
  corroborating: number;
  inferred: number;
}

export interface TechnologyIntelligence {
  detections: TechnologyDetection[];
  tentative: TechnologyDetection[];
  stats: {
    detected: number;
    tentative: number;
    byCategory: Record<TechnologyCategoryId, number>;
    signalsEvaluated: number;
    // ── new ──
    evidenceSignals?: number;
    categoriesRepresented?: number;
  };
  /** NEW: detections suppressed by excludes/requires, retained for audit. */
  suppressed?: TechnologyDetection[];
}

export interface TechnologyInput {
  url: string;
  html?: string;
  metaTags?: Array<{ name?: string; property?: string; content: string }>;
  headers?: Record<string, string | string[] | undefined>;
  cookieNames?: string[];
  scriptUrls?: string[];
  stylesheetUrls?: string[];
  resourceUrls?: string[];
  requestHosts?: string[];
  runtime?: {
    globals?: string[];
    domMarkers?: string[];
    versions?: Record<string, string>;
  };
  domAttributes?: Array<{ name: string; value: string }>;
  // ── new, all optional; rules silently skip when absent ──
  robotsTxt?: string;
  certificateIssuer?: string;
  xhrHosts?: string[];
  inlineScripts?: string[];
  cssText?: string[];
  /** Selectors V10's browser layer confirmed present (see requestManifest). */
  presentSelectors?: string[];
  /** JS property paths confirmed present; value may carry a version. */
  presentJsProperties?: Record<string, string | boolean>;
  /** Results of probes V10 executed through its own safe fetcher. */
  probeResults?: Record<string, { status: number; bodySnippet?: string }>;
}

/* ── NEW: site-wide model ──────────────────────────────────────────── */

export interface PageTechnologyResult {
  url: string;
  intelligence: TechnologyIntelligence;
}

export interface TechnologyCoverage {
  slug: string;
  name: string;
  category: TechnologyCategoryId;
  icon: string;
  homepage: string;
  pageCount: number;
  totalPages: number;
  coveragePct: number;
  firstSeenUrl: string;
  lastSeenUrl: string;
  confidenceStable: boolean;
  observedConfidences: TechnologyConfidence[];
  versions: string[];
}

export type VarianceKind =
  | 'infrastructure-varies'
  | 'analytics-varies'
  | 'partial-coverage'
  | 'single-page-only'
  | 'version-varies';

export interface TechnologyVarianceObservation {
  kind: VarianceKind;
  /** Observation, not a finding. Never phrased as a defect. */
  summary: string;
  slugs: string[];
  detail: Array<{ slug: string; urls: string[] }>;
}

export interface SiteTechnologyIntelligence {
  totalPages: number;
  coverage: TechnologyCoverage[];
  observations: TechnologyVarianceObservation[];
  stats: {
    technologies: number;
    categoriesRepresented: number;
    evidenceSignals: number;
    averageCoveragePct: number;
  };
}

/* ── NEW: manifest the engine publishes for V10 to resolve ─────────── */

export interface TechnologyRequestManifest {
  selectors: string[];
  jsProperties: string[];
  probes: Array<{ id: string; path: string; expectStatus?: number }>;
}
