import * as cheerio from "cheerio";
import { fetchTextResource, type CollectHttpOptions } from "../collectors/httpCollector.js";
import { normalizeCrawlUrl } from "../cache/urlNormalize.js";

/**
 * SCOPE / KNOWN LIMITATION: parses a single sitemap.xml's `<url><loc>`
 * entries. Does NOT recursively expand a sitemap-index file's
 * `<sitemap><loc>` entries (a sitemap-index just points to more
 * sitemap files) - a sitemap-index's own <loc> entries are picked up
 * by the same selector below (since we don't distinguish document
 * type) and treated as if they were page URLs, which for a plain
 * sitemap is correct but for a sitemap-index would incorrectly try to
 * "analyze" a sitemap XML file as if it were a web page (it will
 * simply fail with NON_HTML and be recorded as such - not silently
 * wrong, just not fully expanded). Recursing into nested sitemap
 * indexes is a reasonable follow-up, intentionally left out to keep
 * this bounded and simple for the first version.
 */
export async function discoverSitemapUrls(sitemapUrl: string, allowedOrigin: string, fetchOptions: CollectHttpOptions = {}): Promise<string[]> {
  const result = await fetchTextResource(sitemapUrl, fetchOptions);
  if (!result || !result.ok) return [];

  const $ = cheerio.load(result.bodyText, { xmlMode: true });
  const urls = new Set<string>();
  $("loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (!loc) return;
    try {
      const parsed = new URL(loc);
      if (parsed.origin !== allowedOrigin) return; // same-origin only, like link discovery
      urls.add(normalizeCrawlUrl(parsed.href));
    } catch {
      /* malformed <loc> entry - skip it, don't fail the whole sitemap */
    }
  });
  return [...urls];
}
