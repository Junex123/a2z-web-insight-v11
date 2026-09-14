import type * as cheerio from "cheerio";
import type {
  StructuredDataAnalysis,
  StructuredDataItem,
  StructuredDataMalformedEntry,
  StructuredDataMismatch,
  StructuredDataConflict,
} from "../types.js";

/**
 * Required-property checklist for high-value schema.org types, kept
 * intentionally small (per the task's own instruction: "do not attempt
 * to implement the entire Schema.org specification - prioritize
 * high-value website types"). Each entry is a property name that
 * SHOULD be present per Google's/schema.org's commonly-recommended
 * fields for search-result eligibility - not the full spec.
 */
const REQUIRED_PROPERTIES: Record<string, string[]> = {
  Organization: ["name", "url"],
  WebSite: ["name", "url"],
  BreadcrumbList: ["itemListElement"],
  Article: ["headline"],
  NewsArticle: ["headline"],
  BlogPosting: ["headline"],
  Product: ["name"],
  Offer: ["price", "priceCurrency"],
  LocalBusiness: ["name", "address"],
  FAQPage: ["mainEntity"],
};

function extractTypes(obj: Record<string, unknown>): string[] {
  const t = obj["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/** Flattens @graph arrays and top-level arrays into a flat list of typed nodes. */
function flattenJsonLd(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => flattenJsonLd(entry));
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) {
      return (obj["@graph"] as unknown[]).flatMap((entry) => flattenJsonLd(entry));
    }
    return [obj];
  }
  return [];
}

/**
 * Parses every <script type="application/ld+json"> block on the page.
 * Pure MEASURE step: malformed JSON is recorded as evidence, never
 * silently dropped or "fixed."
 */
export function parseJsonLd($: cheerio.CheerioAPI): { items: StructuredDataItem[]; malformed: StructuredDataMalformedEntry[] } {
  const items: StructuredDataItem[] = [];
  const malformed: StructuredDataMalformedEntry[] = [];
  let itemIndex = 0;

  $('script[type="application/ld+json"]').each((scriptIndex, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      malformed.push({
        index: scriptIndex,
        error: err instanceof Error ? err.message : "Invalid JSON",
        snippet: raw.trim().slice(0, 200),
      });
      return;
    }
    const nodes = flattenJsonLd(parsed);
    for (const node of nodes) {
      items.push({ index: itemIndex, types: extractTypes(node), data: node });
      itemIndex++;
    }
  });

  return { items, malformed };
}

/** Detects structurally identical JSON-LD blocks repeated on the same page. */
export function findDuplicateBlocks(items: StructuredDataItem[]): { types: string[]; indexes: number[] }[] {
  const byKey = new Map<string, number[]>();
  for (const item of items) {
    const key = JSON.stringify(item.data);
    const arr = byKey.get(key) ?? [];
    arr.push(item.index);
    byKey.set(key, arr);
  }
  const duplicates: { types: string[]; indexes: number[] }[] = [];
  for (const [key, indexes] of byKey) {
    if (indexes.length > 1) {
      const types = items.find((i) => i.index === indexes[0])!.types;
      duplicates.push({ types, indexes });
    }
  }
  return duplicates;
}

/** Checks each item against REQUIRED_PROPERTIES for any type it declares. */
export function findIncompleteItems(items: StructuredDataItem[]): { itemIndex: number; types: string[]; missingProperties: string[] }[] {
  const out: { itemIndex: number; types: string[]; missingProperties: string[] }[] = [];
  for (const item of items) {
    const relevantTypes = item.types.filter((t) => t in REQUIRED_PROPERTIES);
    if (relevantTypes.length === 0) continue;
    const missing = new Set<string>();
    for (const t of relevantTypes) {
      for (const prop of REQUIRED_PROPERTIES[t]) {
        if (item.data[prop] === undefined || item.data[prop] === null || item.data[prop] === "") {
          missing.add(prop);
        }
      }
    }
    if (missing.size > 0) {
      out.push({ itemIndex: item.index, types: item.types, missingProperties: [...missing] });
    }
  }
  return out;
}

