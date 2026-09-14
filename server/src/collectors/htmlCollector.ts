import * as cheerio from "cheerio";
import type { HtmlAnalysis, ThirdPartyCategory } from "../types.js";
import { normalizeCrawlUrl } from "../cache/urlNormalize.js";

/**
 * Curated hostname → vendor-category lookup for third-party resource
 * detection (see collectHtml()'s thirdPartyResources). Intentionally
 * small and exact-suffix-matched rather than a fuzzy guess - an
 * uncategorized third-party host is reported as "uncategorized", never
 * mis-labeled just to fill a bucket.
 */
const THIRD_PARTY_VENDORS: Record<string, ThirdPartyCategory> = {
  "google-analytics.com": "analytics",
  "googletagmanager.com": "analytics",
  "analytics.google.com": "analytics",
  "segment.com": "analytics",
  "segment.io": "analytics",
  "mixpanel.com": "analytics",
  "hotjar.com": "analytics",
  "plausible.io": "analytics",
  "doubleclick.net": "advertising",
  "googlesyndication.com": "advertising",
  "googleadservices.com": "advertising",
  "adnxs.com": "advertising",
  "fonts.googleapis.com": "fonts",
  "fonts.gstatic.com": "fonts",
  "use.typekit.net": "fonts",
  "platform.twitter.com": "social",
  "connect.facebook.net": "social",
  "platform.linkedin.com": "social",
  "assets.pinterest.com": "social",
  "js.stripe.com": "payments",
  "checkout.stripe.com": "payments",
  "www.paypal.com": "payments",
  "player.vimeo.com": "video",
  "www.youtube.com": "video",
  "youtube.com": "video",
  "fast.wistia.com": "video",
  "maps.googleapis.com": "maps",
  "maps.google.com": "maps",
  "widget.intercom.io": "chat",
  "js.intercomcdn.com": "chat",
  "embed.tawk.to": "chat",
  "static.zdassets.com": "chat",
  "cdnjs.cloudflare.com": "cdn",
  "unpkg.com": "cdn",
  "cdn.jsdelivr.net": "cdn",
  "ajax.googleapis.com": "cdn",
};

function categorizeThirdPartyHost(host: string): ThirdPartyCategory {
  return THIRD_PARTY_VENDORS[host] ?? "uncategorized";
}


const NON_CRAWLABLE_HREF_PREFIX = /^(?:mailto:|tel:|javascript:|data:|blob:)/i;
function extractInternalLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  let origin: string;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const found = new Set<string>();
  $("a[href]").each((_, el) => {
    const raw = ($(el).attr("href") ?? "").trim();
    if (!raw || raw.startsWith("#") || NON_CRAWLABLE_HREF_PREFIX.test(raw)) return;
    let resolved: URL;
    try { resolved = new URL(raw, pageUrl); } catch { return; }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    if (resolved.origin !== origin) return;
    try { found.add(normalizeCrawlUrl(resolved.href)); } catch {}
  });
  return [...found];
}

/**
 * Parses raw HTML into structured facts. Pure static-DOM analysis -
 * no JavaScript execution, no rendering. This mirrors what any crawler
 * (including most search engine bots on first pass) would see.
 *
 * `pageUrl` is optional and used only to resolve relative resource URLs
 * and determine the page's own host for third-party detection
 * (`thirdPartyResources`) - when omitted, that field is simply empty
 * rather than guessed.
 */
