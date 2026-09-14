import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { collectResponsive } from "../src/collectors/responsiveCollector.js";

// ---------------- viewport ----------------

test("detects a missing viewport meta tag", async () => {
  const result = await collectResponsive("<html><head></head><body></body></html>", "https://example.com/");
  assert.equal(result.viewport.present, false);
  assert.equal(result.viewport.content, null);
});

test("detects a healthy device-width viewport", async () => {
  const html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.viewport.present, true);
  assert.equal(result.viewport.hasDeviceWidthToken, true);
  assert.equal(result.viewport.hasFixedNumericWidth, false);
});

test("detects a suspicious fixed-numeric-width viewport", async () => {
  const html = `<html><head><meta name="viewport" content="width=980"></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.viewport.present, true);
  assert.equal(result.viewport.hasDeviceWidthToken, false);
  assert.equal(result.viewport.hasFixedNumericWidth, true);
  assert.equal(result.viewport.fixedWidthValue, 980);
});

test("detects a zoom-disabling viewport", async () => {
  const html = `<html><head><meta name="viewport" content="width=device-width, user-scalable=no"></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.viewport.disablesZoom, true);
});

// ---------------- inline CSS: media queries / fixed widths / vw / responsive images ----------------

test("counts inline media queries and distinct breakpoint values", async () => {
  const html = `<html><head><style>
    @media (max-width: 768px) { .nav { display: none; } }
    @media (min-width: 1024px) { .sidebar { display: block; } }
  </style></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.css.inspected, true);
  assert.equal(result.css.mediaQueryCount, 2);
  assert.deepEqual(result.css.distinctBreakpointValues, [768, 1024]);
});

test("no CSS at all is represented as not-inspected, not as a false pass", async () => {
  const html = `<html><head></head><body><p>no styles here</p></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.css.inspected, false);
  assert.equal(result.css.mediaQueryCount, 0);
});

test("flags a fixed-width CSS declaration but not a max-width media-query condition", async () => {
  const html = `<html><head><style>
    .container { width: 980px; }
    @media (max-width: 900px) { .container { width: 100%; } }
  </style></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.css.fixedWidthDeclarations.length, 1);
  assert.equal(result.css.fixedWidthDeclarations[0].valuePx, 980);
});

test("counts 100vw usages", async () => {
  const html = `<html><head><style>.hero { width: 100vw; }</style></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.css.viewportUnitFullWidthCount, 1);
});

test("detects a responsive-image CSS pattern", async () => {
  const html = `<html><head><style>img { max-width: 100%; height: auto; }</style></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.css.hasResponsiveImagePattern, true);
});

test("modern CSS with no media queries but a responsive image pattern is not automatically flagged as unresponsive", async () => {
  // this test only proves the raw evidence is collected correctly - the
  // "no media query != not responsive" judgment call lives in
  // responsiveIssues.ts, tested separately
  const html = `<html><head><style>img { max-width: 100%; height: auto; }</style></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.css.mediaQueryCount, 0);
  assert.equal(result.css.hasResponsiveImagePattern, true);
});

// ---------------- images ----------------

test("detects large static-width images with no srcset/sizes", async () => {
  const html = `<html><body>
    <img src="hero.jpg" width="1600">
    <img src="icon.png" width="32">
    <img src="responsive.jpg" width="1600" srcset="responsive-800.jpg 800w, responsive-1600.jpg 1600w">
  </body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.images.total, 3);
  assert.equal(result.images.withSrcsetOrSizes, 1);
  assert.equal(result.images.largeStaticWidthExamples.length, 1);
  assert.equal(result.images.largeStaticWidthExamples[0].src, "hero.jpg");
});

test("an image with sizes (no srcset) still counts as responsive", async () => {
  const html = `<html><body><img src="a.jpg" width="1600" sizes="(max-width: 600px) 100vw, 50vw"></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.images.withSrcsetOrSizes, 1);
  assert.equal(result.images.largeStaticWidthExamples.length, 0);
});

// ---------------- navigation ----------------

test("counts the largest nav menu's link count", async () => {
  const html = `<html><body>
    <nav><a href="/a">A</a><a href="/b">B</a></nav>
    <nav><a href="/c">C</a><a href="/d">D</a><a href="/e">E</a></nav>
  </body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.navigation.navElementCount, 2);
  assert.equal(result.navigation.largestMenuLinkCount, 3);
});

test("detects duplicate navigation structures with substantially overlapping links", async () => {
  const html = `<html><body>
    <nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav>
    <nav><a href="/a">Home</a><a href="/b">About</a><a href="/c">Contact</a></nav>
  </body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.navigation.duplicateNavRisk, true);
});

