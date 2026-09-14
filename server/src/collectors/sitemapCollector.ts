import type { SitemapAnalysis, SitemapUrlEntry } from "../types.js";
import { fetchTextResource } from "./resourceFetcher.js";

/**
 * Parses XML sitemap content. Deliberately NOT a general XML parser -
 * this project has no XML dependency and adding one is out of scope
 * for an "upgrade the existing SEO system" task, so this uses tolerant
 * regex-based tag extraction scoped to the handful of sitemap
 * protocol elements (<urlset>, <sitemapindex>, <url>, <sitemap>,
 * <loc>, <lastmod>). This is intentionally forgiving of minor
 * real-world malformation (stray whitespace, missing XML declaration)
 * while still flagging genuinely broken input (no recognizable root
 * element, unparseable/empty <loc> entries).
 */
export function parseSitemapXml(xml: string): {
  isSitemapIndex: boolean;
  childSitemapUrls: string[];
  urls: SitemapUrlEntry[];
  malformedUrlCount: number;
  parseError: string | null;
} {
  const trimmed = xml.trim();
  if (!trimmed) {
    return { isSitemapIndex: false, childSitemapUrls: [], urls: [], malformedUrlCount: 0, parseError: "Empty sitemap body" };
  }

  const isSitemapIndex = /<sitemapindex[\s>]/i.test(trimmed);
  const isUrlset = /<urlset[\s>]/i.test(trimmed);

  if (!isSitemapIndex && !isUrlset) {
    return {
      isSitemapIndex: false,
      childSitemapUrls: [],
      urls: [],
      malformedUrlCount: 0,
      parseError: "No <urlset> or <sitemapindex> root element found - not a recognizable XML sitemap",
    };
  }

  function extractLoc(block: string): string | null {
    const m = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i);
    if (!m) return null;
    return decodeXmlEntities(m[1].trim());
  }

  if (isSitemapIndex) {
    const childBlocks = trimmed.match(/<sitemap>[\s\S]*?<\/sitemap>/gi) ?? [];
    const childSitemapUrls: string[] = [];
    for (const block of childBlocks) {
      const loc = extractLoc(block);
      if (loc) childSitemapUrls.push(loc);
    }
    return { isSitemapIndex: true, childSitemapUrls, urls: [], malformedUrlCount: 0, parseError: null };
  }

  const urlBlocks = trimmed.match(/<url>[\s\S]*?<\/url>/gi) ?? [];
  const urls: SitemapUrlEntry[] = [];
  let malformedUrlCount = 0;

  for (const block of urlBlocks) {
    const loc = extractLoc(block);
    const lastmodMatch = block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i);
    const lastmod = lastmodMatch ? lastmodMatch[1].trim() : null;

    if (!loc) {
      malformedUrlCount++;
      continue;
    }
    let isWellFormedUrl = true;
    try {
      new URL(loc);
    } catch {
      isWellFormedUrl = false;
      malformedUrlCount++;
    }
    urls.push({ loc, lastmod, isWellFormedUrl });
  }

  return { isSitemapIndex: false, childSitemapUrls: [], urls, malformedUrlCount, parseError: null };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

const UNAVAILABLE: SitemapAnalysis = {
  fetched: false,
  available: false,
  sitemapUrl: null,
  isSitemapIndex: false,
  childSitemapUrls: [],
  urls: [],
  malformedUrlCount: 0,
  duplicateUrlCount: 0,
  parseError: null,
};

/**
 * Fetches and parses a sitemap. If it's a sitemap index, follows child
 * sitemaps up to `maxChildSitemaps` (bounded - a compromised/malicious
 * or misconfigured index could otherwise reference unbounded children)
 * and merges their URLs. Never throws - an unreachable/missing sitemap
 * resolves to `available: false`, since not every site has one.
 */
export async function fetchSitemap(sitemapUrl: string, maxChildSitemaps = 10): Promise<SitemapAnalysis> {
  const result = await fetchTextResource(sitemapUrl);
  if (!result.ok || result.bodyText === null) {
    return { ...UNAVAILABLE, fetched: result.statusCode !== null, sitemapUrl, fetchError: result.error };
  }

  const parsed = parseSitemapXml(result.bodyText);
  if (parsed.parseError) {
    return { ...UNAVAILABLE, fetched: true, available: false, sitemapUrl, parseError: parsed.parseError };
  }

  if (!parsed.isSitemapIndex) {
    const seen = new Map<string, number>();
    for (const u of parsed.urls) seen.set(u.loc, (seen.get(u.loc) ?? 0) + 1);
    const duplicateUrlCount = [...seen.values()].filter((n) => n > 1).reduce((sum, n) => sum + (n - 1), 0);
    return {
      fetched: true,
      available: true,
      sitemapUrl,
      isSitemapIndex: false,
      childSitemapUrls: [],
      urls: parsed.urls,
      malformedUrlCount: parsed.malformedUrlCount,
      duplicateUrlCount,
      parseError: null,
    };
  }

  // sitemap index: fetch children and merge their <url> entries
  const childUrls = parsed.childSitemapUrls.slice(0, maxChildSitemaps);
  const mergedUrls: SitemapUrlEntry[] = [];
  let malformedUrlCount = 0;
  for (const childUrl of childUrls) {
    const child = await fetchSitemap(childUrl, 0); // one level of nesting only
    if (child.available) {
      mergedUrls.push(...child.urls);
      malformedUrlCount += child.malformedUrlCount;
    }
  }
  const seen = new Map<string, number>();
  for (const u of mergedUrls) seen.set(u.loc, (seen.get(u.loc) ?? 0) + 1);
  const duplicateUrlCount = [...seen.values()].filter((n) => n > 1).reduce((sum, n) => sum + (n - 1), 0);

  return {
    fetched: true,
    available: true,
    sitemapUrl,
    isSitemapIndex: true,
    childSitemapUrls: parsed.childSitemapUrls,
    urls: mergedUrls,
    malformedUrlCount,
    duplicateUrlCount,
    parseError: null,
  };
}
