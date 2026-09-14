import type {
  Issue,
  PerformanceOpportunity,
  PerformanceOpportunityCategory,
  PerformanceRootCauseChain,
  Severity,
  SiteWideFinding,
  SiteWidePerformanceOpportunity,
  SiteWideRootCauseChain,
} from "../types.js";

/**
 * Every rule that emits a performance Issue uses a FIXED literal title
 * string, with two known exceptions (documented, not silently papered
 * over): analysis/cwvIssues.ts interpolates the metric name and
 * severity word into the title (e.g. "LCP is poor"), and
 * analysis/resourceIssues.ts interpolates the third-party entity name
 * (e.g. `Third-party resource "Stripe" (payments) has a measurable
 * performance cost`). classify() below handles both via pattern
 * matching rather than an exact-match table entry, in addition to the
 * exact-match table for every other (genuinely fixed) title.
 *
 * Anything that doesn't match anything here lands in "other-performance"
 * rather than being silently dropped - a future new rule is visible
 * immediately, not lost until someone remembers to add a mapping.
 */
const EXACT_TITLE_CATEGORY: Record<string, PerformanceOpportunityCategory> = {
  // Images
  "Large total image payload": "image-delivery",
  "Some images could use a modern format": "image-delivery",
  "Below-the-fold images are not deferred": "image-delivery",
  "Images served substantially larger than their rendered size": "image-delivery",
  "Images missing explicit width/height": "image-delivery",
  "Images later in the page are not marked for lazy loading": "image-delivery",

  // JavaScript
  "Large JavaScript payload": "javascript-delivery",
  "Significant unused JavaScript": "javascript-delivery",
  "Unminified JavaScript": "javascript-delivery",
  "The same script is referenced more than once": "javascript-delivery",
  "Large amount of inline JavaScript in the document": "javascript-delivery",
  "High JavaScript execution time": "javascript-delivery",

  // CSS
  "Large CSS payload": "css-delivery",
  "Significant unused CSS": "css-delivery",
  "Unminified CSS": "css-delivery",
  "The same stylesheet is referenced more than once": "css-delivery",

  // Fonts
  "Large font payload": "font-delivery",
  "Fonts missing an effective font-display": "font-delivery",
  "Excessive font weights/styles requested for one font family": "font-delivery",

  // Render-blocking / network
  "Render-blocking resources delay first paint": "render-blocking-and-network",
  "Multiple render-blocking scripts in <head>": "render-blocking-and-network",
  "Many render-blocking stylesheets": "render-blocking-and-network",
  "Requested URL redirects before serving content": "render-blocking-and-network",
  "Excessive preconnect/dns-prefetch hints": "render-blocking-and-network",

  // Caching / compression
  "Static assets have a short or missing cache lifetime": "caching-and-compression",
  "Some text-based resources are not compressed": "caching-and-compression",
  "HTML response is not compressed": "caching-and-compression",
  "No Cache-Control header on the document response": "caching-and-compression",

  // Server response
  "Server response time is very slow": "server-response",
  "Server response time is slow": "server-response",

  // Document/page weight
  "Total page weight is large": "document-weight",
  "HTML document is large": "document-weight",

  // Rendering / interactivity
  "Excessive DOM size": "rendering-and-interactivity",
  "High main-thread work during load": "rendering-and-interactivity",

  // Production build quality
  "Development/localhost resource referenced in production HTML": "production-build-quality",
  "Source map referenced from production HTML": "production-build-quality",
};

const CWV_TITLE_PATTERN = / is (poor|needs improvement)$/;
const THIRD_PARTY_TITLE_PREFIX = 'Third-party resource "';

export function classifyPerformanceTitle(title: string): PerformanceOpportunityCategory {
  const exact = EXACT_TITLE_CATEGORY[title];
  if (exact) return exact;
  if (CWV_TITLE_PATTERN.test(title)) return "core-web-vitals";
  if (title.startsWith(THIRD_PARTY_TITLE_PREFIX)) return "third-party-overhead";
  return "other-performance";
}

