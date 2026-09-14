import * as cheerio from "cheerio";
import { analyzeStructuredData } from "../analysis/structuredData.js";
import type {
  CanonicalAnalysis,
  ContentDiscoverability,
  HreflangAnalysis,
  HreflangEntry,
  ImageSeoFact,
  IndexabilitySignals,
  OpenGraphAnalysis,
  PageLinkFacts,
  PaginationFacts,
  RobotsDirectives,
  SeoExtendedAnalysis,
} from "../types.js";

/**
 * Extends (does not replace) collectHtml() with the deeper SEO facts
 * needed for the advanced checks in analysis/seoIssues.ts. Same
 * MEASURE-step discipline as every other collector: no scoring or
 * severity judgment happens here, only fact extraction.
 */
export function collectSeoExtras(bodyText: string, pageUrl: string, headers: Record<string, string> = {}): SeoExtendedAnalysis {
  const $ = cheerio.load(bodyText);

  const metaRobotsRaw = $('meta[name="robots"]').first().attr("content")?.trim() || null;
  const xRobotsTagRaw = headers["x-robots-tag"]?.trim() || null;
  const metaRobots = parseRobotsDirectives(metaRobotsRaw);
  const xRobotsTag = parseRobotsDirectives(xRobotsTagRaw);

  const indexability: IndexabilitySignals = {
    metaRobots,
    xRobotsTag,
    isIndexable: !(metaRobots.noindex || metaRobots.none || xRobotsTag.noindex || xRobotsTag.none),
    isFollowable: !(metaRobots.nofollow || metaRobots.none || xRobotsTag.nofollow || xRobotsTag.none),
    conflicting:
      (metaRobotsRaw !== null && xRobotsTagRaw !== null) &&
      ((metaRobots.noindex || metaRobots.none) !== (xRobotsTag.noindex || xRobotsTag.none)),
  };

  const canonical = analyzeCanonical($, pageUrl);
  const openGraph = analyzeOpenGraph($, canonical);
  const hreflang = analyzeHreflang($, pageUrl);

  const title = $("title").first().text().trim() || null;
  const h1Texts = $("h1")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  $("script, style, noscript").remove();
  const visibleText = $("body").text().replace(/\s+/g, " ").trim();

  const structuredData = analyzeStructuredData(cheerio.load(bodyText), { title, h1Texts, visibleText, pageUrl });

  const images = analyzeImages(cheerio.load(bodyText));
  const content = analyzeContent(visibleText);
  const links = analyzeLinks(cheerio.load(bodyText), pageUrl);
  const pagination = analyzePagination(cheerio.load(bodyText), pageUrl);

  return { indexability, canonical, openGraph, hreflang, structuredData, images, content, links, pagination };
}

const KNOWN_ROBOTS_TOKENS = new Set(["index", "follow", "noindex", "nofollow", "none", "noarchive", "nosnippet", "all"]);

export function parseRobotsDirectives(raw: string | null): RobotsDirectives {
  if (!raw) {
    return { raw: null, noindex: false, nofollow: false, none: false, noarchive: false, nosnippet: false, otherTokens: [] };
  }
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const none = tokens.includes("none");
  return {
    raw,
    noindex: tokens.includes("noindex") || none,
    nofollow: tokens.includes("nofollow") || none,
    none,
    noarchive: tokens.includes("noarchive"),
    nosnippet: tokens.includes("nosnippet"),
    otherTokens: tokens.filter((t) => !KNOWN_ROBOTS_TOKENS.has(t)),
  };
}

export function normalizeUrlForCompare(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return u;
  }
}

function analyzeCanonical($: cheerio.CheerioAPI, pageUrl: string): CanonicalAnalysis {
  const canonicalTags = $('link[rel="canonical"]');
  const rawHref = canonicalTags.first().attr("href")?.trim() || null;
  const duplicateDeclarations = canonicalTags.length;

  if (!rawHref) {
    return {
      rawHref: null,
      resolvedUrl: null,
      isAbsolute: false,
      isMalformed: false,
      pointsToDifferentDomain: false,
      isSelfReferencing: false,
      duplicateDeclarations,
    };
  }

  const isAbsolute = /^https?:\/\//i.test(rawHref);
  let resolvedUrl: string | null = null;
  let isMalformed = false;
  try {
    resolvedUrl = new URL(rawHref, pageUrl).href;
  } catch {
    isMalformed = true;
  }

  let pointsToDifferentDomain = false;
  let isSelfReferencing = false;
  if (resolvedUrl) {
    try {
      const canonicalHost = new URL(resolvedUrl).hostname.replace(/^www\./, "");
      const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
      pointsToDifferentDomain = canonicalHost !== pageHost;
    } catch {
      // ignore
    }
    isSelfReferencing = normalizeUrlForCompare(resolvedUrl) === normalizeUrlForCompare(pageUrl);
  }

  return { rawHref, resolvedUrl, isAbsolute, isMalformed, pointsToDifferentDomain, isSelfReferencing, duplicateDeclarations };
}

function analyzeOpenGraph($: cheerio.CheerioAPI, canonical: CanonicalAnalysis): OpenGraphAnalysis {
  const meta = (prop: string) => $(`meta[property="${prop}"]`).first().attr("content")?.trim() || null;
  const metaName = (name: string) => $(`meta[name="${name}"]`).first().attr("content")?.trim() || null;

  const ogUrl = meta("og:url");
  const referenceUrl = canonical.resolvedUrl;
  const ogUrlInconsistentWithCanonical =
    !!ogUrl && !!referenceUrl && normalizeUrlForCompare(ogUrl) !== normalizeUrlForCompare(referenceUrl);

  return {
    ogTitle: meta("og:title"),
    ogDescription: meta("og:description"),
    ogImage: meta("og:image"),
    ogUrl,
    ogType: meta("og:type"),
    twitterCard: metaName("twitter:card"),
    twitterTitle: metaName("twitter:title"),
    twitterDescription: metaName("twitter:description"),
    twitterImage: metaName("twitter:image"),
    ogUrlInconsistentWithCanonical,
  };
}