export function collectHtml(bodyText: string, pageIsHttps: boolean, pageUrl?: string): HtmlAnalysis {
  const $ = cheerio.load(bodyText);

  const titleTags = $("title");
  const title = titleTags.first().text().trim() || null;

  const metaDescriptionTags = $('meta[name="description"]');
  const metaDescription = metaDescriptionTags.first().attr("content")?.trim() || null;

  const h1Elements = $("h1");
  const h1s = h1Elements
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const canonicalTags = $('link[rel="canonical"]');
  const canonicalHref = canonicalTags.first().attr("href")?.trim() || null;
  // A canonical tag can exist with an empty/whitespace href (canonicalHref
  // is then null) - that is a different, more specific problem than no
  // canonical tag existing at all, so it's tracked separately below.
  const canonicalUrl = canonicalHref;
  const canonicalEmpty = canonicalTags.length > 0 && !canonicalHref;

  const robotsMetaTags = $('meta[name="robots"]');
  const robotsMeta = robotsMetaTags.first().attr("content")?.trim() || null;
  const robotsMetaValues = [
    ...new Set(
      robotsMetaTags
        .map((_, el) => $(el).attr("content")?.trim() ?? "")
        .get()
        .filter(Boolean),
    ),
  ];

  const hasViewportMeta = $('meta[name="viewport"]').length > 0;
  const hasCharsetMeta = $("meta[charset]").length > 0 || $('meta[http-equiv="Content-Type"]').length > 0;

  const openGraph = {
    title: $('meta[property="og:title"]').length > 0,
    description: $('meta[property="og:description"]').length > 0,
    image: $('meta[property="og:image"]').length > 0,
    url: $('meta[property="og:url"]').length > 0,
  };
  const twitterCardPresent = $('meta[name="twitter:card"]').length > 0;

  const seenStructuredDataBlocks = new Set<string>();
  let malformedStructuredDataBlocks = 0;
  let duplicateStructuredDataBlocks = 0;
  const structuredDataScripts = $('script[type="application/ld+json"]');
  structuredDataScripts.each((_, el) => {
    const raw = ($(el).html() ?? "").trim();
    try {
      JSON.parse(raw);
      const normalized = raw.replace(/\s+/g, " ");
      if (seenStructuredDataBlocks.has(normalized)) {
        duplicateStructuredDataBlocks++;
      } else {
        seenStructuredDataBlocks.add(normalized);
      }
    } catch {
      malformedStructuredDataBlocks++;
    }
  });

  const imgs = $("img");
  const missingAlt = imgs.filter((_, el) => {
    const alt = $(el).attr("alt");
    return alt === undefined || alt.trim() === "";
  }).length;
  const missingDimensions = imgs.filter((_, el) => {
    const $el = $(el);
    return !$el.attr("width") || !$el.attr("height");
  }).length;
  const missingLazyLoading = imgs.filter((_, el) => $(el).attr("loading") !== "lazy").length;
  const missingResponsiveSrcset = imgs.filter((_, el) => !$(el).attr("srcset")).length;

  const scripts = $("script[src]");
  let blockingScriptsInHead = 0;
  let asyncOrDeferScripts = 0;
  scripts.each((_, el) => {
    const $el = $(el);
    const hasAsyncOrDefer = $el.attr("async") !== undefined || $el.attr("defer") !== undefined;
    const type = $el.attr("type");
    const isModule = type === "module";
    if (hasAsyncOrDefer || isModule) {
      asyncOrDeferScripts++;
    } else if ($el.closest("head").length > 0) {
      blockingScriptsInHead++;
    }
  });

  const stylesheets = $('link[rel="stylesheet"]');
  let blockingStylesInHead = 0;
  stylesheets.each((_, el) => {
    const $el = $(el);
    const media = $el.attr("media");
    const isPrint = media === "print";
    if (!isPrint && $el.closest("head").length > 0) {
      blockingStylesInHead++;
    }
  });

  // Third-party resource detection: only possible when we know the
  // page's own URL to compare hosts against and to resolve relative
  // resource paths. Silently empty (never guessed) when pageUrl is
  // omitted - see the collectHtml() doc comment.
  const thirdPartyCounts = new Map<string, number>();
  if (pageUrl) {
    let pageHost: string | null = null;
    try {
      pageHost = new URL(pageUrl).hostname;
    } catch {
      pageHost = null;
    }
    if (pageHost) {
      $("script[src], img[src], link[rel=\"stylesheet\"][href], iframe[src]").each((_, el) => {
        const $el = $(el);
        const ref = $el.attr("src") ?? $el.attr("href");
        if (!ref) return;
        let resolvedHost: string;
        try {
          resolvedHost = new URL(ref, pageUrl).hostname;
        } catch {
          return; // malformed resource URL - not a third-party fact we can establish
        }
        if (resolvedHost && resolvedHost !== pageHost) {
          thirdPartyCounts.set(resolvedHost, (thirdPartyCounts.get(resolvedHost) ?? 0) + 1);
        }
      });
    }
  }
  const thirdPartyResources = [...thirdPartyCounts.entries()]
    .map(([host, count]) => ({ host, category: categorizeThirdPartyHost(host), count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

  const insecureResourceRefs: string[] = [];
  if (pageIsHttps) {
    $("img[src], script[src], link[href], iframe[src]").each((_, el) => {
      const src = $(el).attr("src") ?? $(el).attr("href");
      if (src && src.startsWith("http://")) {
        insecureResourceRefs.push(src);
      }
    });
  }

  return {
    title,
    titleLength: title?.length ?? 0,
    titleCount: titleTags.length,
    metaDescription,
    metaDescriptionLength: metaDescription?.length ?? 0,
    metaDescriptionCount: metaDescriptionTags.length,
    h1Count: h1s.length,
    h1Texts: h1s,
    rawH1Count: h1Elements.length,
    canonicalUrl,
    canonicalCount: canonicalTags.length,
    canonicalEmpty,
    robotsMeta,
    robotsMetaCount: robotsMetaTags.length,
    robotsMetaValues,
    hasViewportMeta,
    hasCharsetMeta,
    openGraph,
    twitterCardPresent,
    structuredData: {
      totalBlocks: structuredDataScripts.length,
      malformedBlocks: malformedStructuredDataBlocks,
      duplicateBlocks: duplicateStructuredDataBlocks,
    },
    images: { total: imgs.length, missingAlt, missingDimensions, missingLazyLoading, missingResponsiveSrcset },
    scripts: { total: scripts.length, blockingInHead: blockingScriptsInHead, asyncOrDefer: asyncOrDeferScripts },
    stylesheets: { total: stylesheets.length, blockingInHead: blockingStylesInHead },
    thirdPartyResources,
    insecureResourceRefs: [...new Set(insecureResourceRefs)],
    internalLinks: pageUrl ? extractInternalLinks($, pageUrl) : [],
  };
}
