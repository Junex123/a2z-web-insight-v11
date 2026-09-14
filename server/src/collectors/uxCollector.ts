import * as cheerio from "cheerio";
import type { UxAnalysis } from "../types.js";

/**
 * Parses raw HTML into structured, deterministic UX/content-usability
 * facts. Same philosophy as accessibilityCollector.ts and
 * htmlCollector.ts: pure static-DOM analysis (no JS execution, no
 * rendering), one cheerio.load() pass, zero judgment calls made here -
 * analysis/uxIssues.ts turns these facts into Issues.
 *
 * Deliberately narrow to OBJECTIVE, evidence-backed conditions (literal
 * "lorem ipsum" text, an empty <nav>-less page, a mailto: link with no
 * @ in it) - never a subjective "does this page feel good" judgment.
 * No LLM is used anywhere in this file or its callers.
 */

const MAX_EXAMPLES = 5;

const PLACEHOLDER_PATTERNS = [/lorem ipsum/i, /dolor sit amet/i];

const COMING_SOON_PATTERNS = [
  /coming soon/i,
  /under construction/i,
  /site is currently unavailable/i,
  /this is a placeholder page/i,
  /page (has not been|hasn't been) (created|published)/i,
  /default (parking|placeholder) page/i,
];

/** Short, deterministic, human-readable locator for an element - never a full outerHTML dump. */
function describeElement($el: cheerio.Cheerio<any>, tag: string): string {
  const id = $el.attr("id");
  if (id) return `${tag}#${id}`;
  const href = $el.attr("href");
  if (href) {
    const truncated = href.length > 40 ? `${href.slice(0, 40)}…` : href;
    return `${tag}[href="${truncated}"]`;
  }
  const text = $el.text().trim();
  if (text) return `${tag} ("${text.length > 30 ? `${text.slice(0, 30)}…` : text}")`;
  return `${tag} (no identifying attribute)`;
}

/** Visible text only: strips script/style/noscript content before measuring. Mutates $ (safe: called first, before any other selector in collectUx runs). */
function visibleText($: cheerio.CheerioAPI): string {
  $("script, style, noscript, template").remove();
  const root = $("body").length > 0 ? $("body") : $.root();
  return root.text().replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function isInternalHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("#")) return false; // in-page anchor, not a navigation destination
  if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return false;
  if (/^https?:\/\//i.test(href)) return false; // absolute -> treated as external by this heuristic
  return true; // relative path -> same site
}

/** Drops trailing slashes and query/hash so equivalent nav targets ("/about", "/about/", "/about?ref=x") compare equal across pages. */
function normalizeHrefForComparison(href: string): string {
  return href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
}

const DEAD_LINK_HREFS = new Set(["#", "", "javascript:void(0)", "javascript:void(0);", "javascript:;"]);

export function collectUx(bodyText: string): UxAnalysis {
  const $ = cheerio.load(bodyText);
  const text = visibleText($);
  const wordCount = countWords(text);

  // ---------------- primary navigation ----------------
  const navCandidates = $('nav, [role="navigation"]');
  let navLinkCount = 0;
  const navLinkHrefs: string[] = [];
  navCandidates.each((_, el) => {
    const navLinks = $(el).find("a[href]");
    navLinkCount += navLinks.length;
    navLinks.each((__, a) => {
      const href = $(a).attr("href")?.trim();
      if (href) navLinkHrefs.push(normalizeHrefForComparison(href));
    });
  });
  // conservative fallback: a <header> with several links but no <nav>/role still counts as
  // "has some form of primary navigation" for this static heuristic's purposes
  const headerLinkCount = navCandidates.length === 0 ? $("header").find("a[href]").length : 0;
  const hasPrimaryNav = navLinkCount > 0 || headerLinkCount >= 2;
  if (headerLinkCount >= 2) {
    navLinkCount = headerLinkCount;
    $("header")
      .find("a[href]")
      .each((_, a) => {
        const href = $(a).attr("href")?.trim();
        if (href) navLinkHrefs.push(normalizeHrefForComparison(href));
      });
  }

  // ---------------- ambiguous duplicate nav link labels (Session 9) ----------------
  // Scoped to links within the SAME <nav>/role=navigation container: two+
  // links with identical visible text but DIFFERENT destinations within
  // one navigation region is genuinely ambiguous ("Read more" x3 leading
  // to 3 different pages). Deliberately NOT compared across the whole
  // page (e.g. a "Read more" link in a nav and another in body content
  // are unrelated) or across different <nav> regions.
  let duplicateNavLabelCount = 0;
  const duplicateNavLabelExamples: string[] = [];
  navCandidates.each((_, navEl) => {
    const textToHrefs = new Map<string, Set<string>>();
    $(navEl)
      .find("a[href]")
      .each((__, a) => {
        const $a = $(a);
        const linkText = $a.text().trim().toLowerCase();
        const href = $a.attr("href")?.trim();
        if (!linkText || !href) return;
        if (!textToHrefs.has(linkText)) textToHrefs.set(linkText, new Set());
        textToHrefs.get(linkText)!.add(normalizeHrefForComparison(href));
      });
    for (const [linkText, hrefs] of textToHrefs) {
      if (hrefs.size >= 2) {
        duplicateNavLabelCount++;
        if (duplicateNavLabelExamples.length < MAX_EXAMPLES) {
          duplicateNavLabelExamples.push(`"${linkText}" links to ${hrefs.size} different destinations in the same nav`);
        }
      }
    }
  });

  // ---------------- empty sections ----------------
  const sectionEls = $("main, article, section");
  let emptySectionCount = 0;
  const emptySectionExamples: string[] = [];
  sectionEls.each((_, el) => {
    const $el = $(el);
    const hasText = $el.text().trim().length > 0;
    const hasMedia = $el.find("img, video, audio, svg, canvas, iframe").length > 0;
    const hasInteractive = $el.find("input, button, select, textarea, a[href]").length > 0;
    if (!hasText && !hasMedia && !hasInteractive) {
      emptySectionCount++;
      if (emptySectionExamples.length < MAX_EXAMPLES) {
        const tag = (el as any).tagName?.toLowerCase() ?? "section";
        emptySectionExamples.push(describeElement($el, tag));
      }
    }
  });

  // ---------------- placeholder / coming-soon content ----------------
  const placeholderExamples: string[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = text.match(pattern);
    if (match && placeholderExamples.length < MAX_EXAMPLES) placeholderExamples.push(match[0]);
  }
  const comingSoonExamples: string[] = [];
  for (const pattern of COMING_SOON_PATTERNS) {
    const match = text.match(pattern);
    if (match && comingSoonExamples.length < MAX_EXAMPLES) comingSoonExamples.push(match[0]);
  }

  // ---------------- links: internal/external + mailto/tel sanity ----------------
  let internalCount = 0;
  let externalCount = 0;
  let mailtoCount = 0;
  let mailtoMalformed = 0;
  const mailtoMalformedExamples: string[] = [];
  let telCount = 0;
  let telMalformed = 0;
  const telMalformedExamples: string[] = [];

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href")?.trim() ?? "";
    if (href.startsWith("mailto:")) {
      mailtoCount++;
      const address = href.slice("mailto:".length).split("?")[0].trim();
      // deterministic sanity check only - not full RFC 5322 validation
      const looksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
      if (!looksValid) {
        mailtoMalformed++;
        if (mailtoMalformedExamples.length < MAX_EXAMPLES) mailtoMalformedExamples.push(describeElement($el, "a"));
      }
    } else if (href.startsWith("tel:")) {
      telCount++;
      const number = href.slice("tel:".length).trim();
      const looksValid = /^[+0-9][0-9()\-.\s]{5,}$/.test(number);
      if (!looksValid) {
        telMalformed++;
        if (telMalformedExamples.length < MAX_EXAMPLES) telMalformedExamples.push(describeElement($el, "a"));
      }
    } else if (isInternalHref(href)) {
      internalCount++;
    } else if (/^https?:\/\//i.test(href)) {
      externalCount++;
    }
  });

  // ---------------- dead-link candidates (Phase 2, heuristic only) ----------------
  // href="#"/""/javascript:void(0)-style targets with NO onclick attribute. This
  // is a HEURISTIC signal, not proof of brokenness - a framework may attach a
  // real click handler at runtime via addEventListener rather than an inline
  // onclick, which static analysis cannot see. Framed as advisory in uxIssues.ts.
  let deadLinkCount = 0;
  const deadLinkExamples: string[] = [];
  $("a").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href")?.trim() ?? "";
    if (!DEAD_LINK_HREFS.has(href)) return;
    if ($el.attr("onclick") !== undefined) return;
    deadLinkCount++;
    if (deadLinkExamples.length < MAX_EXAMPLES) deadLinkExamples.push(describeElement($el, "a"));
  });

  // ---------------- empty / placeholder-action forms (Phase 2, heuristic only) ----------------
  let emptyFormCount = 0;
  const emptyFormExamples: string[] = [];
  let placeholderActionFormCount = 0;
  const placeholderActionFormExamples: string[] = [];
  $("form").each((_, el) => {
    const $form = $(el);
    const realFieldCount = $form.find('input, select, textarea').not('input[type="hidden"]').length;
    if (realFieldCount === 0) {
      emptyFormCount++;
      if (emptyFormExamples.length < MAX_EXAMPLES) emptyFormExamples.push(describeElement($form, "form"));
    }
    // NOTE: an OMITTED action attribute is normal (defaults to the current
    // page, and is the standard pattern for JS-driven forms that
    // preventDefault() the submit) - only an explicit placeholder VALUE is
    // evidence of anything, so an absent action is deliberately not flagged.
    const action = $form.attr("action")?.trim();
    if (action !== undefined && (action === "#" || action.startsWith("javascript:"))) {
      placeholderActionFormCount++;
      if (placeholderActionFormExamples.length < MAX_EXAMPLES) placeholderActionFormExamples.push(describeElement($form, "form"));
    }
  });

  return {
    hasPrimaryNav,
    navLinkCount,
    wordCount,
    emptySections: { count: emptySectionCount, examples: emptySectionExamples },
    hasPlaceholderText: placeholderExamples.length > 0,
    placeholderExamples,
    hasComingSoonText: comingSoonExamples.length > 0,
    comingSoonExamples,
    links: {
      internalCount,
      externalCount,
      mailto: { count: mailtoCount, malformed: mailtoMalformed, malformedExamples: mailtoMalformedExamples },
      tel: { count: telCount, malformed: telMalformed, malformedExamples: telMalformedExamples },
    },
    navLinkHrefs,
    duplicateNavLabels: { count: duplicateNavLabelCount, examples: duplicateNavLabelExamples },
    deadLinkCandidates: { count: deadLinkCount, examples: deadLinkExamples },
    emptyForms: { count: emptyFormCount, examples: emptyFormExamples },
    formsWithPlaceholderAction: { count: placeholderActionFormCount, examples: placeholderActionFormExamples },
  };
}
