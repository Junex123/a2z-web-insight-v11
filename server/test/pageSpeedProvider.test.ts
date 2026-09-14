import assert from "node:assert/strict";
import { test } from "node:test";
import { PageSpeedProvider, normalizePageSpeedResponse } from "../src/providers/pageSpeedProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fullPsiPayload() {
  return {
    lighthouseResult: {
      categories: { performance: { score: 0.73 } },
      audits: {
        "largest-contentful-paint": { numericValue: 2800 },
        "cumulative-layout-shift": { numericValue: 0.04 },
        "first-contentful-paint": { numericValue: 1600 },
        "speed-index": { numericValue: 3900 },
        "total-blocking-time": { numericValue: 320 },
        "server-response-time": { numericValue: 410 },
        "unused-css-rules": {
          title: "Reduce unused CSS",
          details: { type: "opportunity", overallSavingsMs: 240 },
        },
        "render-blocking-resources": {
          title: "Eliminate render-blocking resources",
          details: { type: "opportunity", overallSavingsMs: 610 },
        },
        "largest-contentful-paint-element": {
          details: {
            items: [{ node: { snippet: '<img src="https://example.com/hero.jpg" class="hero">', selector: "div.hero > img" } }],
          },
        },
        "layout-shift-elements": {
          details: {
            items: [
              { score: 0.08, node: { snippet: '<img src="https://example.com/banner.jpg" class="banner">', selector: "div.promo > img.banner" } },
              { score: 0.02, node: { snippet: '<div class="ad-slot" width="300" height="250"></div>', selector: "div.ad-slot" } },
            ],
          },
        },
      },
    },
    loadingExperience: {
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2600, category: "AVERAGE" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 3, category: "GOOD" }, // -> 0.03
        INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "GOOD" },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 1500, category: "GOOD" },
      },
    },
  };
}

// ---------------- normalization ----------------

test("extracts LCP, preferring field data over lab data", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.ok(evidence);
  assert.equal(evidence!.metrics.lcp.value, 2600); // field, not the 2800 lab value
  assert.equal(evidence!.metrics.lcp.source, "pagespeed-field");
  assert.equal(evidence!.metrics.lcp.status, "needs-improvement");
});

test("extracts INP from field data", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.equal(evidence!.metrics.inp.value, 180);
  assert.equal(evidence!.metrics.inp.status, "good");
  assert.equal(evidence!.metrics.inp.source, "pagespeed-field");
});

test("extracts CLS and converts the field percentile from x100 to a decimal", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.equal(evidence!.metrics.cls.value, 0.03);
  assert.equal(evidence!.metrics.cls.status, "good");
});

test("extracts TTFB from the lab server-response-time audit when no field data exists", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.equal(evidence!.metrics.ttfb.value, 410);
  assert.equal(evidence!.metrics.ttfb.source, "pagespeed-lab");
});

test("extracts FCP", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.equal(evidence!.metrics.fcp.value, 1500);
  assert.equal(evidence!.metrics.fcp.status, "good");
});

test("extracts and scales the Lighthouse performance score to 0-100", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.equal(evidence!.lighthousePerformanceScore, 73);
});

test("extracts and ranks opportunities by estimated savings, capped at 5", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.equal(evidence!.opportunities.length, 2);
  assert.equal(evidence!.opportunities[0].id, "render-blocking-resources");
  assert.equal(evidence!.opportunities[0].estimatedSavingsMs, 610);
});

test("a missing audit results in an unavailable metric, never a fabricated 0", () => {
  const payload = fullPsiPayload();
  // @ts-expect-error - deliberately deleting for the test
  delete payload.lighthouseResult.audits["speed-index"];
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.metrics.speedIndex.value, null);
  assert.equal(evidence!.metrics.speedIndex.status, "unavailable");
  assert.equal(evidence!.metrics.speedIndex.source, "unavailable");
});

test("a missing Core Web Vital (LCP) with no field or lab data is unavailable, not 0", () => {
  const payload = fullPsiPayload();
  delete (payload.loadingExperience.metrics as any).LARGEST_CONTENTFUL_PAINT_MS;
  // @ts-expect-error - deliberately deleting for the test
  delete payload.lighthouseResult.audits["largest-contentful-paint"];
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.metrics.lcp.value, null);
  assert.equal(evidence!.metrics.lcp.status, "unavailable");
  assert.notEqual(evidence!.metrics.lcp.value, 0);
});

