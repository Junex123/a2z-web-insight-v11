import * as cheerio from "cheerio";
import type { AccessibilityAnalysis } from "../types.js";

/**
 * Parses raw HTML into structured accessibility facts. Pure static-DOM
 * analysis - same philosophy as htmlCollector.ts (no JS execution, no
 * rendering), and deliberately mirrors its style/conventions.
 *
 * WHY A SEPARATE cheerio.load() PASS: htmlCollector.ts already parses
 * the same bodyText once for SEO/Performance facts. Ideally this would
 * share that single `$` instance, but htmlCollector.collectHtml()'s
 * signature (`(bodyText, httpsUsed) -> HtmlAnalysis`) is depended on
 * directly by existing tests and the pipeline; changing it to accept/
 * return a cheerio instance would be a breaking change to completed,
 * tested work for no functional benefit. The cost here is one bounded,
 * linear second parse per scan (the body is already capped at 5MB by
 * the collector) - NOT the kind of repeated per-check re-traversal the
 * "avoid expensive repeated DOM traversals" guidance is actually
 * warning against. Every fact below is collected via a single pass per
 * concern (images once, forms once, ids once, etc.) and the 20+
 * accessibility rules in analysis/accessibilityIssues.ts then run as
 * pure logic against this already-collected object - no rule re-queries
 * the DOM.
 */

const VALID_ARIA_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "command", "complementary", "contentinfo", "definition",
  "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid",
  "gridcell", "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main",
  "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation",
  "none", "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row",
  "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox",
  "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

/** naturally interactive / focusable-by-default elements - excluded from the "clickable but not keyboard accessible" check */
const NATURALLY_INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "audio", "video"]);

/** ARIA widget roles that imply the element must itself be operable by keyboard (a subset of VALID_ARIA_ROLES). */
const INTERACTIVE_ARIA_ROLES = new Set([
  "button", "checkbox", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio",
  "switch", "tab", "treeitem", "combobox", "slider", "spinbutton", "searchbox", "textbox",
]);

const ARIA_INVALID_TRUTHY = /^(true|grammar|spelling)$/i;

const MAX_EXAMPLES = 5; // cap example lists so evidence stays small and reviewable, not a full DOM dump

/** Short, deterministic, human-readable locator for an element - never a full outerHTML dump. */
function describeElement($el: cheerio.Cheerio<any>, tag: string): string {
  const id = $el.attr("id");
  if (id) return `${tag}#${id}`;
  const identifyingAttr = $el.attr("src") ?? $el.attr("href") ?? $el.attr("name") ?? $el.attr("type");
  if (identifyingAttr) {
    const truncated = identifyingAttr.length > 40 ? `${identifyingAttr.slice(0, 40)}…` : identifyingAttr;
    return `${tag}[${$el.attr("src") ? "src" : $el.attr("href") ? "href" : $el.attr("name") ? "name" : "type"}="${truncated}"]`;
  }
  const text = $el.text().trim();
  if (text) return `${tag} ("${text.length > 30 ? `${text.slice(0, 30)}…` : text}")`;
  return `${tag} (no identifying attribute)`;
}

/** Accessible-name computation, simplified: label/aria-label/aria-labelledby/title/text-content, in roughly spec priority order. */
function hasAccessibleName($: cheerio.CheerioAPI, $el: cheerio.Cheerio<any>, idSet: Set<string>): boolean {
  const ariaLabel = $el.attr("aria-label")?.trim();
  if (ariaLabel) return true;

  const labelledBy = $el.attr("aria-labelledby")?.trim();
  if (labelledBy && labelledBy.split(/\s+/).some((id) => idSet.has(id))) return true;

  const title = $el.attr("title")?.trim();
  if (title) return true;

  const text = $el.text().trim();
  if (text) return true;

  // an <img alt="..."> child (e.g. inside a link/button) also provides an accessible name
  const imgAlt = $el.find("img[alt]").first().attr("alt")?.trim();
  if (imgAlt) return true;

  return false;
}

