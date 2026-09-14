import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { loadRobotsPolicy, isAllowedByRobots } from "../src/crawler/robots.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let mockServer: Server;
let mockPort: number;
let mockOrigin: string;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;
  mockOrigin = `http://localhost:${mockPort}`;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

test("a real robots.txt is fetched and parsed, with its Disallow rule enforced", async () => {
  const policy = await loadRobotsPolicy(mockOrigin, true, { timeoutMs: 5000 });
  assert.equal(policy.status, "fetched");
  assert.equal(isAllowedByRobots(policy, "/site/disallowed"), false);
  assert.equal(isAllowedByRobots(policy, "/site/home"), true);
});

test("its Sitemap: entry is discovered", async () => {
  const policy = await loadRobotsPolicy(mockOrigin, true, { timeoutMs: 5000 });
  assert.equal(policy.sitemapUrls.length, 1);
  assert.ok(policy.sitemapUrls[0].endsWith("/sitemap.xml"));
});

test("respectRobots=false disables fetching entirely", async () => {
  const policy = await loadRobotsPolicy(mockOrigin, false, { timeoutMs: 5000 });
  assert.equal(policy.status, "disabled");
  assert.equal(isAllowedByRobots(policy, "/site/disallowed"), true);
});

test("a genuinely missing robots.txt (404) means everything is allowed", async () => {
  const express = (await import("express")).default;
  const bareApp = express();
  const bareServer = bareApp.listen(0);
  await new Promise((r) => bareServer.once("listening", r));
  const barePort = (bareServer.address() as any).port;
  try {
    const policy = await loadRobotsPolicy(`http://localhost:${barePort}`, true, { timeoutMs: 5000 });
    assert.equal(policy.status, "missing");
    assert.equal(isAllowedByRobots(policy, "/anything"), true);
  } finally {
    await new Promise((r) => bareServer.close(r));
  }
});

test("an unreachable origin is treated conservatively (unavailable -> disallowed for non-seed URLs)", async () => {
  const policy = await loadRobotsPolicy("http://localhost:1", true, { timeoutMs: 500 });
  assert.equal(policy.status, "unavailable");
  assert.equal(isAllowedByRobots(policy, "/anything"), false);
});