test("coverage reflects how many of the 7 metrics actually had data", () => {
  const payload = fullPsiPayload();
  delete (payload.loadingExperience.metrics as any).LARGEST_CONTENTFUL_PAINT_MS;
  // @ts-expect-error
  delete payload.lighthouseResult.audits["largest-contentful-paint"];
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.coverage.metricsTotal, 7);
  assert.equal(evidence!.coverage.metricsAvailable, 6);
});

test("a response with neither lighthouseResult nor loadingExperience normalizes to null", () => {
  assert.equal(normalizePageSpeedResponse({}, "mobile"), null);
  assert.equal(normalizePageSpeedResponse(null, "mobile"), null);
  assert.equal(normalizePageSpeedResponse("not an object", "mobile"), null);
});

// ---------------- LCP element extraction (Session 12) ----------------

test("extracts the LCP element's image URL from its HTML snippet", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.ok(evidence!.lcpElement);
  assert.equal(evidence!.lcpElement!.imageUrl, "https://example.com/hero.jpg");
  assert.equal(evidence!.lcpElement!.selector, "div.hero > img");
});

test("extracts a background-image URL when the LCP element snippet uses CSS background-image instead of <img src>", () => {
  const payload = fullPsiPayload();
  payload.lighthouseResult.audits["largest-contentful-paint-element"] = {
    details: { items: [{ node: { snippet: '<div style="background-image: url(\'https://example.com/bg.jpg\')" class="hero"></div>', selector: "div.hero" } }] },
  };
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.lcpElement!.imageUrl, "https://example.com/bg.jpg");
});

test("lcpElement.imageUrl is null (not guessed) when the LCP element is text, not an image", () => {
  const payload = fullPsiPayload();
  payload.lighthouseResult.audits["largest-contentful-paint-element"] = {
    details: { items: [{ node: { snippet: "<h1>Welcome to our site</h1>", selector: "h1" } }] },
  };
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.lcpElement!.imageUrl, null);
  assert.equal(evidence!.lcpElement!.selector, "h1");
});

test("lcpElement is null (not fabricated) when the audit is absent entirely", () => {
  const payload = fullPsiPayload();
  // @ts-expect-error test fixture shape
  delete payload.lighthouseResult.audits["largest-contentful-paint-element"];
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.lcpElement, null);
});

test("lcpElement is null when the audit exists but has an unrecognized/empty shape", () => {
  const payload = fullPsiPayload();
  payload.lighthouseResult.audits["largest-contentful-paint-element"] = { details: { items: [] } };
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.lcpElement, null);
});

// ---------------- provider-level behavior (mocked fetch, no live API) ----------------

test("missing API key resolves to not_configured without making any network call", async () => {
  let called = false;
  const provider = new PageSpeedProvider({
    apiKey: undefined,
    fetchImpl: (async () => {
      called = true;
      return jsonResponse(fullPsiPayload());
    }) as unknown as typeof fetch,
  });
  // ensure no ambient env var leaks into the test
  delete process.env.PAGESPEED_INSIGHTS_API_KEY;

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "not_configured");
  assert.equal(result.evidence, null);
  assert.equal(called, false);
});

test("a successful response resolves to status available with normalized evidence", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse(fullPsiPayload())) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "available");
  assert.ok(result.evidence);
  assert.equal(result.evidence!.metrics.lcp.value, 2600);
});

test("HTTP 429 resolves to rate_limited, not a thrown error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse({ error: "rate limited" }, 429)) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "rate_limited");
  assert.equal(result.evidence, null);
});

test("a request that aborts on timeout resolves to status timeout", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    timeoutMs: 20,
    fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "timeout");
  assert.equal(result.evidence, null);
});

test("a network-level failure resolves to status error, not a thrown exception", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.ok(result.errorMessage);
  // never leak a raw stack trace to the user-facing message
  assert.ok(!result.errorMessage!.includes("ENOTFOUND"));
});

test("an invalid/malformed JSON response resolves to status error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => new Response("not json{{{", { status: 200 })) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
});

test("a well-formed but unusable response body resolves to status error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse({ unexpected: "shape" })) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.equal(result.evidence, null);
});

test("a non-429 non-2xx HTTP status resolves to status error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
});


