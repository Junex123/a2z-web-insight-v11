// These tests launch a REAL headless Chromium via Playwright against the
// local mock-site (see mock-site/app.ts's /browser/* routes) - no
// external network access is used. Requires `npx playwright install
// chromium` to have been run (see README.md "Runtime/browser
// verification"). Security-specific (SSRF/redirect) scenarios live in
// browserCollectorSecurity.test.ts, mirroring how httpCollector.ts's
// tests are split from httpCollectorSecurity.test.ts.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createMockApp } from "../mock-site/app.js";
import { collectRuntime, runBrowserVerification } from "../src/collectors/browserCollector.js";
import { closeSharedBrowser } from "../src/browser/browserManager.js";
import { CollectorError } from "../src/collectors/httpCollector.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let server: Server;
let base: string;

before(async () => {
  const app = createMockApp();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  delete process.env.ALLOW_LOCAL_TARGETS;
  await closeSharedBrowser();
  await new Promise((r) => server.close(r));
});

// ---------------------------------------------------------------------
// 1. clean JavaScript page
// ---------------------------------------------------------------------

test("1. a clean JS page navigates successfully with no errors and real rendered content", async () => {
  const evidence = await collectRuntime(`${base}/browser/js-ok`);
  assert.equal(evidence.navigationOk, true);
  assert.equal(evidence.httpStatus, 200);
  assert.deepEqual(evidence.jsErrors, []);
  assert.equal(evidence.domSnapshot.hasBodyContent, true);
  assert.match(evidence.domSnapshot.visibleTextSample, /Loaded via JavaScript/);
  assert.equal(evidence.engine, "chromium");
});

// ---------------------------------------------------------------------
// 2. JavaScript exception
// ---------------------------------------------------------------------

test("2. an uncaught JS exception is captured as a pageerror", async () => {
  const evidence = await collectRuntime(`${base}/browser/js-error`);
  const uncaught = evidence.jsErrors.filter((e) => e.source === "pageerror");
  assert.ok(uncaught.length >= 1, "expected at least one uncaught pageerror");
  assert.match(uncaught[0].message, /thisFunctionDoesNotExist/);
});

test("runBrowserVerification turns a JS exception into a critical finding", async () => {
  const report = await runBrowserVerification(`${base}/browser/js-error`);
  assert.equal(report.status, "completed");
  const finding = report.findings.find((f) => /Uncaught JavaScript error/.test(f.title));
  assert.ok(finding);
  assert.equal(finding!.severity, "critical");
});

// ---------------------------------------------------------------------
// 3. console error
// ---------------------------------------------------------------------

test("3. a console.error call is captured as a console message AND as a jsError", async () => {
  const evidence = await collectRuntime(`${base}/browser/console-error`);
  const consoleErrors = evidence.consoleMessages.filter((m) => m.level === "error");
  assert.ok(consoleErrors.some((m) => m.text.includes("deliberate test console error")));
  const jsErrorFromConsole = evidence.jsErrors.filter((e) => e.source === "console-error");
  assert.ok(jsErrorFromConsole.length >= 1);
});

// ---------------------------------------------------------------------
// 4. failed first-party resource
// ---------------------------------------------------------------------

test("4. a broken first-party script shows up as a failed, first-party request", async () => {
  const evidence = await collectRuntime(`${base}/browser/first-party-fail`);
  const failed = evidence.requests.find((r) => r.url.includes("/browser/missing.js"));
  assert.ok(failed, "the missing script should be recorded");
  assert.equal(failed!.isFirstParty, true);
  assert.equal(failed!.outcome, "failed");
});

// ---------------------------------------------------------------------
// 5. failed third-party resource
// ---------------------------------------------------------------------

test("5. a broken third-party image is recorded as failed and NOT first-party", async () => {
  const evidence = await collectRuntime(`${base}/browser/third-party-fail`);
  const failed = evidence.requests.find((r) => r.url.includes("third-party-cdn.invalid"));
  assert.ok(failed, "the broken third-party image should be recorded");
  assert.equal(failed!.isFirstParty, false);
  assert.equal(failed!.outcome, "failed");
});

test("third-party failures never produce a finding via the full runBrowserVerification wrapper", async () => {
  const report = await runBrowserVerification(`${base}/browser/third-party-fail`);
  assert.equal(report.status, "completed");
  assert.deepEqual(
    report.findings.filter((f) => /First-party/.test(f.title)),
    [],
  );
});

// ---------------------------------------------------------------------
// 6. JavaScript-generated content
// ---------------------------------------------------------------------

test("6. sparse raw HTML that JS successfully populates is flagged as likely-JS-dependent, not blank", async () => {
  const rawHtml = `<html><head></head><body><div id="app"></div></body></html>`;
  const evidence = await collectRuntime(`${base}/browser/js-generated-content`, { rawHtmlForComparison: rawHtml });
  assert.equal(evidence.domSnapshot.hasBodyContent, true);
  assert.ok(evidence.contentComparison);
  assert.equal(evidence.contentComparison!.likelyJsDependentContent, true);
  assert.match(evidence.domSnapshot.visibleTextSample, /Real content, rendered by JavaScript/);
});

// ---------------------------------------------------------------------
// 7. blank rendered page
// ---------------------------------------------------------------------

test("7. a page whose mount script 404s stays blank after rendering", async () => {
  const evidence = await collectRuntime(`${base}/browser/js-blank`);
  assert.equal(evidence.domSnapshot.hasBodyContent, false);
});

test("runBrowserVerification turns a blank render into a critical finding", async () => {
  const report = await runBrowserVerification(`${base}/browser/js-blank`);
  assert.equal(report.status, "completed");
  const finding = report.findings.find((f) => /renders blank/.test(f.title));
  assert.ok(finding);
  assert.equal(finding!.severity, "critical");
});

