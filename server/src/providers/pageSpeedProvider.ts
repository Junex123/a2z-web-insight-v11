import type {
  CoreWebVitalsEvidence,
  CwvMetricKey,
  LcpElementInfo,
  LayoutShiftElementInfo,
  NormalizedMetricValue,
  PerformanceProvider,
  PerformanceProviderResult,
} from "../types.js";
import { classifyMetric } from "../analysis/performanceThresholds.js";
import { withRetry } from "../net/retry.js";
import { logEvent } from "../logging/logger.js";

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const DEFAULT_TIMEOUT_MS = Number(process.env.PAGESPEED_TIMEOUT) || 15_000;
const DEFAULT_MAX_RETRIES = Number(process.env.MAX_RETRIES) || 2;
const RETRY_BASE_DELAY_MS = 250;

/** 5xx statuses worth a retry - a transient blip on Google's side, not our request being wrong. */
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

export interface PageSpeedProviderOptions {
  /** defaults to PAGESPEED_INSIGHTS_API_KEY, falling back to PAGESPEED_API_KEY */
  apiKey?: string;
  /** injectable for tests - defaults to the global fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  strategy?: "mobile" | "desktop";
  maxRetries?: number;
  /** injectable for deterministic retry-delay tests */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown internally for failures worth retrying; carries the terminal result to return if retries run out. */
class TransientProviderFailure extends Error {
  constructor(public readonly result: PerformanceProviderResult) {
    super(result.errorMessage ?? "transient PageSpeed failure");
  }
}

/**
 * Real PageSpeed Insights / Lighthouse provider.
 *
 * Never throws: every failure mode (missing key, timeout, rate limit,
 * network error, malformed response) resolves to a PerformanceProviderResult
 * with a status other than "available", so callers (the pipeline) can
 * always continue the rest of the scan. Transient failures (network
 * errors, 5xx) get a small number of bounded retries with backoff before
 * giving up; permanent failures (429, other 4xx, malformed response) are
 * never retried.
 */
export class PageSpeedProvider implements PerformanceProvider {
  name = "pagespeed-insights";

  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly strategy: "mobile" | "desktop";
  private readonly maxRetries: number;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(options: PageSpeedProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PAGESPEED_INSIGHTS_API_KEY ?? process.env.PAGESPEED_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.strategy = options.strategy ?? "mobile";
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = options.sleep;
  }

  async analyze(url: string): Promise<PerformanceProviderResult> {
    if (!this.apiKey) {
      return {
        status: "not_configured",
        evidence: null,
        errorMessage: "PAGESPEED_INSIGHTS_API_KEY is not set - Core Web Vitals were not requested.",
      };
    }

    logEvent("pagespeed_request", { url, strategy: this.strategy });

    try {
      return await withRetry(() => this.attemptOnce(url), {
        maxRetries: this.maxRetries,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        sleep: this.sleep,
        shouldRetry: (err) => err instanceof TransientProviderFailure,
      });
    } catch (err) {
      if (err instanceof TransientProviderFailure) {
        logEvent("pagespeed_failure", { url, status: err.result.status, reason: err.result.errorMessage });
        return err.result;
      }
      logEvent("pagespeed_failure", { url, status: "error", reason: "unexpected exception" });
      return { status: "error", evidence: null, errorMessage: "The performance provider failed unexpectedly." };
    }
  }