/** A hreflang value looks like a BCP-47 language tag: "en", "en-US", "x-default". */
const HREFLANG_PATTERN = /^([a-zA-Z]{2,3})(-[a-zA-Z]{2}|-[0-9]{3})?$/;

function analyzeHreflang($: cheerio.CheerioAPI, pageUrl: string): HreflangAnalysis {
  const entries: HreflangEntry[] = [];
  const malformedLangCodes: string[] = [];

  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr("hreflang")?.trim() || "";
    const href = $(el).attr("href")?.trim() || "";
    if (!lang || !href) return;
    let resolvedHref: string | null = null;
    try {
      resolvedHref = new URL(href, pageUrl).href;
    } catch {
      resolvedHref = null;
    }
    entries.push({ lang, href, resolvedHref });
    if (lang.toLowerCase() !== "x-default" && !HREFLANG_PATTERN.test(lang)) {
      malformedLangCodes.push(lang);
    }
  });

  const hasXDefault = entries.some((e) => e.lang.toLowerCase() === "x-default");
  const hasSelfReference = entries.some((e) => e.resolvedHref && normalizeUrlForCompare(e.resolvedHref) === normalizeUrlForCompare(pageUrl));

  return { entries, hasXDefault, hasSelfReference, malformedLangCodes };
}

const GENERIC_FILENAME_PATTERN = /(^|\/)(img|image|photo|pic|dsc|untitled|screenshot)[-_ ]?\d*\.[a-z]{3,4}$/i;

function analyzeImages($: cheerio.CheerioAPI): ImageSeoFact[] {
  const facts: ImageSeoFact[] = [];
  $("img").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src") ?? "";
    const alt = $el.attr("alt");
    const hasAlt = alt !== undefined && alt.trim() !== "";
    const hasDimensions = !!$el.attr("width") && !!$el.attr("height");
    const genericFilename = GENERIC_FILENAME_PATTERN.test(src);
    facts.push({ src, hasAlt, hasDimensions, genericFilename });
  });
  return facts;
}

const PLACEHOLDER_PATTERNS = [/coming soon/i, /under construction/i, /lorem ipsum/i, /this is a placeholder/i, /page is being (built|updated)/i];

function analyzeContent(visibleText: string): ContentDiscoverability {
  const visibleTextLength = visibleText.length;
  const isThinContent = visibleTextLength < 200;
  const looksLikePlaceholder = PLACEHOLDER_PATTERNS.some((re) => re.test(visibleText)) && visibleTextLength < 500;
  return { visibleTextLength, isThinContent, looksLikePlaceholder };
}

/**
 * Single-page link facts only (see PageLinkFacts's doc comment in
 * types.ts) - NOT a crawl graph. Skips mailto:/tel:/javascript:/pure
 * fragment links, which aren't navigable page-to-page links.
 */
/**
 * Generic, non-descriptive anchor text - present, but giving a search
 * engine (or a user scanning the page) essentially no information
 * about what the link actually goes to. Deliberately a short, literal,
 * whole-text-match list (not a substring/regex match) to avoid
 * flagging text that merely CONTAINS one of these words as part of a
 * genuinely descriptive phrase, e.g. "Learn more about our returns
 * policy" is fine; a bare "Learn more" is the pattern being targeted.
 */
const GENERIC_ANCHOR_TEXTS = new Set(["click here", "here", "read more", "learn more", "more", "link", "this link", "click", "continue reading", "see more", "more info", "details"]);

function analyzeLinks($: cheerio.CheerioAPI, pageUrl: string): PageLinkFacts {
  const internal = new Set<string>();
  const externalHosts = new Set<string>();
  const genericExamples: { text: string; href: string }[] = [];
  let genericAnchorCount = 0;
  let pageHost: string;
  try {
    pageHost = new URL(pageUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return { internal: [], externalCount: 0, genericAnchorCount: 0, genericAnchorExamples: [] };
  }

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href")?.trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) return;
    let resolved: URL;
    try {
      resolved = new URL(raw, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(resolved.protocol)) return;
    resolved.hash = "";
    const linkHost = resolved.hostname.replace(/^www\./, "").toLowerCase();
    if (linkHost === pageHost) {
      internal.add(resolved.href);
      const text = $(el).text().trim().replace(/\s+/g, " ").toLowerCase();
      if (GENERIC_ANCHOR_TEXTS.has(text)) {
        genericAnchorCount++;
        if (genericExamples.length < 5) genericExamples.push({ text: $(el).text().trim(), href: resolved.href });
      }
    } else {
      externalHosts.add(linkHost);
    }
  });

  return { internal: [...internal], externalCount: externalHosts.size, genericAnchorCount, genericAnchorExamples: genericExamples };
}

function analyzePagination($: cheerio.CheerioAPI, pageUrl: string): PaginationFacts {
  const resolve = (href: string | undefined): string | null => {
    if (!href) return null;
    try {
      return new URL(href, pageUrl).href;
    } catch {
      return null;
    }
  };
  const nextHref = $('link[rel="next"]').first().attr("href")?.trim() || null;
  const prevHref = $('link[rel="prev"], link[rel="previous"]').first().attr("href")?.trim() || null;
  return {
    nextHref,
    nextResolvedHref: resolve(nextHref ?? undefined),
    prevHref,
    prevResolvedHref: resolve(prevHref ?? undefined),
  };
}