interface CategoryMeta {
  label: string;
  whyItMatters: string;
  recommendedFix: string;
  problem: (issueCount: number) => string;
}

const CATEGORY_META: Record<PerformanceOpportunityCategory, CategoryMeta> = {
  "core-web-vitals": {
    label: "Core Web Vitals",
    whyItMatters: "LCP, INP, and CLS are Google's own measured signals for loading, responsiveness, and visual stability - they correlate directly with how fast and stable a page feels to a real visitor.",
    recommendedFix: "Address the specific metric(s) flagged below - each has its own evidence and recommendation from the underlying PageSpeed measurement.",
    problem: (n) => `${n} Core Web Vitals metric(s) are outside Google's "good" threshold on this page.`,
  },
  "image-delivery": {
    label: "Image delivery",
    whyItMatters: "Images are typically the largest share of page weight and a common cause of both slow loading and layout shift - oversized, undeferred, or dimension-less images compound into a real, measurable slowdown.",
    recommendedFix: "Compress and appropriately size images, add width/height (or aspect-ratio) to prevent layout shift, defer below-the-fold images, and use a modern format where Lighthouse confirms a real savings.",
    problem: (n) => `Image delivery has ${n} finding(s) affecting this page's load performance and/or layout stability.`,
  },
  "javascript-delivery": {
    label: "JavaScript delivery",
    whyItMatters: "JavaScript must be downloaded, parsed, compiled, and executed before it can respond to interactions - excess, unused, duplicated, or inline JS directly slows interactivity (INP/TBT) and can delay rendering.",
    recommendedFix: "Code-split and lazy-load non-critical bundles, remove unused/duplicated code, minify for production, and move large inline scripts to external cacheable files.",
    problem: (n) => `JavaScript delivery has ${n} finding(s) contributing to this page's load and interactivity cost.`,
  },
  "css-delivery": {
    label: "CSS delivery",
    whyItMatters: "Stylesheets block rendering until they're downloaded and parsed - a large or duplicated CSS payload directly delays first paint.",
    recommendedFix: "Remove unused/duplicated CSS, split critical CSS per route, and minify for production.",
    problem: (n) => `CSS delivery has ${n} finding(s) affecting how quickly this page can start rendering.`,
  },
  "font-delivery": {
    label: "Font delivery",
    whyItMatters: "Font files can be render-blocking for the text that uses them, and every extra weight/style is a separate file to download.",
    recommendedFix: "Subset fonts to the characters/weights actually used, drop unused variants, and set font-display: swap (or similar) on each @font-face.",
    problem: (n) => `Font delivery has ${n} finding(s) affecting text rendering and/or page weight.`,
  },
  "third-party-overhead": {
    label: "Third-party overhead",
    whyItMatters: "Third-party resources (analytics, ads, chat widgets, embeds, etc.) run on the same connection/main-thread budget as the page's own content - a real, measured cost, not a judgment that any specific vendor shouldn't be there.",
    recommendedFix: "For any third party with a significant measured cost below, confirm the tradeoff is intentional - load it conditionally, defer it until after first render, or self-host/facade it if it isn't essential on every page.",
    problem: (n) => `${n} third-party resource(s) have a measurable performance cost on this page.`,
  },
  "render-blocking-and-network": {
    label: "Render-blocking resources & network requests",
    whyItMatters: "Resources that block rendering, or requests that add unnecessary round trips (redirects, excessive connection hints), directly delay when a visitor sees usable content.",
    recommendedFix: "Defer/async non-critical scripts, inline or defer non-critical CSS, remove unnecessary redirects, and keep resource hints (preconnect/dns-prefetch) to only the origins that are actually critical.",
    problem: (n) => `${n} finding(s) relate to render-blocking resources or avoidable network overhead on this page.`,
  },
  "caching-and-compression": {
    label: "Caching & compression",
    whyItMatters: "Assets served without compression or with a short cache lifetime are re-downloaded at full size more often than necessary, on both first visits and repeat visits.",
    recommendedFix: "Enable gzip/Brotli compression for text-based responses, and set long, immutable Cache-Control lifetimes on fingerprinted/versioned static assets (not on dynamic HTML).",
    problem: (n) => `${n} finding(s) relate to missing compression or short-lived caching on this page's resources.`,
  },
  "server-response": {
    label: "Server response time",
    whyItMatters: "Every other metric on the page is delayed by how long the server takes to start responding (TTFB) - a slow backend caps how fast the page can possibly be.",
    recommendedFix: "Profile the server-side request handling (database queries, backend rendering, upstream API calls) for this page.",
    problem: (n) => `${n} finding(s) indicate this page's server response time is a contributing factor.`,
  },
  "document-weight": {
    label: "Total page/document weight",
    whyItMatters: "Total transferred bytes correlate directly with load time, especially on constrained mobile connections - this is the page-level total the other categories roll up into.",
    recommendedFix: "Use the other opportunity categories on this page to find which resource type (JS/CSS/images/fonts/third-party) is driving the total.",
    problem: (n) => `${n} finding(s) indicate this page's overall weight (HTML and/or total transfer) is large.`,
  },
  "rendering-and-interactivity": {
    label: "Rendering & interactivity cost",
    whyItMatters: "A very large DOM or heavy main-thread work during load increases memory use, slows style/layout recalculation, and typically correlates with slower interactivity (INP).",
    recommendedFix: "Reduce unnecessary DOM nodes/wrapper elements, virtualize long lists, and break up long JavaScript tasks.",
    problem: (n) => `${n} finding(s) relate to DOM size or main-thread work on this page.`,
  },
  "production-build-quality": {
    label: "Production build quality",
    whyItMatters: "These are production-build mistakes, not tuning opportunities - a development/localhost reference will fail entirely for real visitors, and an exposed source map can leak original source.",
    recommendedFix: "Verify the production build/deploy pipeline is configured correctly and re-deploy.",
    problem: (n) => `${n} finding(s) suggest this page may not be running a clean production build.`,
  },
  "other-performance": {
    label: "Other performance findings",
    whyItMatters: "These findings didn't fit an existing opportunity category (likely a newer rule) - each still carries its own full evidence and recommendation.",
    recommendedFix: "See each finding's individual recommendation below.",
    problem: (n) => `${n} additional performance finding(s) on this page.`,
  },
};

