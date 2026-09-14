import * as cheerio from "cheerio";
import type { Issue, ResourceIntelligence, ResourceKind, ResourceProbeEntry, Severity, ImageAttributeFacts } from "../types.js";

/**
 * Turns real, probed sub-resource evidence (collectors/resourceProbe.ts)
 * into Issues. Every finding here requires an actually-known
 * Content-Length or an actually-observed header - never a guess. This
 * is intentionally separate from analysis/issues.ts's existing
 * "blocking scripts in <head>" / "blocking stylesheets" / "HTML not
 * compressed" checks (those are about the main document and DOM
 * structure; this file is entirely about the sub-resources'
 * *response evidence* obtained via resourceProbe.ts).
 */

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 70, medium: 40, low: 15 };

let counter = 0;
function nextId(): string {
  counter += 1;
  return `performance-res-${counter}`;
}
export function resetResourceIssueIdCounter() {
  counter = 0;
}
function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  return { ...input, category: "performance", id: nextId(), priorityScore: SEVERITY_WEIGHT[input.severity] };
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}

// ---------------- A: large individual resources ----------------

const LARGE_THRESHOLDS: Record<ResourceKind, { medium: number; high: number }> = {
  script: { medium: 200_000, high: 500_000 },
  stylesheet: { medium: 100_000, high: 250_000 },
  image: { medium: 500_000, high: 1_000_000 },
  font: { medium: 150_000, high: 300_000 },
  other: { medium: 500_000, high: 1_000_000 },
};

function detectLargeResources(entries: ResourceProbeEntry[], pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  for (const entry of entries) {
    if (entry.kind === "image") continue; // images are handled as a single grouped root-cause finding, see detectImageOptimizationOpportunity()
    if (entry.contentLength === null) continue;
    const thresholds = LARGE_THRESHOLDS[entry.kind];
    if (entry.contentLength < thresholds.medium) continue;
    const severity: Severity = entry.contentLength >= thresholds.high ? "high" : "medium";
    issues.push(
      makeIssue({
        severity,
        title: `Large ${entry.kind} resource (${kb(entry.contentLength)})`,
        affected: pageUrl,
        whyItMatters: `A single ${entry.kind} this large delays everything that depends on it - scripts and stylesheets block rendering or execution until they finish downloading.`,
        estimatedImpact: `${kb(entry.contentLength)} for ${entry.url}`,
        recommendedFix:
          entry.kind === "font"
            ? "Subset the font to only the glyphs/weights actually used, and consider woff2 if not already used."
            : `Minify and/or code-split this ${entry.kind}, and check for content that shouldn't be there (unused code, embedded source maps, debug data).`,
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "header", label: "Content-Length", value: `${entry.contentLength} bytes (${entry.url})` }],
      }),
    );
  }
  return issues;
}

// ---------------- B: excessive total bytes by kind ----------------

const TOTAL_BYTES_THRESHOLDS: Partial<Record<ResourceKind, { medium: number; high: number; label: string }>> = {
  script: { medium: 600_000, high: 1_200_000, label: "JavaScript" },
  image: { medium: 1_500_000, high: 3_000_000, label: "image" },
};

function detectExcessiveTotalBytes(intel: ResourceIntelligence, pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  for (const [kind, threshold] of Object.entries(TOTAL_BYTES_THRESHOLDS) as [ResourceKind, { medium: number; high: number; label: string }][]) {
    const totals = intel.totalsByKind[kind];
    if (totals.knownBytes < threshold.medium) continue;
    const severity: Severity = totals.knownBytes >= threshold.high ? "high" : "medium";
    const partial = totals.sizeKnownCount < totals.count;
    issues.push(
      makeIssue({
        severity,
        title: `Excessive total ${threshold.label} weight`,
        affected: pageUrl,
        whyItMatters: `${threshold.label} this heavy has to be downloaded (and, for scripts, parsed and executed) before the page is fully usable, directly slowing load and interactivity.`,
        estimatedImpact: partial
          ? `At least ${kb(totals.knownBytes)} across ${totals.sizeKnownCount} of ${totals.count} probed ${threshold.label.toLowerCase()} resource(s) with a known size (some resources' sizes could not be determined, so the true total may be higher).`
          : `${kb(totals.knownBytes)} across ${totals.count} probed ${threshold.label.toLowerCase()} resource(s).`,
        recommendedFix:
          kind === "script"
            ? "Code-split and remove unused JavaScript, defer non-critical scripts, and check for duplicate library versions."
            : "Compress and appropriately size images for their actual display dimensions, and lazy-load offscreen images.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "computed", label: `Total probed ${threshold.label.toLowerCase()} bytes`, value: kb(totals.knownBytes) }],
      }),
    );
  }
  return issues;
}

