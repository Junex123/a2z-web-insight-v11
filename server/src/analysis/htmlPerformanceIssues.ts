import type { Evidence, HtmlAnalysis, Issue } from "../types.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `performance-html-${counter}`;
}
export function resetHtmlPerformanceIssueIdCounter() {
  counter = 0;
}

function makeIssue(input: Omit<Issue, "id" | "category" | "priorityScore" | "source">): Issue {
  const priorityScore = { critical: 100, high: 70, medium: 40, low: 15 }[input.severity];
  return { ...input, id: nextId(), category: "performance", priorityScore, source: "measured" };
}

const FONT_VARIANT_WARN_THRESHOLD = 4;
const RESOURCE_HINT_EXCESSIVE_THRESHOLD = 6; // combined preconnect + dns-prefetch

/**
 * Turns HtmlAnalysis.resourceIntel (see collectors/htmlCollector.ts)
 * into Issues. Every rule here reads only from the already-fetched
 * HTML - no sub-resource fetching, no browser execution. This is
 * deliberately a SEPARATE module from analysis/issues.ts (which
 * already owns the existing render-blocking-script/stylesheet-in-head
 * rules) and analysis/resourceIssues.ts (which owns PageSpeed/
 * Lighthouse-sourced resource evidence) - this one owns what's
 * observable purely from HTML markup patterns: resource hints, image
 * dimension attributes, duplicate resource references, and obvious
 * production-build mistakes (localhost refs, exposed source maps).
 */
