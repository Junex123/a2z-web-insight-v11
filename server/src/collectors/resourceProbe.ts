import * as cheerio from "cheerio";
import type { ResourceIntelligence, ResourceKind, ResourceKindTotals, ResourceProbeEntry, ThirdPartyOriginInfo } from "../types.js";
import { fetchResourceHead } from "./resourceFetcher.js";
import { categorizeThirdPartyOrigin } from "../analysis/thirdPartyCatalog.js";

/**
 * Extracts and probes the sub-resources a page's HTML actually
 * references (scripts, stylesheets, images, fonts) with a real,
 * bounded HEAD request each - genuine Content-Length/Cache-Control/
 * Content-Encoding/Content-Type evidence, no browser, no estimates.
 *
 * Deliberately bounded on two axes so a single scan can't turn into an
 * unbounded fan-out against a third party's infrastructure:
 *   - MAX_PROBES candidate resources total (env: RESOURCE_PROBE_MAX)
 *   - PROBE_CONCURRENCY in flight at once (env: RESOURCE_PROBE_CONCURRENCY)
 * When a page references more candidates than the cap, scripts/
 * stylesheets/fonts are prioritized (there are usually few and they're
 * usually the most performance-relevant) and images fill the remainder
 * - `truncated: true` and `candidateCount` vs `probedCount` make the
 * partial coverage explicit rather than silently under-reporting.
 *
 * This is HTTP-only: it cannot tell whether a resource actually blocks
 * rendering, gets requested by runtime JS, or hits a warm cache on a
 * real visit. It reports what a HEAD request to the page's *declared*
 * resource URLs actually returns - nothing more.
 */

const MAX_PROBES = Number(process.env.RESOURCE_PROBE_MAX) || 40;
const PROBE_CONCURRENCY = Number(process.env.RESOURCE_PROBE_CONCURRENCY) || 6;
const PROBE_TIMEOUT_MS = Number(process.env.RESOURCE_PROBE_TIMEOUT) || 5_000;

export interface ResourceProbeOptions {
  /** override for testing/tuning - defaults to RESOURCE_PROBE_MAX or 40 */
  maxProbes?: number;
  /** override for testing/tuning - defaults to RESOURCE_PROBE_CONCURRENCY or 6 */
  concurrency?: number;
  /** override for testing/tuning - defaults to RESOURCE_PROBE_TIMEOUT or 5000ms */
  timeoutMs?: number;
}

interface Candidate {
  url: string;
  kind: ResourceKind;
}

const FONT_EXTENSION_PATTERN = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const IMAGE_DATA_URI_PATTERN = /^data:/i;

function classifyLinkTag(rel: string | undefined, as: string | undefined, href: string): ResourceKind | null {
  const relLower = (rel ?? "").toLowerCase();
  if (relLower === "stylesheet") return "stylesheet";
  if (relLower === "preload" || relLower === "font") {
    if (as === "font" || FONT_EXTENSION_PATTERN.test(href)) return "font";
    if (as === "style") return "stylesheet";
    if (as === "script") return "script";
    if (as === "image") return "image";
  }
  if (FONT_EXTENSION_PATTERN.test(href)) return "font";
  return null;
}

/** Extracts every candidate sub-resource URL from the page's HTML, deduped and resolved absolute. Pure, no I/O. */
export function extractCandidateResources(bodyText: string, pageUrl: string): Candidate[] {
  const $ = cheerio.load(bodyText);
  const seen = new Set<string>();
  const scriptsAndStyles: Candidate[] = [];
  const images: Candidate[] = [];

  const add = (raw: string | undefined, kind: ResourceKind, bucket: Candidate[]) => {
    if (!raw || IMAGE_DATA_URI_PATTERN.test(raw)) return;
    let resolved: URL;
    try {
      resolved = new URL(raw, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(resolved.protocol)) return;
    resolved.hash = "";
    const href = resolved.href;
    if (seen.has(href)) return;
    seen.add(href);
    bucket.push({ url: href, kind });
  };

  $("script[src]").each((_, el) => add($(el).attr("src"), "script", scriptsAndStyles));
  $('link[rel="stylesheet"]').each((_, el) => add($(el).attr("href"), "stylesheet", scriptsAndStyles));
  $("link[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const kind = classifyLinkTag($(el).attr("rel"), $(el).attr("as"), href);
    if (kind === "font") add(href, "font", scriptsAndStyles);
    // stylesheet/script/image via <link> are rare and already covered by the dedicated selectors above when they matter
  });
  $("img[src]").each((_, el) => add($(el).attr("src"), "image", images));
  $("picture source[srcset]").each((_, el) => {
    const srcset = ($(el).attr("srcset") ?? "").trim();
    // Include every declared candidate. The existing MAX_PROBES cap still
    // bounds network work; this avoids silently ignoring the 2x/3x variants
    // that a <picture><source> actually makes available.
    for (const candidate of srcset.split(",")) {
      add(candidate.trim().split(/\s+/)[0], "image", images);
    }
  });

  // scripts/stylesheets/fonts first (usually few, usually most performance-relevant), images fill the remainder up to the cap
  return [...scriptsAndStyles, ...images];
}