// ---------------- C: missing compression on sizable text resources ----------------

const COMPRESSIBLE_MIN_BYTES = 10_000;

function looksCompressed(contentEncoding: string | null): boolean {
  if (!contentEncoding) return false;
  return /\b(gzip|br|deflate|zstd)\b/i.test(contentEncoding);
}

function detectMissingCompression(entries: ResourceProbeEntry[], pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  for (const entry of entries) {
    if (entry.kind !== "script" && entry.kind !== "stylesheet") continue;
    if (entry.contentLength === null || entry.contentLength < COMPRESSIBLE_MIN_BYTES) continue;
    if (looksCompressed(entry.contentEncoding)) continue;
    issues.push(
      makeIssue({
        severity: entry.contentLength >= 100_000 ? "high" : "medium",
        title: `${entry.kind === "script" ? "JavaScript" : "CSS"} resource served without compression`,
        affected: pageUrl,
        whyItMatters: "Text-based resources like JS and CSS typically compress to a fraction of their original size; serving them uncompressed wastes bandwidth and slows every visitor's download.",
        estimatedImpact: `${kb(entry.contentLength)} uncompressed at ${entry.url}${entry.contentEncoding ? ` (Content-Encoding: ${entry.contentEncoding})` : " (no Content-Encoding header)"}`,
        recommendedFix: "Enable gzip or Brotli compression for this resource at the web server / CDN level.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Content-Encoding", value: entry.contentEncoding ?? "missing" }],
      }),
    );
  }
  return issues;
}

// ---------------- D: missing/weak caching on static assets ----------------

const MIN_REASONABLE_MAX_AGE_SECONDS = 3600; // 1 hour - conservative floor, not demanding "immutable, 1 year" for every asset

function parseMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const match = cacheControl.match(/max-age\s*=\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function detectWeakCaching(entries: ResourceProbeEntry[], pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  const missing: ResourceProbeEntry[] = [];
  const validatorOnly: ResourceProbeEntry[] = [];
  const weak: ResourceProbeEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === "other" || !entry.probed || entry.statusCode !== 200) continue;
    if (!entry.cacheControl) {
      if (entry.etag) validatorOnly.push(entry);
      else missing.push(entry);
      continue;
    }
    if (/\bno-store\b/i.test(entry.cacheControl)) continue;
    const maxAge = parseMaxAge(entry.cacheControl);
    if (maxAge !== null && maxAge < MIN_REASONABLE_MAX_AGE_SECONDS) weak.push(entry);
  }

  if (missing.length > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Static resources with no Cache-Control header",
        affected: pageUrl,
        whyItMatters: "Without Cache-Control, browsers have no explicit freshness policy and may revalidate or re-download resources that have not changed.",
        estimatedImpact: `${missing.length} static resource(s) with no Cache-Control header, e.g. ${missing[0].url}`,
        recommendedFix: "Add an explicit Cache-Control policy with an appropriate max-age (and immutable, for hashed/versioned filenames) to static resources.",
        difficulty: "easy",
        source: "measured",
        evidence: missing.slice(0, 5).map((e) => ({ type: "header" as const, label: `${e.kind} with no Cache-Control`, value: e.url })),
      }),
    );
  }

  if (validatorOnly.length > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Static resources rely on validators without an explicit freshness lifetime",
        affected: pageUrl,
        whyItMatters: "An ETag can make conditional revalidation efficient, but without Cache-Control the browser still lacks an explicit freshness lifetime and may revalidate resources more often than necessary.",
        estimatedImpact: `${validatorOnly.length} static resource(s) expose ETag without Cache-Control, e.g. ${validatorOnly[0].url}`,
        recommendedFix: "Keep the validator if useful, but add an explicit freshness policy appropriate to the asset; use a long max-age and immutable for safely fingerprinted assets.",
        difficulty: "easy",
        source: "measured",
        evidence: validatorOnly.slice(0, 5).map((e) => ({ type: "header" as const, label: "ETag without Cache-Control", value: `${e.etag} (${e.url})` })),
      }),
    );
  }

  if (weak.length > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Static resources with a short cache lifetime",
        affected: pageUrl,
        whyItMatters: "A short max-age on a static asset means it gets revalidated or re-downloaded far more often than necessary for content that, if versioned or hashed, should rarely change.",
        estimatedImpact: `${weak.length} static resource(s) with max-age under ${MIN_REASONABLE_MAX_AGE_SECONDS}s, e.g. ${weak[0].url}`,
        recommendedFix: "For static, versioned/hashed assets, use a long max-age (for example one year) with immutable rather than a short lifetime.",
        difficulty: "easy",
        source: "measured",
        evidence: weak.slice(0, 5).map((e) => ({ type: "header" as const, label: "Cache-Control", value: `${e.cacheControl} (${e.url})` })),
      }),
    );
  }

  return issues;
}

