import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { detectResourceIssues, extractImageAttributeFacts, resetResourceIssueIdCounter } from "../src/analysis/resourceIssues.js";
import { categorizeThirdPartyOrigin } from "../src/analysis/thirdPartyCatalog.js";
import type { ResourceIntelligence, ResourceKind, ResourceKindTotals, ResourceProbeEntry } from "../src/types.js";

const PAGE_URL = "https://example.com/page";

function entry(overrides: Partial<ResourceProbeEntry>): ResourceProbeEntry {
  return {
    url: "https://example.com/a.js",
    kind: "script",
    origin: "example.com",
    isThirdParty: false,
    probed: true,
    statusCode: 200,
    contentLength: null,
    contentType: null,
    cacheControl: null,
    contentEncoding: null,
    etag: null,
    probeError: null,
    ...overrides,
  };
}

function emptyTotals(): ResourceKindTotals {
  return { count: 0, sizeKnownCount: 0, knownBytes: 0 };
}

function intelFrom(entries: ResourceProbeEntry[]): ResourceIntelligence {
  const totalsByKind: Record<ResourceKind, ResourceKindTotals> = {
    script: emptyTotals(),
    stylesheet: emptyTotals(),
    image: emptyTotals(),
    font: emptyTotals(),
    other: emptyTotals(),
  };
  const thirdPartyByOrigin = new Map<string, { requestCount: number; knownBytes: number }>();
  for (const e of entries) {
    const t = totalsByKind[e.kind];
    t.count++;
    if (e.contentLength !== null) {
      t.sizeKnownCount++;
      t.knownBytes += e.contentLength;
    }
    if (e.isThirdParty) {
      const agg = thirdPartyByOrigin.get(e.origin) ?? { requestCount: 0, knownBytes: 0 };
      agg.requestCount++;
      if (e.contentLength !== null) agg.knownBytes += e.contentLength;
      thirdPartyByOrigin.set(e.origin, agg);
    }
  }
  const origins = [...thirdPartyByOrigin.entries()].map(([origin, agg]) => {
    const known = categorizeThirdPartyOrigin(origin);
    return { origin, requestCount: agg.requestCount, knownBytes: agg.knownBytes, category: known?.category ?? null, vendorLabel: known?.label ?? null };
  });
  return {
    entries,
    totalsByKind,
    thirdParty: {
      originCount: origins.length,
      requestCount: origins.reduce((s, o) => s + o.requestCount, 0),
      knownBytes: origins.reduce((s, o) => s + o.knownBytes, 0),
      origins,
    },
    truncated: false,
    candidateCount: entries.length,
    probedCount: entries.length,
  };
}

beforeEach(() => resetResourceIssueIdCounter());

test("a clean, well-optimized set of resources produces no findings", () => {
  const entries = [
    entry({ url: "https://example.com/app.js", contentLength: 50_000, contentEncoding: "br", cacheControl: "public, max-age=31536000, immutable" }),
    entry({ url: "https://example.com/styles.css", kind: "stylesheet", contentLength: 20_000, contentEncoding: "gzip", cacheControl: "public, max-age=31536000, immutable" }),
    entry({ url: "https://example.com/hero.png", kind: "image", contentLength: 100_000, cacheControl: "public, max-age=31536000, immutable" }),
  ];
  const issues = detectResourceIssues(intelFrom(entries), "<html></html>", PAGE_URL);
  assert.deepEqual(issues, []);
});

test("flags a large individual JS resource", () => {
  const issues = detectResourceIssues(intelFrom([entry({ contentLength: 600_000 })]), "<html></html>", PAGE_URL);
  const found = issues.find((i) => i.title.includes("Large script resource"));
  assert.ok(found);
  assert.equal(found?.severity, "high");
});

test("does not flag a modestly-sized JS resource", () => {
  const issues = detectResourceIssues(intelFrom([entry({ contentLength: 50_000 })]), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Large script")));
});

test("does not invent a size for an unprobed resource", () => {
  const issues = detectResourceIssues(intelFrom([entry({ contentLength: null, probed: false, statusCode: null, probeError: "timeout" })]), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Large")));
});

test("flags excessive total JS weight and states partial coverage honestly", () => {
  const entries = [
    entry({ url: "https://example.com/a.js", contentLength: 700_000 }),
    entry({ url: "https://example.com/b.js", contentLength: null, probed: false, probeError: "timeout" }),
  ];
  const issues = detectResourceIssues(intelFrom(entries), "<html></html>", PAGE_URL);
  const found = issues.find((i) => i.title.includes("Excessive total JavaScript"));
  assert.ok(found);
  assert.match(found!.estimatedImpact!, /At least/);
});

test("flags a sizable JS resource served without compression", () => {
  const issues = detectResourceIssues(intelFrom([entry({ contentLength: 50_000, contentEncoding: null })]), "<html></html>", PAGE_URL);
  assert.ok(issues.some((i) => i.title.includes("without compression")));
});

test("does not flag a small resource for missing compression", () => {
  const issues = detectResourceIssues(intelFrom([entry({ contentLength: 2_000, contentEncoding: null })]), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("without compression")));
});

test("does not flag a resource that IS compressed", () => {
  const issues = detectResourceIssues(intelFrom([entry({ contentLength: 50_000, contentEncoding: "br" })]), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("without compression")));
});