test("extracts multiple layout-shift contributors with per-element score and declared-dimension detection", () => {
  const evidence = normalizePageSpeedResponse(fullPsiPayload(), "mobile");
  assert.equal(evidence!.layoutShiftElements.length, 2);

  const banner = evidence!.layoutShiftElements[0];
  assert.equal(banner.imageUrl, "https://example.com/banner.jpg");
  assert.equal(banner.scoreContribution, 0.08);
  assert.equal(banner.hasDeclaredDimensions, false); // the banner <img> snippet has no width/height attrs

  const adSlot = evidence!.layoutShiftElements[1];
  assert.equal(adSlot.hasDeclaredDimensions, true); // the ad-slot div DOES declare width="300" height="250"
  assert.equal(adSlot.scoreContribution, 0.02);
});

test("layoutShiftElements is an empty array (not null, not fabricated) when the audit is absent", () => {
  const payload = fullPsiPayload();
  // @ts-expect-error - deliberately deleting for the test
  delete payload.lighthouseResult.audits["layout-shift-elements"];
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.deepEqual(evidence!.layoutShiftElements, []);
});

test("layoutShiftElements caps at a small number of elements even if Lighthouse reports more", () => {
  const payload = fullPsiPayload();
  const manyItems = Array.from({ length: 20 }, (_, i) => ({ score: 0.01, node: { snippet: `<div class="item-${i}"></div>`, selector: `.item-${i}` } }));
  payload.lighthouseResult.audits["layout-shift-elements"] = { details: { items: manyItems } };
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.ok(evidence!.layoutShiftElements.length <= 5);
});

test("scoreContribution is null (not defaulted to 0) when Lighthouse doesn't provide a score", () => {
  const payload = fullPsiPayload();
  // @ts-expect-error - deliberately omitting `score` for the test
  payload.lighthouseResult.audits["layout-shift-elements"] = { details: { items: [{ node: { snippet: "<img src=\"https://example.com/x.jpg\">", selector: "img.x" } }] } };
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.layoutShiftElements[0].scoreContribution, null);
});

test("hasDeclaredDimensions is null (not guessed) when no snippet is available at all", () => {
  const payload = fullPsiPayload();
  // @ts-expect-error - deliberately omitting `snippet` for the test
  payload.lighthouseResult.audits["layout-shift-elements"] = { details: { items: [{ score: 0.05, node: { selector: "div.mystery" } }] } };
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.layoutShiftElements[0].hasDeclaredDimensions, null);
});

// ---------------- provider-level behavior (mocked fetch, no live API) ----------------

test("missing API key resolves to not_configured without making any network call", async () => {
  let called = false;
  const provider = new PageSpeedProvider({
    apiKey: undefined,
    fetchImpl: (async () => {
      called = true;
      return jsonResponse(fullPsiPayload());
    }) as unknown as typeof fetch,
  });
  // ensure no ambient env var leaks into the test
  delete process.env.PAGESPEED_INSIGHTS_API_KEY;

  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "not_configured");
  assert.equal(result.evidence, null);
  assert.equal(called, false);
});

test("a successful response resolves to status available with normalized evidence", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse(fullPsiPayload())) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "available");
  assert.ok(result.evidence);
  assert.equal(result.evidence!.metrics.lcp.value, 2600);
});

test("HTTP 429 resolves to rate_limited, not a thrown error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse({ error: "rate limited" }, 429)) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "rate_limited");
  assert.equal(result.evidence, null);
});

test("a request that aborts on timeout resolves to status timeout", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    timeoutMs: 20,
    fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "timeout");
  assert.equal(result.evidence, null);
});

test("a network-level failure resolves to status error, not a thrown exception", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.ok(result.errorMessage);
  // never leak a raw stack trace to the user-facing message
  assert.ok(!result.errorMessage!.includes("ENOTFOUND"));
});

test("an invalid/malformed JSON response resolves to status error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => new Response("not json{{{", { status: 200 })) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
});

test("a well-formed but unusable response body resolves to status error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse({ unexpected: "shape" })) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
  assert.equal(result.evidence, null);
});

test("a non-429 non-2xx HTTP status resolves to status error", async () => {
  const provider = new PageSpeedProvider({
    apiKey: "test-key",
    fetchImpl: (async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch,
  });
  const result = await provider.analyze("https://example.com");
  assert.equal(result.status, "error");
});