const SEVERITY_ORDER: Severity[] = ["low", "medium", "high", "critical"];
function worstSeverity(severities: Severity[]): Severity {
  let worst: Severity = "low";
  for (const s of severities) {
    if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst)) worst = s;
  }
  return worst;
}

type Difficulty = Issue["difficulty"];
const DIFFICULTY_ORDER: Difficulty[] = ["easy", "moderate", "hard"];

/** Mode (most common) difficulty among a group's issues; ties resolve toward the more optimistic (easier) option. */
function dominantDifficulty(difficulties: Difficulty[]): Difficulty {
  const counts: Record<Difficulty, number> = { easy: 0, moderate: 0, hard: 0 };
  for (const d of difficulties) counts[d]++;
  let best: Difficulty = "moderate";
  let bestCount = -1;
  for (const d of DIFFICULTY_ORDER) {
    if (counts[d] > bestCount) {
      best = d;
      bestCount = counts[d];
    }
  }
  return best;
}

type FixPriority = PerformanceOpportunity["fixPriority"];
const FIX_PRIORITY_ORDER: FixPriority[] = ["quick-win", "major-project", "fill-in", "reconsider"];

/**
 * Classic impact/effort quadrant, using ONLY the grouped issues' own
 * severity/difficulty fields - no new evidence, no invented numbers.
 * This answers "what should the owner fix first" (the product's own
 * stated goal), not just "what's most severe" - a high-severity,
 * low-effort opportunity is worth doing before a high-severity,
 * high-effort one, even though a naive severity-only sort would rank
 * them the same.
 */