export function collectAccessibility(bodyText: string): AccessibilityAnalysis {
  const $ = cheerio.load(bodyText);

  // ---------------- document-level ----------------
  const htmlLangValue = $("html").first().attr("lang")?.trim() || null;
  const hasHtmlLangAttr = !!htmlLangValue;

  const viewportContent = $('meta[name="viewport"]').first().attr("content")?.trim() ?? null;
  const viewportDisablesZoom =
    viewportContent !== null &&
    (/user-scalable\s*=\s*no/i.test(viewportContent) || /maximum-scale\s*=\s*(0(\.\d+)?|1(\.0+)?)\b/i.test(viewportContent));

  // ---------------- heading outline (full h1-h6, document order) ----------------
  const headingOutline: { level: number; text: string }[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const $el = $(el);
    const level = Number(el.tagName.slice(1));
    headingOutline.push({ level, text: $el.text().trim() });
  });

  // ---------------- ids (collected once, reused for duplicate-id + ARIA-reference checks) ----------------
  const idOccurrences = new Map<string, number>();
  $("[id]").each((_, el) => {
    const id = $(el).attr("id")!.trim();
    if (!id) return;
    idOccurrences.set(id, (idOccurrences.get(id) ?? 0) + 1);
  });
  const idSet = new Set(idOccurrences.keys());
  const duplicateIds = [...idOccurrences.entries()].filter(([, count]) => count > 1).map(([id]) => id);

  // ---------------- images: alt text + decorative-contradiction heuristic ----------------
  const imgs = $("img");
  let noAltAttribute = 0;
  let emptyAlt = 0;
  let suspiciousDecorative = 0;
  imgs.each((_, el) => {
    const $el = $(el);
    const alt = $el.attr("alt");
    if (alt === undefined) {
      noAltAttribute++;
    } else if (alt.trim() === "") {
      emptyAlt++;
      // alt="" declares "decorative, ignore me" - but if the SAME element
      // also has an accessible name (aria-label) or an explicit
      // non-presentation role, that's a real contradiction: assistive
      // tech can't tell whether to announce it or skip it.
      const hasAriaLabel = !!$el.attr("aria-label")?.trim();
      const role = $el.attr("role")?.trim().toLowerCase();
      const hasContentRole = !!role && role !== "presentation" && role !== "none";
      if (hasAriaLabel || hasContentRole) suspiciousDecorative++;
    }
  });

  // ---------------- form controls: accessible name / label association ----------------
  const formControls = $("input, select, textarea").not('input[type="hidden"]');
  let unlabeledFormControls = 0;
  const unlabeledFormExamples: string[] = [];
  formControls.each((_, el) => {
    const $el = $(el);
    const id = $el.attr("id");
    const hasAssociatedLabel = !!id && $(`label[for="${cssEscape(id)}"]`).length > 0;
    const isWrappedInLabel = $el.closest("label").length > 0;
    if (hasAssociatedLabel || isWrappedInLabel || hasAccessibleName($, $el, idSet)) return;
    unlabeledFormControls++;
    if (unlabeledFormExamples.length < MAX_EXAMPLES) {
      unlabeledFormExamples.push(describeElement($el, (el as any).tagName ?? "input"));
    }
  });

  // ---------------- buttons: accessible name ----------------
  const buttons = $('button, input[type="button"], input[type="submit"], input[type="reset"]');
  let buttonsWithoutName = 0;
  const buttonExamples: string[] = [];
  buttons.each((_, el) => {
    const $el = $(el);
    const tag = (el as any).tagName?.toLowerCase() ?? "button";
    // <input type=button|submit|reset> gets its accessible name from `value`, not text content
    const value = $el.attr("value")?.trim();
    const named = tag === "input" ? !!value || hasAccessibleName($, $el, idSet) : hasAccessibleName($, $el, idSet);
    if (named) return;
    buttonsWithoutName++;
    if (buttonExamples.length < MAX_EXAMPLES) buttonExamples.push(describeElement($el, tag));
  });

  // ---------------- links: accessible name (also covers "empty link" case) ----------------
  const links = $("a[href]");
  let linksWithoutName = 0;
  const linkExamples: string[] = [];
  links.each((_, el) => {
    const $el = $(el);
    if (hasAccessibleName($, $el, idSet)) return;
    linksWithoutName++;
    if (linkExamples.length < MAX_EXAMPLES) linkExamples.push(describeElement($el, "a"));
  });

  // ---------------- broken ARIA references ----------------
  const brokenAriaRefs: { element: string; attr: string; value: string }[] = [];
  $("[aria-labelledby], [aria-describedby], [aria-controls], [aria-owns]").each((_, el) => {
    const $el = $(el);
    const tag = (el as any).tagName?.toLowerCase() ?? "element";
    for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"] as const) {
      const value = $el.attr(attr);
      if (!value) continue;
      const missingIds = value.split(/\s+/).filter((id) => id && !idSet.has(id));
      if (missingIds.length > 0 && brokenAriaRefs.length < MAX_EXAMPLES) {
        brokenAriaRefs.push({ element: describeElement($el, tag), attr, value: missingIds.join(" ") });
      }
    }
  });

  // ---------------- invalid ARIA role values ----------------
  const invalidAriaRoles: { element: string; role: string }[] = [];
  $("[role]").each((_, el) => {
    const $el = $(el);
    const roleAttr = $el.attr("role")?.trim().toLowerCase();
    if (!roleAttr) return;
    const tokens = roleAttr.split(/\s+/);
    const anyValid = tokens.some((t) => VALID_ARIA_ROLES.has(t));
    if (!anyValid && invalidAriaRoles.length < MAX_EXAMPLES) {
      const tag = (el as any).tagName?.toLowerCase() ?? "element";
      invalidAriaRoles.push({ element: describeElement($el, tag), role: roleAttr });
    }
  });

  // ---------------- iframes ----------------
  const iframes = $("iframe");
  let iframesMissingTitle = 0;
  iframes.each((_, el) => {
    const title = $(el).attr("title")?.trim();
    if (!title) iframesMissingTitle++;
  });

  // ---------------- tables: header structure ----------------
  // Conservative heuristic: only flag tables that look like real data
  // tables (multiple rows AND multiple columns) with zero <th> anywhere -
  // avoids false positives on simple 1x1 layout tables, which static
  // analysis can't reliably distinguish from data tables otherwise.
  const tables = $("table");
  let tablesWithoutHeaders = 0;
  tables.each((_, el) => {
    const $table = $(el);
    const rowCount = $table.find("tr").length;
    const colCount = $table.find("tr").first().find("td, th").length;
    const hasTh = $table.find("th").length > 0;
    if (rowCount > 1 && colCount > 1 && !hasTh) tablesWithoutHeaders++;
  });

  // ---------------- autoplaying media without user control ----------------
  const autoplayMedia = $("video[autoplay], audio[autoplay]");
  let autoplayWithoutControl = 0;
  autoplayMedia.each((_, el) => {
    const $el = $(el);
    const hasControls = $el.attr("controls") !== undefined;
    const isMuted = $el.attr("muted") !== undefined;
    if (!hasControls && !isMuted) autoplayWithoutControl++;
  });

  // ---------------- non-interactive elements made "clickable" without keyboard support ----------------
  const clickableNonInteractive = $("[onclick]").filter((_, el) => {
    const tag = (el as any).tagName?.toLowerCase() ?? "";
    if (NATURALLY_INTERACTIVE_TAGS.has(tag)) return false;
    const $el = $(el);
    const hasRole = !!$el.attr("role")?.trim();
    const hasTabindex = $el.attr("tabindex") !== undefined;
    return !hasRole && !hasTabindex;
  });
  const clickableExamples: string[] = [];
  clickableNonInteractive.each((_, el) => {
    if (clickableExamples.length < MAX_EXAMPLES) {
      clickableExamples.push(describeElement($(el), (el as any).tagName?.toLowerCase() ?? "element"));
    }
  });

  // ---------------- tabindex anti-patterns ----------------
  let positiveTabindexCount = 0;
  const positiveTabindexExamples: string[] = [];
  $("[tabindex]").each((_, el) => {
    const raw = $(el).attr("tabindex");
    const n = raw !== undefined ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) {
      positiveTabindexCount++;
      if (positiveTabindexExamples.length < MAX_EXAMPLES) {
        positiveTabindexExamples.push(describeElement($(el), (el as any).tagName?.toLowerCase() ?? "element"));
      }
    }
  });

  // ---------------- landmarks / skip-navigation (Phase 2) ----------------
  const mainCount = $('main, [role="main"]').length;
  const hasSkipLink = $("a[href^='#']")
    .toArray()
    .some((el) => /skip\s*(to|navigation|content|main)?/i.test($(el).text().trim()));

  // ---------------- empty headings (Phase 2): a heading with no accessible name at all ----------------
  let emptyHeadingCount = 0;
  const emptyHeadingExamples: string[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const $el = $(el);
    if (hasAccessibleName($, $el, idSet)) return;
    emptyHeadingCount++;
    if (emptyHeadingExamples.length < MAX_EXAMPLES) {
      emptyHeadingExamples.push(describeElement($el, (el as any).tagName?.toLowerCase() ?? "heading"));
    }
  });

  // ---------------- fieldset/legend grouping (Phase 2) ----------------
  // Related radio/checkbox controls (same `name`, group size > 1) should be
  // grouped under a <fieldset><legend> so assistive tech announces what the
  // group of options is FOR, not just each individual option's own label.
  const radioCheckboxByName = new Map<string, cheerio.Cheerio<any>[]>();
  $('input[type="radio"], input[type="checkbox"]').each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name")?.trim();
    if (!name) return;
    if (!radioCheckboxByName.has(name)) radioCheckboxByName.set(name, []);
    radioCheckboxByName.get(name)!.push($el);
  });
  let ungroupedRadioCheckboxSets = 0;
  const ungroupedExamples: string[] = [];
  for (const [name, group] of radioCheckboxByName) {
    if (group.length < 2) continue;
    const allGrouped = group.every(($el) => {
      const $fieldset = $el.closest("fieldset");
      return $fieldset.length > 0 && $fieldset.find("legend").length > 0;
    });
    if (!allGrouped) {
      ungroupedRadioCheckboxSets++;
      if (ungroupedExamples.length < MAX_EXAMPLES) ungroupedExamples.push(`name="${name}" (${group.length} controls)`);
    }
  }
  let fieldsetsWithoutLegend = 0;
  $("fieldset").each((_, el) => {
    if ($(el).find("legend").length === 0) fieldsetsWithoutLegend++;
  });

  // ---------------- error-message association (Phase 2) ----------------
  // A control explicitly marked invalid (aria-invalid="true"/"grammar"/"spelling")
  // should point at the error text via aria-describedby - otherwise assistive
  // tech knows something is wrong but never announces WHAT or HOW to fix it.
  let unassociatedErrorCount = 0;
  const unassociatedErrorExamples: string[] = [];
  $("[aria-invalid]").each((_, el) => {
    const $el = $(el);
    const value = $el.attr("aria-invalid")?.trim() ?? "";
    if (!ARIA_INVALID_TRUTHY.test(value)) return;
    const describedBy = $el.attr("aria-describedby")?.trim();
    const resolvesToRealId = !!describedBy && describedBy.split(/\s+/).some((id) => idSet.has(id));
    if (!resolvesToRealId) {
      unassociatedErrorCount++;
      if (unassociatedErrorExamples.length < MAX_EXAMPLES) {
        unassociatedErrorExamples.push(describeElement($el, (el as any).tagName?.toLowerCase() ?? "element"));
      }
    }
  });

  // ---------------- disabled-state contradictions (Phase 2) ----------------
  // Native `disabled` removes an element from the tab order and blocks
  // interaction entirely; aria-disabled="false" on the SAME element
  // explicitly claims the opposite. Browsers honor native `disabled`, but
  // the contradiction is real evidence of inconsistent/generated markup.
  let disabledContradictionCount = 0;
  const disabledContradictionExamples: string[] = [];
  $("[disabled][aria-disabled]").each((_, el) => {
    const $el = $(el);
    if ($el.attr("aria-disabled")?.trim().toLowerCase() === "false") {
      disabledContradictionCount++;
      if (disabledContradictionExamples.length < MAX_EXAMPLES) {
        disabledContradictionExamples.push(describeElement($el, (el as any).tagName?.toLowerCase() ?? "element"));
      }
    }
  });

  // ---------------- ARIA interactive-widget roles without keyboard focusability (Phase 2) ----------------
  // Distinct from clickableNonInteractive above (which is onclick-driven):
  // this flags elements that DECLARE themselves an interactive ARIA widget
  // (role="button"/"tab"/"checkbox"/etc.) on a non-natively-focusable tag
  // with NO tabindex attribute at all. Deliberately does not flag
  // tabindex="-1" - that's also used by legitimate roving-tabindex widget
  // patterns (e.g. tablist/radiogroup), which static analysis can't
  // reliably distinguish from a genuine mistake.
  let ariaWidgetsNotFocusableCount = 0;
  const ariaWidgetsNotFocusableExamples: string[] = [];
  $("[role]").each((_, el) => {
    const $el = $(el);
    const tag = (el as any).tagName?.toLowerCase() ?? "";
    if (NATURALLY_INTERACTIVE_TAGS.has(tag)) return;
    const role = $el.attr("role")?.trim().toLowerCase();
    if (!role || !role.split(/\s+/).some((r) => INTERACTIVE_ARIA_ROLES.has(r))) return;
    if ($el.attr("tabindex") === undefined) {
      ariaWidgetsNotFocusableCount++;
      if (ariaWidgetsNotFocusableExamples.length < MAX_EXAMPLES) {
        ariaWidgetsNotFocusableExamples.push(describeElement($el, tag));
      }
    }
  });

  // ---------------- dialog/modal STATIC markup (Session 8) ----------------
  // Deliberately narrow to what's actually checkable without executing JS:
  // does the dialog element have an accessible name, and does it contain
  // ANY focusable/interactive content at all (so there's at least a
  // possible way to operate/close it). Whether it actually TRAPS focus,
  // moves focus on open, or restores focus on close is genuine runtime
  // behavior and is never inferred here - see VerificationEntry's
  // "Modal/dialog focus behavior" category (always unverified).
  //
  // The accessible-name check here deliberately does NOT fall back to
  // $el.text() the way hasAccessibleName() does for buttons/links: a
  // dialog's accessible name per the ARIA spec comes specifically from
  // aria-label/aria-labelledby/title, not from arbitrary text it
  // contains (a dialog full of body copy isn't "named" by that copy).
  const dialogCandidates = $('[role="dialog"], [role="alertdialog"], dialog');
  const FOCUSABLE_DESCENDANT_SELECTOR =
    'a[href], button, input, select, textarea, summary, [tabindex], [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
  let dialogsWithoutNameCount = 0;
  const dialogsWithoutNameExamples: string[] = [];
  let dialogsWithoutFocusableContentCount = 0;
  const dialogsWithoutFocusableContentExamples: string[] = [];
  dialogCandidates.each((_, el) => {
    const $el = $(el);
    const tag = (el as any).tagName?.toLowerCase() ?? "dialog";
    const ariaLabel = $el.attr("aria-label")?.trim();
    const labelledBy = $el.attr("aria-labelledby")?.trim();
    const labelledByResolves = !!labelledBy && labelledBy.split(/\s+/).some((id) => idSet.has(id));
    const title = $el.attr("title")?.trim();
    if (!ariaLabel && !labelledByResolves && !title) {
      dialogsWithoutNameCount++;
      if (dialogsWithoutNameExamples.length < MAX_EXAMPLES) dialogsWithoutNameExamples.push(describeElement($el, tag));
    }
    if ($el.find(FOCUSABLE_DESCENDANT_SELECTOR).length === 0) {
      dialogsWithoutFocusableContentCount++;
      if (dialogsWithoutFocusableContentExamples.length < MAX_EXAMPLES) {
        dialogsWithoutFocusableContentExamples.push(describeElement($el, tag));
      }
    }
  });

  // ---------------- skip-link target resolution + hidden-target detection (Session 9) ----------------
  // Deepens the boolean hasSkipLink check from Session 7: does the link's
  // target actually exist, and if it does, is it hidden in a way that
  // would defeat the whole point of a skip link? Deliberately checks only
  // the `hidden` attribute and `aria-hidden="true"` (statically visible
  // signals) - NOT computed CSS (display:none via a stylesheet), which
  // requires rendering and is out of scope here.
  let skipLinkTargetMissing = false;
  let skipLinkTargetHidden = false;
  if (hasSkipLink) {
    const skipLinkEl = $("a[href^='#']")
      .toArray()
      .find((el) => /skip\s*(to|navigation|content|main)?/i.test($(el).text().trim()));
    const targetId = skipLinkEl ? $(skipLinkEl).attr("href")?.trim().slice(1) : undefined;
    if (!targetId || !idSet.has(targetId)) {
      skipLinkTargetMissing = true;
    } else {
      const $target = $(`#${cssEscape(targetId)}`);
      const isHidden = $target.attr("hidden") !== undefined || $target.attr("aria-hidden")?.trim().toLowerCase() === "true";
      const ancestorHidden = $target.parents("[hidden], [aria-hidden='true']").length > 0;
      if (isHidden || ancestorHidden) skipLinkTargetHidden = true;
    }
  }

  // ---------------- broken label[for] associations (Session 9) ----------------
  // Distinct from formControls.unlabeled above: this flags the <label>
  // element itself pointing at an id that doesn't exist anywhere on the
  // page - a typo/stale-refactor bug, not simply "no label was written".
  let brokenLabelCount = 0;
  const brokenLabelExamples: string[] = [];
  $("label[for]").each((_, el) => {
    const $el = $(el);
    const forId = $el.attr("for")?.trim();
    if (forId && !idSet.has(forId)) {
      brokenLabelCount++;
      if (brokenLabelExamples.length < MAX_EXAMPLES) brokenLabelExamples.push(describeElement($el, "label"));
    }
  });

  // ---------------- aria-hidden hiding focusable content (Session 9/10) ----------------
  // Keyboard reachability is narrower than the dialog helper above: tabindex="-1"
  // removes an element from the normal Tab sequence, including when it overrides
  // an otherwise-natively-focusable element such as <a> or <button>.
  const KEYBOARD_REACHABLE_SELECTOR = [
    'a[href]', "button", "input", "select", "textarea", "summary",
    "[tabindex]", '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  ]
    .map((clause) => `${clause}:not([tabindex="-1"])`)
    .join(", ");
  let ariaHiddenFocusableCount = 0;
  const ariaHiddenFocusableExamples: string[] = [];
  $('[aria-hidden="true"]').each((_, el) => {
    const $el = $(el);
    const selfFocusable = $el.is(KEYBOARD_REACHABLE_SELECTOR);
    const hasFocusableDescendant = $el.find(KEYBOARD_REACHABLE_SELECTOR).length > 0;
    if (selfFocusable || hasFocusableDescendant) {
      ariaHiddenFocusableCount++;
      if (ariaHiddenFocusableExamples.length < MAX_EXAMPLES) {
        ariaHiddenFocusableExamples.push(describeElement($el, (el as any).tagName?.toLowerCase() ?? "element"));
      }
    }
  });

  // ---------------- duplicate/conflicting landmark labels (Session 9) ----------------
  // Multiple landmarks of the SAME type (e.g. two <nav> elements) need a
  // distinguishing aria-label/aria-labelledby so assistive tech can tell
  // them apart ("Main navigation" vs "Footer navigation") - otherwise
  // they're announced as indistinguishable duplicates, or worse, two
  // DIFFERENT landmarks claim the exact same label.
  const SECTIONING_ANCESTOR_SELECTOR = "article, aside, main, nav, section";
  function landmarkGroupKey(tag: string, role: string | undefined, $el: cheerio.Cheerio<any>): string | null {
    if (role === "navigation" || tag === "nav") return "navigation";
    if (role === "complementary" || tag === "aside") return "complementary";
    if (role === "search" || tag === "search") return "search";
    if (tag === "header" || role === "banner") {
      if (tag === "header" && $el.closest(SECTIONING_ANCESTOR_SELECTOR).length > 0) return null; // not a page-level banner
      return "banner";
    }
    if (tag === "footer" || role === "contentinfo") {
      if (tag === "footer" && $el.closest(SECTIONING_ANCESTOR_SELECTOR).length > 0) return null; // not a page-level contentinfo
      return "contentinfo";
    }
    return null;
  }
  function landmarkLabelText($el: cheerio.Cheerio<any>): string | null {
    const ariaLabel = $el.attr("aria-label")?.trim();
    if (ariaLabel) return ariaLabel;
    const labelledBy = $el.attr("aria-labelledby")?.trim();
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .filter((id) => idSet.has(id))
        .map((id) => $(`#${cssEscape(id)}`).text().trim())
        .join(" ")
        .trim();
      if (text) return text;
    }
    return null;
  }
  const landmarkGroups = new Map<string, cheerio.Cheerio<any>[]>();
  $('nav, header, footer, aside, search, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]').each(
    (_, el) => {
      const $el = $(el);
      const tag = (el as any).tagName?.toLowerCase() ?? "";
      const role = $el.attr("role")?.trim().toLowerCase();
      const key = landmarkGroupKey(tag, role, $el);
      if (!key) return;
      if (!landmarkGroups.has(key)) landmarkGroups.set(key, []);
      landmarkGroups.get(key)!.push($el);
    },
  );
  let ambiguousLandmarkCount = 0;
  const ambiguousLandmarkExamples: string[] = [];
  let conflictingLandmarkLabelCount = 0;
  const conflictingLandmarkLabelExamples: string[] = [];
  for (const [key, group] of landmarkGroups) {
    if (group.length < 2) continue;
    const labelsSeen = new Map<string, number>();
    let unlabeledInGroup = 0;
    for (const $el of group) {
      const label = landmarkLabelText($el);
      if (!label) {
        unlabeledInGroup++;
      } else {
        labelsSeen.set(label, (labelsSeen.get(label) ?? 0) + 1);
      }
    }
    // Count once per ambiguous GROUP, matching the issue wording, not once
    // per unlabeled instance inside the group.
    if (unlabeledInGroup > 0) {
      ambiguousLandmarkCount++;
      if (ambiguousLandmarkExamples.length < MAX_EXAMPLES) {
        ambiguousLandmarkExamples.push(`${key} landmark: ${unlabeledInGroup} of ${group.length} found with no distinguishing label`);
      }
    }
    for (const [label, count] of labelsSeen) {
      if (count >= 2) {
        conflictingLandmarkLabelCount++;
        if (conflictingLandmarkLabelExamples.length < MAX_EXAMPLES) {
          conflictingLandmarkLabelExamples.push(`${count} "${key}" landmarks all labeled "${label}"`);
        }
      }
    }
  }

  // ---------------- redundant ARIA role matching native implicit role (Session 10) ----------------
  const REDUNDANT_ROLE_MAP: Array<{ selector: string; role: string; tag: string; requiresTopLevel?: boolean }> = [
    { selector: "button", role: "button", tag: "button" },
    { selector: "a[href]", role: "link", tag: "a" },
    { selector: "nav", role: "navigation", tag: "nav" },
    { selector: "aside", role: "complementary", tag: "aside" },
    { selector: "main", role: "main", tag: "main" },
    { selector: "header", role: "banner", tag: "header", requiresTopLevel: true },
    { selector: "footer", role: "contentinfo", tag: "footer", requiresTopLevel: true },
  ];
  let redundantAriaRoleCount = 0;
  const redundantAriaRoleExamples: string[] = [];
  for (const { selector, role, tag, requiresTopLevel } of REDUNDANT_ROLE_MAP) {
    $(`${selector}[role="${role}"]`).each((_, el) => {
      const $el = $(el);
      if (requiresTopLevel && $el.closest(SECTIONING_ANCESTOR_SELECTOR).length > 0) return;
      redundantAriaRoleCount++;
      if (redundantAriaRoleExamples.length < MAX_EXAMPLES) {
        redundantAriaRoleExamples.push(`${describeElement($el, tag)} has role="${role}" (already its native implicit role)`);
      }
    });
  }

  return {
    hasHtmlLangAttr,
    htmlLangValue,
    viewportContent,
    viewportDisablesZoom,
    headingOutline,
    images: { total: imgs.length, noAltAttribute, emptyAlt, suspiciousDecorative },
    formControls: { total: formControls.length, unlabeled: unlabeledFormControls, unlabeledExamples: unlabeledFormExamples },
    buttons: { total: buttons.length, withoutAccessibleName: buttonsWithoutName, examples: buttonExamples },
    links: { total: links.length, withoutAccessibleName: linksWithoutName, examples: linkExamples },
    duplicateIds,
    brokenAriaRefs,
    invalidAriaRoles,
    iframes: { total: iframes.length, missingTitle: iframesMissingTitle },
    tables: { total: tables.length, withoutHeaders: tablesWithoutHeaders },
    autoplayMedia: { total: autoplayMedia.length, withoutControl: autoplayWithoutControl },
    clickableNonInteractive: { count: clickableNonInteractive.length, examples: clickableExamples },
    positiveTabindex: { count: positiveTabindexCount, examples: positiveTabindexExamples },
    landmarks: { mainCount, hasSkipLink, skipLinkTargetMissing, skipLinkTargetHidden },
    emptyHeadings: { count: emptyHeadingCount, examples: emptyHeadingExamples },
    fieldsetGrouping: { ungroupedRadioCheckboxSets, examples: ungroupedExamples, fieldsetsWithoutLegend },
    errorAssociation: { unassociatedCount: unassociatedErrorCount, examples: unassociatedErrorExamples },
    disabledStateContradictions: { count: disabledContradictionCount, examples: disabledContradictionExamples },
    ariaWidgetsNotFocusable: { count: ariaWidgetsNotFocusableCount, examples: ariaWidgetsNotFocusableExamples },
    dialogs: {
      total: dialogCandidates.length,
      withoutAccessibleName: { count: dialogsWithoutNameCount, examples: dialogsWithoutNameExamples },
      withoutFocusableContent: { count: dialogsWithoutFocusableContentCount, examples: dialogsWithoutFocusableContentExamples },
    },
    brokenLabelAssociations: { count: brokenLabelCount, examples: brokenLabelExamples },
    ariaHiddenFocusable: { count: ariaHiddenFocusableCount, examples: ariaHiddenFocusableExamples },
    duplicateLandmarks: {
      ambiguousCount: ambiguousLandmarkCount,
      ambiguousExamples: ambiguousLandmarkExamples,
      conflictingLabelCount: conflictingLandmarkLabelCount,
      conflictingLabelExamples: conflictingLandmarkLabelExamples,
    },
    redundantAriaRoles: { count: redundantAriaRoleCount, examples: redundantAriaRoleExamples },
  };
}

/** Minimal CSS.escape-alike for building an attribute selector from an arbitrary id value. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
