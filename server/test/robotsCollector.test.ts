import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { checkRobotsPath, fetchRobotsTxt, isSiteWideBlocked, parseRobotsTxt } from "../src/collectors/robotsCollector.js";

test("parses User-agent/Disallow/Allow groups", () => {
  const raw = `User-agent: *\nDisallow: /admin/\nDisallow: /private/\nAllow: /private/public-page\n\nSitemap: https://example.com/sitemap.xml`;
  const result = parseRobotsTxt(raw);
  assert.equal(result.available, true);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].userAgents, ["*"]);
  assert.deepEqual(result.groups[0].disallow, ["/admin/", "/private/"]);
  assert.deepEqual(result.groups[0].allow, ["/private/public-page"]);
  assert.deepEqual(result.sitemapUrls, ["https://example.com/sitemap.xml"]);
});

test("supports multiple consecutive User-agent lines sharing one group", () => {
  const raw = `User-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /no-bots/`;
  const result = parseRobotsTxt(raw);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].userAgents, ["Googlebot", "Bingbot"]);
});

test("treats separate User-agent blocks (with directives between) as separate groups", () => {
  const raw = `User-agent: Googlebot\nDisallow: /a/\n\nUser-agent: *\nDisallow: /b/`;
  const result = parseRobotsTxt(raw);
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups[0].disallow, ["/a/"]);
  assert.deepEqual(result.groups[1].disallow, ["/b/"]);
});

test("flags lines with no colon separator as a syntax warning", () => {
  const raw = `User-agent: *\nThis line is broken\nDisallow: /x/`;
  const result = parseRobotsTxt(raw);
  assert.equal(result.syntaxWarnings.length, 1);
  assert.match(result.syntaxWarnings[0], /no ":" separator/i);
});

test("records a malformed Sitemap reference without throwing", () => {
  const raw = `User-agent: *\nDisallow:\nSitemap: not-a-valid-url`;
  const result = parseRobotsTxt(raw);
  assert.deepEqual(result.malformedSitemapRefs, ["not-a-valid-url"]);
});

test("an empty Disallow value means everything is allowed", () => {
  const raw = `User-agent: *\nDisallow:`;
  const result = parseRobotsTxt(raw);
  const check = checkRobotsPath(result, "https://example.com/anything");
  assert.equal(check.blocked, false);
});

test("checkRobotsPath blocks a path matching a Disallow rule", () => {
  const raw = `User-agent: *\nDisallow: /admin/`;
  const result = parseRobotsTxt(raw);
  const check = checkRobotsPath(result, "https://example.com/admin/dashboard");
  assert.equal(check.blocked, true);
  assert.equal(check.matchedRule, "/admin/");
});

test("checkRobotsPath does not block an unrelated path", () => {
  const raw = `User-agent: *\nDisallow: /admin/`;
  const result = parseRobotsTxt(raw);
  const check = checkRobotsPath(result, "https://example.com/products/");
  assert.equal(check.blocked, false);
});

test("checkRobotsPath: longest-matching-rule-wins - a more specific Allow overrides a broader Disallow", () => {
  const raw = `User-agent: *\nDisallow: /private/\nAllow: /private/public-page`;
  const result = parseRobotsTxt(raw);
  const blocked = checkRobotsPath(result, "https://example.com/private/secret");
  const allowed = checkRobotsPath(result, "https://example.com/private/public-page");
  assert.equal(blocked.blocked, true);
  assert.equal(allowed.blocked, false);
});

test("checkRobotsPath on an unavailable robots.txt never blocks anything", () => {
  const check = checkRobotsPath({ fetched: false, statusCode: null, available: false, raw: null, groups: [], sitemapUrls: [], malformedSitemapRefs: [], syntaxWarnings: [] }, "https://example.com/anything");
  assert.equal(check.blocked, false);
});

test("isSiteWideBlocked detects a catastrophic 'Disallow: /' for User-agent: *", () => {
  const result = parseRobotsTxt("User-agent: *\nDisallow: /");
  assert.equal(isSiteWideBlocked(result), true);
});

test("isSiteWideBlocked is false for a narrower Disallow rule", () => {
  const result = parseRobotsTxt("User-agent: *\nDisallow: /admin/");
  assert.equal(isSiteWideBlocked(result), false);
});

test("isSiteWideBlocked is false when an Allow rule carves out exceptions to a root Disallow", () => {
  const result = parseRobotsTxt("User-agent: *\nDisallow: /\nAllow: /public/");
  assert.equal(isSiteWideBlocked(result), false);
});

test("isSiteWideBlocked is false when the root block only applies to a specific named bot, not *", () => {
  const result = parseRobotsTxt("User-agent: BadBot\nDisallow: /");
  assert.equal(isSiteWideBlocked(result), false);
});

test("isSiteWideBlocked is false when robots.txt is unavailable", () => {
  assert.equal(
    isSiteWideBlocked({ fetched: false, statusCode: null, available: false, raw: null, groups: [], sitemapUrls: [], malformedSitemapRefs: [], syntaxWarnings: [] }),
    false,
  );
});

// ---------------- fetching (real HTTP against a local test server) ----------------

process.env.ALLOW_LOCAL_TARGETS = "true";

let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /admin/\nSitemap: /sitemap.xml");
  });
  app.get("/no-robots-here", (_req, res) => res.send("nothing"));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test("fetchRobotsTxt retrieves and parses a real robots.txt over HTTP", async () => {
  const result = await fetchRobotsTxt(`http://localhost:${port}/clean`);
  assert.equal(result.available, true);
  assert.deepEqual(result.groups[0].disallow, ["/admin/"]);
});

test("fetchRobotsTxt resolves to available:false (not an error) when robots.txt 404s", async () => {
  const isolatedApp = express(); // a server with no /robots.txt route at all
  const isolatedServer = isolatedApp.listen(0);
  await new Promise((r) => isolatedServer.once("listening", r));
  const isolatedPort = (isolatedServer.address() as any).port;

  const result = await fetchRobotsTxt(`http://localhost:${isolatedPort}/anything`);
  assert.equal(result.available, false);
  assert.equal(result.fetched, true);

  await new Promise((r) => isolatedServer.close(r));
});
