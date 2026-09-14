import type { HtmlAnalysis, Issue, RobotsTxtAnalysis, SeoExtendedAnalysis, SitemapAnalysis, Severity, StructuredDataItem } from "../types.js";
import { isSiteWideBlocked } from "../collectors/robotsCollector.js";

/**
 * Deterministic detection of SEO failure PATTERNS that are common on
 * AI-generated/scaffolded websites (generic placeholder metadata,
 * leaked dev/staging URLs, catastrophic robots.txt misconfiguration,
 * placeholder structured data, generated-looking placeholder slugs).
 *
 * Per the task's own instruction: this never assumes a site WAS
 * AI-generated - it only reports the observable technical failure
 * itself ("title is a generic placeholder", not "this looks AI-made").
 * Every finding here is something a human-built site could trigger
 * too; the pattern is just disproportionately common on generated
 * sites that skipped a real content pass before launch.
 *
 * Isolated on purpose (own file, own id prefix) so this rule set can
 * be extended/tuned independently of the general SEO rules in
 * seoIssues.ts without touching that file.
 */

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 70, medium: 40, low: 15 };

let counter = 0;
function nextId(): string {
  counter += 1;
  return `seo-ai-${counter}`;
}
export function resetAiGeneratedSeoIssueIdCounter() {
  counter = 0;
}
function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  return { ...input, category: "seo", id: nextId(), priorityScore: SEVERITY_WEIGHT[input.severity] };
}

const GENERIC_TITLE_PATTERNS = [
  /^home\s*\|\s*website$/i,
  /^welcome to wordpress$/i,
  /^untitled( document)?$/i,
  /^new page$/i,
  /^page title$/i,
  /^document$/i,
  /^my (new )?website$/i,
  /^site title$/i,
  /^home\s*-\s*my site$/i,
  /lorem ipsum/i,
];

const GENERIC_DESCRIPTION_PATTERNS = [
  /lorem ipsum/i,
  /your (meta )?description (goes )?here/i,
  /add (a |your )?(meta )?description/i,
  /description (goes|placeholder) here/i,
  /sample (meta )?description/i,
  /this is a placeholder/i,
  /edit this description/i,
];

/** Hostnames/patterns that indicate development, staging, or local infrastructure rather than a real production domain. */
const DEV_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.0\.0\.1$/,
  /^0\.0\.0\.0$/,
  /^(\d{1,3}\.){3}\d{1,3}$/, // any bare IPv4 literal - real production sites should be on a domain, not a raw IP, in canonical/OG/schema URLs
  /\.local$/i,
  /^staging\./i,
  /^stage\./i,
  /^dev\./i,
  /^test\./i,
  /^preview\./i,
  /\.ngrok(-free)?\.(io|app|dev)$/i,
  /\.vercel\.app$/i,
  /\.netlify\.app$/i,
  /\.pages\.dev$/i,
  /\.herokuapp\.com$/i,
  /\.github\.io$/i,
  /\.repl\.co$/i,
  /\.lovable\.app$/i,
];

function looksLikeDevHost(hostname: string): boolean {
  return DEV_HOST_PATTERNS.some((re) => re.test(hostname));
}

function extractUrlLikeStrings(items: StructuredDataItem[]): { itemIndex: number; property: string; value: string }[] {
  const out: { itemIndex: number; property: string; value: string }[] = [];
  const urlKeys = ["url", "@id", "sameAs", "image", "logo"];
  for (const item of items) {
    for (const key of urlKeys) {
      const value = item.data[key];
      if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        out.push({ itemIndex: item.index, property: key, value });
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === "string" && /^https?:\/\//i.test(v)) out.push({ itemIndex: item.index, property: key, value: v });
        }
      }
    }
  }
  return out;
}

/**
 * Checks every URL this page exposes in its OWN metadata (canonical,
 * og:url/og:image, hreflang alternates, JSON-LD url/@id/sameAs/image/
 * logo) for development/staging/local hosts. This is one of the
 * clearest, most common pre-launch leaks: a site built and tested
 * against localhost/staging that never had its metadata URLs swapped
 * for the real production domain before going live.
 */