test("flags a static resource with no Cache-Control", () => {
  const issues = detectResourceIssues(intelFrom([entry({ cacheControl: null })]), "<html></html>", PAGE_URL);
  assert.ok(issues.some((i) => i.title.includes("no Cache-Control")));
});

test("flags a static resource with a short max-age", () => {
  const issues = detectResourceIssues(intelFrom([entry({ cacheControl: "public, max-age=60" })]), "<html></html>", PAGE_URL);
  assert.ok(issues.some((i) => i.title.includes("short cache lifetime")));
});

test("does not flag an explicit no-store as 'weak' caching (it's an intentional choice)", () => {
  const issues = detectResourceIssues(intelFrom([entry({ cacheControl: "no-store" })]), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Cache-Control") || i.title.includes("cache lifetime")));
});

test("flags heavy reliance on third-party resources when both share and origin count are high", () => {
  const entries = [
    entry({ url: "https://example.com/own.js" }),
    entry({ url: "https://cdn-a.example/x.js", origin: "cdn-a.example", isThirdParty: true }),
    entry({ url: "https://cdn-b.example/x.js", origin: "cdn-b.example", isThirdParty: true }),
    entry({ url: "https://cdn-c.example/x.js", origin: "cdn-c.example", isThirdParty: true }),
  ];
  const issues = detectResourceIssues(intelFrom(entries), "<html></html>", PAGE_URL);
  assert.ok(issues.some((i) => i.title.includes("third-party")));
});

test("does not flag a page using just one or two deliberate third-party origins", () => {
  const entries = [
    entry({ url: "https://example.com/own.js" }),
    entry({ url: "https://example.com/own2.js" }),
    entry({ url: "https://fonts.example/font.woff2", kind: "font", origin: "fonts.example", isThirdParty: true }),
  ];
  const issues = detectResourceIssues(intelFrom(entries), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("third-party")));
});

test("flags a development build filename", () => {
  const issues = detectResourceIssues(intelFrom([entry({ url: "https://example.com/react.development.js" })]), "<html></html>", PAGE_URL);
  assert.ok(issues.some((i) => i.title.includes("Development build")));
});

test("does not flag a normal production script filename", () => {
  const issues = detectResourceIssues(intelFrom([entry({ url: "https://example.com/app.min.js" })]), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Development build")));
});

test("flags an inline sourceMappingURL reference", () => {
  const html = `<html><head><script>console.log("hi");\n//# sourceMappingURL=app.js.map</script></head></html>`;
  const issues = detectResourceIssues(intelFrom([]), html, PAGE_URL);
  assert.ok(issues.some((i) => i.title.includes("Source map reference")));
});

test("does not flag ordinary inline script content", () => {
  const html = `<html><head><script>console.log("hi");</script></head></html>`;
  const issues = detectResourceIssues(intelFrom([]), html, PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Source map")));
});

test("flags two different versions of the same library", () => {
  const entries = [entry({ url: "https://example.com/jquery-1.9.1.min.js" }), entry({ url: "https://example.com/jquery-3.6.0.min.js" })];
  const issues = detectResourceIssues(intelFrom(entries), "<html></html>", PAGE_URL);
  assert.ok(issues.some((i) => i.title.includes("Multiple versions of jQuery")));
});

test("does not flag a single version of a library loaded once", () => {
  const issues = detectResourceIssues(intelFrom([entry({ url: "https://example.com/jquery-3.6.0.min.js" })]), "<html></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Multiple versions")));
});

test("every emitted issue carries evidence, a fix, and an explanation", () => {
  const entries = [entry({ contentLength: 700_000, contentEncoding: null, cacheControl: null })];
  const issues = detectResourceIssues(intelFrom(entries), "<html></html>", PAGE_URL);
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.ok(issue.evidence.length > 0);
    assert.ok(issue.recommendedFix.length > 0);
    assert.ok(issue.whyItMatters.length > 0);
    assert.equal(issue.category, "performance");
  }
});

// ---------------- image attribute extraction ----------------