function normalizeForCompare(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Extracts currency-looking numeric amounts (e.g. "$49,999", "49999.00") from visible text. */
function extractPriceLikeStrings(text: string): Set<string> {
  const matches = text.match(/[$₹€£]\s?[\d,]+(?:\.\d+)?|\b\d{2,}(?:,\d{3})*(?:\.\d{1,2})?\b/g) ?? [];
  return new Set(matches.map((m) => m.replace(/[^0-9.]/g, "")).filter(Boolean));
}

/**
 * Compares deterministic, observable fields in structured data against
 * the page's own visible content. Only compares what is actually
 * present in both places - never infers hidden business information,
 * per the task's constraint. `visibleText` should be the page's
 * visible (script/style-stripped) body text.
 */
export function compareStructuredDataToPage(
  items: StructuredDataItem[],
  page: { title: string | null; h1Texts: string[]; visibleText: string; pageUrl: string },
): StructuredDataMismatch[] {
  const mismatches: StructuredDataMismatch[] = [];
  const visiblePrices = extractPriceLikeStrings(page.visibleText);
  const normalizedVisibleText = normalizeForCompare(page.visibleText);

  for (const item of items) {
    // Product / Offer price vs visible page price
    const offer = (item.data["offers"] ?? item.data) as Record<string, unknown> | undefined;
    const priceRaw = offer && typeof offer === "object" ? (offer as Record<string, unknown>)["price"] : undefined;
    if (item.types.includes("Product") && priceRaw !== undefined && priceRaw !== null) {
      const schemaPrice = String(priceRaw).replace(/[^0-9.]/g, "");
      if (schemaPrice && visiblePrices.size > 0 && !visiblePrices.has(schemaPrice)) {
        mismatches.push({
          itemIndex: item.index,
          schemaType: "Product",
          property: "offers.price",
          schemaValue: String(priceRaw),
          observedPageValue: [...visiblePrices].slice(0, 5).join(", "),
          note: "Product schema price does not match any price-looking value found in the page's visible text.",
        });
      }
    }

    // Organization/Product/WebSite name vs title/H1
    if ((item.types.includes("Organization") || item.types.includes("Product") || item.types.includes("WebSite")) && typeof item.data["name"] === "string") {
      const schemaName = normalizeForCompare(item.data["name"] as string);
      const titleHas = page.title ? normalizeForCompare(page.title).includes(schemaName) : false;
      const h1Has = page.h1Texts.some((h) => normalizeForCompare(h).includes(schemaName));
      const bodyHas = normalizedVisibleText.includes(schemaName);
      if (schemaName.length >= 3 && !titleHas && !h1Has && !bodyHas) {
        mismatches.push({
          itemIndex: item.index,
          schemaType: item.types.join("/"),
          property: "name",
          schemaValue: item.data["name"] as string,
          observedPageValue: page.title ?? "(no title)",
          note: "Structured-data name does not appear in the page's title, H1, or visible body text.",
        });
      }
    }

    // Article headline vs title/H1
    if ((item.types.includes("Article") || item.types.includes("NewsArticle") || item.types.includes("BlogPosting")) && typeof item.data["headline"] === "string") {
      const headline = normalizeForCompare(item.data["headline"] as string);
      const titleHas = page.title ? normalizeForCompare(page.title).includes(headline) || headline.includes(normalizeForCompare(page.title)) : false;
      const h1Has = page.h1Texts.some((h) => normalizeForCompare(h) === headline || normalizeForCompare(h).includes(headline));
      if (headline.length >= 3 && !titleHas && !h1Has) {
        mismatches.push({
          itemIndex: item.index,
          schemaType: item.types.join("/"),
          property: "headline",
          schemaValue: item.data["headline"] as string,
          observedPageValue: page.h1Texts.join(" | ") || page.title || "(no H1/title)",
          note: "Article schema headline doesn't match the page's title or H1 text.",
        });
      }
    }
  }

  return mismatches;
}

/**
 * Detects two same-type entities on the SAME page disagreeing on an
 * identifying property - e.g. two Organization blocks with different
 * "name" values, or two WebSite blocks with different "url" values.
 * This is a genuinely different signal from findDuplicateBlocks()
 * (identical blocks repeated) and from compareStructuredDataToPage()
 * (schema vs. visible text) - this is schema vs. schema, entirely
 * within the structured data itself. Scoped to a small set of
 * identifying properties per type to avoid false-positiving on
 * legitimately-different-but-unrelated properties (e.g. two Product
 * blocks naturally have different names - that's not a conflict, it's
 * two different products, so Product is deliberately excluded here).
 */
const CONFLICT_CHECK_PROPERTIES: Record<string, string> = {
  Organization: "name",
  WebSite: "url",
};

export function findEntityConflicts(items: StructuredDataItem[]): StructuredDataConflict[] {
  const conflicts: StructuredDataConflict[] = [];
  for (const [type, property] of Object.entries(CONFLICT_CHECK_PROPERTIES)) {
    const matching = items.filter((i) => i.types.includes(type) && typeof i.data[property] === "string" && (i.data[property] as string).trim() !== "");
    if (matching.length < 2) continue;
    const distinctValues = new Map<string, number[]>(); // normalized value -> item indexes
    for (const item of matching) {
      const raw = (item.data[property] as string).trim();
      const normalized = normalizeForCompare(raw);
      const indexes = distinctValues.get(normalized) ?? [];
      indexes.push(item.index);
      distinctValues.set(normalized, indexes);
    }
    if (distinctValues.size > 1) {
      const values = matching.map((item) => ({ itemIndex: item.index, value: (item.data[property] as string).trim() }));
      conflicts.push({ type, property, values });
    }
  }
  return conflicts;
}

export function analyzeStructuredData(
  $: cheerio.CheerioAPI,
  page: { title: string | null; h1Texts: string[]; visibleText: string; pageUrl: string },
): StructuredDataAnalysis {
  const { items, malformed } = parseJsonLd($);
  const typesFound = [...new Set(items.flatMap((i) => i.types))];
  const duplicateBlocks = findDuplicateBlocks(items);
  const incompleteItems = findIncompleteItems(items);
  const contentMismatches = compareStructuredDataToPage(items, page);
  const conflicts = findEntityConflicts(items);

  return { items, malformed, typesFound, duplicateBlocks, incompleteItems, contentMismatches, conflicts };
}