// ---------------- E: third-party concentration ----------------

function detectThirdPartyConcentration(intel: ResourceIntelligence, pageUrl: string): Issue[] {
  if (intel.probedCount === 0) return [];
  const share = intel.thirdParty.requestCount / intel.probedCount;
  // require both a meaningful share AND enough distinct origins to avoid
  // flagging a page that just uses one or two well-known, deliberate
  // third-party services (a font CDN, a single analytics script).
  if (share < 0.5 || intel.thirdParty.originCount < 3) return [];

  const labeled = intel.thirdParty.origins.map((o) => (o.vendorLabel ? `${o.origin} (${o.vendorLabel})` : o.origin));

  return [
    makeIssue({
      severity: intel.thirdParty.originCount >= 6 ? "high" : "medium",
      title: "Heavy reliance on third-party resources",
      affected: pageUrl,
      whyItMatters:
        "Third-party resources are outside this site's control - their availability, speed, and any changes they make can directly affect this page's load time and reliability.",
      estimatedImpact: `${intel.thirdParty.requestCount} of ${intel.probedCount} probed resources (${Math.round(share * 100)}%) come from ${intel.thirdParty.originCount} third-party origins: ${labeled.slice(0, 6).join(", ")}.`,
      recommendedFix: "Audit third-party scripts/resources for ones that aren't earning their cost, self-host what's practical, and use resource hints (preconnect) for the ones that remain.",
      difficulty: "moderate",
      source: "measured",
      evidence: [{ type: "computed", label: "Third-party origins", value: labeled.join(", ") }],
    }),
  ];
}

// ---------------- F: development-bundle filename patterns ----------------

