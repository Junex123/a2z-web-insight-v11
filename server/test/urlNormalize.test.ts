import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCacheKey } from "../src/cache/urlNormalize.js";

test("the same URL produces the same key", () => {
  const a = normalizeCacheKey("https://example.com/page", "mobile");
  const b = normalizeCacheKey("https://example.com/page", "mobile");
  assert.equal(a, b);
});

test("a trailing slash does not change the key", () => {
  const a = normalizeCacheKey("https://example.com/page", "mobile");
  const b = normalizeCacheKey("https://example.com/page/", "mobile");
  assert.equal(a, b);
});

test("hostname case does not change the key", () => {
  const a = normalizeCacheKey("https://Example.com/page", "mobile");
  const b = normalizeCacheKey("https://example.com/page", "mobile");
  assert.equal(a, b);
});

test("query parameter order does not change the key", () => {
  const a = normalizeCacheKey("https://example.com/page?b=2&a=1", "mobile");
  const b = normalizeCacheKey("https://example.com/page?a=1&b=2", "mobile");
  assert.equal(a, b);
});

test("an explicit default port does not change the key", () => {
  const a = normalizeCacheKey("https://example.com:443/page", "mobile");
  const b = normalizeCacheKey("https://example.com/page", "mobile");
  assert.equal(a, b);
});

test("a fragment does not change the key", () => {
  const a = normalizeCacheKey("https://example.com/page#section", "mobile");
  const b = normalizeCacheKey("https://example.com/page", "mobile");
  assert.equal(a, b);
});

test("different paths produce different keys", () => {
  const a = normalizeCacheKey("https://example.com/a", "mobile");
  const b = normalizeCacheKey("https://example.com/b", "mobile");
  assert.notEqual(a, b);
});

test("different hosts produce different keys", () => {
  const a = normalizeCacheKey("https://example.com/page", "mobile");
  const b = normalizeCacheKey("https://other.com/page", "mobile");
  assert.notEqual(a, b);
});

test("different query values produce different keys", () => {
  const a = normalizeCacheKey("https://example.com/page?id=1", "mobile");
  const b = normalizeCacheKey("https://example.com/page?id=2", "mobile");
  assert.notEqual(a, b);
});

test("mobile and desktop strategy produce different keys for the same URL", () => {
  const a = normalizeCacheKey("https://example.com/page", "mobile");
  const b = normalizeCacheKey("https://example.com/page", "desktop");
  assert.notEqual(a, b);
});

test("a non-default port is preserved and distinguishes the key", () => {
  const a = normalizeCacheKey("https://example.com:8443/page", "mobile");
  const b = normalizeCacheKey("https://example.com/page", "mobile");
  assert.notEqual(a, b);
});
