import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFetchQuality } from "../src/analysis/fetchQuality.js";
import type { FetchResult, HtmlAnalysis } from "../src/types.js";

function fetchResult(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    requestedUrl: "https://example.test/",
    finalUrl: "https://example.test/",
    statusCode: 200,
    httpsUsed: true,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 50, totalDownloadMs: 55 },
    headers: {},
    bodyBytes: 663,
    bodyText: "<html>...</html>",
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function html(overrides: Partial<HtmlAnalysis> = {}): HtmlAnalysis {
  return ({
    title: "A real page title",
    titleLength: 17, metaDescription: "A real description", metaDescriptionLength: 18,
    h1Count: 1, h1Texts: ["Heading"], rawH1Count: 1, canonicalUrl: null, canonicalCount: 0, canonicalEmpty: false,
    robotsMeta: null, robotsMetaCount: 0, robotsMetaValues: [], hasViewportMeta: true, hasCharsetMeta: true,
    openGraph: { title: false, description: false, image: false, url: false }, twitterCardPresent: false,
    images: { total: 1, missingAlt: 0 }, scripts: { total: 0, blockingInHead: 0, asyncOrDefer: 0 },
    stylesheets: { total: 0, blockingInHead: 0 }, insecureResourceRefs: [],
    ...overrides,
  } as HtmlAnalysis);
}

test("a genuinely empty body (0 bytes) is classified as 'empty', regardless of any HTML fields", () => {
  const result = classifyFetchQuality(fetchResult({ bodyBytes: 0 }), html());
  assert.equal(result, "empty");
});

test("a real, minimal page (title + h1 + meta + image present) is classified as 'usable', even at a small byte size", () => {
  // matches this project's own /clean fixture: 663 bytes, real content
  const result = classifyFetchQuality(fetchResult({ bodyBytes: 663 }), html());
  assert.equal(result, "usable");
});

test("a non-empty body with NO title, heading, meta description, or images is classified as 'insufficient'", () => {
  const result = classifyFetchQuality(
    fetchResult({ bodyBytes: 300 }),
    html({ title: null, h1Count: 0, metaDescription: null, images: { total: 0, missingAlt: 0 } }),
  );
  assert.equal(result, "insufficient");
});

test("having ONLY a title (nothing else) is enough to be classified as 'usable' - a single real structural signal is sufficient", () => {
  const result = classifyFetchQuality(
    fetchResult({ bodyBytes: 100 }),
    html({ title: "Coming soon", h1Count: 0, metaDescription: null, images: { total: 0, missingAlt: 0 } }),
  );
  assert.equal(result, "usable");
});

test("having ONLY an h1 (nothing else) is enough to be classified as 'usable'", () => {
  const result = classifyFetchQuality(
    fetchResult({ bodyBytes: 100 }),
    html({ title: null, h1Count: 1, metaDescription: null, images: { total: 0, missingAlt: 0 } }),
  );
  assert.equal(result, "usable");
});

test("having ONLY a meta description (nothing else) is enough to be classified as 'usable'", () => {
  const result = classifyFetchQuality(
    fetchResult({ bodyBytes: 100 }),
    html({ title: null, h1Count: 0, metaDescription: "Some description", images: { total: 0, missingAlt: 0 } }),
  );
  assert.equal(result, "usable");
});

test("having ONLY images (nothing else) is enough to be classified as 'usable'", () => {
  const result = classifyFetchQuality(
    fetchResult({ bodyBytes: 100 }),
    html({ title: null, h1Count: 0, metaDescription: null, images: { total: 2, missingAlt: 2 } }),
  );
  assert.equal(result, "usable");
});

test("a large body with no structural content is STILL classified as 'insufficient' - byte count alone never overrides the structural check", () => {
  const result = classifyFetchQuality(
    fetchResult({ bodyBytes: 50_000 }), // large, e.g. a big inline script blob with no real markup
    html({ title: null, h1Count: 0, metaDescription: null, images: { total: 0, missingAlt: 0 } }),
  );
  assert.equal(result, "insufficient");
});

test("a genuinely broken/messy-but-real page (this project's own /messy fixture shape) is still 'usable' - having bad SEO is not the same as having no content", () => {
  // /messy has no title/meta/canonical/viewport, but DOES have h1s and images
  const result = classifyFetchQuality(
    fetchResult({ bodyBytes: 78_598 }),
    html({ title: null, metaDescription: null, h1Count: 2, images: { total: 3, missingAlt: 3 } }),
  );
  assert.equal(result, "usable");
});