function classifyFixPriority(severity: Severity, difficulty: Difficulty): FixPriority {
  const highImpact = severity === "critical" || severity === "high";
  const lowEffort = difficulty === "easy";
  if (highImpact && lowEffort) return "quick-win";
  if (highImpact && !lowEffort) return "major-project";
  if (!highImpact && lowEffort) return "fill-in";
  return "reconsider";
}

/**
 * Groups the performance-category subset of `issues` into human-
 * readable opportunities. Pure function; does not touch scoring,
 * severity, or any Issue field - purely an additional organizing view
 * over data that already exists. Every input Issue's id is preserved
 * in exactly one output opportunity's affectedIssueIds.
 */
export function buildPerformanceOpportunities(issues: Issue[]): PerformanceOpportunity[] {
  const performanceIssues = issues.filter((i) => i.category === "performance");
  const groups = new Map<PerformanceOpportunityCategory, Issue[]>();
  for (const issue of performanceIssues) {
    const category = classifyPerformanceTitle(issue.title);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(issue);
  }

  const opportunities: Omit<PerformanceOpportunity, "fixPriorityRank">[] = [];
  for (const [category, groupIssues] of groups) {
    const meta = CATEGORY_META[category];
    const severity = worstSeverity(groupIssues.map((i) => i.severity));
    const difficulty = dominantDifficulty(groupIssues.map((i) => i.difficulty));
    opportunities.push({
      category,
      title: meta.label,
      severity,
      problem: meta.problem(groupIssues.length),
      whyItMatters: meta.whyItMatters,
      evidenceSummary: groupIssues.map((i) => i.estimatedImpact ?? i.title),
      recommendedFix: meta.recommendedFix,
      affectedIssueIds: groupIssues.map((i) => i.id),
      issueCount: groupIssues.length,
      fixPriority: classifyFixPriority(severity, difficulty),
      dominantDifficulty: difficulty,
    });
  }

  opportunities.sort((a, b) => {
    const priorityDiff = FIX_PRIORITY_ORDER.indexOf(a.fixPriority) - FIX_PRIORITY_ORDER.indexOf(b.fixPriority);
    if (priorityDiff !== 0) return priorityDiff;
    const severityDiff = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    if (severityDiff !== 0) return severityDiff;
    return b.issueCount - a.issueCount;
  });

  return opportunities.map((o, index) => ({ ...o, fixPriorityRank: index + 1 }));
}

/**
 * A small, deliberately conservative set of within-performance
 * root-cause chains - NOT full cross-domain reasoning (that's a
 * different, not-yet-built layer's job - see PROJECT_PROGRESS.md).
 * Each chain requires BOTH sides to have real, present evidence before
 * firing; language stays at "contributes to"/"likely"/"may" throughout,
 * never asserting proven causality. Confidence is "medium" only when
 * the underlying mechanism is well-established (e.g. the LCP element
 * is very often an image) and "low" for a plausible but weaker link
 * (e.g. font-display -> CLS, which is a real but not the only cause of
 * CLS). Never "high" - that would need runtime confirmation this
 * codebase doesn't have (see performanceVerification.ts's
 * rendering-and-runtime-behavior entry, always "unverified").
 */
function findCwvIssue(issues: Issue[], metricPrefix: string): Issue | undefined {
  return issues.find((i) => i.title.startsWith(`${metricPrefix} `) && CWV_TITLE_PATTERN.test(i.title));
}

