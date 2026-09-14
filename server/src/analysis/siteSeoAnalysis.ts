import type {
  CanonicalConflict,
  CrawlDepthStats,
  DuplicateGroup,
  Issue,
  OrphanPage,
  Severity,
  SitemapAnalysis,
  SitemapReconciliation,
  SitePageInput,
  SiteSeoReport,
  UrlVariantGroup,
} from "../types.js";

/**
 * ============================================================================
 * CRAWLER INTEGRATION POINT
 * ============================================================================
 * analyzeSite() below is a pure function: it does no network I/O and owns no
 * crawl orchestration. Main Claude's multi-page crawler is expected to:
 *
 *   1. Discover and fetch pages (collectHttp) starting from a seed/homepage
 *      URL, applying the SSRF guard to every discovered URL (not just the
 *      seed), capped by MAX_CRAWL_PAGES / crawl depth as documented in
 *      PROJECT_PROGRESS.md.
 *   2. For each fetched page, run collectHtml() + collectSeoExtras() (see
 *      collectors/htmlCollector.ts and collectors/seoCollector.ts) and
 *      extract every absolute, same-site <a href> found in the HTML -
 *      collectSeoExtras() already computes this as `seo.links.internal`
 *      (see PageLinkFacts in types.ts), so the crawler can reuse that
 *      directly as `SitePageInput.internalLinks` instead of re-parsing.
 *   3. Build one SitePageInput per page (see types.ts) and pass the full
 *      array, plus the homepage URL and optionally a fetched SitemapAnalysis
 *      (collectors/sitemapCollector.ts) and RobotsTxtAnalysis, into
 *      analyzeSite() below.
 *
 * This keeps crawl orchestration entirely in Main Claude's code while all of
 * the SEO interpretation logic (orphans, depth, duplicates, canonical
 * conflicts, sitemap reconciliation, broken/redirected internal links,
 * URL-variant detection) lives here, reusable regardless of how the crawler
 * itself is implemented.
 * ============================================================================
 */

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 70, medium: 40, low: 15 };

