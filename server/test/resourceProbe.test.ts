import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { collectResourceIntelligence, extractCandidateResources } from "../src/collectors/resourceProbe.js";

const PAGE_URL = "https://example.com/page";

test("extracts script, stylesheet, and image candidates with absolute resolved URLs", () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js"></script>
  </head><body>
    <img src="/hero.png">
  </body></html>`;
  const candidates = extractCandidateResources(html, PAGE_URL);
  const kinds = candidates.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["image", "script", "stylesheet"]);
  assert.ok(candidates.some((c) => c.url === "https://example.com/app.js"));
});

test("classifies a preloaded font link as font", () => {
  const html = `<html><head><link rel="preload" as="font" href="/font.woff2" crossorigin></head></html>`;
  const candidates = extractCandidateResources(html, PAGE_URL);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "font");
});

test("classifies a bare .woff2 link as font even without as=font", () => {
  const html = `<html><head><link rel="preload" href="/font.woff2"></head></html>`;
  const candidates = extractCandidateResources(html, PAGE_URL);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "font");
});

test("skips data: URIs", () => {
  const html = `<html><body><img src="data:image/png;base64,AAAA"></body></html>`;
  const candidates = extractCandidateResources(html, PAGE_URL);
  assert.equal(candidates.length, 0);
});

test("dedupes identical resolved URLs", () => {
  const html = `<html><body><img src="/logo.png"><img src="/logo.png"></body></html>`;
  const candidates = extractCandidateResources(html, PAGE_URL);
  assert.equal(candidates.length, 1);
});

test("a page with no resources has no candidates", () => {
  const candidates = extractCandidateResources(`<html><body><p>text only</p></body></html>`, PAGE_URL);
  assert.equal(candidates.length, 0);
});

// ---------------- probing (real HTTP against a local test server) ----------------

process.env.ALLOW_LOCAL_TARGETS = "true";

let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.get("/app.js", (_req, res) => {
    res.set("Content-Length", "12345").set("Cache-Control", "public, max-age=31536000, immutable").set("Content-Encoding", "gzip").type("application/javascript").end();
  });
  app.get("/styles.css", (_req, res) => {
    res.set("Content-Length", "500").type("text/css").end();
  });
  app.get("/broken.js", (_req, res) => res.status(404).end());
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test("collectResourceIntelligence probes real resources and captures real headers", async () => {
  const html = `<html><head><script src="http://localhost:${port}/app.js"></script><link rel="stylesheet" href="http://localhost:${port}/styles.css"></head></html>`;
  const intel = await collectResourceIntelligence(html, `http://localhost:${port}/page`);

  assert.equal(intel.candidateCount, 2);
  assert.equal(intel.probedCount, 2);
  assert.equal(intel.truncated, false);

  const script = intel.entries.find((e) => e.kind === "script")!;
  assert.equal(script.probed, true);
  assert.equal(script.contentLength, 12345);
  assert.equal(script.contentEncoding, "gzip");
  assert.match(script.cacheControl ?? "", /max-age=31536000/);
});

test("a resource that 404s is still recorded, with a null contentLength rather than an invented one", async () => {
  const html = `<html><head><script src="http://localhost:${port}/broken.js"></script></head></html>`;
  const intel = await collectResourceIntelligence(html, `http://localhost:${port}/page`);
  const entry = intel.entries[0];
  assert.equal(entry.probed, true);
  assert.equal(entry.statusCode, 404);
  assert.equal(entry.contentLength, null);
});

test("same-host resources are not counted as third-party", async () => {
  const html = `<html><head><script src="http://localhost:${port}/app.js"></script></head></html>`;
  const intel = await collectResourceIntelligence(html, `http://localhost:${port}/page`);
  assert.equal(intel.thirdParty.requestCount, 0);
});

test("a resource on a different host is counted as third-party", async () => {
  // isolated second server acting as a "third-party" origin
  const thirdPartyApp = express();
  thirdPartyApp.get("/lib.js", (_req, res) => res.set("Content-Length", "1000").end());
  const thirdPartyServer = thirdPartyApp.listen(0);
  await new Promise((r) => thirdPartyServer.once("listening", r));
  const thirdPartyPort = (thirdPartyServer.address() as any).port;

  // both "localhost" and "127.0.0.1" resolve to the loopback interface but are different hostnames/origins
  const html = `<html><head><script src="http://127.0.0.1:${thirdPartyPort}/lib.js"></script></head></html>`;
  const intel = await collectResourceIntelligence(html, `http://localhost:${port}/page`);
  assert.equal(intel.thirdParty.requestCount, 1);
  assert.equal(intel.thirdParty.originCount, 1);
  assert.equal(intel.thirdParty.origins[0].category, null); // 127.0.0.1 isn't on the known-vendor catalog - never guessed
  assert.equal(intel.thirdParty.origins[0].vendorLabel, null);

  await new Promise((r) => thirdPartyServer.close(r));
});

test("candidates beyond the probe cap are not probed, and truncated is reported honestly", async () => {
  const html = `<html><head><script src="http://localhost:${port}/app.js"></script><link rel="stylesheet" href="http://localhost:${port}/styles.css"></head></html>`;
  const intel = await collectResourceIntelligence(html, `http://localhost:${port}/page`, { maxProbes: 1 });
  assert.equal(intel.candidateCount, 2);
  assert.equal(intel.probedCount, 1);
  assert.equal(intel.truncated, true);
});