export function buildPerformanceRootCauseChains(issues: Issue[]): PerformanceRootCauseChain[] {
  const performanceIssues = issues.filter((i) => i.category === "performance");
  const byCategory = new Map<PerformanceOpportunityCategory, Issue[]>();
  for (const issue of performanceIssues) {
    const category = classifyPerformanceTitle(issue.title);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(issue);
  }
  const imageIssues = byCategory.get("image-delivery") ?? [];
  const jsIssues = byCategory.get("javascript-delivery") ?? [];
  const renderingIssues = byCategory.get("rendering-and-interactivity") ?? [];
  const networkIssues = byCategory.get("render-blocking-and-network") ?? [];
  const fontIssues = byCategory.get("font-delivery") ?? [];
  const cachingIssues = byCategory.get("caching-and-compression") ?? [];
  const weightIssues = byCategory.get("document-weight") ?? [];

  const chains: PerformanceRootCauseChain[] = [];

  const lcpIssue = findCwvIssue(performanceIssues, "LCP");
  if (imageIssues.length > 0 && lcpIssue) {
    const combinedSeverity = worstSeverity([...imageIssues.map((i) => i.severity), lcpIssue.severity]);
    chains.push({
      id: "image-delivery-to-lcp",
      headline: "Image delivery issues likely contribute to this page's LCP problem",
      chain: ["Large or unoptimized image resources", "commonly form the page's Largest Contentful Paint element", "contributes to a slow LCP"],
      confidence: combinedSeverity === "critical" || combinedSeverity === "high" ? "medium" : "low",
      supportingIssueIds: [...imageIssues.map((i) => i.id), lcpIssue.id],
    });
  }

  const inpIssue = findCwvIssue(performanceIssues, "INP");
  if ((jsIssues.length > 0 || renderingIssues.length > 0) && inpIssue) {
    chains.push({
      id: "js-and-main-thread-to-inp",
      headline: "Heavy JavaScript / main-thread work likely contributes to this page's INP problem",
      chain: ["Large JavaScript payload and/or heavy main-thread work", "delays the browser's ability to respond to input", "contributes to a slow INP"],
      confidence: "medium",
      supportingIssueIds: [...jsIssues.map((i) => i.id), ...renderingIssues.map((i) => i.id), inpIssue.id],
    });
  }

  const lcpOrFcp = lcpIssue ?? findCwvIssue(performanceIssues, "FCP");
  if (networkIssues.length > 0 && lcpOrFcp) {
    chains.push({
      id: "render-blocking-to-paint-timing",
      headline: "Render-blocking resources likely contribute to this page's slow paint timing",
      chain: ["Render-blocking scripts/stylesheets", "delay when the browser can start painting", `contributes to a slow ${lcpOrFcp.title.split(" ")[0]}`],
      confidence: "medium",
      supportingIssueIds: [...networkIssues.map((i) => i.id), lcpOrFcp.id],
    });
  }

  const fontDisplayIssue = fontIssues.find((i) => i.title === "Fonts missing an effective font-display");
  const clsIssue = findCwvIssue(performanceIssues, "CLS");
  if (fontDisplayIssue && clsIssue) {
    chains.push({
      id: "font-display-to-cls",
      headline: "Fonts without font-display may contribute to this page's CLS problem",
      chain: ["Custom fonts without font-display: swap (or similar)", "can cause a layout shift when the font swaps in", "may contribute to CLS"],
      confidence: "low",
      supportingIssueIds: [fontDisplayIssue.id, clsIssue.id],
    });
  }

  if (cachingIssues.length > 0 && weightIssues.length > 0) {
    chains.push({
      id: "caching-compounds-page-weight",
      headline: "Missing caching/compression compounds this page's overall weight problem",
      chain: ["Missing compression and/or short-lived caching", "means the full page weight is re-downloaded more often than necessary", "compounds the overall page-weight problem"],
      confidence: "medium",
      supportingIssueIds: [...cachingIssues.map((i) => i.id), ...weightIssues.map((i) => i.id)],
    });
  }

  return chains;
}