// ---------------------------------------------------------------------
// 8. browser navigation timeout
// ---------------------------------------------------------------------

test("8. navigation to a slow-responding page times out cleanly as BROWSER_TIMEOUT", async () => {
  await assert.rejects(
    () => collectRuntime(`${base}/browser/slow-response`, { timeoutMs: 300 }),
    (err: unknown) => err instanceof CollectorError && err.code === "BROWSER_TIMEOUT",
  );
});

test("runBrowserVerification reports a timeout as status 'error' instead of throwing", async () => {
  const report = await runBrowserVerification(`${base}/browser/slow-response`, { timeoutMs: 300 });
  assert.equal(report.status, "error");
  assert.equal(report.errorCode, "BROWSER_TIMEOUT");
  assert.equal(report.evidence, null);
  assert.deepEqual(report.findings, []);
});

// ---------------------------------------------------------------------
// 12. non-HTTP navigation is rejected before ever touching the browser
// ---------------------------------------------------------------------

test("12. a non-http(s) URL is rejected as INVALID_URL without launching the browser", async () => {
  await assert.rejects(
    () => collectRuntime("ftp://example.test/file"),
    (err: unknown) => err instanceof CollectorError && err.code === "INVALID_URL",
  );
});

// ---------------------------------------------------------------------
// 13. screenshot generation
// ---------------------------------------------------------------------

test("13. screenshot capture, when enabled, produces a valid base64 PNG", async () => {
  const evidence = await collectRuntime(`${base}/browser/js-ok`, { screenshot: true, viewport: { width: 320, height: 240 } });
  assert.ok(evidence.screenshot);
  assert.equal(evidence.screenshot!.enabled, true);
  assert.ok(evidence.screenshot!.base64Png, "expected screenshot bytes");
  const buf = Buffer.from(evidence.screenshot!.base64Png!, "base64");
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual(buf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.deepEqual(evidence.screenshot!.viewport, { width: 320, height: 240 });
});

test("screenshot is disabled by default", async () => {
  const evidence = await collectRuntime(`${base}/browser/js-ok`);
  assert.equal(evidence.screenshot!.enabled, false);
  assert.equal(evidence.screenshot!.base64Png, undefined);
});

// ---------------------------------------------------------------------
// 14. cleanup after failure - the shared browser process itself must
// survive a per-scan failure and remain usable for the next scan.
// ---------------------------------------------------------------------

test("14. after a scan fails (timeout), a subsequent scan still succeeds - no orphaned/broken browser state", async () => {
  await assert.rejects(() => collectRuntime(`${base}/browser/slow-response`, { timeoutMs: 300 }));

  const evidence = await collectRuntime(`${base}/browser/js-ok`);
  assert.equal(evidence.navigationOk, true);
});

// ---------------------------------------------------------------------
// Forms - static detection only, never submitted
// ---------------------------------------------------------------------

test("forms are detected with their action/method, without ever being submitted", async () => {
  const evidence = await collectRuntime(`${base}/browser/form-page`);
  assert.equal(evidence.forms.length, 2);
  const safe = evidence.forms.find((f) => f.action?.endsWith("/submit"));
  assert.ok(safe);
  assert.equal(safe!.method, "post");
  assert.equal(safe!.hasSubmitControl, true);
  // the mock site is served over plain http, so isHttpsPage is false and
  // actionIsInsecureHttp is correctly never true here - the *insecure*
  // classification itself is covered by runtimeFindings.test.ts against
  // a hand-built https evidence object, since this local fixture can't
  // serve TLS.
  for (const f of evidence.forms) {
    assert.equal(f.isHttpsPage, false);
    assert.equal(f.actionIsInsecureHttp, false);
  }
});

// ---------------------------------------------------------------------
// Recording caps - overridable via options so the boundary itself is
// testable without spinning up hundreds of real resources.
// ---------------------------------------------------------------------

test("maxRequestsRecorded caps the number of recorded requests", async () => {
  const evidence = await collectRuntime(`${base}/browser/form-page`, { maxRequestsRecorded: 1 });
  assert.ok(evidence.requests.length <= 1);
});

// ---------------------------------------------------------------------
// BROWSER_LAUNCH_FAILED - simulated via an injected launchFn, mirroring
// how httpCollectorSecurity.test.ts injects a fake dnsLookupFn rather
// than needing a real broken DNS server.
// ---------------------------------------------------------------------

test("a launch failure is reported as BROWSER_LAUNCH_FAILED", async () => {
  // Force a fresh launch attempt - by this point in the file the shared
  // browser is already connected from earlier tests, and getSharedBrowser()
  // correctly reuses it without even calling launchFn, which would make
  // this test pass vacuously. Closing it first is what actually exercises
  // the injected failing launchFn.
  await closeSharedBrowser();
  const failingLaunch = async (): Promise<never> => {
    throw new Error("simulated Chromium launch failure");
  };
  await assert.rejects(
    () => collectRuntime(`${base}/browser/js-ok`, { launchFn: failingLaunch }),
    (err: unknown) => err instanceof CollectorError && err.code === "BROWSER_LAUNCH_FAILED",
  );
});

test("runBrowserVerification reports a launch failure as status 'error', never as a successful scan", async () => {
  await closeSharedBrowser(); // see comment above
  const failingLaunch = async (): Promise<never> => {
    throw new Error("simulated Chromium launch failure");
  };
  const report = await runBrowserVerification(`${base}/browser/js-ok`, { launchFn: failingLaunch });
  assert.equal(report.status, "error");
  assert.equal(report.errorCode, "BROWSER_LAUNCH_FAILED");
});