test("two navs with mostly-different links are not flagged as duplicates", async () => {
  const html = `<html><body>
    <nav><a href="/a">A</a><a href="/b">B</a></nav>
    <nav><a href="/x">X</a><a href="/y">Y</a></nav>
  </body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.navigation.duplicateNavRisk, false);
});

test("a single nav is never flagged as a duplicate", async () => {
  const html = `<html><body><nav><a href="/a">A</a></nav></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.navigation.duplicateNavRisk, false);
});

test("detects empty navigation controls (no text, no aria-label)", async () => {
  const html = `<html><body><nav>
    <a href="/a">Home</a>
    <a href="/b"></a>
    <button></button>
    <button aria-label="Open menu"></button>
  </nav></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.navigation.emptyControlCount, 2);
});

// ---------------- edge cases ----------------

test("empty HTML does not throw and returns sensible zeroed-out evidence", async () => {
  const result = await collectResponsive("", "https://example.com/");
  assert.equal(result.viewport.present, false);
  assert.equal(result.css.inspected, false);
  assert.equal(result.images.total, 0);
  assert.equal(result.navigation.navElementCount, 0);
});

test("malformed/unclosed HTML does not throw", async () => {
  const html = `<html><body><div><img src="a.png"<p>broken tag soup</html>`;
  await assert.doesNotReject(() => collectResponsive(html, "https://example.com/"));
});

test("an unresolvable/invalid stylesheet href is skipped, not thrown", async () => {
  const html = `<html><head><link rel="stylesheet" href="   not a valid url at all   "></head><body></body></html>`;
  await assert.doesNotReject(() => collectResponsive(html, "not-a-valid-base-either"));
});

// ---------------- external stylesheet fetching (real local server, SSRF-guarded path) ----------------

test("fetches and inspects a real external stylesheet", async () => {
  const app = express();
  app.get("/styles.css", (_req, res) => {
    res.type("text/css").send("@media (max-width: 500px) { .x { width: 100vw; } }");
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    const html = `<html><head><link rel="stylesheet" href="/styles.css"></head><body></body></html>`;
    const result = await collectResponsive(html, `http://127.0.0.1:${port}/page`);
    assert.equal(result.css.inspected, true);
    assert.equal(result.css.mediaQueryCount, 1);
    assert.equal(result.css.viewportUnitFullWidthCount, 1);
    assert.equal(result.css.sources.length, 1);
    assert.equal(result.css.sources[0].source, "external");
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("stylesheets beyond the bounded fetch limit are counted as skipped, not silently dropped", async () => {
  const app = express();
  for (let i = 0; i < 5; i++) {
    app.get(`/style${i}.css`, (_req, res) => res.type("text/css").send(`.a${i} { color: red; }`));
  }
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    const links = Array.from({ length: 5 }, (_, i) => `<link rel="stylesheet" href="/style${i}.css">`).join("\n");
    const html = `<html><head>${links}</head><body></body></html>`;
    const result = await collectResponsive(html, `http://127.0.0.1:${port}/page`);
    assert.equal(result.css.sources.filter((s) => s.source === "external").length, 3, "only MAX_EXTERNAL_STYLESHEETS should actually be fetched");
    assert.equal(result.css.externalStylesheetsSkipped, 2);
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("a stylesheet that fails to fetch (404) is counted as skipped, and does not crash the collector", async () => {
  const app = express();
  // no routes registered - every request 404s
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    const html = `<html><head><link rel="stylesheet" href="/missing.css"></head><body></body></html>`;
    const result = await collectResponsive(html, `http://127.0.0.1:${port}/page`);
    assert.equal(result.css.sources.length, 0);
    assert.equal(result.css.externalStylesheetsSkipped, 1);
    assert.equal(result.css.inspected, false);
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("an external stylesheet pointing at a blocked/private host is rejected by the SSRF guard, not fetched", async () => {
  // deliberately NOT setting ALLOW_LOCAL_TARGETS here - the production guard must be active
  const html = `<html><head><link rel="stylesheet" href="http://169.254.169.254/steal.css"></head><body></body></html>`;
  const result = await collectResponsive(html, "https://example.com/");
  assert.equal(result.css.sources.length, 0);
  assert.equal(result.css.externalStylesheetsSkipped, 1);
});