/**
 * Site-wide counterpart - groups SiteWideFinding[] (already produced
 * by analysis/siteWideFindings.ts from a real crawl, see
 * crawler/crawler.ts) the same way, using the exact same
 * classifyPerformanceTitle() so a page-level and site-wide opportunity
 * for the same underlying problem always land in the same category.
 * Does not crawl or re-derive anything - purely a view over data the
 * crawler already computed.
 */
const TEMPLATE_LEVERAGE_MIN_RATIO = 0.5; // 50%+ of analyzed pages sharing a finding suggests a shared template/component

/**
 * Builds one evidence bullet for a SiteWideFinding, appending a
 * template-leverage note when the affected-page ratio is high enough
 * to plausibly indicate a shared template/component rather than N
 * independent per-page problems - a real, useful insight since fixing
 * one shared template can resolve most/all occurrences at once. The
 * percentage is computed directly from the finding's own real
 * occurrenceCount/pagesAnalyzed - nothing estimated or invented.
 */
function describeSiteWideFinding(finding: SiteWideFinding): string {
  const ratio = finding.pagesAnalyzed > 0 ? finding.occurrenceCount / finding.pagesAnalyzed : 0;
  const percent = Math.round(ratio * 100);
  const base = `"${finding.title}" recurs on ${finding.occurrenceCount} of ${finding.pagesAnalyzed} analyzed pages (${percent}%).`;
  if (ratio >= TEMPLATE_LEVERAGE_MIN_RATIO) {
    return `${base} Affecting most analyzed pages suggests a shared template/component - fixing it once may resolve most or all occurrences, rather than needing a page-by-page fix.`;
  }
  return base;
}

export function buildSiteWidePerformanceOpportunities(findings: SiteWideFinding[]): SiteWidePerformanceOpportunity[] {
  const performanceFindings = findings.filter((f) => f.category === "performance");
  if (performanceFindings.length === 0) return [];
  const pagesAnalyzed = performanceFindings[0].pagesAnalyzed;

  const groups = new Map<PerformanceOpportunityCategory, SiteWideFinding[]>();
  for (const finding of performanceFindings) {
    const category = classifyPerformanceTitle(finding.title);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(finding);
  }

  const opportunities: SiteWidePerformanceOpportunity[] = [];
  for (const [category, groupFindings] of groups) {
    const meta = CATEGORY_META[category];
    opportunities.push({
      category,
      title: meta.label,
      severity: worstSeverity(groupFindings.map((f) => f.severity)),
      problem: meta.problem(groupFindings.length),
      whyItMatters: meta.whyItMatters,
      evidenceSummary: groupFindings.map(describeSiteWideFinding),
      recommendedFix: meta.recommendedFix,
      pagesAnalyzed,
    });
  }

  opportunities.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) || b.evidenceSummary.length - a.evidenceSummary.length);
  return opportunities;
}

/**
 * Site-wide counterpart to buildPerformanceRootCauseChains() - the
 * exact same five chains, built from SiteWideFinding[] instead of
 * per-page Issue[]. Same evidence-gating and conservative-language
 * rules apply; see that function's doc comment for the full rationale.
 */
function findCwvFinding(findings: SiteWideFinding[], metricPrefix: string): SiteWideFinding | undefined {
  return findings.find((f) => f.title.startsWith(`${metricPrefix} `) && CWV_TITLE_PATTERN.test(f.title));
}

