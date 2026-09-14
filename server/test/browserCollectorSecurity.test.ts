// This file deliberately does NOT set ALLOW_LOCAL_TARGETS, so the real
// production SSRF guard is exercised throughout - mirroring
// httpCollectorSecurity.test.ts exactly. Requires `npx playwright
// install chromium` (see README.md).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createMockApp } from "../mock-site/app.js";
import { collectRuntime, runBrowserVerification } from "../src/collectors/browserCollector.js";
import { closeSharedBrowser } from "../src/browser/browserManager.js";
import { CollectorError } from "../src/collectors/httpCollector.js";

let server: Server;
let base: string;
let port: number;

before(async () => {
  const app = createMockApp();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await closeSharedBrowser();
  await new Promise((r) => server.close(r));
});

test("the guard rejects an obviously-blocked target before ever launching the browser", async () => {
  await assert.rejects(
    () => collectRuntime("http://127.0.0.1/anything"),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

// =====================================================================
// 9. redirect to a blocked/private destination
// =====================================================================

test("9. a same-origin navigation that redirects to a private target is blocked, via a real browser navigation", async () => {
  // "internal-service.example" is resolved via injected fake DNS to a
  // private address - a DISTINCT hostname from the real mock server
  // (127.0.0.1), so it doesn't collide with the testBypassHosts
  // exemption below. Mirrors httpCollectorSecurity.test.ts test 12
  // exactly.
  const fakeDnsLookup = (async (hostname: string) => {
    if (hostname === "internal-service.example") return [{ address: "127.0.0.1", family: 4 }];
    throw new Error(`unexpected DNS lookup for ${hostname}`);
  }) as any;

  await assert.rejects(
    () =>
      collectRuntime(`${base}/browser/redirect-to-blocked`, {
        dnsLookupFn: fakeDnsLookup,
        testBypassHosts: new Set(["127.0.0.1"]),
      }),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

test("runBrowserVerification reports a blocked redirect as status 'error', never a successful scan", async () => {
  const fakeDnsLookup = (async (hostname: string) => {
    if (hostname === "internal-service.example") return [{ address: "127.0.0.1", family: 4 }];
    throw new Error(`unexpected DNS lookup for ${hostname}`);
  }) as any;

  const report = await runBrowserVerification(`${base}/browser/redirect-to-blocked`, {
    dnsLookupFn: fakeDnsLookup,
    testBypassHosts: new Set(["127.0.0.1"]),
  });
  assert.equal(report.status, "error");
  assert.equal(report.errorCode, "BLOCKED_HOST");
  assert.equal(report.evidence, null);
});

// =====================================================================
// 10. multi-hop redirect security validation
// =====================================================================

test("10. a legitimate same-origin hop is followed, but the SECOND hop to a private target is blocked", async () => {
  const fakeDnsLookup = (async (hostname: string) => {
    if (hostname === "internal-service.example") return [{ address: "127.0.0.1", family: 4 }];
    throw new Error(`unexpected DNS lookup for ${hostname}`);
  }) as any;

  await assert.rejects(
    () =>
      collectRuntime(`${base}/browser/redirect-multi-hop`, {
        dnsLookupFn: fakeDnsLookup,
        testBypassHosts: new Set(["127.0.0.1"]),
      }),
    (err: unknown) => err instanceof CollectorError && err.code === "BLOCKED_HOST",
  );
});

// =====================================================================
// JS-initiated fetch/XHR SSRF - the risk that's specific to a real
// browser (see the module-level comment in browserCollector.ts): the
// page's OWN JavaScript, not just top-level navigation, must not be
// able to reach a blocked target.
// =====================================================================

test("a page whose JavaScript itself fetch()es a private address has that request blocked, not just navigation", async () => {
  const app = createMockApp();
  app.get("/js-ssrf-attempt", (_req, res) => {
    res.type("html").send(
      `<!DOCTYPE html><html><body><div id="result">pending</div><script>
        fetch("http://internal-service.example/secret")
          .then((r) => r.text())
          .then((t) => { document.getElementById("result").textContent = t; })
          .catch((e) => { document.getElementById("result").textContent = "fetch failed: " + e.message; });
      </script></body></html>`,
    );
  });
  const jsSsrfServer = app.listen(0);
  await new Promise((r) => jsSsrfServer.once("listening", r));
  const jsSsrfPort = (jsSsrfServer.address() as any).port;

  const fakeDnsLookup = (async (hostname: string) => {
    if (hostname === "internal-service.example") return [{ address: "127.0.0.1", family: 4 }];
    throw new Error(`unexpected DNS lookup for ${hostname}`);
  }) as any;

  try {
    const evidence = await collectRuntime(`http://127.0.0.1:${jsSsrfPort}/js-ssrf-attempt`, {
      dnsLookupFn: fakeDnsLookup,
      testBypassHosts: new Set(["127.0.0.1"]),
      settleMs: 500, // give the page's own fetch() time to resolve/fail
    });
    const blockedRequest = evidence.requests.find((r) => r.url.includes("internal-service.example"));
    assert.ok(blockedRequest, "the page's own fetch() to the private address should still be recorded");
    assert.equal(blockedRequest!.outcome, "failed");
    // and crucially: the blocked response must never have reached the page's own DOM
    assert.doesNotMatch(evidence.domSnapshot.visibleTextSample, /secret/i);
  } finally {
    await new Promise((r) => jsSsrfServer.close(r));
  }
});

test("ALLOW_LOCAL_TARGETS=true bypasses the guard end-to-end for the browser layer too - for local development only", async () => {
  process.env.ALLOW_LOCAL_TARGETS = "true";
  try {
    // Deliberately just a same-origin mock-site page (127.0.0.1) with no
    // testBypassHosts - proving the env var alone is what unlocks it.
    // (redirect-to-blocked/redirect-multi-hop are NOT used here: their
    // final hop is "internal-service.example", a domain that only our
    // OWN injected fake DNS resolver knows how to resolve - with the
    // guard bypassed entirely, that fake resolver is never consulted,
    // and Chromium's real DNS would correctly fail to resolve it, which
    // would test the wrong thing.)
    const evidence = await collectRuntime(`${base}/browser/js-ok`);
    assert.equal(evidence.navigationOk, true);
  } finally {
    delete process.env.ALLOW_LOCAL_TARGETS;
  }
});
