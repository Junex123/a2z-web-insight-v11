import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import {
  collectHttp,
  CollectorError,
  expandIPv6Groups,
  isPrivateIp,
  isPrivateIPv4,
  isPrivateIPv6,
  parseAndValidateUrl,
} from "../src/collectors/httpCollector.js";

// This file deliberately does NOT set ALLOW_LOCAL_TARGETS, so the real
// production SSRF guard is exercised throughout (except where a test is
// specifically about the dev-mode bypass).

// =====================================================================
// 1-8: direct range/parsing checks (fast, exhaustive, no network/DNS)
// =====================================================================

test("1. localhost is blocked (hostname pattern)", async () => {
  await assert.rejects(
    () => collectHttp("http://localhost:1/page"),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

test("2. 127.0.0.1 is blocked (IPv4 loopback)", () => {
  assert.equal(isPrivateIPv4("127.0.0.1"), true);
  assert.equal(isPrivateIPv4("127.255.255.254"), true);
});

test("3. 0.0.0.0 is blocked", () => {
  assert.equal(isPrivateIPv4("0.0.0.0"), true);
  assert.equal(isPrivateIPv4("0.1.2.3"), true); // whole 0.0.0.0/8 "this network" range
});

test("4. RFC1918 private IPv4 ranges are blocked", () => {
  assert.equal(isPrivateIPv4("10.0.0.1"), true);
  assert.equal(isPrivateIPv4("10.255.255.255"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isPrivateIPv4("172.31.255.255"), true);
  assert.equal(isPrivateIPv4("172.15.255.255"), false, "just outside 172.16.0.0/12");
  assert.equal(isPrivateIPv4("172.32.0.0"), false, "just outside 172.16.0.0/12");
  assert.equal(isPrivateIPv4("192.168.0.1"), true);
  assert.equal(isPrivateIPv4("192.168.255.255"), true);
  // sanity: real public addresses are NOT blocked
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("1.1.1.1"), false);
});

test("5. 169.254.0.0/16 link-local (incl. cloud metadata) is blocked", () => {
  assert.equal(isPrivateIPv4("169.254.169.254"), true, "cloud metadata endpoint");
  assert.equal(isPrivateIPv4("169.254.0.1"), true);
  assert.equal(isPrivateIPv4("169.254.255.255"), true);
  assert.equal(isPrivateIPv4("169.253.255.255"), false, "just outside the range");
});

test("6. IPv6 ::1 (loopback) is blocked", () => {
  assert.equal(isPrivateIPv6("::1"), true);
  assert.equal(isPrivateIPv6("0:0:0:0:0:0:0:1"), true, "fully-expanded form of ::1");
  assert.equal(isPrivateIPv6("::"), true, "unspecified address");
});

test("7. IPv6 ULA (fc00::/7) and link-local (fe80::/10) are blocked", () => {
  assert.equal(isPrivateIPv6("fc00::1"), true);
  assert.equal(isPrivateIPv6("fd12:3456:789a::1"), true, "fd.. is within fc00::/7");
  assert.equal(isPrivateIPv6("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), true, "top of the fc00::/7 range");
  assert.equal(isPrivateIPv6("fe00::1"), false, "just outside fc00::/7");
  assert.equal(isPrivateIPv6("fe80::1"), true);
  assert.equal(isPrivateIPv6("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), true, "top of fe80::/10");
  assert.equal(isPrivateIPv6("fec0::1"), true, "deprecated site-local, also blocked");
  assert.equal(isPrivateIPv6("ff02::1"), false, "multicast - not in our blocked set, sanity check");
  // sanity: a real public-range IPv6 address is NOT blocked
  assert.equal(isPrivateIPv6("2606:4700:4700::1111"), false); // Cloudflare DNS
});

test("8. IPv4-mapped IPv6 is blocked, in BOTH the dotted and canonical hex forms", () => {
  // Node's URL parser always canonicalizes the dotted form into hex
  // groups (verified empirically: `[::ffff:127.0.0.1]` -> hostname
  // `[::ffff:7f00:1]`), so both representations must be recognized.
  assert.equal(isPrivateIPv6("::ffff:127.0.0.1"), true, "dotted-decimal tail form");
  assert.equal(isPrivateIPv6("::ffff:7f00:1"), true, "canonical hex-group form - what url.hostname actually produces");
  assert.equal(isPrivateIPv6("::ffff:169.254.169.254"), true, "mapped cloud metadata address");
  assert.equal(isPrivateIPv6("::ffff:a9fe:a9fe"), true, "hex form of the mapped metadata address");
  assert.equal(isPrivateIPv6("::ffff:8.8.8.8"), false, "a mapped PUBLIC address must not be blocked");
  assert.equal(isPrivateIPv6("::ffff:808:808"), false, "hex form of the mapped public address");
});

test("IPv4-compatible (deprecated) embedded-IPv4 IPv6 form is blocked", () => {
  assert.equal(isPrivateIPv6("::127.0.0.1"), true, "dotted deprecated-compatible form");
  assert.equal(isPrivateIPv6("::7f00:1"), true, "hex form - what url.hostname actually produces");
});

test("NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embedded-IPv4 forms are blocked when the embedded address is private", () => {
  assert.equal(isPrivateIPv6("64:ff9b::127.0.0.1"), true);
  assert.equal(isPrivateIPv6("64:ff9b::7f00:1"), true, "hex form");
  assert.equal(isPrivateIPv6("2002:7f00:1::"), true, "6to4 embedding 127.0.0.1");
  assert.equal(isPrivateIPv6("2002:808:808::"), false, "6to4 embedding a public address must not be blocked");
});

test("expandIPv6Groups correctly parses compressed, full, and mixed-case forms", () => {
  assert.deepEqual(expandIPv6Groups("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6Groups("FC00::1"), [0xfc00, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6Groups("2001:db8::1"), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  assert.equal(expandIPv6Groups("not-an-address"), null);
  assert.equal(expandIPv6Groups("1:2:3:4:5:6:7:8:9"), null, "too many groups");
});

test("isPrivateIp dispatches correctly between IPv4 and IPv6", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

// =====================================================================
// 15: obfuscated IP literals that Node's URL parser normalizes
// =====================================================================

test("15. obfuscated IPv4 literals that Node's URL parser canonicalizes are still blocked", async () => {
  // Node/WHATWG's URL host parser canonicalizes ALL of these into plain
  // dotted-decimal before our code ever sees `url.hostname` (verified
  // empirically), so the existing dotted-decimal range check already
  // covers them - this test proves that end-to-end rather than assuming it.
  const obfuscatedLoopback = [
    "http://0x7f000001/", // hex, single 32-bit integer
    "http://0177.0.0.1/", // octal first octet
    "http://2130706433/", // decimal 32-bit integer
    "http://127.1/", // short form (127.0.0.1)
    "http://0x7f.0.0.1/", // hex first octet only
  ];
  for (const url of obfuscatedLoopback) {
    const parsed = parseAndValidateUrl(url);
    assert.equal(parsed.hostname, "127.0.0.1", `${url} should normalize to 127.0.0.1`);
    await assert.rejects(
      () => collectHttp(url),
      (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
      `${url} should be blocked`,
    );
  }
});

test("15. bare '0' normalizes to 0.0.0.0 and is blocked", async () => {
  const parsed = parseAndValidateUrl("http://0/");
  assert.equal(parsed.hostname, "0.0.0.0");
  await assert.rejects(
    () => collectHttp("http://0/"),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

test("15. obfuscated IPv6-bracketed loopback/metadata forms are blocked end-to-end", async () => {
  const obfuscated = [
    "http://[::ffff:127.0.0.1]/", // IPv4-mapped, dotted input
    "http://[0:0:0:0:0:ffff:127.0.0.1]/", // fully expanded + dotted tail
    "http://[::127.0.0.1]/", // deprecated IPv4-compatible form
    "http://[::ffff:169.254.169.254]/", // mapped cloud metadata address
  ];
  for (const url of obfuscated) {
    await assert.rejects(
      () => collectHttp(url),
      (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
      `${url} should be blocked`,
    );
  }
});

test("15. a hostname that merely CONTAINS a private-IP-looking label (e.g. a wildcard-DNS style host) is judged by DNS resolution, not the literal string", async () => {
  // "169.254.169.254.nip.io"-style hosts are real services that resolve
  // the embedded IP; the guard correctly does NOT try to pattern-match
  // this as a hostname string (that would be both fragile and
  // incomplete) - it relies on the DNS-resolution layer, which the
  // fake resolver here stands in for.
  const fakeDnsLookup = (async () => [{ address: "169.254.169.254", family: 4 }]) as any;
  await assert.rejects(
    () => collectHttp("http://169.254.169.254.nip.io/", { dnsLookupFn: fakeDnsLookup }),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

// =====================================================================
// 9-11: DNS-resolution-based checks
// =====================================================================

test("9. a public-looking hostname that resolves to a private IP is blocked (DNS rebinding)", async () => {
  const fakeDnsLookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as any;
  await assert.rejects(
    () => collectHttp("http://not-obviously-internal.example", { dnsLookupFn: fakeDnsLookup }),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

test("10. a DNS resolution failure produces DNS_ERROR, not a crash", async () => {
  const failingDnsLookup = (async () => {
    throw new Error("ENOTFOUND");
  }) as any;
  await assert.rejects(
    () => collectHttp("http://this-domain-does-not-exist.invalid", { dnsLookupFn: failingDnsLookup }),
    (err: unknown) => err instanceof CollectorError && err.code === "DNS_ERROR",
  );
});

test("11. multiple DNS answers where only ONE is private are still blocked", async () => {
  const mixedDnsLookup = (async () => [
    { address: "203.0.113.10", family: 4 }, // public (TEST-NET-3)
    { address: "8.8.8.8", family: 4 }, // public
    { address: "10.0.0.5", family: 4 }, // private - must be caught even though it's not the only answer
  ]) as any;
  await assert.rejects(
    () => collectHttp("http://multi-answer.example", { dnsLookupFn: mixedDnsLookup }),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

test("11. multiple DNS answers that are ALL public are allowed through the guard", async () => {
  const allPublicDnsLookup = (async () => [
    { address: "203.0.113.10", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ]) as any;
  // We don't need the request to actually succeed (203.0.113.10 isn't
  // reachable from here) - we just need to prove it get PAST the guard,
  // i.e. it fails with a network/timeout error, never BLOCKED_HOST.
  await assert.rejects(
    () => collectHttp("http://all-public.example", { dnsLookupFn: allPublicDnsLookup, timeoutMs: 500 }),
    (err: unknown) => err instanceof CollectorError && err.code !== "BLOCKED_HOST",
  );
});

// =====================================================================
// 12-14, 16: redirect handling - exercising the ACTUAL collector loop
// =====================================================================

test("12. a redirect from an allowed target to a blocked target is rejected, via the real redirect loop", async () => {
  // Real local server, real HTTP round trip, real redirect Location
  // header - this exercises collectHttp's actual manual-redirect loop,
  // not just the SSRF helper in isolation.
  let hop1WasHit = false;
  const app = express();
  app.get("/start", (_req, res) => {
    hop1WasHit = true;
    res.redirect(302, "http://internal-service.example/secret");
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  // `testBypassHosts` is the narrow, test-only escape hatch (see
  // CollectHttpOptions) that lets hop 1 - our own real loopback test
  // server - pass the guard, WITHOUT using ALLOW_LOCAL_TARGETS (which
  // would blanket-disable the guard for every hop, including the one
  // we're actually testing). The redirect target,
  // "internal-service.example", is deliberately NOT in the bypass set,
  // so it is judged by the real, unmodified guard - via the injected
  // DNS resolver, which truthfully reports it as resolving to a
  // private address.
  const fakeDnsLookup = (async (hostname: string) => {
    if (hostname === "internal-service.example") return [{ address: "127.0.0.1", family: 4 }];
    throw new Error(`unexpected DNS lookup for ${hostname}`);
  }) as any;

  try {
    await assert.rejects(
      () =>
        collectHttp(`http://127.0.0.1:${port}/start`, {
          dnsLookupFn: fakeDnsLookup,
          testBypassHosts: new Set(["127.0.0.1"]),
        }),
      (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
    );
    assert.equal(hop1WasHit, true, "the initial hop must have actually been fetched over real HTTP before the redirect was blocked");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("13. multiple legitimate redirect hops are all followed successfully", async () => {
  const app = express();
  app.get("/hop0", (_req, res) => res.redirect(302, "/hop1"));
  app.get("/hop1", (_req, res) => res.redirect(302, "/hop2"));
  app.get("/hop2", (_req, res) => res.type("html").send("<html><body>final destination</body></html>"));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    const result = await collectHttp(`http://127.0.0.1:${port}/hop0`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.redirectCount, 2);
    assert.equal(result.redirected, true);
    assert.ok(result.finalUrl.endsWith("/hop2"));
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("13/16. more than 5 redirect hops is rejected as unreachable rather than looping forever", async () => {
  const app = express();
  for (let i = 0; i < 8; i++) {
    app.get(`/hop${i}`, (_req, res) => res.redirect(302, `/hop${i + 1}`));
  }
  app.get("/hop8", (_req, res) => res.type("html").send("<html><body>ok</body></html>"));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    await assert.rejects(
      () => collectHttp(`http://127.0.0.1:${port}/hop0`),
      (err: unknown) => err instanceof CollectorError && err.code === "TARGET_UNREACHABLE",
    );
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("16. exactly 5 redirect hops (the limit) succeeds; 6 fails", async () => {
  const app = express();
  for (let i = 0; i < 5; i++) {
    app.get(`/limit5_hop${i}`, (_req, res) => res.redirect(302, `/limit5_hop${i + 1}`));
  }
  app.get("/limit5_hop5", (_req, res) => res.type("html").send("<html><body>ok</body></html>"));

  for (let i = 0; i < 6; i++) {
    app.get(`/limit6_hop${i}`, (_req, res) => res.redirect(302, `/limit6_hop${i + 1}`));
  }
  app.get("/limit6_hop6", (_req, res) => res.type("html").send("<html><body>ok</body></html>"));

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    const ok = await collectHttp(`http://127.0.0.1:${port}/limit5_hop0`);
    assert.equal(ok.redirectCount, 5);

    await assert.rejects(
      () => collectHttp(`http://127.0.0.1:${port}/limit6_hop0`),
      (err: unknown) => err instanceof CollectorError && err.code === "TARGET_UNREACHABLE",
    );
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("14. a redirect to a non-http(s) URL is rejected, via the real redirect loop", async () => {
  const app = express();
  app.get("/start", (_req, res) => {
    // Set the Location header directly - Express's res.redirect() helper
    // is bypassed so we can send a scheme it might otherwise normalize.
    res.status(302).set("Location", "ftp://internal.example/secret").end();
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    await assert.rejects(
      () => collectHttp(`http://127.0.0.1:${port}/start`),
      (err: unknown) => err instanceof CollectorError && err.code === "INVALID_URL",
    );
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("14. a redirect to a javascript: URL is rejected", async () => {
  const app = express();
  app.get("/start", (_req, res) => {
    res.status(302).set("Location", "javascript:alert(1)").end();
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    await assert.rejects(
      () => collectHttp(`http://127.0.0.1:${port}/start`),
      (err: unknown) => err instanceof CollectorError && err.code === "INVALID_URL",
    );
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

// =====================================================================
// 17: dev-mode bypass, and basic input validation
// =====================================================================

test("17. ALLOW_LOCAL_TARGETS=true bypasses the guard end-to-end, including across a real redirect - for local development only", async () => {
  const app = express();
  app.get("/start", (_req, res) => res.redirect(302, "/finish"));
  app.get("/finish", (_req, res) => res.type("html").send("<html><body>ok</body></html>"));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    const result = await collectHttp(`http://127.0.0.1:${port}/start`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.redirectCount, 1);
    assert.equal(result.redirected, true);
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await new Promise((r) => server.close(r));
  }
});

test("17. ALLOW_LOCAL_TARGETS is off by default (the guard is active unless explicitly opted out)", async () => {
  assert.notEqual(process.env.ALLOW_LOCAL_TARGETS, "true");
  await assert.rejects(
    () => collectHttp("http://127.0.0.1/page"),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

test("rejects an unsupported protocol", () => {
  assert.throws(
    () => parseAndValidateUrl("ftp://example.com/file"),
    (err: unknown) => err instanceof CollectorError && err.code === "INVALID_URL",
  );
});

test("rejects a malformed URL", () => {
  assert.throws(
    () => parseAndValidateUrl("not a url at all"),
    (err: unknown) => err instanceof CollectorError && err.code === "INVALID_URL",
  );
});
