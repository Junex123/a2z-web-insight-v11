import assert from "node:assert/strict";
import { test } from "node:test";
import { collectSeoExtras, parseRobotsDirectives } from "../src/collectors/seoCollector.js";

test("parseRobotsDirectives handles multiple tokens and 'none' shorthand", () => {
  assert.deepEqual(parseRobotsDirectives(null), { raw: null, noindex: false, nofollow: false, none: false, noarchive: false, nosnippet: false, otherTokens: [] });
  const d = parseRobotsDirectives("noindex, nofollow");
  assert.equal(d.noindex, true);
  assert.equal(d.nofollow, true);
  const none = parseRobotsDirectives("none");
  assert.equal(none.noindex, true);
  assert.equal(none.nofollow, true);
  assert.equal(none.none, true);
});

test("indexability: a plain page with no robots signals is indexable and followable", () => {
  const seo = collectSeoExtras("<html><head></head><body></body></html>", "https://example.com/page");
  assert.equal(seo.indexability.isIndexable, true);
  assert.equal(seo.indexability.isFollowable, true);
  assert.equal(seo.indexability.conflicting, false);
});

test("indexability: meta robots noindex makes the page non-indexable", () => {
  const seo = collectSeoExtras(`<html><head><meta name="robots" content="noindex"></head></html>`, "https://example.com/page");
  assert.equal(seo.indexability.isIndexable, false);
});

test("indexability: X-Robots-Tag header noindex also makes the page non-indexable", () => {
  const seo = collectSeoExtras(`<html><head></head></html>`, "https://example.com/page", { "x-robots-tag": "noindex" });
  assert.equal(seo.indexability.isIndexable, false);
});

test("indexability: meta robots and X-Robots-Tag disagreeing is flagged as conflicting", () => {
  const seo = collectSeoExtras(`<html><head><meta name="robots" content="index, follow"></head></html>`, "https://example.com/page", { "x-robots-tag": "noindex" });
  assert.equal(seo.indexability.conflicting, true);
});

test("canonical: resolves a relative href against the page URL", () => {
  const seo = collectSeoExtras(`<html><head><link rel="canonical" href="/other-page"></head></html>`, "https://example.com/page");
  assert.equal(seo.canonical.resolvedUrl, "https://example.com/other-page");
  assert.equal(seo.canonical.isAbsolute, false);
});

test("canonical: self-referencing absolute canonical is recognized", () => {
  const seo = collectSeoExtras(`<html><head><link rel="canonical" href="https://example.com/page"></head></html>`, "https://example.com/page");
  assert.equal(seo.canonical.isSelfReferencing, true);
  assert.equal(seo.canonical.pointsToDifferentDomain, false);
});

test("canonical: cross-domain canonical is detected", () => {
  const seo = collectSeoExtras(`<html><head><link rel="canonical" href="https://other-site.example/page"></head></html>`, "https://example.com/page");
  assert.equal(seo.canonical.pointsToDifferentDomain, true);
});

test("canonical: a malformed href is flagged rather than crashing", () => {
  // "http://" alone has a scheme but no host - special schemes require a
  // non-empty host, so the WHATWG URL parser rejects it outright, even
  // resolved against a valid base.
  const seo = collectSeoExtras(`<html><head><link rel="canonical" href="http://"></head></html>`, "https://example.com/page");
  assert.equal(seo.canonical.isMalformed, true);
  assert.equal(seo.canonical.resolvedUrl, null);
});

test("canonical: multiple declarations are counted", () => {
  const seo = collectSeoExtras(
    `<html><head><link rel="canonical" href="/a"><link rel="canonical" href="/b"></head></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.canonical.duplicateDeclarations, 2);
});

test("Open Graph: extracts og:* and twitter:* tags", () => {
  const seo = collectSeoExtras(
    `<html><head>
      <meta property="og:title" content="A Title">
      <meta property="og:description" content="A description">
      <meta property="og:image" content="https://example.com/img.png">
      <meta property="og:url" content="https://example.com/page">
      <meta name="twitter:card" content="summary_large_image">
    </head></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.openGraph.ogTitle, "A Title");
  assert.equal(seo.openGraph.twitterCard, "summary_large_image");
  assert.equal(seo.openGraph.ogUrlInconsistentWithCanonical, false);
});

test("Open Graph: og:url inconsistent with canonical is detected", () => {
  const seo = collectSeoExtras(
    `<html><head>
      <link rel="canonical" href="https://example.com/page">
      <meta property="og:url" content="https://example.com/different-page">
    </head></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.openGraph.ogUrlInconsistentWithCanonical, true);
});

test("hreflang: extracts entries, detects x-default and self-reference", () => {
  const seo = collectSeoExtras(
    `<html><head>
      <link rel="alternate" hreflang="en" href="https://example.com/page">
      <link rel="alternate" hreflang="fr" href="https://example.com/fr/page">
      <link rel="alternate" hreflang="x-default" href="https://example.com/page">
    </head></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.hreflang.entries.length, 3);
  assert.equal(seo.hreflang.hasXDefault, true);
  assert.equal(seo.hreflang.hasSelfReference, true);
  assert.equal(seo.hreflang.malformedLangCodes.length, 0);
});

test("hreflang: flags an invalid language code", () => {
  const seo = collectSeoExtras(
    `<html><head><link rel="alternate" hreflang="not-a-lang-code!" href="https://example.com/x"></head></html>`,
    "https://example.com/page",
  );
  assert.deepEqual(seo.hreflang.malformedLangCodes, ["not-a-lang-code!"]);
});