export function buildSiteWideRootCauseChains(findings: SiteWideFinding[]): SiteWideRootCauseChain[] {
  const performanceFindings = findings.filter((f) => f.category === "performance");
  if (performanceFindings.length === 0) return [];
  const pagesAnalyzed = performanceFindings[0].pagesAnalyzed;

  const byCategory = new Map<PerformanceOpportunityCategory, SiteWideFinding[]>();
  for (const finding of performanceFindings) {
    const category = classifyPerformanceTitle(finding.title);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(finding);
  }
  const imageFindings = byCategory.get("image-delivery") ?? [];
  const jsFindings = byCategory.get("javascript-delivery") ?? [];
  const renderingFindings = byCategory.get("rendering-and-interactivity") ?? [];
  const networkFindings = byCategory.get("render-blocking-and-network") ?? [];
  const fontFindings = byCategory.get("font-delivery") ?? [];
  const cachingFindings = byCategory.get("caching-and-compression") ?? [];
  const weightFindings = byCategory.get("document-weight") ?? [];

  const chains: SiteWideRootCauseChain[] = [];

  const lcpFinding = findCwvFinding(performanceFindings, "LCP");
  if (imageFindings.length > 0 && lcpFinding) {
    const combinedSeverity = worstSeverity([...imageFindings.map((f) => f.severity), lcpFinding.severity]);
    chains.push({
      id: "image-delivery-to-lcp",
      headline: "Image delivery issues likely contribute to LCP problems across this site",
      chain: ["Large or unoptimized image resources", "commonly form the Largest Contentful Paint element on affected pages", "contributes to a slow LCP site-wide"],
      confidence: combinedSeverity === "critical" || combinedSeverity === "high" ? "medium" : "low",
      supportingFindingTitles: [...imageFindings.map((f) => f.title), lcpFinding.title],
      pagesAnalyzed,
    });
  }

  const inpFinding = findCwvFinding(performanceFindings, "INP");
  if ((jsFindings.length > 0 || renderingFindings.length > 0) && inpFinding) {
    chains.push({
      id: "js-and-main-thread-to-inp",
      headline: "Heavy JavaScript / main-thread work likely contributes to INP problems across this site",
      chain: ["Large JavaScript payload and/or heavy main-thread work", "delays the browser's ability to respond to input on affected pages", "contributes to a slow INP site-wide"],
      confidence: "medium",
      supportingFindingTitles: [...jsFindings.map((f) => f.title), ...renderingFindings.map((f) => f.title), inpFinding.title],
      pagesAnalyzed,
    });
  }

  const lcpOrFcpFinding = lcpFinding ?? findCwvFinding(performanceFindings, "FCP");
  if (networkFindings.length > 0 && lcpOrFcpFinding) {
    chains.push({
      id: "render-blocking-to-paint-timing",
      headline: "Render-blocking resources likely contribute to slow paint timing across this site",
      chain: ["Render-blocking scripts/stylesheets", "delay when affected pages can start painting", `contributes to a slow ${lcpOrFcpFinding.title.split(" ")[0]} site-wide`],
      confidence: "medium",
      supportingFindingTitles: [...networkFindings.map((f) => f.title), lcpOrFcpFinding.title],
      pagesAnalyzed,
    });
  }

  const fontDisplayFinding = fontFindings.find((f) => f.title === "Fonts missing an effective font-display");
  const clsFinding = findCwvFinding(performanceFindings, "CLS");
  if (fontDisplayFinding && clsFinding) {
    chains.push({
      id: "font-display-to-cls",
      headline: "Fonts without font-display may contribute to CLS problems across this site",
      chain: ["Custom fonts without font-display: swap (or similar)", "can cause a layout shift when the font swaps in on affected pages", "may contribute to CLS site-wide"],
      confidence: "low",
      supportingFindingTitles: [fontDisplayFinding.title, clsFinding.title],
      pagesAnalyzed,
    });
  }

  if (cachingFindings.length > 0 && weightFindings.length > 0) {
    chains.push({
      id: "caching-compounds-page-weight",
      headline: "Missing caching/compression compounds this site's overall weight problem",
      chain: ["Missing compression and/or short-lived caching", "means full page weight is re-downloaded more often than necessary across the site", "compounds the overall page-weight problem"],
      confidence: "medium",
      supportingFindingTitles: [...cachingFindings.map((f) => f.title), ...weightFindings.map((f) => f.title)],
      pagesAnalyzed,
    });
  }

  return chains;
}