const DEV_BUNDLE_PATTERNS = [/\.development\.js(\?|$)/i, /[-.]dev\.js(\?|$)/i, /\/unminified\//i, /\.debug\.js(\?|$)/i];

function detectDevBundles(entries: ResourceProbeEntry[], pageUrl: string): Issue[] {
  const flagged = entries.filter((e) => e.kind === "script" && DEV_BUNDLE_PATTERNS.some((re) => re.test(e.url)));
  if (flagged.length === 0) return [];
  return [
    makeIssue({
      severity: "medium",
      title: "Development build of a JavaScript library shipped to production",
      affected: pageUrl,
      whyItMatters:
        'Development builds (e.g. "react.development.js") are unminified, include extra warnings/checks, and are substantially larger and slower than their production equivalents.',
      estimatedImpact: `${flagged.length} development-looking script URL(s), e.g. ${flagged[0].url}`,
      recommendedFix: "Switch to the production build for this library (most libraries publish a matching `.production.min.js` / equivalent).",
      difficulty: "easy",
      source: "measured",
      evidence: flagged.slice(0, 5).map((e) => ({ type: "url" as const, label: "Development script URL", value: e.url })),
    }),
  ];
}

// ---------------- G: exposed source maps ----------------

function detectExposedSourceMaps(bodyText: string, entries: ResourceProbeEntry[], pageUrl: string): Issue[] {
  const leaks: string[] = [];

  // 1) inline <script> content containing a sourceMappingURL comment
  const $ = cheerio.load(bodyText);
  $("script:not([src])").each((_, el) => {
    const content = $(el).contents().text();
    if (/\/\/#\s*sourceMappingURL\s*=/.test(content)) leaks.push("inline <script> block");
  });

  // 2) an external script URL that is itself a .map file directly referenced
  for (const entry of entries) {
    if (entry.kind === "script" && /\.js\.map(\?|$)/i.test(entry.url)) leaks.push(entry.url);
  }

  if (leaks.length === 0) return [];
  return [
    makeIssue({
      severity: "low",
      title: "Source map reference found in shipped code",
      affected: pageUrl,
      whyItMatters: "A source map reference means original (often unminified, sometimes commented) source is reconstructable by anyone who requests it - fine for staging, usually unintentional in production.",
      estimatedImpact: `${leaks.length} source-map reference(s) found, e.g. ${leaks[0]}`,
      recommendedFix: "Remove sourceMappingURL comments from production builds, or ensure the referenced .map files are not actually deployed/publicly accessible.",
      difficulty: "easy",
      source: "measured",
      evidence: leaks.slice(0, 5).map((l) => ({ type: "html" as const, label: "Source map reference", value: l })),
    }),
  ];
}

// ---------------- H: duplicate library versions ----------------

const KNOWN_LIBRARIES: { name: string; pattern: RegExp }[] = [
  { name: "jQuery", pattern: /jquery[.-]?(\d+(?:\.\d+)*)/i },
  { name: "React", pattern: /\breact(?:-dom)?[.-](\d+(?:\.\d+)*)/i },
  { name: "Vue", pattern: /\bvue[.-](\d+(?:\.\d+)*)/i },
  { name: "Lodash", pattern: /lodash[.-]?(\d+(?:\.\d+)*)/i },
  { name: "Moment.js", pattern: /moment[.-]?(\d+(?:\.\d+)*)/i },
  { name: "Bootstrap", pattern: /bootstrap[.-](\d+(?:\.\d+)*)/i },
];

function detectDuplicateLibraryVersions(entries: ResourceProbeEntry[], pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  const scripts = entries.filter((e) => e.kind === "script");

  for (const lib of KNOWN_LIBRARIES) {
    const matches = new Map<string, string>(); // version -> url
    for (const entry of scripts) {
      const m = entry.url.match(lib.pattern);
      if (m && m[1]) matches.set(m[1], entry.url);
    }
    if (matches.size > 1) {
      const versions = [...matches.entries()];
      issues.push(
        makeIssue({
          severity: "medium",
          title: `Multiple versions of ${lib.name} loaded`,
          affected: pageUrl,
          whyItMatters: `Loading more than one version of the same library ships redundant code (and can cause subtle bugs from version conflicts) - usually a sign one copy was added without removing an older one.`,
          estimatedImpact: versions.map(([v, u]) => `${v} (${u})`).join("; "),
          recommendedFix: `Consolidate on a single version of ${lib.name} and remove the others.`,
          difficulty: "moderate",
          source: "measured",
          evidence: versions.map(([v, u]) => ({ type: "url" as const, label: `${lib.name} ${v}`, value: u })),
        }),
      );
    }
  }
  return issues;
}

// ---------------- I: image optimization (grouped root-cause finding) ----------------

/**
 * Pure HTML-attribute facts, no HTTP involved - `loading`/`srcset`/
 * declared-width-height as literally written in the markup.
 */
export function extractImageAttributeFacts(bodyText: string): ImageAttributeFacts[] {
  const $ = cheerio.load(bodyText);
  const facts: ImageAttributeFacts[] = [];
  $("img").each((i, el) => {
    const $el = $(el);
    const src = $el.attr("src") ?? "";
    if (!src) return;
    facts.push({
      src,
      domOrder: i,
      hasWidth: !!$el.attr("width"),
      hasHeight: !!$el.attr("height"),
      loading: $el.attr("loading") ?? null,
      hasSrcset: !!$el.attr("srcset"),
    });
  });
  return facts;
}

const OVERSIZED_IMAGE_BYTES = 150_000;
/** images before this DOM position are treated as likely above-the-fold and not flagged for missing lazy-loading */
const LIKELY_ABOVE_FOLD_COUNT = 3;

/**
 * A single, consolidated "image optimization" finding rather than one
 * Issue per oversized image / missing loading="lazy" / missing srcset -
 * directly implementing the task's own root-cause-grouping example
 * ("12 oversized images + 8 missing lazy-loading..." -> one finding
 * with evidence underneath, not ten separate ones). Individual
 * evidence is preserved in the Issue's `evidence` array, one line per
 * SYMPTOM TYPE (with a concrete example), not one line per image.
 */
function detectImageOptimizationOpportunity(intel: ResourceIntelligence, bodyText: string, pageUrl: string, alreadyExplainedUrls: Set<string> = new Set()): Issue[] {
  const attrFacts = extractImageAttributeFacts(bodyText);
  const bySrc = new Map(attrFacts.map((f) => [f.src, f]));

  const probedImages = intel.entries.filter((e) => e.kind === "image" && e.probed && !alreadyExplainedUrls.has(e.url));
  const oversized = probedImages.filter((e) => e.contentLength !== null && e.contentLength >= OVERSIZED_IMAGE_BYTES);

  const missingLazy = attrFacts.filter((f) => {
    if (f.domOrder < LIKELY_ABOVE_FOLD_COUNT) return false;
    if (f.loading && f.loading.toLowerCase() === "lazy") return false;
    try {
      if (alreadyExplainedUrls.has(new URL(f.src, pageUrl).href)) return false;
    } catch {}
    return true;
  });

  const missingSrcset = oversized
    .map((e) => bySrc.get(e.url) ?? bySrc.get(new URL(e.url).pathname)) // probe URL is absolute; markup src may be relative - best-effort match
    .filter((f): f is ImageAttributeFacts => !!f && !f.hasSrcset);

  const symptomCount = [oversized.length, missingLazy.length, missingSrcset.length].filter((n) => n > 0).length;
  if (symptomCount === 0) return [];

  const evidence: Issue["evidence"] = [];
  if (oversized.length > 0) {
    const totalBytes = oversized.reduce((sum, e) => sum + (e.contentLength ?? 0), 0);
    evidence.push({ type: "computed", label: "Oversized images", value: `${oversized.length} image(s) over ${kb(OVERSIZED_IMAGE_BYTES)}, totaling ${kb(totalBytes)} - e.g. ${oversized[0].url} (${kb(oversized[0].contentLength!)})` });
  }
  if (missingLazy.length > 0) {
    evidence.push({ type: "html", label: "Missing lazy-loading", value: `${missingLazy.length} image(s) beyond the first ${LIKELY_ABOVE_FOLD_COUNT} without loading="lazy" - e.g. ${missingLazy[0].src}` });
  }
  if (missingSrcset.length > 0) {
    evidence.push({ type: "html", label: "Missing responsive images", value: `${missingSrcset.length} large image(s) with no srcset for different viewport sizes - e.g. ${missingSrcset[0].src}` });
  }

  const severity: Severity = oversized.reduce((sum, e) => sum + (e.contentLength ?? 0), 0) >= 1_000_000 || oversized.length >= 3 ? "high" : symptomCount >= 2 ? "medium" : "low";

  return [
    makeIssue({
      severity,
      title: "Image optimization is a significant performance opportunity",
      affected: pageUrl,
      whyItMatters:
        "Images are usually the largest share of a typical page's weight. Oversized files, eagerly-loading offscreen images, and serving one image size to every device all compound into slower loads, especially on mobile connections.",
      estimatedImpact: `${symptomCount} related image-optimization issue(s) found across ${probedImages.length} probed image(s) (see evidence below for each).`,
      recommendedFix: "Compress/resize oversized images for their actual display size, add loading=\"lazy\" to offscreen images, and use srcset to serve appropriately-sized images per device.",
      difficulty: "moderate",
      source: "measured",
      evidence,
    }),
  ];
}

export function detectResourceIssues(intel: ResourceIntelligence, bodyText: string, pageUrl: string, alreadyExplainedImageUrls: Set<string> = new Set()): Issue[] {
  return [
    ...detectLargeResources(intel.entries, pageUrl),
    ...detectExcessiveTotalBytes(intel, pageUrl),
    ...detectMissingCompression(intel.entries, pageUrl),
    ...detectWeakCaching(intel.entries, pageUrl),
    ...detectThirdPartyConcentration(intel, pageUrl),
    ...detectDevBundles(intel.entries, pageUrl),
    ...detectExposedSourceMaps(bodyText, intel.entries, pageUrl),
    ...detectDuplicateLibraryVersions(intel.entries, pageUrl),
    ...detectImageOptimizationOpportunity(intel, bodyText, pageUrl, alreadyExplainedImageUrls),
  ];
}