  /** A single attempt. Throws TransientProviderFailure for retry-worthy conditions; returns directly for everything else. */
  private async attemptOnce(url: string): Promise<PerformanceProviderResult> {
    const endpoint = new URL(PSI_ENDPOINT);
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("key", this.apiKey!);
    endpoint.searchParams.set("category", "PERFORMANCE");
    endpoint.searchParams.set("strategy", this.strategy);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(endpoint.toString(), { signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        // timeouts are not retried: retrying would multiply an already-slow
        // wait by (maxRetries + 1), which is a bad tradeoff for a
        // synchronous user-facing request.
        return { status: "timeout", evidence: null, errorMessage: `PageSpeed Insights did not respond within ${this.timeoutMs}ms.` };
      }
      // a network-level failure (DNS, connection refused, etc.) is usually
      // transient and fails fast - worth a bounded retry.
      throw new TransientProviderFailure({ status: "error", evidence: null, errorMessage: "Could not reach PageSpeed Insights." });
    }
    clearTimeout(timer);

    if (res.status === 429) {
      // never retried: retrying a rate-limited call immediately just makes
      // the rate limiting worse.
      return { status: "rate_limited", evidence: null, errorMessage: "PageSpeed Insights rate limit exceeded." };
    }
    if (RETRYABLE_HTTP_STATUSES.has(res.status)) {
      throw new TransientProviderFailure({
        status: "error",
        evidence: null,
        errorMessage: `PageSpeed Insights returned HTTP ${res.status}.`,
      });
    }
    if (res.status === 400) {
      return { status: "error", evidence: null, errorMessage: "PageSpeed Insights could not analyze this URL." };
    }
    if (!res.ok) {
      return { status: "error", evidence: null, errorMessage: `PageSpeed Insights returned HTTP ${res.status}.` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { status: "error", evidence: null, errorMessage: "PageSpeed Insights returned an unreadable response." };
    }

    const evidence = normalizePageSpeedResponse(json, this.strategy);
    if (!evidence) {
      return { status: "error", evidence: null, errorMessage: "PageSpeed Insights response did not contain usable performance data." };
    }

    return { status: "available", evidence };
  }
}

// ---------------------------------------------------------------------
// Normalization: raw Google PSI JSON -> our stable internal shape.
// Everything here is defensive (optional chaining / typeof checks)
// because we do not control or trust the shape of a third-party API
// response. Any missing metric becomes { value: null, status: "unavailable" }
// - never 0, never guessed.
// ---------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function labAuditValue(audits: unknown, auditId: string): number | null {
  if (!isRecord(audits)) return null;
  const audit = audits[auditId];
  if (!isRecord(audit)) return null;
  const value = audit.numericValue;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fieldMetricPercentile(metrics: unknown, metricId: string): number | null {
  if (!isRecord(metrics)) return null;
  const metric = metrics[metricId];
  if (!isRecord(metric)) return null;
  const percentile = metric.percentile;
  return typeof percentile === "number" && Number.isFinite(percentile) ? percentile : null;
}

/** Prefers real-user field data (CrUX) over lab data, per Google's own guidance. */
function resolveMetric(
  key: CwvMetricKey,
  fieldValue: number | null,
  labValue: number | null,
): NormalizedMetricValue {
  const value = fieldValue ?? labValue;
  if (value === null) {
    return { value: null, unit: key === "cls" ? "unitless" : "ms", status: "unavailable", source: "unavailable" };
  }
  return {
    value,
    unit: key === "cls" ? "unitless" : "ms",
    status: classifyMetric(key, value),
    source: fieldValue !== null ? "pagespeed-field" : "pagespeed-lab",
  };
}

export function normalizePageSpeedResponse(json: unknown, strategy: "mobile" | "desktop"): CoreWebVitalsEvidence | null {
  if (!isRecord(json)) return null;

  const lighthouseResult = json.lighthouseResult;
  const loadingExperience = json.loadingExperience;

  // We require at least a lighthouse lab result OR field data to consider
  // the response usable at all.
  if (!isRecord(lighthouseResult) && !isRecord(loadingExperience)) return null;

  const audits = isRecord(lighthouseResult) ? lighthouseResult.audits : undefined;
  const fieldMetrics = isRecord(loadingExperience) ? loadingExperience.metrics : undefined;

  // CLS field percentile is reported x100 (e.g. 5 means 0.05); lab value is already a decimal.
  const clsFieldRaw = fieldMetricPercentile(fieldMetrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const clsField = clsFieldRaw === null ? null : clsFieldRaw / 100;

  const metrics: Record<CwvMetricKey, NormalizedMetricValue> = {
    lcp: resolveMetric(
      "lcp",
      fieldMetricPercentile(fieldMetrics, "LARGEST_CONTENTFUL_PAINT_MS"),
      labAuditValue(audits, "largest-contentful-paint"),
    ),
    inp: resolveMetric(
      "inp",
      fieldMetricPercentile(fieldMetrics, "INTERACTION_TO_NEXT_PAINT"),
      labAuditValue(audits, "interaction-to-next-paint"),
    ),
    cls: resolveMetric("cls", clsField, labAuditValue(audits, "cumulative-layout-shift")),
    ttfb: resolveMetric(
      "ttfb",
      fieldMetricPercentile(fieldMetrics, "EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
      labAuditValue(audits, "server-response-time"),
    ),
    fcp: resolveMetric(
      "fcp",
      fieldMetricPercentile(fieldMetrics, "FIRST_CONTENTFUL_PAINT_MS"),
      labAuditValue(audits, "first-contentful-paint"),
    ),
    speedIndex: resolveMetric("speedIndex", null, labAuditValue(audits, "speed-index")),
    tbt: resolveMetric("tbt", null, labAuditValue(audits, "total-blocking-time")),
  };

  let lighthousePerformanceScore: number | null = null;
  if (isRecord(lighthouseResult)) {
    const categories = lighthouseResult.categories;
    if (isRecord(categories)) {
      const perf = categories.performance;
      if (isRecord(perf) && typeof perf.score === "number") {
        lighthousePerformanceScore = Math.round(perf.score * 100);
      }
    }
  }

  const opportunities = extractOpportunities(audits);
  const lcpElement = extractLcpElement(audits);
  const layoutShiftElements = extractLayoutShiftElements(audits);

  const metricsAvailable = Object.values(metrics).filter((m) => m.value !== null).length;

  return {
    strategy,
    lighthousePerformanceScore,
    metrics,
    opportunities,
    coverage: { metricsAvailable, metricsTotal: Object.keys(metrics).length },
    lcpElement,
    layoutShiftElements,
  };
}

/**
 * Best-effort extraction from the "largest-contentful-paint-element"
 * Lighthouse audit - see LcpElementInfo's doc comment in types.ts for
 * why this is deliberately defensive. Lighthouse nests the element
 * under `.node` on most versions we've seen documented, but not all,
 * so both shapes are checked.
 */
function extractLcpElement(audits: unknown): LcpElementInfo | null {
  if (!isRecord(audits)) return null;
  const audit = audits["largest-contentful-paint-element"];
  if (!isRecord(audit)) return null;
  const details = audit.details;
  if (!isRecord(details) || !Array.isArray(details.items) || details.items.length === 0) return null;

  const first = details.items[0];
  if (!isRecord(first)) return null;
  const node = isRecord(first.node) ? first.node : first;

  const snippet = typeof node.snippet === "string" ? node.snippet : null;
  const selector = typeof node.selector === "string" ? node.selector : typeof node.nodeLabel === "string" ? node.nodeLabel : null;
  if (!snippet && !selector) return null;

  return { nodeSnippet: snippet, selector, imageUrl: snippet ? extractUrlFromSnippet(snippet) : null };
}

const MAX_LAYOUT_SHIFT_ELEMENTS = 5;

/**
 * Best-effort extraction from the "layout-shift-elements" Lighthouse
 * audit - the CLS counterpart to extractLcpElement() above, same
 * defensive shape-checking. Lighthouse's `score` for each item (its
 * contribution to overall CLS) is sometimes nested under `.node` and
 * sometimes on the item directly, depending on version - both are
 * checked; if neither is a number, `scoreContribution` stays null
 * rather than defaulting to 0 (which would understate its impact).
 * `hasDeclaredDimensions` is parsed from the element's OWN snippet as
 * captured by Lighthouse (the actual shifting element), not re-derived
 * from this scan's static HTML fetch - `null` when the snippet itself
 * isn't available, since without it we genuinely can't tell.
 */
function extractLayoutShiftElements(audits: unknown): LayoutShiftElementInfo[] {
  if (!isRecord(audits)) return [];
  const audit = audits["layout-shift-elements"];
  if (!isRecord(audit)) return [];
  const details = audit.details;
  if (!isRecord(details) || !Array.isArray(details.items)) return [];

  const results: LayoutShiftElementInfo[] = [];
  for (const item of details.items.slice(0, MAX_LAYOUT_SHIFT_ELEMENTS)) {
    if (!isRecord(item)) continue;
    const node = isRecord(item.node) ? item.node : item;
    const snippet = typeof node.snippet === "string" ? node.snippet : null;
    const selector = typeof node.selector === "string" ? node.selector : typeof node.nodeLabel === "string" ? node.nodeLabel : null;
    if (!snippet && !selector) continue;

    const rawScore = typeof item.score === "number" ? item.score : isRecord(item.node) && typeof (item.node as Record<string, unknown>).score === "number" ? ((item.node as Record<string, unknown>).score as number) : null;
    const hasDeclaredDimensions = snippet ? /\bwidth\s*=\s*["']?\d/.test(snippet) && /\bheight\s*=\s*["']?\d/.test(snippet) : null;

    results.push({
      nodeSnippet: snippet,
      selector,
      imageUrl: snippet ? extractUrlFromSnippet(snippet) : null,
      hasDeclaredDimensions,
      scoreContribution: rawScore,
    });
  }
  return results;
}

/** Pulls a src="..." or CSS background-image: url(...) out of an HTML snippet string. Returns null (never a guess) if neither pattern is found. */
function extractUrlFromSnippet(snippet: string): string | null {
  const srcMatch = snippet.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  if (srcMatch) return srcMatch[1];
  const bgMatch = snippet.match(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/i);
  if (bgMatch) return bgMatch[1];
  return null;
}

function extractOpportunities(audits: unknown): CoreWebVitalsEvidence["opportunities"] {
  if (!isRecord(audits)) return [];
  const results: CoreWebVitalsEvidence["opportunities"] = [];

  for (const [id, raw] of Object.entries(audits)) {
    if (!isRecord(raw)) continue;
    const details = raw.details;
    if (!isRecord(details) || details.type !== "opportunity") continue;
    const savings = details.overallSavingsMs;
    const title = typeof raw.title === "string" ? raw.title : id;
    results.push({
      id,
      title,
      estimatedSavingsMs: typeof savings === "number" && Number.isFinite(savings) ? savings : null,
    });
  }

  return results
    .sort((a, b) => (b.estimatedSavingsMs ?? 0) - (a.estimatedSavingsMs ?? 0))
    .slice(0, 5);
}
