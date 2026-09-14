import type {
  HtmlAnalysis,
  RobotsTxtAnalysis,
  SeoExtendedAnalysis,
  SeoVerificationCheck,
  SeoVerificationSummary,
  SitemapAnalysis,
} from "../types.js";

/**
 * Turns evidence the pipeline already collected into an explicit
 * VERIFIED/FAILED/WARNING/UNVERIFIED/NOT_APPLICABLE statement per SEO
 * area. This is reporting, not analysis - it makes no new HTTP/HTML
 * observations of its own, it only characterizes what the rest of the
 * SEO layer already established (or explicitly could not establish).
 *
 * The one rule every branch below must satisfy: something this scan
 * did not actually check must never come out as "verified". Where the
 * current single-page architecture genuinely cannot answer a question
 * (anything requiring the multi-page crawler), the state is
 * "unverified", not silently omitted and not "not_applicable" (which
 * is reserved for things that are genuinely out of scope for this
 * page, like hreflang on a page that isn't part of any language set).
 */
export function buildSeoVerificationSummary(
  html: HtmlAnalysis,
  seo: SeoExtendedAnalysis,
  robots: RobotsTxtAnalysis,
  sitemap: SitemapAnalysis,
): SeoVerificationSummary {
  const checks: SeoVerificationCheck[] = [
    verifyRobotsTxt(robots),
    verifySitemap(sitemap),
    verifyCanonical(seo),
    verifyIndexability(seo),
    verifyStructuredData(seo),
    verifyOpenGraph(seo),
    verifyHreflang(seo),
    verifyDuplicateMetadata(),
    verifyInternalLinkGraph(),
  ];
  return { checks };
}

function verifyRobotsTxt(robots: RobotsTxtAnalysis): SeoVerificationCheck {
  if (robots.available) {
    return {
      check: "robots_txt",
      label: "robots.txt",
      state: "verified",
      detail: `robots.txt was retrieved and parsed (${robots.groups.length} user-agent group(s), ${robots.sitemapUrls.length} declared sitemap(s)).`,
    };
  }
  if (robots.fetched) {
    // we got a definitive response (e.g. 404) at the one canonical
    // location robots.txt can live at - that IS a verified answer.
    return { check: "robots_txt", label: "robots.txt", state: "verified", detail: "No robots.txt was found at this host's root (checked; none present)." };
  }
  return {
    check: "robots_txt",
    label: "robots.txt",
    state: "unverified",
    detail: `robots.txt could not be retrieved: ${robots.fetchError ?? "unknown fetch error"}.`,
  };
}

function verifySitemap(sitemap: SitemapAnalysis): SeoVerificationCheck {
  if (sitemap.available) {
    return {
      check: "sitemap",
      label: "XML sitemap",
      state: "verified",
      detail: `A sitemap was retrieved and parsed (${sitemap.urls.length} URL(s)${sitemap.isSitemapIndex ? ", via a sitemap index" : ""}).`,
    };
  }
  if (sitemap.parseError) {
    return { check: "sitemap", label: "XML sitemap", state: "failed", detail: `A sitemap was found but could not be parsed: ${sitemap.parseError}` };
  }
  // Unlike robots.txt, a sitemap has no single mandatory location - not
  // finding one at the declared/guessed URL does not prove none exists.
  return {
    check: "sitemap",
    label: "XML sitemap",
    state: "unverified",
    detail: sitemap.sitemapUrl
      ? `No accessible sitemap was found at ${sitemap.sitemapUrl}. This does not rule out a sitemap existing at a different, undeclared location.`
      : "No sitemap URL was declared in robots.txt and no sitemap was found at the conventional /sitemap.xml location.",
  };
}

function verifyCanonical(seo: SeoExtendedAnalysis): SeoVerificationCheck {
  const c = seo.canonical;
  if (!c.rawHref) {
    return { check: "canonical", label: "Canonical URL", state: "warning", detail: "No canonical tag is present on this page." };
  }
  if (c.isMalformed) {
    return { check: "canonical", label: "Canonical URL", state: "failed", detail: `Canonical href "${c.rawHref}" does not resolve to a valid URL.` };
  }
  if (c.pointsToDifferentDomain) {
    return { check: "canonical", label: "Canonical URL", state: "warning", detail: `Canonical points to a different domain (${c.resolvedUrl}) - verify this is intentional.` };
  }
  if (!c.isSelfReferencing) {
    return { check: "canonical", label: "Canonical URL", state: "warning", detail: `Canonical points to a different URL on the same site (${c.resolvedUrl}) - not verified as correct or incorrect without knowing whether this page is a genuine duplicate/variant.` };
  }
  return { check: "canonical", label: "Canonical URL", state: "verified", detail: "Canonical tag is present, well-formed, and self-referencing." };
}