export function detectHtmlPerformanceIssues(html: HtmlAnalysis, affectedUrl: string): Issue[] {
  const r = html.resourceIntel;
  if (!r) return [];
  const issues: Issue[] = [];

  // ---------------- Images: missing dimensions (CLS risk) ----------------
  if (r.images.missingDimensions > 0) {
    issues.push(
      makeIssue({
        severity: r.images.missingDimensions >= 5 ? "high" : "medium",
        title: "Images missing explicit width/height",
        affected: affectedUrl,
        whyItMatters:
          "Without a declared width and height (or aspect-ratio), the browser cannot reserve space for an image before it loads, which is a common cause of layout shift (poor CLS).",
        estimatedImpact: `${r.images.missingDimensions} <img> tag(s) have neither a width nor a height attribute.`,
        recommendedFix: "Add width and height attributes (or a CSS aspect-ratio) to every <img> so the browser can reserve layout space before the image loads.",
        difficulty: "easy",
        evidence: r.images.missingDimensionsExamples.map((src): Evidence => ({ type: "html", label: "Image missing width/height", value: src })),
      }),
    );
  }

  // ---------------- Images: likely-eager below-the-fold images ----------------
  if (r.images.eagerLikelyBelowFold > 0) {
    issues.push(
      makeIssue({
        severity: r.images.eagerLikelyBelowFold >= 8 ? "medium" : "low",
        title: "Images later in the page are not marked for lazy loading",
        affected: affectedUrl,
        whyItMatters:
          "Images well past the first screenful of content are plausibly below the fold; loading them eagerly competes for bandwidth with what's actually visible on load. This is a document-order heuristic, not a measured viewport position - treat it as a hint, not a proven fact.",
        estimatedImpact: `${r.images.eagerLikelyBelowFold} <img> tag(s) after the first few in document order have no loading="lazy".`,
        recommendedFix: 'Add loading="lazy" to images that are not part of the initial viewport, and verify visually which images actually are above the fold.',
        difficulty: "easy",
        evidence: r.images.eagerLikelyBelowFoldExamples.map((src): Evidence => ({ type: "html", label: "Image without loading=lazy", value: src })),
      }),
    );
  }

  // ---------------- Development/localhost references in production HTML ----------------
  if (r.scripts.devOrLocalhostRefs.length > 0) {
    issues.push(
      makeIssue({
        severity: "critical",
        title: "Development/localhost resource referenced in production HTML",
        affected: affectedUrl,
        whyItMatters:
          "A resource pointing at localhost or a common dev-server port will fail to load entirely for real visitors - this is a production-build mistake, not just a performance nit.",
        estimatedImpact: `${r.scripts.devOrLocalhostRefs.length} resource reference(s) point at a development host/port.`,
        recommendedFix: "Confirm the production build/deploy is injecting the correct base URLs and rebuild/redeploy - this typically means an environment variable or build config pointed at a dev server.",
        difficulty: "moderate",
        evidence: r.scripts.devOrLocalhostRefs.slice(0, 5).map((src): Evidence => ({ type: "html", label: "Development/localhost resource reference", value: src })),
      }),
    );
  }

  // ---------------- Source maps referenced from production HTML ----------------
  if (r.scripts.sourceMapRefs.length > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Source map referenced from production HTML",
        affected: affectedUrl,
        whyItMatters:
          "A source map reference visible in the shipped HTML/JS suggests source maps may be deployed alongside production code, which can expose original (unminified, commented) source to anyone who looks.",
        estimatedImpact: `${r.scripts.sourceMapRefs.length} source map reference(s) found.`,
        recommendedFix: "Exclude .map files from the production deploy, or restrict access to them, unless intentionally shipping them for error-reporting tooling.",
        difficulty: "easy",
        evidence: r.scripts.sourceMapRefs.map((ref): Evidence => ({ type: "html", label: "Source map reference", value: ref })),
      }),
    );
  }

  // ---------------- Duplicate script/stylesheet requests ----------------
  if (r.scripts.duplicateSrcCount > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "The same script is referenced more than once",
        affected: affectedUrl,
        whyItMatters: "Referencing the same script URL multiple times typically means the browser requests (or at minimum parses/evaluates) it more than once - wasted work for no benefit.",
        estimatedImpact: `${r.scripts.duplicateSrcCount} script URL(s) appear more than once in the document.`,
        recommendedFix: "Remove the duplicate <script> tag(s) - this is usually leftover from a template/component that doesn't check whether the script was already injected.",
        difficulty: "easy",
        evidence: r.scripts.duplicateSrcExamples.map((src): Evidence => ({ type: "html", label: "Duplicate script reference", value: src })),
      }),
    );
  }

  if (r.stylesheets.duplicateHrefCount > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "The same stylesheet is referenced more than once",
        affected: affectedUrl,
        whyItMatters: "A duplicated stylesheet reference adds an unnecessary request/parse without adding any new styles.",
        estimatedImpact: `${r.stylesheets.duplicateHrefCount} stylesheet URL(s) appear more than once in the document.`,
        recommendedFix: "Remove the duplicate <link rel=\"stylesheet\"> tag(s).",
        difficulty: "easy",
        evidence: r.stylesheets.duplicateHrefExamples.map((href): Evidence => ({ type: "html", label: "Duplicate stylesheet reference", value: href })),
      }),
    );
  }

  // ---------------- Excessive inline script/style payload ----------------
  if (r.scripts.inlineScriptBytes > 50_000) {
    issues.push(
      makeIssue({
        severity: r.scripts.inlineScriptBytes > 150_000 ? "high" : "medium",
        title: "Large amount of inline JavaScript in the document",
        affected: affectedUrl,
        whyItMatters: "Inline scripts block HTML parsing at the point they appear and cannot be cached separately from the page, unlike an external file.",
        estimatedImpact: `${Math.round(r.scripts.inlineScriptBytes / 1024)}KB of inline <script> content.`,
        recommendedFix: "Move large inline scripts to an external, cacheable file (with defer/async as appropriate).",
        difficulty: "moderate",
        evidence: [{ type: "computed", label: "Inline script bytes", value: `${Math.round(r.scripts.inlineScriptBytes / 1024)}KB` }],
      }),
    );
  }

  // ---------------- Resource hints ----------------
  if (r.resourceHints.preloadMissingAs > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: '<link rel="preload"> without an "as" attribute',
        affected: affectedUrl,
        whyItMatters: 'A preload without a correct "as" attribute may not be applied as a high-priority fetch, and in some browsers can cause the resource to be fetched twice.',
        estimatedImpact: `${r.resourceHints.preloadMissingAs} preload link(s) missing the "as" attribute.`,
        recommendedFix: 'Add the appropriate as="script"/"style"/"font"/"image" (etc.) attribute to each preload link.',
        difficulty: "easy",
        evidence: [{ type: "computed", label: "Preload links missing as=", value: String(r.resourceHints.preloadMissingAs) }],
      }),
    );
  }

  const originHints = r.resourceHints.preconnect + r.resourceHints.dnsPrefetch;
  if (originHints > RESOURCE_HINT_EXCESSIVE_THRESHOLD) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Excessive preconnect/dns-prefetch hints",
        affected: affectedUrl,
        whyItMatters: "Each preconnect opens a real connection speculatively; beyond a handful of origins, the browser's own connection budget means the hints stop helping and can even compete with the connections the page actually needs first.",
        estimatedImpact: `${originHints} combined preconnect/dns-prefetch hint(s) declared.`,
        recommendedFix: "Keep preconnect/dns-prefetch to the handful of origins that are actually critical for the initial render (e.g. the font CDN, the API host) and drop the rest.",
        difficulty: "easy",
        evidence: [
          { type: "computed", label: "preconnect", value: String(r.resourceHints.preconnect) },
          { type: "computed", label: "dns-prefetch", value: String(r.resourceHints.dnsPrefetch) },
        ],
      }),
    );
  }

  // ---------------- Fonts: excessive variants for one family ----------------
  for (const family of r.fonts.families) {
    if (family.variantCount > FONT_VARIANT_WARN_THRESHOLD) {
      issues.push(
        makeIssue({
          severity: "medium",
          title: "Excessive font weights/styles requested for one font family",
          affected: affectedUrl,
          whyItMatters: "Every additional weight/style is a separate font file to download; most pages use only 2-3 weights (e.g. regular + bold) of any given family.",
          estimatedImpact: `${family.variantCount} distinct weight/style combinations requested from one @font-face/Google Fonts URL.`,
          recommendedFix: "Request only the specific weights/styles the design actually uses.",
          difficulty: "easy",
          evidence: [{ type: "url", label: "Font URL with many variants", value: family.href }],
        }),
      );
    }
  }

  // ---------------- Duplicate library purpose (e.g. two icon libraries) ----------------
  const purposeGroups = new Map<string, Set<string>>();
  const KEYWORD_TO_PURPOSE: Record<string, string> = {
    "font-awesome": "icon-library",
    fontawesome: "icon-library",
    "material-icons": "icon-library",
    ionicons: "icon-library",
    feathericons: "icon-library",
    gsap: "animation-library",
    "animate.css": "animation-library",
    "aos.js": "animation-library",
    "aos.css": "animation-library",
    "framer-motion": "animation-library",
    swiper: "carousel-library",
    slick: "carousel-library",
    "owl.carousel": "carousel-library",
  };
  for (const hint of r.libraryHints) {
    const purpose = KEYWORD_TO_PURPOSE[hint.keyword];
    if (!purpose) continue;
    if (!purposeGroups.has(purpose)) purposeGroups.set(purpose, new Set());
    purposeGroups.get(purpose)!.add(hint.src);
  }
  for (const [purpose, srcs] of purposeGroups) {
    // multiple DISTINCT sources for the same purpose category = likely duplicate libraries
    const uniqueKeywordCount = new Set(r.libraryHints.filter((h) => KEYWORD_TO_PURPOSE[h.keyword] === purpose).map((h) => h.keyword)).size;
    if (uniqueKeywordCount > 1) {
      issues.push(
        makeIssue({
          severity: "medium",
          title: `Multiple ${purpose.replace("-", " ")} libraries detected`,
          affected: affectedUrl,
          whyItMatters: "Loading more than one library for the same purpose (e.g. two icon sets, two carousel libraries) typically means duplicated functionality shipped to every visitor.",
          estimatedImpact: `${uniqueKeywordCount} distinct ${purpose.replace("-", " ")} references detected.`,
          recommendedFix: "Standardize on a single library for this purpose and remove the others.",
          difficulty: "moderate",
          evidence: [...srcs].slice(0, 5).map((src): Evidence => ({ type: "html", label: `${purpose} reference`, value: src })),
        }),
      );
    }
  }

  return issues;
}
