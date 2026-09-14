import type { HtmlAnalysis, Issue, RobotsTxtAnalysis, SeoExtendedAnalysis, Severity } from "../types.js";
import { checkRobotsPath } from "../collectors/robotsCollector.js";
import { normalizeUrlForCompare } from "../collectors/seoCollector.js";

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 70, medium: 40, low: 15 };

let counter = 0;
function nextId(): string {
  counter += 1;
  return `seo-adv-${counter}`;
}
export function resetSeoIssueIdCounter() {
  counter = 0;
}

function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  return { ...input, category: "seo", id: nextId(), priorityScore: SEVERITY_WEIGHT[input.severity] };
}

/**
 * Deeper, single-page SEO checks that build on top of the existing
 * basic SEO rules in analysis/issues.ts (title/description/H1/canonical
 * presence, viewport, image alt). This file does NOT re-detect any of
 * those - it only adds checks that analysis/issues.ts genuinely does
 * not cover: indexability distinctions, canonical correctness beyond
 * "exists," structured data, Open Graph/social metadata, hreflang,
 * deeper image SEO, and content-discoverability signals. `robots`, if
 * provided (best-effort, may be `available: false`), lets this cross-
 * check the current page's own path against robots.txt.
 */
export function detectAdvancedSeoIssues(
  fetchResult: { finalUrl: string; statusCode: number },
  html: HtmlAnalysis,
  seo: SeoExtendedAnalysis,
  robots: RobotsTxtAnalysis | null,
): Issue[] {
  const issues: Issue[] = [];
  const page = fetchResult.finalUrl;

  // ---------------- Indexability ----------------
  if (seo.indexability.conflicting) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Conflicting indexability signals",
        affected: page,
        whyItMatters:
          "The meta robots tag and the X-Robots-Tag response header disagree about whether this page should be indexed. Search engines resolve conflicts unpredictably, so the outcome is not guaranteed.",
        recommendedFix: "Make the meta robots tag and X-Robots-Tag header agree on index/noindex for this page.",
        difficulty: "easy",
        source: "measured",
        evidence: [
          { type: "html", label: "meta[name=robots]", value: seo.indexability.metaRobots.raw ?? "not present" },
          { type: "header", label: "X-Robots-Tag", value: seo.indexability.xRobotsTag.raw ?? "not present" },
        ],
      }),
    );
  }

  if (!seo.indexability.isIndexable && html.canonicalUrl) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Non-indexable page still declares a canonical URL",
        affected: page,
        whyItMatters:
          "A canonical tag on a noindex page is a mixed signal - it implies this URL is a duplicate of a preferred, indexable version, but noindex tells search engines to drop it from the index entirely regardless.",
        recommendedFix: "If this page should never be indexed, the canonical tag is unnecessary. If it should be indexed under a different URL, remove noindex and keep the canonical pointing there.",
        difficulty: "easy",
        source: "measured",
        evidence: [
          { type: "html", label: "meta[name=robots]", value: seo.indexability.metaRobots.raw ?? "noindex via header" },
          { type: "html", label: "link[rel=canonical]", value: html.canonicalUrl },
        ],
      }),
    );
  }

  // ---------------- Canonical (deeper than "exists") ----------------
  const c = seo.canonical;
  if (c.rawHref) {
    if (c.isMalformed) {
      issues.push(
        makeIssue({
          severity: "high",
          title: "Canonical URL is malformed",
          affected: page,
          whyItMatters: "A canonical tag that isn't a valid, resolvable URL cannot be honored by search engines and is effectively ignored.",
          recommendedFix: "Fix the href attribute of the canonical link so it resolves to a valid absolute URL.",
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "html", label: "link[rel=canonical] href", value: c.rawHref }],
        }),
      );
    } else if (c.pointsToDifferentDomain) {
      issues.push(
        makeIssue({
          severity: "high",
          title: "Canonical URL points to a different domain",
          affected: page,
          whyItMatters:
            "A cross-domain canonical tells search engines this page's content is owned by another site, which can remove this page from this site's search results entirely. This is sometimes intentional (e.g. syndicated content) but is high-impact either way.",
          recommendedFix: "Confirm this is intentional (content syndication). Otherwise, point the canonical at this domain.",
          difficulty: "easy",
          source: "measured",
          evidence: [
            { type: "html", label: "Canonical target", value: c.resolvedUrl ?? c.rawHref },
            { type: "url", label: "Page URL", value: page },
          ],
        }),
      );
    } else if (!c.isSelfReferencing && c.resolvedUrl) {
      issues.push(
        makeIssue({
          severity: "low",
          title: "Canonical URL points to a different page on the same site",
          affected: page,
          whyItMatters:
            "This tells search engines a different URL is the preferred version of this content. If unintentional, it can prevent this exact page from ever appearing in search results.",
          estimatedImpact: `Canonical target: ${c.resolvedUrl}`,
          recommendedFix: "Confirm this is intentional (this page is a genuine duplicate/variant). Otherwise, make the canonical self-referencing.",
          difficulty: "easy",
          source: "measured",
          evidence: [
            { type: "html", label: "Canonical target", value: c.resolvedUrl },
            { type: "url", label: "Page URL", value: page },
          ],
        }),
      );
    }

    if (!c.isAbsolute && !c.isMalformed) {
      issues.push(
        makeIssue({
          severity: "low",
          title: "Canonical URL is relative, not absolute",
          affected: page,
          whyItMatters: "Google explicitly recommends absolute canonical URLs; a relative canonical relies on correct base-URL resolution, which isn't guaranteed across all crawlers/proxies.",
          recommendedFix: `Use an absolute URL, e.g. "${c.resolvedUrl ?? "https://example.com/page"}" instead of "${c.rawHref}".`,
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "html", label: "link[rel=canonical] href", value: c.rawHref }],
        }),
      );
    }

    if (c.duplicateDeclarations > 1) {
      issues.push(
        makeIssue({
          severity: "medium",
          title: "Multiple canonical tags declared",
          affected: page,
          whyItMatters: "When more than one <link rel=\"canonical\"> tag is present, search engines may ignore all of them or pick an unintended one.",
          estimatedImpact: `${c.duplicateDeclarations} canonical tags found on this page.`,
          recommendedFix: "Keep exactly one <link rel=\"canonical\"> tag per page.",
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "html", label: "link[rel=canonical] count", value: String(c.duplicateDeclarations) }],
        }),
      );
    }
  }

  // ---------------- robots.txt cross-check ----------------
  if (robots?.available) {
    const check = checkRobotsPath(robots, page);
    if (check.blocked) {
      issues.push(
        makeIssue({
          severity: seo.indexability.isIndexable ? "high" : "low",
          title: "Page is blocked by robots.txt",
          affected: page,
          whyItMatters: seo.indexability.isIndexable
            ? "robots.txt prevents search engines from crawling this page at all, even though nothing else on the page says it shouldn't be indexed - meaning it can still be indexed from external links but never actually crawled/refreshed, a confusing and usually unintended state."
            : "robots.txt disallows crawling this page, consistent with its noindex directive.",
          recommendedFix: "If this page should be discoverable, remove the matching Disallow rule from robots.txt. If it's intentional, no action is needed.",
          difficulty: "easy",
          source: "measured",
          evidence: [
            { type: "url", label: "robots.txt rule", value: `${check.matchedGroup ?? "*"}: Disallow: ${check.matchedRule}` },
            { type: "url", label: "Page path", value: new URL(page).pathname },
          ],
        }),
      );
    }
  }

  // ---------------- Structured data ----------------
  for (const m of seo.structuredData.malformed) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Malformed JSON-LD structured data",
        affected: page,
        whyItMatters: "Invalid JSON in a structured-data script block means search engines cannot parse any of it - the entire block is silently discarded.",
        estimatedImpact: `Parse error: ${m.error}`,
        recommendedFix: "Fix the JSON syntax in the affected <script type=\"application/ld+json\"> block.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "JSON-LD parse error", value: `${m.error} (near: ${m.snippet.slice(0, 80)})` }],
      }),
    );
  }

  for (const inc of seo.structuredData.incompleteItems) {
    issues.push(
      makeIssue({
        severity: "low",
        title: `${inc.types.join("/")} structured data is missing recommended properties`,
        affected: page,
        whyItMatters: "Incomplete structured data may make this page ineligible for the corresponding rich-result treatment in search.",
        estimatedImpact: `Missing: ${inc.missingProperties.join(", ")}`,
        recommendedFix: `Add ${inc.missingProperties.join(", ")} to the ${inc.types.join("/")} structured-data block.`,
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "JSON-LD missing properties", value: inc.missingProperties.join(", ") }],
      }),
    );
  }

  for (const mismatch of seo.structuredData.contentMismatches) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: `Structured data doesn't match visible page content (${mismatch.schemaType})`,
        affected: page,
        whyItMatters:
          "Search engines may treat a mismatch between structured data and visible content as unreliable or spammy markup, and rich results can be suppressed or flagged as inaccurate.",
        estimatedImpact: `Schema ${mismatch.property}: "${mismatch.schemaValue}" vs. observed page content: "${mismatch.observedPageValue}"`,
        recommendedFix: mismatch.note,
        difficulty: "moderate",
        source: "measured",
        evidence: [
          { type: "html", label: `Structured data ${mismatch.property}`, value: mismatch.schemaValue },
          { type: "html", label: "Observed on page", value: mismatch.observedPageValue },
        ],
      }),
    );
  }

  for (const dup of seo.structuredData.duplicateBlocks) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Duplicate structured-data blocks",
        affected: page,
        whyItMatters: "Identical structured-data blocks repeated on the page add no information and can make automated validation/interpretation ambiguous.",
        estimatedImpact: `${dup.indexes.length} identical ${dup.types.join("/")} blocks found.`,
        recommendedFix: "Remove the duplicate JSON-LD block, keeping only one.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Duplicate JSON-LD blocks", value: `${dup.indexes.length} copies of ${dup.types.join("/")}` }],
      }),
    );
  }

  // ---------------- Open Graph / social metadata ----------------
  const og = seo.openGraph;
  const hasAnyOg = og.ogTitle || og.ogDescription || og.ogImage || og.ogType;
  if (hasAnyOg) {
    const missing: string[] = [];
    if (!og.ogTitle) missing.push("og:title");
    if (!og.ogDescription) missing.push("og:description");
    if (!og.ogImage) missing.push("og:image");
    if (missing.length > 0) {
      issues.push(
        makeIssue({
          severity: "low",
          title: "Incomplete Open Graph metadata",
          affected: page,
          whyItMatters: "Missing Open Graph tags mean social platforms (Facebook, LinkedIn, Slack, etc.) fall back to guessing a title/description/image when this page is shared, which may render poorly.",
          estimatedImpact: `Missing: ${missing.join(", ")}`,
          recommendedFix: `Add ${missing.join(", ")} meta tags.`,
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "html", label: "Open Graph tags missing", value: missing.join(", ") }],
        }),
      );
    }
    if (og.ogUrlInconsistentWithCanonical) {
      issues.push(
        makeIssue({
          severity: "low",
          title: "og:url does not match the canonical URL",
          affected: page,
          whyItMatters: "When og:url and the canonical URL disagree, social shares and search engines get inconsistent signals about this page's true address.",
          estimatedImpact: `og:url: ${og.ogUrl} vs canonical: ${seo.canonical.resolvedUrl}`,
          recommendedFix: "Set og:url to the same URL as the canonical tag.",
          difficulty: "easy",
          source: "measured",
          evidence: [
            { type: "html", label: "og:url", value: og.ogUrl ?? "" },
            { type: "html", label: "canonical", value: seo.canonical.resolvedUrl ?? "" },
          ],
        }),
      );
    }
  }

  // ---------------- hreflang ----------------
  const hl = seo.hreflang;
  if (hl.entries.length > 0) {
    if (hl.malformedLangCodes.length > 0) {
      issues.push(
        makeIssue({
          severity: "medium",
          title: "Malformed hreflang language codes",
          affected: page,
          whyItMatters: "An hreflang value that isn't a valid language[-region] code is ignored by search engines, silently breaking international targeting for that entry.",
          estimatedImpact: `Invalid codes: ${hl.malformedLangCodes.join(", ")}`,
          recommendedFix: 'Use valid BCP-47 codes, e.g. "en", "en-US", or "x-default".',
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "html", label: "Invalid hreflang values", value: hl.malformedLangCodes.join(", ") }],
        }),
      );
    }
    if (!hl.hasSelfReference) {
      issues.push(
        makeIssue({
          severity: "low",
          title: "hreflang set has no self-referencing entry",
          affected: page,
          whyItMatters: "Google's guidance is that each page in an hreflang set should include a self-referencing entry pointing at itself; omitting it can make the whole set unreliable.",
          recommendedFix: "Add a hreflang entry for this page's own language/region pointing back at this exact URL.",
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "html", label: "hreflang entries", value: hl.entries.map((e) => e.lang).join(", ") }],
        }),
      );
    }
  }

  // ---------------- Image SEO (beyond alt presence, already covered elsewhere) ----------------
  const imagesMissingDimensions = seo.images.filter((i) => i.hasAlt && !i.hasDimensions);
  if (imagesMissingDimensions.length > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Images missing width/height attributes",
        affected: page,
        whyItMatters: "Without explicit dimensions, the browser cannot reserve layout space before the image loads, which can contribute to layout shift.",
        estimatedImpact: `${imagesMissingDimensions.length} image(s) missing width/height.`,
        recommendedFix: "Add explicit width and height attributes to <img> tags (CSS can still control display size).",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Images missing dimensions", value: String(imagesMissingDimensions.length) }],
      }),
    );
  }

  // ---------------- Content discoverability ----------------
  if (seo.content.looksLikePlaceholder) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Page looks like placeholder/unfinished content",
        affected: page,
        whyItMatters: "Placeholder text (\"coming soon\", \"under construction\", etc.) combined with very little other content gives search engines almost nothing to index or rank.",
        recommendedFix: "Replace placeholder content with real page content, or noindex the page until it's ready.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: "Visible text length", value: `${seo.content.visibleTextLength} characters` }],
      }),
    );
  } else if (seo.content.isThinContent) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Very little visible text content",
        affected: page,
        whyItMatters: "Search engines primarily rank text content. A page with almost no visible text gives them very little to understand or rank the page for.",
        estimatedImpact: `Only ${seo.content.visibleTextLength} characters of visible text detected.`,
        recommendedFix: "Add meaningful, unique text content describing what this page is about.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: "Visible text length", value: `${seo.content.visibleTextLength} characters` }],
      }),
    );
  }

  // ---------------- Internal links (single-page signal only) ----------------
  if (seo.links.internal.length === 0 && seo.content.visibleTextLength >= 200) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Page has no internal links",
        affected: page,
        whyItMatters:
          "This page doesn't link to any other page on the same site. That's a dead end for users and gives search engines nothing to follow onward from here - it can also mean the page is unreachable from anywhere except a direct URL. (This is a single-page signal only - it can't tell you whether other pages link to this one; that requires crawling the whole site.)",
        recommendedFix: "Add relevant internal links (navigation, related content, breadcrumbs, etc.) from this page to other pages on the site.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Internal links found on this page", value: "0" }],
      }),
    );
  }

  // ---------------- Anchor text quality (Session 10) ----------------
  // Gated at >=3 occurrences deliberately: an occasional "Read more" next
  // to an article teaser is a common, low-risk UI pattern, not a real
  // problem - this only fires when generic anchor text is a PATTERN
  // across the page, not an isolated instance.
  if ((seo.links.genericAnchorCount ?? 0) >= 3) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Multiple links use generic, non-descriptive anchor text",
        affected: page,
        whyItMatters:
          'Search engines use a link\'s visible text as a relevance signal for the page it points to. Text like "click here" or "read more" carries no topical information, so those links contribute little to how the destination pages are understood.',
        estimatedImpact: `${seo.links.genericAnchorCount ?? 0} internal link(s) with generic anchor text, e.g. "${seo.links.genericAnchorExamples?.[0]?.text ?? "n/a"}" -> ${seo.links.genericAnchorExamples?.[0]?.href ?? "n/a"}`,
        recommendedFix: 'Replace generic anchor text with a short phrase describing the destination page, e.g. "Read our shipping policy" instead of "Click here".',
        difficulty: "easy",
        source: "measured",
        evidence: (seo.links.genericAnchorExamples ?? []).map((e) => ({ type: "html" as const, label: "Generic anchor text", value: `"${e.text}" -> ${e.href}` })),
      }),
    );
  }

  if (seo.links.genericAnchorCount >= 3) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Multiple links use generic, non-descriptive anchor text",
        affected: page,
        whyItMatters:
          'Search engines use a link\'s visible text as a relevance signal for the page it points to. Text like "click here" or "read more" carries no topical information, so those links contribute little to how the destination pages are understood.',
        estimatedImpact: `${seo.links.genericAnchorCount} internal link(s) with generic anchor text, e.g. "${seo.links.genericAnchorExamples[0]?.text}" -> ${seo.links.genericAnchorExamples[0]?.href}`,
        recommendedFix: 'Replace generic anchor text with a short phrase describing the destination page, e.g. "Read our shipping policy" instead of "Click here".',
        difficulty: "easy",
        source: "measured",
        evidence: seo.links.genericAnchorExamples.map((e) => ({ type: "html" as const, label: "Generic anchor text", value: `"${e.text}" -> ${e.href}` })),
      }),
    );
  }

  // ---------------- Pagination (rel=next/prev) - only checked when actually present ----------------
  const pg = seo.pagination;
  if (pg && pg.nextHref && !pg.nextResolvedHref) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: 'Malformed rel="next" pagination link',
        affected: page,
        whyItMatters: 'A rel="next" link that doesn\'t resolve to a valid URL is ignored, silently breaking the pagination relationship for this sequence of pages.',
        recommendedFix: "Fix the href on the rel=\"next\" <link> tag so it resolves to a valid URL.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: 'link[rel="next"] href', value: pg.nextHref }],
      }),
    );
  }
  if (pg && pg.prevHref && !pg.prevResolvedHref) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: 'Malformed rel="prev" pagination link',
        affected: page,
        whyItMatters: 'A rel="prev" link that doesn\'t resolve to a valid URL is ignored, silently breaking the pagination relationship for this sequence of pages.',
        recommendedFix: 'Fix the href on the rel="prev" <link> tag so it resolves to a valid URL.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: 'link[rel="prev"] href', value: pg.prevHref }],
      }),
    );
  }
  if (pg && pg.nextResolvedHref && normalizeUrlForCompare(pg.nextResolvedHref) === normalizeUrlForCompare(page)) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: 'rel="next" pagination link points at this same page',
        affected: page,
        whyItMatters: "A pagination link pointing back at itself is almost always a bug in how pagination URLs were generated - it doesn't advance the sequence.",
        recommendedFix: 'Point rel="next" at the actual next page in the sequence, or remove it if this is the last page.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: 'link[rel="next"] href', value: pg.nextResolvedHref }],
      }),
    );
  }

  // ---------------- Structured-data entity conflicts (Session 10) ----------------
  for (const conflict of seo.structuredData.conflicts ?? []) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: `Conflicting ${conflict.type} structured data on the same page`,
        affected: page,
        whyItMatters: `Multiple ${conflict.type} blocks on this page disagree on ${conflict.property}, which sends search engines contradictory information about the same entity.`,
        estimatedImpact: conflict.values.map((v) => `"${v.value}"`).join(" vs. "),
        recommendedFix: `Make every ${conflict.type} block on this page agree on ${conflict.property}, or remove the ones that don't describe this page.`,
        difficulty: "easy",
        source: "measured",
        evidence: conflict.values.map((v) => ({ type: "html" as const, label: `${conflict.type} ${conflict.property}`, value: v.value })),
      }),
    );
  }

  return issues;
}