function verifyIndexability(seo: SeoExtendedAnalysis): SeoVerificationCheck {
  const idx = seo.indexability;
  if (idx.conflicting) {
    return { check: "indexability", label: "Indexability", state: "failed", detail: "meta robots and X-Robots-Tag disagree on whether this page should be indexed." };
  }
  if (!idx.isIndexable) {
    return { check: "indexability", label: "Indexability", state: "warning", detail: "This page is marked noindex - verify that is intentional for a production page." };
  }
  return { check: "indexability", label: "Indexability", state: "verified", detail: "No noindex/nofollow directive found in meta robots or X-Robots-Tag." };
}

function verifyStructuredData(seo: SeoExtendedAnalysis): SeoVerificationCheck {
  const sd = seo.structuredData;
  if (sd.items.length === 0 && sd.malformed.length === 0) {
    return { check: "structured_data", label: "Structured data (JSON-LD)", state: "not_applicable", detail: "No JSON-LD structured data is present on this page." };
  }
  if (sd.malformed.length > 0) {
    return { check: "structured_data", label: "Structured data (JSON-LD)", state: "failed", detail: `${sd.malformed.length} JSON-LD block(s) failed to parse.` };
  }
  if (sd.incompleteItems.length > 0 || sd.contentMismatches.length > 0 || (sd.conflicts?.length ?? 0) > 0) {
    return {
      check: "structured_data",
      label: "Structured data (JSON-LD)",
      state: "warning",
      detail: `Structured data parses correctly but has ${sd.incompleteItems.length} incomplete item(s), ${sd.contentMismatches.length} content mismatch(es), and ${sd.conflicts?.length ?? 0} entity conflict(s). This checks syntactic validity and internal consistency only - it does NOT verify eligibility for any specific Google rich result.`,
    };
  }
  return {
    check: "structured_data",
    label: "Structured data (JSON-LD)",
    state: "verified",
    detail: `${sd.items.length} structured-data item(s) parsed successfully with recommended properties present. This confirms syntactic validity only - NOT eligibility for any specific search rich result, which depends on additional Google-side criteria this scan cannot evaluate.`,
  };
}

function verifyOpenGraph(seo: SeoExtendedAnalysis): SeoVerificationCheck {
  const og = seo.openGraph;
  const hasAny = og.ogTitle || og.ogDescription || og.ogImage || og.ogType;
  if (!hasAny) {
    return { check: "open_graph", label: "Open Graph / social metadata", state: "not_applicable", detail: "No Open Graph tags are present on this page." };
  }
  const missing = [!og.ogTitle && "og:title", !og.ogDescription && "og:description", !og.ogImage && "og:image"].filter(Boolean);
  if (missing.length > 0) {
    return { check: "open_graph", label: "Open Graph / social metadata", state: "warning", detail: `Open Graph tags present but missing: ${missing.join(", ")}.` };
  }
  return { check: "open_graph", label: "Open Graph / social metadata", state: "verified", detail: "og:title, og:description, and og:image are all present." };
}

function verifyHreflang(seo: SeoExtendedAnalysis): SeoVerificationCheck {
  const hl = seo.hreflang;
  if (hl.entries.length === 0) {
    return { check: "hreflang", label: "hreflang / international targeting", state: "not_applicable", detail: "No hreflang alternates are declared - treated as a single-language page, not a missing-hreflang failure." };
  }
  if (hl.malformedLangCodes.length > 0) {
    return { check: "hreflang", label: "hreflang / international targeting", state: "failed", detail: `Invalid language code(s): ${hl.malformedLangCodes.join(", ")}.` };
  }
  if (!hl.hasSelfReference) {
    return { check: "hreflang", label: "hreflang / international targeting", state: "warning", detail: "hreflang set has no entry that references this page itself." };
  }
  return { check: "hreflang", label: "hreflang / international targeting", state: "verified", detail: `${hl.entries.length} hreflang entries, valid codes, self-reference present.` };
}

/**
 * Duplicate-title/description detection genuinely requires seeing more
 * than one page (analysis/siteSeoAnalysis.ts implements the actual
 * check) - the current single-page pipeline has no other pages to
 * compare against. This must stay "unverified", never silently
 * omitted or implied to be fine.
 */
function verifyDuplicateMetadata(): SeoVerificationCheck {
  return {
    check: "duplicate_metadata",
    label: "Duplicate titles/descriptions across the site",
    state: "unverified",
    detail: "This scan only analyzed a single page, so duplicate titles/descriptions across the site could not be checked. analysis/siteSeoAnalysis.ts implements this check and is ready to run once multi-page crawl data is available.",
  };
}

/** Same reasoning as verifyDuplicateMetadata(): orphan pages, crawl depth, and sitewide canonical conflicts all require multiple pages. */
function verifyInternalLinkGraph(): SeoVerificationCheck {
  return {
    check: "internal_link_graph",
    label: "Site-wide internal-link graph (orphan pages, crawl depth, sitewide canonical conflicts)",
    state: "unverified",
    detail: "This scan only analyzed a single page. Whether other pages link to it, its position in the site's crawl-depth structure, and sitewide canonical conflicts all require crawling multiple pages, which this scan does not yet do.",
  };
}
