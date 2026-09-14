import assert from "node:assert/strict";
import { test } from "node:test";
import { isPathAllowedByRobots, parseRobotsTxt } from "../src/crawler/robots.js";

test("a Disallow rule under the wildcard User-agent blocks the matching path", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /private\n");
  assert.equal(isPathAllowedByRobots("/private", rules), false);
  assert.equal(isPathAllowedByRobots("/private/sub", rules), false);
  assert.equal(isPathAllowedByRobots("/public", rules), true);
});

test("rules under a non-wildcard User-agent group are ignored (documented scope limitation)", () => {
  const rules = parseRobotsTxt("User-agent: SomeOtherBot\nDisallow: /only-for-other-bot\n");
  assert.equal(isPathAllowedByRobots("/only-for-other-bot", rules), true);
});

test("an Allow rule can carve out an exception within a broader Disallow", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /assets/\nAllow: /assets/public/\n");
  assert.equal(isPathAllowedByRobots("/assets/secret.js", rules), false);
  assert.equal(isPathAllowedByRobots("/assets/public/logo.png", rules), true);
});

test("wildcard (*) and end-anchor ($) patterns are supported", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /*.pdf$\n");
  assert.equal(isPathAllowedByRobots("/file.pdf", rules), false);
  assert.equal(isPathAllowedByRobots("/file.pdf.html", rules), true);
});

test("no matching rule at all means allowed by default", () => {
  const rules = parseRobotsTxt("User-agent: *\n");
  assert.equal(isPathAllowedByRobots("/anything", rules), true);
});

test("an empty robots.txt (or one with only comments) means everything is allowed", () => {
  const rules = parseRobotsTxt("# just a comment\n\n");
  assert.equal(isPathAllowedByRobots("/anything", rules), true);
  assert.equal(rules.disallow.length, 0);
});

test("Sitemap: lines are collected regardless of which User-agent group they appear near", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /x\nSitemap: https://example.com/sitemap.xml\n");
  assert.deepEqual(rules.sitemaps, ["https://example.com/sitemap.xml"]);
});

test("Crawl-delay and unknown directives are ignored without error", () => {
  const rules = parseRobotsTxt("User-agent: *\nCrawl-delay: 10\nSome-Unknown-Field: value\nDisallow: /x\n");
  assert.equal(isPathAllowedByRobots("/x", rules), false);
});

test("comments after a directive on the same line are stripped", () => {
  const rules = parseRobotsTxt("User-agent: * # applies to everyone\nDisallow: /x # block this\n");
  assert.equal(isPathAllowedByRobots("/x", rules), false);
});
