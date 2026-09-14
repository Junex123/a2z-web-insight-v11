import * as cheerio from "cheerio";
import { fetchTextResource } from "./resourceFetcher.js";
import { MAX_EXTERNAL_STYLESHEETS } from "../analysis/responsiveThresholds.js";
import type { CssEvidenceSource, ImageResponsivenessEvidence, NavigationResponsivenessEvidence, ResponsiveAnalysis, ViewportEvidence } from "../types.js";

/**
 * Mobile + Desktop Responsiveness Intelligence - MEASURE step.
 *
 * Same static-analysis philosophy as every other collector in this
 * project (htmlCollector.ts, accessibilityCollector.ts, etc.): no JS
 * execution, no rendering, no headless browser. This collector adds
 * exactly one new capability the rest of the project didn't already
 * have - a small, BOUNDED, SSRF-guarded fetch of external stylesheets
 * (via resourceFetcher.ts's fetchTextResource(), reused rather than
 * duplicated) so media queries and fixed-width rules can actually be
 * inspected. Everything else is derived from the HTML already fetched
 * for this scan - no second page fetch, no re-collection of anything
 * htmlCollector.ts/accessibilityCollector.ts already own.
 *
 * WHY A SEPARATE cheerio.load() PASS: matches the precedent already
 * established for accessibilityCollector.ts/uxCollector.ts/etc. in
 * this project - avoids touching htmlCollector.ts's existing,
 * depended-upon signature. See accessibilityCollector.ts's own comment
 * for the full reasoning; not repeated here.
 */
export async function collectResponsive(bodyText: string, pageUrl: string): Promise<ResponsiveAnalysis> {
  const $ = cheerio.load(bodyText);

  const viewport = collectViewportEvidence($);
  const css = await collectCssEvidence($, pageUrl);
  const images = collectImageEvidence($);
  const navigation = collectNavigationEvidence($);

  return { viewport, css, images, navigation };
}

function collectViewportEvidence($: cheerio.CheerioAPI): ViewportEvidence {
  const content = $('meta[name="viewport"]').first().attr("content")?.trim() ?? null;
  const present = content !== null;
  const hasDeviceWidthToken = present && /width\s*=\s*device-width/i.test(content!);
  const fixedWidthMatch = present ? content!.match(/(?:^|,)\s*width\s*=\s*(\d+)/i) : null;
  const hasFixedNumericWidth = !!fixedWidthMatch;
  const fixedWidthValue = fixedWidthMatch ? Number(fixedWidthMatch[1]) : null;
  const disablesZoom =
    present &&
    (/user-scalable\s*=\s*no/i.test(content!) || /maximum-scale\s*=\s*(0(\.\d+)?|1(\.0+)?)\b/i.test(content!));

  return { present, content, hasDeviceWidthToken, hasFixedNumericWidth, fixedWidthValue, disablesZoom };
}