test("extractImageAttributeFacts captures loading/srcset/dimensions per image, in DOM order", () => {
  const html = `<html><body>
    <img src="/a.png" width="10" height="10" loading="lazy" srcset="/a.png 1x, /a-2x.png 2x">
    <img src="/b.png">
  </body></html>`;
  const facts = extractImageAttributeFacts(html);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].domOrder, 0);
  assert.equal(facts[0].hasWidth, true);
  assert.equal(facts[0].loading, "lazy");
  assert.equal(facts[0].hasSrcset, true);
  assert.equal(facts[1].hasSrcset, false);
  assert.equal(facts[1].loading, null);
});

// ---------------- grouped image-optimization finding (root-cause grouping) ----------------

function imageEntry(url: string, contentLength: number | null): ResourceProbeEntry {
  return entry({ url, kind: "image", contentLength });
}

test("a page with several unrelated image symptoms gets ONE grouped finding, not one per symptom", () => {
  const html = `<html><body>
    <img src="/hero.png">
    <img src="/a.png">
    <img src="/b.png">
    <img src="/c.png">
    <img src="/d.png">
  </body></html>`;
  const entries = [
    imageEntry("https://example.com/hero.png", 400_000), // oversized
    imageEntry("https://example.com/a.png", 20_000),
    imageEntry("https://example.com/b.png", 20_000),
    imageEntry("https://example.com/c.png", 20_000), // beyond first 3 -> missing-lazy candidate
    imageEntry("https://example.com/d.png", 20_000), // beyond first 3 -> missing-lazy candidate
  ];
  const issues = detectResourceIssues(intelFrom(entries), html, PAGE_URL);
  const imageIssues = issues.filter((i) => i.title.includes("Image optimization"));
  assert.equal(imageIssues.length, 1);
  assert.ok(imageIssues[0].evidence.length >= 2); // more than one symptom type represented
});

test("does not flag lazy-loading on the first few (likely above-the-fold) images", () => {
  const html = `<html><body><img src="/a.png"><img src="/b.png"><img src="/c.png"></body></html>`;
  const entries = [imageEntry("https://example.com/a.png", 20_000), imageEntry("https://example.com/b.png", 20_000), imageEntry("https://example.com/c.png", 20_000)];
  const issues = detectResourceIssues(intelFrom(entries), html, PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Image optimization")));
});

test("a page with no oversized/lazy/srcset symptoms produces no image-optimization finding", () => {
  const html = `<html><body><img src="/a.png" loading="lazy" srcset="/a.png 1x"></body></html>`;
  const entries = [imageEntry("https://example.com/a.png", 20_000)];
  const issues = detectResourceIssues(intelFrom(entries), html, PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Image optimization")));
});

test("a page with no images at all produces no image-optimization finding", () => {
  const issues = detectResourceIssues(intelFrom([]), "<html><body>no images</body></html>", PAGE_URL);
  assert.ok(!issues.some((i) => i.title.includes("Image optimization")));
});

test("a large batch of oversized images is high severity", () => {
  const html = `<html><body><img src="/a.png"><img src="/b.png"><img src="/c.png"></body></html>`;
  const entries = [imageEntry("https://example.com/a.png", 400_000), imageEntry("https://example.com/b.png", 400_000), imageEntry("https://example.com/c.png", 400_000)];
  const issues = detectResourceIssues(intelFrom(entries), html, PAGE_URL);
  const found = issues.find((i) => i.title.includes("Image optimization"));
  assert.ok(found);
  assert.equal(found?.severity, "high");
});

// ---------------- third-party categorization ----------------

test("categorizeThirdPartyOrigin recognizes a well-known analytics domain", () => {
  const result = categorizeThirdPartyOrigin("google-analytics.com");
  assert.equal(result?.category, "analytics");
});

test("categorizeThirdPartyOrigin matches a subdomain of a known vendor", () => {
  const result = categorizeThirdPartyOrigin("widget.intercom.io");
  assert.equal(result?.category, "chat");
});

test("categorizeThirdPartyOrigin returns null for an unrecognized domain rather than guessing", () => {
  const result = categorizeThirdPartyOrigin("totally-unknown-vendor-xyz.example");
  assert.equal(result, null);
});

test("third-party concentration evidence includes vendor labels for known origins", () => {
  const entries = [
    entry({ url: "https://example.com/own.js" }),
    entry({ url: "https://www.google-analytics.com/ga.js", origin: "google-analytics.com", isThirdParty: true }),
    entry({ url: "https://cdn-b.example/x.js", origin: "cdn-b.example", isThirdParty: true }),
    entry({ url: "https://cdn-c.example/x.js", origin: "cdn-c.example", isThirdParty: true }),
  ];
  const issues = detectResourceIssues(intelFrom(entries), "<html></html>", PAGE_URL);
  const found = issues.find((i) => i.title.includes("third-party"));
  assert.ok(found);
  assert.match(found!.estimatedImpact!, /Google Analytics/);
});