let counter = 0;
function nextId(): string {
  counter += 1;
  return `seo-site-${counter}`;
}
export function resetSiteSeoIssueIdCounter() {
  counter = 0;
}
function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  return { ...input, category: "seo", id: nextId(), priorityScore: SEVERITY_WEIGHT[input.severity] };
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [k, v] of params) url.searchParams.append(k, v);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${url.pathname}${url.search}`;
  } catch {
    return u;
  }
}

/** Groups a raw URL list by normalized form, keeping only groups with >1 distinct raw variant. */
export function findUrlVariantGroups(urls: string[]): UrlVariantGroup[] {
  const byNormalized = new Map<string, Set<string>>();
  for (const u of urls) {
    const key = normalizeUrl(u);
    const set = byNormalized.get(key) ?? new Set<string>();
    set.add(u);
    byNormalized.set(key, set);
  }
  const groups: UrlVariantGroup[] = [];
  for (const [normalized, variants] of byNormalized) {
    if (variants.size > 1) groups.push({ normalized, variants: [...variants] });
  }
  return groups;
}

function findDuplicates(pages: SitePageInput[], pick: (p: SitePageInput) => string | null): DuplicateGroup[] {
  const byValue = new Map<string, string[]>();
  for (const p of pages) {
    const value = pick(p);
    if (!value) continue;
    const arr = byValue.get(value) ?? [];
    arr.push(p.url);
    byValue.set(value, arr);
  }
  const groups: DuplicateGroup[] = [];
  for (const [value, urls] of byValue) {
    if (urls.length > 1) groups.push({ value, urls });
  }
  return groups;
}

/**
 * BFS from the homepage over the internal-link graph restricted to pages we
 * actually have data for. Returns depth (hop count) per URL; a page with no
 * entry was never reached by following internal links from the homepage,
 * even if it's present in `pages` (e.g. discovered only via the sitemap).
 */
function computeDepths(pages: SitePageInput[], homepageUrl: string): Map<string, number> {
  const byUrl = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const depths = new Map<string, number>();
  const homeKey = normalizeUrl(homepageUrl);
  if (!byUrl.has(homeKey)) return depths;

  const queue: string[] = [homeKey];
  depths.set(homeKey, 0);
  while (queue.length > 0) {
    const currentKey = queue.shift()!;
    const currentDepth = depths.get(currentKey)!;
    const page = byUrl.get(currentKey);
    if (!page) continue;
    for (const link of page.internalLinks) {
      const linkKey = normalizeUrl(link);
      if (!byUrl.has(linkKey)) continue; // link target not among analyzed pages
      if (depths.has(linkKey)) continue;
      depths.set(linkKey, currentDepth + 1);
      queue.push(linkKey);
    }
  }
  return depths;
}

/** Inbound internal-link counts, restricted to link targets present in `pages`. */
function computeInboundCounts(pages: SitePageInput[]): Map<string, number> {
  const byUrl = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const inbound = new Map<string, number>();
  for (const p of pages) {
    const fromKey = normalizeUrl(p.url);
    const seenTargets = new Set<string>(); // one inbound credit per source page, not per link occurrence
    for (const link of p.internalLinks) {
      const linkKey = normalizeUrl(link);
      if (linkKey === fromKey) continue; // self-links don't count
      if (!byUrl.has(linkKey)) continue;
      if (seenTargets.has(linkKey)) continue;
      seenTargets.add(linkKey);
      inbound.set(linkKey, (inbound.get(linkKey) ?? 0) + 1);
    }
  }
  return inbound;
}

function reconcileSitemap(pages: SitePageInput[], sitemap: SitemapAnalysis | null): SitemapReconciliation | null {
  if (!sitemap || !sitemap.available) return null;
  const discovered = new Set(pages.map((p) => normalizeUrl(p.url)));
  const sitemapNorm = new Map<string, string>(); // normalized -> original loc
  for (const entry of sitemap.urls) sitemapNorm.set(normalizeUrl(entry.loc), entry.loc);

  const sitemapOnly: string[] = [];
  for (const [norm, loc] of sitemapNorm) {
    if (!discovered.has(norm)) sitemapOnly.push(loc);
  }
  const discoveredOnly: string[] = [];
  for (const p of pages) {
    if (!sitemapNorm.has(normalizeUrl(p.url))) discoveredOnly.push(p.url);
  }
  const overlapCount = sitemapNorm.size - sitemapOnly.length;

  return { sitemapCount: sitemapNorm.size, discoveredCount: discovered.size, sitemapOnly, discoveredOnly, overlapCount };
}

export interface AnalyzeSiteInput {
  pages: SitePageInput[];
  homepageUrl: string;
  sitemap?: SitemapAnalysis | null;
  /** URLs considered important enough that deep-burial/missing-from-sitemap is worth flagging (defaults to the homepage only) */
  importantUrls?: string[];
  /** crawl depth beyond which an important page is flagged as "buried" */
  deepThreshold?: number;
}

export function analyzeSite(input: AnalyzeSiteInput): SiteSeoReport {
  const { pages, homepageUrl } = input;
  const sitemap = input.sitemap ?? null;
  const deepThreshold = input.deepThreshold ?? 3;
  const byUrl = new Map(pages.map((p) => [normalizeUrl(p.url), p]));

  const issues: Issue[] = [];

  // ---------------- duplicate titles / descriptions ----------------
  const duplicateTitles = findDuplicates(pages, (p) => p.html.title);
  const duplicateDescriptions = findDuplicates(pages, (p) => p.html.metaDescription);
  for (const group of duplicateTitles) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Duplicate <title> across multiple pages",
        affected: group.urls[0],
        whyItMatters: "Identical titles across different pages make it harder for both users and search engines to distinguish the pages in search results.",
        estimatedImpact: `Title "${group.value}" is used on ${group.urls.length} pages.`,
        recommendedFix: "Give each page a unique, descriptive title.",
        difficulty: "easy",
        source: "measured",
        evidence: group.urls.slice(0, 10).map((u) => ({ type: "url" as const, label: "Page with this title", value: u })),
      }),
    );
  }
  for (const group of duplicateDescriptions) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Duplicate meta description across multiple pages",
        affected: group.urls[0],
        whyItMatters: "Identical descriptions give search engines and users no way to distinguish the pages in a results list.",
        estimatedImpact: `Same description used on ${group.urls.length} pages.`,
        recommendedFix: "Write a unique meta description for each page.",
        difficulty: "easy",
        source: "measured",
        evidence: group.urls.slice(0, 10).map((u) => ({ type: "url" as const, label: "Page with this description", value: u })),
      }),
    );
  }

  // ---------------- canonical conflicts ----------------
  const canonicalConflicts: CanonicalConflict[] = [];
  for (const p of pages) {
    const target = p.seo.canonical.resolvedUrl;
    if (!target || p.seo.canonical.isSelfReferencing) continue;
    const targetPage = byUrl.get(normalizeUrl(target));
    if (!targetPage) continue; // target not among analyzed pages - nothing more we can verify
    if (!targetPage.seo.indexability.isIndexable) {
      canonicalConflicts.push({ url: p.url, canonicalTarget: target, reason: "canonical target is noindex" });
    } else if (targetPage.redirectTarget) {
      canonicalConflicts.push({ url: p.url, canonicalTarget: target, reason: `canonical target redirects to ${targetPage.redirectTarget}` });
    } else if (targetPage.statusCode >= 400) {
      canonicalConflicts.push({ url: p.url, canonicalTarget: target, reason: `canonical target returns HTTP ${targetPage.statusCode}` });
    }
  }
  for (const conflict of canonicalConflicts) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Canonical URL points to a problematic target",
        affected: conflict.url,
        whyItMatters: `A canonical tag should point at a healthy, indexable page. This one's target has a problem (${conflict.reason}), which undermines the canonical signal entirely.`,
        estimatedImpact: conflict.reason,
        recommendedFix: "Point the canonical tag at a URL that returns 200 and is indexable, or fix the underlying issue on the target page.",
        difficulty: "moderate",
        source: "measured",
        evidence: [
          { type: "url", label: "Page", value: conflict.url },
          { type: "url", label: "Canonical target", value: conflict.canonicalTarget },
          { type: "computed", label: "Problem", value: conflict.reason },
        ],
      }),
    );
  }

  // ---------------- internal link graph: depth + orphans ----------------
  const depths = computeDepths(pages, homepageUrl);
  const inbound = computeInboundCounts(pages);
  const homeKey = normalizeUrl(homepageUrl);

  const orphanPages: OrphanPage[] = [];
  for (const p of pages) {
    const key = normalizeUrl(p.url);
    if (key === homeKey) continue;
    const inCount = inbound.get(key) ?? 0;
    if (inCount === 0) {
      orphanPages.push({ url: p.url, kind: "no-internal-inbound-links" });
    }
  }
  if (sitemap?.available) {
    for (const entry of sitemap.urls) {
      const key = normalizeUrl(entry.loc);
      if (!byUrl.has(key)) {
        orphanPages.push({ url: entry.loc, kind: "sitemap-only" });
      }
    }
  }
  for (const orphan of orphanPages) {
    issues.push(
      makeIssue({
        severity: orphan.kind === "sitemap-only" ? "medium" : "high",
        title: orphan.kind === "sitemap-only" ? "Sitemap includes a URL with no discovered internal links" : "Orphan page: no internal links point to it",
        affected: orphan.url,
        whyItMatters:
          orphan.kind === "sitemap-only"
            ? "This URL is declared in the sitemap but wasn't reached by following internal links from the homepage, so users and crawlers relying on navigation alone can't find it."
            : "A page with zero internal inbound links is hard for both users and search engines to discover, and receives no internal link authority.",
        recommendedFix: "Add at least one internal link to this page from relevant, already-linked pages (navigation, related content, sitemap page, etc.).",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "url", label: "Orphan page", value: orphan.url }],
      }),
    );
  }

  // crawl depth stats
  let crawlDepth: CrawlDepthStats | null = null;
  const depthValues = [...depths.values()];
  if (depthValues.length > 0) {
    const importantUrls = new Set((input.importantUrls ?? [homepageUrl]).map(normalizeUrl));
    const deepImportantPages: { url: string; depth: number }[] = [];
    for (const [key, depth] of depths) {
      if (importantUrls.has(key) && depth > deepThreshold) {
        const p = byUrl.get(key);
        if (p) deepImportantPages.push({ url: p.url, depth });
      }
    }
    crawlDepth = {
      min: Math.min(...depthValues),
      max: Math.max(...depthValues),
      average: Math.round((depthValues.reduce((s, d) => s + d, 0) / depthValues.length) * 10) / 10,
      deepImportantPages,
    };
    for (const deep of deepImportantPages) {
      issues.push(
        makeIssue({
          severity: "medium",
          title: "Important page is buried deep in the site structure",
          affected: deep.url,
          whyItMatters: `This page is ${deep.depth} clicks from the homepage. Pages that are harder to reach through internal navigation tend to be crawled less often and get less internal link authority.`,
          estimatedImpact: `Crawl depth: ${deep.depth} (threshold: ${deepThreshold})`,
          recommendedFix: "Add a shorter internal-link path to this page, e.g. from the homepage, main navigation, or a relevant hub page.",
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "computed", label: "Crawl depth from homepage", value: String(deep.depth) }],
        }),
      );
    }
  }

  // ---------------- broken / redirected / noindex internal links ----------------
  const brokenInternalLinks: { fromUrl: string; toUrl: string }[] = [];
  const internalLinksToRedirects: { fromUrl: string; toUrl: string; redirectsTo: string }[] = [];
  const internalLinksToNoindexPages: { fromUrl: string; toUrl: string }[] = [];
  for (const p of pages) {
    for (const link of p.internalLinks) {
      const target = byUrl.get(normalizeUrl(link));
      if (!target) continue; // link target outside the analyzed set - can't verify
      if (target.statusCode >= 400) {
        brokenInternalLinks.push({ fromUrl: p.url, toUrl: link });
      } else if (target.redirectTarget) {
        internalLinksToRedirects.push({ fromUrl: p.url, toUrl: link, redirectsTo: target.redirectTarget });
      } else if (!target.seo.indexability.isIndexable) {
        internalLinksToNoindexPages.push({ fromUrl: p.url, toUrl: link });
      }
    }
  }
  for (const b of brokenInternalLinks) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Internal link points to a broken page",
        affected: b.fromUrl,
        whyItMatters: "A broken internal link wastes crawl budget and creates a dead end for users following it.",
        estimatedImpact: `Link to ${b.toUrl} on ${b.fromUrl}`,
        recommendedFix: `Fix or remove the link to ${b.toUrl}.`,
        difficulty: "easy",
        source: "measured",
        evidence: [
          { type: "url", label: "Linking page", value: b.fromUrl },
          { type: "url", label: "Broken link target", value: b.toUrl },
        ],
      }),
    );
  }
  for (const r of internalLinksToRedirects) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Internal link points to a redirect instead of the final URL",
        affected: r.fromUrl,
        whyItMatters: "Linking directly to a redirect adds an unnecessary hop for users and dilutes internal link signal slightly compared to linking straight to the destination.",
        estimatedImpact: `${r.toUrl} redirects to ${r.redirectsTo}`,
        recommendedFix: `Update the link on ${r.fromUrl} to point directly at ${r.redirectsTo}.`,
        difficulty: "easy",
        source: "measured",
        evidence: [
          { type: "url", label: "Linking page", value: r.fromUrl },
          { type: "url", label: "Redirect target", value: `${r.toUrl} -> ${r.redirectsTo}` },
        ],
      }),
    );
  }
  for (const n of internalLinksToNoindexPages) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Internal link points to a noindex page",
        affected: n.fromUrl,
        whyItMatters: "Linking to a noindex page from an indexable page is often unintentional and can pass link equity toward a page that will never appear in search results.",
        estimatedImpact: `Link to ${n.toUrl} on ${n.fromUrl}`,
        recommendedFix: "Confirm this is intentional. If not, either remove the link or make the target page indexable.",
        difficulty: "easy",
        source: "measured",
        evidence: [
          { type: "url", label: "Linking page", value: n.fromUrl },
          { type: "url", label: "Noindex target", value: n.toUrl },
        ],
      }),
    );
  }

  // ---------------- sitemap reconciliation ----------------
  const sitemapReconciliation = reconcileSitemap(pages, sitemap);
  if (sitemap?.available) {
    if (sitemap.malformedUrlCount > 0) {
      issues.push(
        makeIssue({
          severity: "medium",
          title: "Sitemap contains malformed URL entries",
          affected: sitemap.sitemapUrl ?? "sitemap.xml",
          whyItMatters: "Malformed <loc> entries are typically skipped by search engines, wasting space in the sitemap.",
          estimatedImpact: `${sitemap.malformedUrlCount} malformed entries.`,
          recommendedFix: "Fix or remove malformed URL entries from the sitemap.",
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "computed", label: "Malformed sitemap entries", value: String(sitemap.malformedUrlCount) }],
        }),
      );
    }
    if (sitemap.duplicateUrlCount > 0) {
      issues.push(
        makeIssue({
          severity: "low",
          title: "Sitemap contains duplicate URL entries",
          affected: sitemap.sitemapUrl ?? "sitemap.xml",
          whyItMatters: "Duplicate entries add no value and bloat the sitemap unnecessarily.",
          estimatedImpact: `${sitemap.duplicateUrlCount} duplicate entries.`,
          recommendedFix: "De-duplicate the sitemap's URL list.",
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "computed", label: "Duplicate sitemap entries", value: String(sitemap.duplicateUrlCount) }],
        }),
      );
    }
    for (const loc of sitemap.urls.map((u) => u.loc)) {
      const target = byUrl.get(normalizeUrl(loc));
      if (!target) continue;
      if (target.statusCode >= 400) {
        issues.push(
          makeIssue({
            severity: "high",
            title: "Sitemap URL returns an error status",
            affected: loc,
            whyItMatters: "A sitemap should only list URLs that are actually reachable and indexable; a broken URL in the sitemap wastes crawl budget.",
            estimatedImpact: `HTTP ${target.statusCode}`,
            recommendedFix: "Remove this URL from the sitemap, or fix the underlying page so it returns 200.",
            difficulty: "easy",
            source: "measured",
            evidence: [{ type: "computed", label: "Sitemap URL status", value: String(target.statusCode) }],
          }),
        );
      } else if (target.redirectTarget) {
        issues.push(
          makeIssue({
            severity: "medium",
            title: "Sitemap URL redirects instead of returning 200",
            affected: loc,
            whyItMatters: "Sitemaps should list final destination URLs; a redirecting entry forces an extra hop and signals a stale sitemap.",
            estimatedImpact: `Redirects to ${target.redirectTarget}`,
            recommendedFix: `Update the sitemap entry to ${target.redirectTarget} directly.`,
            difficulty: "easy",
            source: "measured",
            evidence: [{ type: "computed", label: "Redirect target", value: target.redirectTarget }],
          }),
        );
      } else if (!target.seo.indexability.isIndexable) {
        issues.push(
          makeIssue({
            severity: "medium",
            title: "Sitemap includes a noindex URL",
            affected: loc,
            whyItMatters: "Listing a noindex page in the sitemap sends contradictory signals - the sitemap says \"please index this\" while the page itself says \"don't.\"",
            recommendedFix: "Remove this URL from the sitemap, or remove noindex from the page if it should be indexed.",
            difficulty: "easy",
            source: "measured",
            evidence: [{ type: "html", label: "Page indexability", value: "noindex" }],
          }),
        );
      }
    }
  }

  // ---------------- URL variants ----------------
  const urlVariantGroups = findUrlVariantGroups(pages.map((p) => p.url));
  for (const group of urlVariantGroups) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Inconsistent URL variants for equivalent content",
        affected: group.variants[0],
        whyItMatters: "Multiple raw URL forms (scheme/www/trailing-slash/case) reaching what appears to be the same content can dilute ranking signals across duplicate URLs if not consistently canonicalized.",
        estimatedImpact: `Variants seen: ${group.variants.join(", ")}`,
        recommendedFix: "Pick one canonical URL form and 301-redirect (or canonicalize) the others to it.",
        difficulty: "moderate",
        source: "measured",
        evidence: group.variants.map((v) => ({ type: "url" as const, label: "URL variant", value: v })),
      }),
    );
  }

  const structuredDataIssueCount = pages.reduce(
    (sum, p) => sum + p.seo.structuredData.malformed.length + p.seo.structuredData.incompleteItems.length + p.seo.structuredData.contentMismatches.length,
    0,
  );

  return {
    pagesAnalyzed: pages.length,
    duplicateTitles,
    duplicateDescriptions,
    canonicalConflicts,
    orphanPages,
    crawlDepth,
    sitemap: sitemapReconciliation,
    brokenInternalLinks,
    internalLinksToRedirects,
    internalLinksToNoindexPages,
    urlVariantGroups,
    structuredDataIssueCount,
    issues,
  };
}