function detectDevUrlLeakage(seo: SeoExtendedAnalysis, pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  const leaks: { source: string; url: string }[] = [];

  const check = (source: string, url: string | null) => {
    if (!url) return;
    try {
      const host = new URL(url).hostname;
      if (looksLikeDevHost(host)) leaks.push({ source, url });
    } catch {
      // malformed URLs are reported by other checks; not this one's job
    }
  };

  check("canonical", seo.canonical.resolvedUrl);
  check("og:url", seo.openGraph.ogUrl);
  check("og:image", seo.openGraph.ogImage);
  check("twitter:image", seo.openGraph.twitterImage);
  for (const entry of seo.hreflang.entries) check(`hreflang (${entry.lang})`, entry.resolvedHref);
  for (const found of extractUrlLikeStrings(seo.structuredData.items)) {
    check(`structured data (${found.property})`, found.value);
  }

  if (leaks.length > 0) {
    issues.push(
      makeIssue({
        severity: "critical",
        title: "Development/staging URL exposed in production page metadata",
        affected: pageUrl,
        whyItMatters:
          "This page's own metadata points at a localhost/staging/preview host instead of a real production domain. Search engines that follow these URLs (canonical, Open Graph, structured data) will index or attribute the wrong (often unreachable) address, and social shares will point nowhere useful. This is one of the most common pre-launch mistakes on generated or rapidly-scaffolded sites.",
        estimatedImpact: leaks.map((l) => `${l.source}: ${l.url}`).join("; "),
        recommendedFix: "Replace every development/staging/preview URL in this page's metadata with the real production domain before launch.",
        difficulty: "easy",
        source: "measured",
        evidence: leaks.slice(0, 8).map((l) => ({ type: "html" as const, label: l.source, value: l.url })),
      }),
    );
  }

  return issues;
}

function detectGenericPlaceholderMetadata(html: HtmlAnalysis, pageUrl: string): Issue[] {
  const issues: Issue[] = [];

  if (html.title && GENERIC_TITLE_PATTERNS.some((re) => re.test(html.title!.trim()))) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Generic placeholder page title",
        affected: pageUrl,
        whyItMatters:
          'A title like "Home | Website" or "Untitled Document" gives search engines and users no information about what this page actually is - it will not be competitive in search results and is a strong signal the site was launched without a real content pass.',
        estimatedImpact: `Title: "${html.title}"`,
        recommendedFix: "Replace the placeholder title with a real, descriptive title specific to this page.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Page title", value: html.title }],
      }),
    );
  }

  if (html.metaDescription && GENERIC_DESCRIPTION_PATTERNS.some((re) => re.test(html.metaDescription!))) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Placeholder meta description",
        affected: pageUrl,
        whyItMatters: "A placeholder description (lorem ipsum, \"add your description here\", etc.) left in production metadata will often be shown verbatim in search results and social shares.",
        estimatedImpact: `Description: "${html.metaDescription}"`,
        recommendedFix: "Replace the placeholder meta description with real, page-specific copy.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Meta description", value: html.metaDescription }],
      }),
    );
  }

  return issues;
}

// Audited (Session 10) for a real false-positive: \bnull\b / \bundefined\b
// previously matched INSIDE a legitimate hyphenated slug too, since a
// hyphen counts as a word boundary - e.g. "/understanding-null-hypothesis"
// or "/callback-undefined-behavior-explained" would have false-triggered
// "generated placeholder content". Anchored to a full path SEGMENT
// (between slashes, or at the very start/end) instead, since "undefined"/
// "null" as an entire path segment (e.g. "/undefined", "/products/null")
// is a genuinely different, much more suspicious signal than the word
// merely appearing somewhere in a real slug.
const GENERATED_SLUG_PATTERNS = [/lorem-?ipsum/i, /placeholder/i, /test-page/i, /sample-page/i, /dummy-content/i, /(^|\/)undefined(\/|$)/i, /(^|\/)null(\/|$)/i];

function detectGeneratedSlugPattern(pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return issues;
  }
  const matched = GENERATED_SLUG_PATTERNS.find((re) => re.test(path));
  if (matched) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "URL path looks like generated placeholder content",
        affected: pageUrl,
        whyItMatters: "A URL segment like this usually means scaffolded/placeholder content that was never replaced with a real page before launch.",
        estimatedImpact: `Path: ${path}`,
        recommendedFix: "Replace this placeholder page with real content, or remove/redirect it if it shouldn't exist.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "url", label: "URL path", value: path }],
      }),
    );
  }
  return issues;
}

/** FAQPage entries where every answer is identical or is itself an obvious placeholder string. */
const PLACEHOLDER_ANSWER_PATTERNS = [/^answer( here| goes here)?\.?$/i, /^lorem ipsum/i, /^sample answer/i, /^coming soon$/i, /^tbd$/i, /^placeholder/i];

