import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTechnology } from "../src/technology/technologyIntelligence.js";
import { validateRegistryGraph } from "../src/technology/graph/validate.js";
import { requestManifest } from "../src/technology/detect/extendedSignals.js";
import { aggregateSiteTechnology } from "../src/technology/site/coverage.js";

test("V11 technology graph is internally valid", () => {
  assert.deepEqual(validateRegistryGraph(), []);
});

test("V11 manifest resolves safe DOM selectors and JS properties", () => {
  const m = requestManifest();
  assert.ok(m.selectors.includes("#___gatsby"));
  assert.ok(m.selectors.includes('iframe[src*="youtube"]'));
  assert.ok(m.jsProperties.includes("React.version"));
  assert.ok(m.jsProperties.includes("jQuery.fn.jquery"));
});

test("V11 retains base detections and adds forensic evidence", () => {
  const r = analyzeTechnology({
    url: "https://example.com/",
    html: '<meta name="generator" content="WordPress 7.0.4"><script src="https://static.hotjar.com/c/hotjar-1.js"></script>',
    metaTags: [{ name: "generator", content: "WordPress 7.0.4" }],
    resourceUrls: ["https://example.com/wp-content/plugins/woocommerce/a.js"],
    cookieNames: ["woocommerce_items_in_cart"],
  });
  const wp = r.detections.find((d) => d.slug === "wordpress");
  const wc = r.detections.find((d) => d.slug === "woocommerce");
  assert.equal(wp?.version, "7.0.4");
  assert.equal(wp?.technologyRisk?.exposedVersion, true);
  assert.ok(wp?.explanation);
  assert.ok(wc);
});

test("V11 uses DOM selector and JS-property evidence when supplied by the browser layer", () => {
  const r = analyzeTechnology({
    url: "https://example.com/",
    presentSelectors: ["#___gatsby", 'iframe[src*="youtube"]'],
    presentJsProperties: { "React.version": "19.1.0", "jQuery.fn.jquery": "3.7.1" },
  });
  assert.ok(r.detections.some((d) => d.slug === "gatsby"));
  assert.equal(r.detections.find((d) => d.slug === "react")?.version, "19.1.0");
  assert.equal(r.detections.find((d) => d.slug === "jquery")?.version, "3.7.1");
  assert.ok(r.detections.some((d) => d.slug === "youtube-embed"));
});

test("V11 requires WordPress for Elementor/WooCommerce-family plugin detections", () => {
  const r = analyzeTechnology({
    url: "https://example.com/",
    resourceUrls: ["https://example.com/wp-content/plugins/elementor/assets/app.js"],
  });
  assert.equal(r.detections.some((d) => d.slug === "elementor"), false);
  assert.ok(r.suppressed?.some((d) => d.slug === "elementor" && d.unmetDependency === "requires wordpress"));
});

test("V11 exposes evidence roles and neutral audit bridge", () => {
  const r = analyzeTechnology({
    url: "https://example.com/",
    headers: { "x-vercel-id": "abc" },
    scriptUrls: ["https://js.stripe.com/v3"],
  });
  const stripe = r.detections.find((d) => d.slug === "stripe");
  assert.ok(stripe);
  assert.ok(stripe.evidence.every((e) => e.role));
  assert.ok(stripe.auditRelevance?.categories.includes("ecommerce"));
});

test("V11 site-wide technology coverage is deterministic", () => {
  const a = analyzeTechnology({ url: "https://example.test/a", headers: { "cf-ray": "1" } });
  const b = analyzeTechnology({ url: "https://example.test/b", headers: { "x-vercel-id": "2" } });
  const site = aggregateSiteTechnology([
    { url: "https://example.test/a", intelligence: a },
    { url: "https://example.test/b", intelligence: b },
  ]);
  assert.equal(site.totalPages, 2);
  assert.equal(site.stats.categoriesRepresented, 1);
  assert.equal(site.coverage.find((x) => x.slug === "cloudflare")?.coveragePct, 50);
  assert.equal(site.coverage.find((x) => x.slug === "vercel")?.coveragePct, 50);
});
