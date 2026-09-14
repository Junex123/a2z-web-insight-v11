import assert from "node:assert/strict";
import { test } from "node:test";
import { collectUx } from "../src/collectors/uxCollector.js";

test("detects a <nav> as primary navigation and counts its links", () => {
  const html = `<html><body><nav><a href="/a">A</a><a href="/b">B</a></nav></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasPrimaryNav, true);
  assert.equal(result.navLinkCount, 2);
});

test("role=navigation also counts as primary navigation", () => {
  const html = `<html><body><div role="navigation"><a href="/a">A</a></div></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasPrimaryNav, true);
});

test("a page with no nav and no header links has no primary navigation", () => {
  const html = `<html><body><p>Just a paragraph, no nav anywhere.</p></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasPrimaryNav, false);
  assert.equal(result.navLinkCount, 0);
});

test("a <header> with several links counts as a navigation fallback when there's no real <nav>", () => {
  const html = `<html><body><header><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></header></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasPrimaryNav, true);
});

test("counts visible words and excludes script/style content", () => {
  const html = `<html><body>
    <script>var shouldNotCount = "this is a bunch of script text that must not be counted";</script>
    <style>.x { color: red; /* also should not count */ }</style>
    <p>Five real visible words here.</p>
  </body></html>`;
  const result = collectUx(html);
  assert.equal(result.wordCount, 5);
});

test("detects an element with no text, media, or interactive content as an empty section", () => {
  const html = `<html><body>
    <main></main>
    <section><p>Has real text.</p></section>
    <article><img src="a.png"></article>
  </body></html>`;
  const result = collectUx(html);
  assert.equal(result.emptySections.count, 1);
});

test("detects literal lorem ipsum placeholder text", () => {
  const html = `<html><body><p>Lorem ipsum dolor sit amet, consectetur.</p></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasPlaceholderText, true);
  assert.ok(result.placeholderExamples.length > 0);
});

test("does not flag ordinary content as placeholder text", () => {
  const html = `<html><body><p>Welcome to our real, finished homepage.</p></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasPlaceholderText, false);
});

test("detects 'coming soon' language", () => {
  const html = `<html><body><h1>Coming Soon</h1><p>We're launching soon, coming soon!</p></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasComingSoonText, true);
});

test("does not flag ordinary content as coming-soon language", () => {
  const html = `<html><body><p>Our new product ships nationwide starting today.</p></body></html>`;
  const result = collectUx(html);
  assert.equal(result.hasComingSoonText, false);
});

test("classifies relative links as internal and absolute http(s) links as external", () => {
  const html = `<html><body>
    <a href="/about">About</a>
    <a href="https://example.com/other">Other site</a>
    <a href="#section">Jump link</a>
  </body></html>`;
  const result = collectUx(html);
  assert.equal(result.links.internalCount, 1);
  assert.equal(result.links.externalCount, 1);
});

test("flags a mailto: link with no @ as malformed", () => {
  const html = `<html><body><a href="mailto:not-an-email">Contact</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.links.mailto.count, 1);
  assert.equal(result.links.mailto.malformed, 1);
});

test("accepts a well-formed mailto: link", () => {
  const html = `<html><body><a href="mailto:hello@example.com">Contact</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.links.mailto.count, 1);
  assert.equal(result.links.mailto.malformed, 0);
});

test("flags a tel: link with no digits as malformed", () => {
  const html = `<html><body><a href="tel:call-us">Call</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.links.tel.count, 1);
  assert.equal(result.links.tel.malformed, 1);
});

test("accepts a well-formed tel: link", () => {
  const html = `<html><body><a href="tel:+1-555-123-4567">Call</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.links.tel.count, 1);
  assert.equal(result.links.tel.malformed, 0);
});

// ---------------- Phase 2 additions ----------------

test("collects normalized nav link hrefs, ignoring query/hash/trailing slash differences", () => {
  const html = `<html><body><nav><a href="/about/">About</a><a href="/contact?ref=nav">Contact</a></nav></body></html>`;
  const result = collectUx(html);
  assert.deepEqual(result.navLinkHrefs.sort(), ["/about", "/contact"]);
});

test("flags an href=\"#\" link with no onclick as a dead-link candidate", () => {
  const html = `<html><body><a href="#">Learn More</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.deadLinkCandidates.count, 1);
});

test("does not flag href=\"#\" when an onclick handler is present", () => {
  const html = `<html><body><a href="#" onclick="doThing()">Learn More</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.deadLinkCandidates.count, 0);
});

test("does not flag an in-page anchor link like href=\"#section2\"", () => {
  const html = `<html><body><a href="#section2">Jump down</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.deadLinkCandidates.count, 0);
});

test("flags javascript:void(0) links with no onclick as dead-link candidates", () => {
  const html = `<html><body><a href="javascript:void(0)">Click me</a></body></html>`;
  const result = collectUx(html);
  assert.equal(result.deadLinkCandidates.count, 1);
});

test("flags a form with no real input fields as empty", () => {
  const html = `<html><body><form><button type="submit">Go</button></form></body></html>`;
  const result = collectUx(html);
  assert.equal(result.emptyForms.count, 1);
});

test("does not flag a form that has real input fields", () => {
  const html = `<html><body><form><input type="text"><button type="submit">Go</button></form></body></html>`;
  const result = collectUx(html);
  assert.equal(result.emptyForms.count, 0);
});

test("a hidden-only input still counts the form as empty", () => {
  const html = `<html><body><form><input type="hidden" name="csrf"><button type="submit">Go</button></form></body></html>`;
  const result = collectUx(html);
  assert.equal(result.emptyForms.count, 1);
});

test("flags a form with action=\"#\" as having a placeholder action", () => {
  const html = `<html><body><form action="#"><input type="text"></form></body></html>`;
  const result = collectUx(html);
  assert.equal(result.formsWithPlaceholderAction.count, 1);
});

test("does not flag a form with no action attribute at all (normal JS-handled pattern)", () => {
  const html = `<html><body><form><input type="text"></form></body></html>`;
  const result = collectUx(html);
  assert.equal(result.formsWithPlaceholderAction.count, 0);
});

test("does not flag a form with a real action URL", () => {
  const html = `<html><body><form action="/submit"><input type="text"></form></body></html>`;
  const result = collectUx(html);
  assert.equal(result.formsWithPlaceholderAction.count, 0);
});

// ---------------- Session 9: duplicate nav link labels ----------------

test("flags identical link text pointing at different destinations within the same nav", () => {
  const html = `<html><body><nav>
    <a href="/product-a">Read more</a>
    <a href="/product-b">Read more</a>
  </nav></body></html>`;
  const result = collectUx(html);
  assert.equal(result.duplicateNavLabels.count, 1);
});

test("does not flag identical link text pointing at the SAME destination (harmless duplicate)", () => {
  const html = `<html><body><nav>
    <a href="/home">Home</a>
    <a href="/home">Home</a>
  </nav></body></html>`;
  const result = collectUx(html);
  assert.equal(result.duplicateNavLabels.count, 0);
});

test("does not flag distinct link text within the same nav", () => {
  const html = `<html><body><nav>
    <a href="/a">About</a>
    <a href="/b">Contact</a>
  </nav></body></html>`;
  const result = collectUx(html);
  assert.equal(result.duplicateNavLabels.count, 0);
});

test("does not compare identical link text ACROSS two different nav regions", () => {
  const html = `<html><body>
    <nav><a href="/a">Read more</a></nav>
    <nav><a href="/b">Read more</a></nav>
  </body></html>`;
  const result = collectUx(html);
  assert.equal(result.duplicateNavLabels.count, 0);
});