test("images: detects missing dimensions and generic filenames", () => {
  const seo = collectSeoExtras(
    `<html><body>
      <img src="/img1.png" alt="described" width="100" height="100">
      <img src="/photo123.jpg" alt="described">
    </body></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.images.length, 2);
  assert.equal(seo.images[0].hasDimensions, true);
  assert.equal(seo.images[1].hasDimensions, false);
  assert.equal(seo.images[1].genericFilename, true);
});

test("content: flags thin content", () => {
  const seo = collectSeoExtras(`<html><body><p>Hi.</p></body></html>`, "https://example.com/page");
  assert.equal(seo.content.isThinContent, true);
});

test("content: flags an obvious placeholder page", () => {
  const seo = collectSeoExtras(`<html><body><h1>Coming soon</h1><p>We're working on it.</p></body></html>`, "https://example.com/page");
  assert.equal(seo.content.looksLikePlaceholder, true);
});

test("content: a substantial page is not flagged as thin or placeholder", () => {
  const longText = "This is a genuinely long and descriptive paragraph about our product. ".repeat(10);
  const seo = collectSeoExtras(`<html><body><p>${longText}</p></body></html>`, "https://example.com/page");
  assert.equal(seo.content.isThinContent, false);
  assert.equal(seo.content.looksLikePlaceholder, false);
});

test("structuredData is populated from JSON-LD on the page", () => {
  const seo = collectSeoExtras(
    `<html><head><title>Acme</title><script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://example.com"}</script></head><body></body></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.structuredData.items.length, 1);
  assert.deepEqual(seo.structuredData.typesFound, ["Organization"]);
});

test("links: classifies same-host links as internal and different-host as external", () => {
  const seo = collectSeoExtras(
    `<html><body>
      <a href="/about">About</a>
      <a href="https://example.com/contact">Contact</a>
      <a href="https://other-site.example/page">Other</a>
    </body></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.links.internal.length, 2);
  assert.ok(seo.links.internal.includes("https://example.com/about"));
  assert.equal(seo.links.externalCount, 1);
});

test("links: treats www and non-www as the same host for internal classification", () => {
  const seo = collectSeoExtras(`<html><body><a href="https://www.example.com/about">About</a></body></html>`, "https://example.com/page");
  assert.equal(seo.links.internal.length, 1);
  assert.equal(seo.links.externalCount, 0);
});

test("links: dedupes repeated internal links", () => {
  const seo = collectSeoExtras(`<html><body><a href="/about">1</a><a href="/about">2</a></body></html>`, "https://example.com/page");
  assert.equal(seo.links.internal.length, 1);
});

test("links: skips mailto/tel/javascript/fragment-only hrefs", () => {
  const seo = collectSeoExtras(
    `<html><body>
      <a href="mailto:hi@example.com">Email</a>
      <a href="tel:+15551234567">Call</a>
      <a href="javascript:void(0)">JS</a>
      <a href="#section">Jump</a>
    </body></html>`,
    "https://example.com/page",
  );
  assert.equal(seo.links.internal.length, 0);
  assert.equal(seo.links.externalCount, 0);
});

test("links: a page with no <a> tags has zero internal links", () => {
  const seo = collectSeoExtras(`<html><body><p>No links here.</p></body></html>`, "https://example.com/page");
  assert.equal(seo.links.internal.length, 0);
});

test("links: detects a pattern of generic anchor text on internal links", () => {
  const html = `<html><body>
    <a href="/a">Click here</a>
    <a href="/b">Read More</a>
    <a href="/c">here</a>
    <a href="/d">Our detailed shipping policy</a>
  </body></html>`;
  const seo = collectSeoExtras(html, "https://example.com/page");
  assert.equal(seo.links.genericAnchorCount, 3);
  assert.ok(seo.links.genericAnchorExamples.length > 0);
});

test("links: a descriptive phrase that merely contains a generic word is not flagged", () => {
  const html = `<html><body><a href="/a">Learn more about our return policy</a></body></html>`;
  const seo = collectSeoExtras(html, "https://example.com/page");
  assert.equal(seo.links.genericAnchorCount, 0);
});

test("links: generic anchor text on an EXTERNAL link is not counted (SEO anchor-text signal is about internal linking)", () => {
  const html = `<html><body><a href="https://other-site.example/x">Click here</a></body></html>`;
  const seo = collectSeoExtras(html, "https://example.com/page");
  assert.equal(seo.links.genericAnchorCount, 0);
});

test("pagination: extracts rel=next/prev hrefs, resolved absolute", () => {
  const html = `<html><head><link rel="next" href="/page/3"><link rel="prev" href="/page/1"></head></html>`;
  const seo = collectSeoExtras(html, "https://example.com/page/2");
  assert.equal(seo.pagination.nextResolvedHref, "https://example.com/page/3");
  assert.equal(seo.pagination.prevResolvedHref, "https://example.com/page/1");
});

test("pagination: also recognizes rel=previous as well as rel=prev", () => {
  const html = `<html><head><link rel="previous" href="/page/1"></head></html>`;
  const seo = collectSeoExtras(html, "https://example.com/page/2");
  assert.equal(seo.pagination.prevResolvedHref, "https://example.com/page/1");
});

test("pagination: absent on a page with no pagination links (normal, not an error)", () => {
  const seo = collectSeoExtras(`<html><head></head></html>`, "https://example.com/page");
  assert.equal(seo.pagination.nextHref, null);
  assert.equal(seo.pagination.prevHref, null);
});