async function probeOne(url: string, timeoutMs: number): Promise<Omit<ResourceProbeEntry, "kind" | "origin" | "isThirdParty">> {
  const result = await fetchResourceHead(url, timeoutMs);
  if (!result.ok) {
    return { url, probed: result.statusCode !== null, statusCode: result.statusCode, contentLength: null, contentType: null, cacheControl: null, contentEncoding: null, etag: null, probeError: result.error ?? null };
  }
  const lengthHeader = result.headers["content-length"];
  const contentLength = lengthHeader !== undefined && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  return {
    url,
    probed: true,
    statusCode: result.statusCode,
    contentLength,
    contentType: result.headers["content-type"] ?? null,
    cacheControl: result.headers["cache-control"] ?? null,
    contentEncoding: result.headers["content-encoding"] ?? null,
    etag: result.headers["etag"] ?? null,
    probeError: null,
  };
}

/** Runs `items` through `worker` with at most `concurrency` in flight at once. */
async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}

function registrableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

const EMPTY_TOTALS: ResourceKindTotals = { count: 0, sizeKnownCount: 0, knownBytes: 0 };

/**
 * Extracts candidate resources from the page's HTML, probes up to
 * MAX_PROBES of them (bounded concurrency), and aggregates the result.
 * Never throws: an individual probe failure just yields a
 * `probed: false` entry, it never aborts the batch.
 */
export async function collectResourceIntelligence(bodyText: string, pageUrl: string, options: ResourceProbeOptions = {}): Promise<ResourceIntelligence> {
  const maxProbes = options.maxProbes ?? MAX_PROBES;
  const concurrency = options.concurrency ?? PROBE_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const candidates = extractCandidateResources(bodyText, pageUrl);
  const toProbe = candidates.slice(0, maxProbes);
  const truncated = candidates.length > toProbe.length;

  let pageHost: string;
  try {
    pageHost = registrableHost(new URL(pageUrl).hostname);
  } catch {
    pageHost = "";
  }

  const probed = await runWithConcurrency(toProbe, concurrency, (c) => probeOne(c.url, timeoutMs));

  const entries: ResourceProbeEntry[] = probed.map((p, i) => {
    const kind = toProbe[i].kind;
    let origin = "";
    try {
      origin = registrableHost(new URL(p.url).hostname);
    } catch {
      // leave empty - url was already validated when extracted, this should not happen
    }
    return { ...p, kind, origin, isThirdParty: origin !== "" && origin !== pageHost };
  });

  const totalsByKind: Record<ResourceKind, ResourceKindTotals> = {
    script: { ...EMPTY_TOTALS },
    stylesheet: { ...EMPTY_TOTALS },
    image: { ...EMPTY_TOTALS },
    font: { ...EMPTY_TOTALS },
    other: { ...EMPTY_TOTALS },
  };
  const thirdPartyByOrigin = new Map<string, { requestCount: number; knownBytes: number }>();

  for (const entry of entries) {
    const totals = totalsByKind[entry.kind];
    totals.count++;
    if (entry.contentLength !== null) {
      totals.sizeKnownCount++;
      totals.knownBytes += entry.contentLength;
    }
    if (entry.isThirdParty) {
      const agg = thirdPartyByOrigin.get(entry.origin) ?? { requestCount: 0, knownBytes: 0 };
      agg.requestCount++;
      if (entry.contentLength !== null) agg.knownBytes += entry.contentLength;
      thirdPartyByOrigin.set(entry.origin, agg);
    }
  }

  const thirdPartyOrigins: ThirdPartyOriginInfo[] = [...thirdPartyByOrigin.entries()].map(([origin, agg]) => {
    const known = categorizeThirdPartyOrigin(origin);
    return { origin, requestCount: agg.requestCount, knownBytes: agg.knownBytes, category: known?.category ?? null, vendorLabel: known?.label ?? null };
  });
  const thirdPartyRequestCount = thirdPartyOrigins.reduce((sum, o) => sum + o.requestCount, 0);
  const thirdPartyKnownBytes = thirdPartyOrigins.reduce((sum, o) => sum + o.knownBytes, 0);

  return {
    entries,
    totalsByKind,
    thirdParty: { originCount: thirdPartyOrigins.length, requestCount: thirdPartyRequestCount, knownBytes: thirdPartyKnownBytes, origins: thirdPartyOrigins },
    truncated,
    candidateCount: candidates.length,
    probedCount: entries.length,
  };
}