async function collectCssEvidence($: cheerio.CheerioAPI, pageUrl: string) {
  const inlineBlocks: string[] = [];
  $("style").each((_, el) => {
    const text = $(el).html();
    if (text && text.trim()) inlineBlocks.push(text);
  });

  const stylesheetHrefs = $('link[rel="stylesheet"][href]')
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter((href): href is string => !!href);

  const resolvedUrls: string[] = [];
  for (const href of stylesheetHrefs) {
    try {
      resolvedUrls.push(new URL(href, pageUrl).href);
    } catch {
      // an unparseable href is simply not fetchable - not an error, just skipped
    }
  }

  const toFetch = resolvedUrls.slice(0, MAX_EXTERNAL_STYLESHEETS);
  let externalStylesheetsSkipped = Math.max(0, resolvedUrls.length - MAX_EXTERNAL_STYLESHEETS);

  const sources: CssEvidenceSource[] = [];
  const externalCssTexts: string[] = [];
  for (const url of toFetch) {
    const result = await fetchTextResource(url);
    if (result.ok && result.bodyText) {
      externalCssTexts.push(result.bodyText);
      sources.push({ source: "external", url, bytesInspected: result.bodyText.length });
    } else {
      // fetched-but-failed (network error, non-CSS response, timeout, etc.) counts as
      // "not inspectable" the same as "skipped due to the bound" - both mean we don't
      // have real evidence for this stylesheet, so both must be represented, not silently dropped.
      externalStylesheetsSkipped += 1;
    }
  }
  for (const block of inlineBlocks) {
    sources.push({ source: "inline", url: null, bytesInspected: block.length });
  }

  const allCss = [...inlineBlocks, ...externalCssTexts].join("\n");
  const inspected = allCss.trim().length > 0;

  const mediaQueryCount = (allCss.match(/@media/gi) ?? []).length;

  const breakpointValues = new Set<number>();
  for (const match of allCss.matchAll(/\(\s*(?:max|min)-width\s*:\s*(\d+)px\s*\)/gi)) {
    breakpointValues.add(Number(match[1]));
  }
  const distinctBreakpointValues = [...breakpointValues].sort((a, b) => a - b);

  // Fixed-width declarations: `width: NNNpx` NOT inside a max-width/min-width
  // media query condition (those are legitimate breakpoint definitions, not
  // fixed layout). This is a line-oriented heuristic, not a real CSS parser -
  // documented as such; see analysis/responsiveThresholds.ts.
  const fixedWidthDeclarations: { valuePx: number }[] = [];
  for (const match of allCss.matchAll(/(?<![-\w])width\s*:\s*(\d{3,5})px/gi)) {
    const value = Number(match[1]);
    // heuristic: ignore matches that are clearly part of a media-query condition
    // by checking a short window of preceding text for "(max-width" / "(min-width"
    const precedingContext = allCss.slice(Math.max(0, match.index! - 40), match.index!);
    if (/\(\s*(?:max|min)-width\s*:?\s*$/i.test(precedingContext)) continue;
    fixedWidthDeclarations.push({ valuePx: value });
  }

  const viewportUnitFullWidthCount = (allCss.match(/\b100vw\b/gi) ?? []).length;
  const fixedPositionRuleCount = (allCss.match(/position\s*:\s*fixed/gi) ?? []).length;
  const hasResponsiveImagePattern =
    /img[^{]*\{[^}]*max-width\s*:\s*100%/i.test(allCss) || /max-width\s*:\s*100%\s*;\s*height\s*:\s*auto/i.test(allCss);

  return {
    inspected,
    sources,
    externalStylesheetsSkipped,
    mediaQueryCount,
    distinctBreakpointValues,
    fixedWidthDeclarations,
    viewportUnitFullWidthCount,
    fixedPositionRuleCount,
    hasResponsiveImagePattern,
  };
}

function collectImageEvidence($: cheerio.CheerioAPI): ImageResponsivenessEvidence {
  const imgs = $("img");
  let withSrcsetOrSizes = 0;
  const largeStaticWidthExamples: { src: string; widthPx: number }[] = [];

  imgs.each((_, el) => {
    const $el = $(el);
    if ($el.attr("srcset")?.trim() || $el.attr("sizes")?.trim()) {
      withSrcsetOrSizes++;
      return;
    }
    const widthAttr = $el.attr("width");
    const width = widthAttr ? Number(widthAttr) : NaN;
    if (Number.isFinite(width) && width >= 1200 && largeStaticWidthExamples.length < 5) {
      largeStaticWidthExamples.push({ src: $el.attr("src") ?? "(no src attribute)", widthPx: width });
    }
  });

  return { total: imgs.length, withSrcsetOrSizes, largeStaticWidthExamples };
}

function collectNavigationEvidence($: cheerio.CheerioAPI): NavigationResponsivenessEvidence {
  const navs = $("nav");
  let largestMenuLinkCount = 0;
  let emptyControlCount = 0;
  const linkSetsByNav: Set<string>[] = [];

  navs.each((_, el) => {
    const $nav = $(el);
    const hrefs = $nav
      .find("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get()
      .filter((h): h is string => !!h);
    if (hrefs.length > largestMenuLinkCount) largestMenuLinkCount = hrefs.length;
    linkSetsByNav.push(new Set(hrefs));

    $nav.find("a, button").each((_, ctl) => {
      const $ctl = $(ctl);
      const hasVisibleText = $ctl.text().trim().length > 0;
      const hasAriaLabel = !!$ctl.attr("aria-label")?.trim();
      if (!hasVisibleText && !hasAriaLabel) emptyControlCount++;
    });
  });

  const duplicateNavRisk = hasSubstantialOverlap(linkSetsByNav);

  return { navElementCount: navs.length, duplicateNavRisk, largestMenuLinkCount, emptyControlCount };
}

/** True if two distinct, non-trivial <nav> elements share most of the same link targets - a common "left the old nav in place" template bug. */
function hasSubstantialOverlap(linkSets: Set<string>[]): boolean {
  const substantial = linkSets.filter((s) => s.size >= 2);
  if (substantial.length < 2) return false;
  for (let i = 0; i < substantial.length; i++) {
    for (let j = i + 1; j < substantial.length; j++) {
      const a = substantial[i];
      const b = substantial[j];
      const overlap = [...a].filter((href) => b.has(href)).length;
      const smaller = Math.min(a.size, b.size);
      if (smaller > 0 && overlap / smaller >= 0.7) return true;
    }
  }
  return false;
}