function detectPlaceholderFaqSchema(seo: SeoExtendedAnalysis, pageUrl: string): Issue[] {
  const issues: Issue[] = [];
  for (const item of seo.structuredData.items) {
    if (!item.types.includes("FAQPage")) continue;
    const mainEntity = item.data["mainEntity"];
    if (!Array.isArray(mainEntity)) continue;

    const answers: string[] = [];
    for (const q of mainEntity) {
      if (q && typeof q === "object") {
        const accepted = (q as Record<string, unknown>)["acceptedAnswer"];
        const text = accepted && typeof accepted === "object" ? (accepted as Record<string, unknown>)["text"] : undefined;
        if (typeof text === "string") answers.push(text.trim());
      }
    }
    if (answers.length === 0) continue;

    const anyPlaceholder = answers.some((a) => PLACEHOLDER_ANSWER_PATTERNS.some((re) => re.test(a)));
    const allIdentical = answers.length > 1 && new Set(answers).size === 1;

    if (anyPlaceholder || allIdentical) {
      issues.push(
        makeIssue({
          severity: "high",
          title: "FAQPage structured data contains placeholder or duplicate answers",
          affected: pageUrl,
          whyItMatters:
            "FAQ rich results are meant to show real, distinct answers. Placeholder text or every answer being identical means this markup describes content that doesn't actually exist on the page yet, which risks the markup being considered spammy/misleading.",
          estimatedImpact: anyPlaceholder ? `Placeholder-looking answer(s) found, e.g. "${answers.find((a) => PLACEHOLDER_ANSWER_PATTERNS.some((re) => re.test(a)))}"` : `All ${answers.length} answers are identical.`,
          recommendedFix: "Replace placeholder FAQ answers with real, distinct content, or remove the FAQPage markup until real FAQ content exists.",
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "html", label: "FAQPage answers", value: answers.slice(0, 5).join(" | ") }],
        }),
      );
    }
  }
  return issues;
}

function detectCatastrophicRobotsBlock(robots: RobotsTxtAnalysis | null, pageUrl: string): Issue[] {
  if (!robots || !isSiteWideBlocked(robots)) return [];
  return [
    makeIssue({
      severity: "critical",
      title: "robots.txt blocks the entire site from all crawlers",
      affected: pageUrl,
      whyItMatters:
        'A "User-agent: *" group with "Disallow: /" and no exceptions tells every search engine not to crawl anything on this site at all. If public indexing is intended, this alone is enough to keep the site out of search results entirely, regardless of how good the rest of the SEO is.',
      recommendedFix: 'If this site should be publicly indexable, remove the blanket "Disallow: /" rule (or the whole robots.txt file) before launch. If the site is intentionally private/staging, this is correct and no action is needed.',
      difficulty: "easy",
      source: "measured",
      evidence: [{ type: "url", label: "robots.txt", value: "User-agent: * / Disallow: /" }],
    }),
  ];
}

/** Checks a fetched sitemap's own URLs for development/staging/local hosts - a common leftover from launching straight off a dev environment. */
function detectDevUrlsInSitemap(sitemap: SitemapAnalysis | null, pageUrl: string): Issue[] {
  if (!sitemap || !sitemap.available) return [];
  const leaks: string[] = [];
  for (const entry of sitemap.urls) {
    try {
      const host = new URL(entry.loc).hostname;
      if (looksLikeDevHost(host)) leaks.push(entry.loc);
    } catch {
      // malformed sitemap URLs are reported elsewhere (sitemapCollector's malformedUrlCount)
    }
  }
  if (leaks.length === 0) return [];
  return [
    makeIssue({
      severity: "critical",
      title: "Sitemap contains development/staging URLs",
      affected: sitemap.sitemapUrl ?? "sitemap.xml",
      whyItMatters:
        "A sitemap that lists localhost/staging/preview URLs instead of the production domain means search engines are being pointed at addresses that either don't resolve publicly or aren't the real site - a common sign the sitemap was generated in a dev environment and never regenerated for production.",
      estimatedImpact: `${leaks.length} development-looking URL(s), e.g. ${leaks[0]}`,
      recommendedFix: "Regenerate the sitemap against the production domain, or fix the sitemap generator's base URL configuration.",
      difficulty: "moderate",
      source: "measured",
      evidence: leaks.slice(0, 8).map((l) => ({ type: "url" as const, label: "Sitemap URL", value: l })),
    }),
  ];
}

export function detectAiGeneratedSeoFailures(
  fetchResult: { finalUrl: string },
  html: HtmlAnalysis,
  seo: SeoExtendedAnalysis,
  robots: RobotsTxtAnalysis | null,
  sitemap: SitemapAnalysis | null = null,
): Issue[] {
  const page = fetchResult.finalUrl;
  return [
    ...detectGenericPlaceholderMetadata(html, page),
    ...detectDevUrlLeakage(seo, page),
    ...detectGeneratedSlugPattern(page),
    ...detectPlaceholderFaqSchema(seo, page),
    ...detectCatastrophicRobotsBlock(robots, page),
    ...detectDevUrlsInSitemap(sitemap, page),
  ];
}
