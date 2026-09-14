import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import https from "node:https";
import express from "express";
import { collectSecurity } from "../src/collectors/securityCollector.js";
import type { FetchResult } from "../src/types.js";

/**
 * These tests exercise collectSecurity's REAL network probes (CORS
 * reflection check, information-disclosure path checks, source-map
 * detection) against a real local Express server, through the exact
 * same SSRF guard as every other request this app makes - via
 * `testBypassHosts`, the same narrow test-only escape hatch used by
 * httpCollectorSecurity.test.ts, rather than the blanket
 * ALLOW_LOCAL_TARGETS bypass (keeping the guard itself meaningfully
 * exercised even in this file).
 */

// A static, pre-generated, long-lived (10 year) self-signed cert/key for
// 127.0.0.1/localhost - embedded directly rather than generated at test
// time via the `openssl` CLI, so these tests don't depend on openssl
// being installed in whatever environment actually runs them. This
// certificate is used ONLY for a local loopback test server and is not
// a secret (it's checked into the test file itself), so there is
// nothing to redact here - it is not the kind of "secret" this
// project's redaction rules are about.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUVaFYBYOPrPgBzrKMn9py35tpz0IwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgyMzA5NTExMVoXDTM2MDgy
MDA5NTExMVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEArfw9j+xpUaznjIeXo7nlsy4Qwig4eiRTpWfZMGUuSwfi
WPajMg79oNwwcn55mRWD88/nRRpRolRkndn4cQwqinRkeD6+zDNdrXHKYvcwIDkT
uaPf2RdQ+dmlBj9x8AQnUDhHB6RkqSNjvJtPRhwa8F03fwGbldw2mCbZcs4QL51+
Z7vyFmpsAq/M7cm/lXaQ5r/HaGK4XvagZn671cBG/dhKTjn73WAozO38au4AxKqB
5SkBZDKplJE8oMDeUaWzD5DJ4vswoL4hRj0Vm5KzYAQBQ13ZDfAlrdCMK8SEQrQA
nQqlCpLkw4UDsdh6IOefjlWSEI111BqyE1uH51tu/QIDAQABo28wbTAdBgNVHQ4E
FgQUCZ6sWqe8QySxiXHhqFcb0o0O1dAwHwYDVR0jBBgwFoAUCZ6sWqe8QySxiXHh
qFcb0o0O1dAwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAKnWGbM1KK1RkDXzc8Dk+wAx+dQab1Z+
Wv4kuPa7j3emEHUXnzL9I7Dq4j3/MnZf5TlpaP3grY33/cBk+zNddvBEIcE5/rqt
zbtarfPeEOHYPu+dqvEuORpPhzWD4Lml3NaecKLEqJvB5nXBI1X/2cDXw6u0KfSI
5IY6chq7QquhrrksOsWfjkt4lEH4i/b1TNwOLeEpPkhLuatXJ0cGFlSvkfPGvMS6
+mQPWRRHwlmno03cDRZqRLlqM9r3+Pt5/O3nnLO4EUIahEr28o8ZgMPJ0D1sA/hd
P5kovz0fda/rPyAqlxpO/SkSUJlJOLD8ujKXBH4d1h57eOXkH4wTeOo=
-----END CERTIFICATE-----`;
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCt/D2P7GlRrOeM
h5ejueWzLhDCKDh6JFOlZ9kwZS5LB+JY9qMyDv2g3DByfnmZFYPzz+dFGlGiVGSd
2fhxDCqKdGR4Pr7MM12tccpi9zAgORO5o9/ZF1D52aUGP3HwBCdQOEcHpGSpI2O8
m09GHBrwXTd/AZuV3DaYJtlyzhAvnX5nu/IWamwCr8ztyb+VdpDmv8doYrhe9qBm
frvVwEb92EpOOfvdYCjM7fxq7gDEqoHlKQFkMqmUkTygwN5RpbMPkMni+zCgviFG
PRWbkrNgBAFDXdkN8CWt0IwrxIRCtACdCqUKkuTDhQOx2Hog55+OVZIQjXXUGrIT
W4fnW279AgMBAAECggEAD6So0lpyw720mf2NBFMQFJK1PgfIwC6o+KvEKuZGCcf9
MXuHg9Y2NrLlhj3Z6Ao3sYHFbQCnS12kKE8zV9K8tnMtn2Qg2pJZv2EGTeykvpjz
LZNO6qF+jeBkRpIIyAhPkpZkyIqe5FhCvPAH6ilXwLnY5gn6d7hzji2cCob9jJJJ
4rM7ny4h2o+7zMkwWugHlaMOljri86Zo2GuirPAPKODM8iC88F8wm1WqJy9Y/FBy
DfZtFLD7ytIZcZysw/xa1cKgodjOkeeDKYDslJ5dSppQFivx11n9QeUZ7SXtgZyX
BHDUzKnzywG+/HcgfzlO14KHo6Chsjq2psf5BRmSgQKBgQDq2Y5p9vqAPHfgTTaF
SCx69ct9V565oGyGOSMrmOuCANJCE5Jd4SJ1g1+MsIZgzTSSGSXASF+nyXUGtRUM
LXVnN13Au9GrxW35THsCD0GXLPJIFRMUAPgBi+vx/EQO8fm5kM4F45hDRvHZdGMl
dOz8jcwvxWFc+VQPzW5dV6jFPQKBgQC9p3UuLHAdcf8VHgBgmDck4QwWZZfeZdo3
E1W81K7hk/QTRGwB8pcytesVZAOmf4MKhQY6emxNuN4z+mTWQvxor+JMO7be/vpZ
alecT7EP/iubv1qPuw+eU586cYtr4tRGFzaYF7gIClsqJN0OtcM9zgQAS+YogDf3
Kj8cvh1swQKBgGGzIAv1M0El5rjpZkUMQXTlzEHYsa+HjZ5JJth8RX1P2iii+8ES
Z8N7Y8Sjq0OaGsSssYfMk/65UHX530exoaXO4rHLcO6Es7uClanFrwO1LxXNrqIj
xQjfrMh+qdGN2NXZ59uLU0yptvM/9/8dJXnrg4ZcFqUXFGF+lOtADHYBAoGAYflg
T7olMRDy9bXJ/BymYCbiV6+kBQAY+trCMAqvTVlhfZKbOWZZNZlFGIfSWvEEgSq3
TP5xdLVMFQ4FiaqROoOiJD+0+P4/1nFZUSbaEaj8Xjk8T4QTTXdlioudut4zSwIy
8d9O8thmwB7LFA5SDlufNYgAHmwefVEVyYNtMAECgYEAmyuZsP/Fgrg9JEs7x7Sv
peOPxkabMHDzjOrIfg0xT5Q5oysv3sWiCEijnm/WEVsEe1UsY9MvPYtTLXu2NUHH
X2KkWXBbXSO0Mianr2UMpi0z3WsBzS60VDKRp4ZwRc9fTDR5snakLKLv1E21iryt
Y427A2EK6wwJx1yAjC5IFgs=
-----END PRIVATE KEY-----`;

// A second embedded self-signed cert, deliberately using a weak 1024-bit
// RSA key, to test the real "undersized key" evidence path end-to-end.
const WEAK_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIICIDCCAYmgAwIBAgIULL6Imco2Iwerexchcu6KjkhtIMQwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgyNDA0MTQ0OFoXDTM2MDgy
MTA0MTQ0OFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIGfMA0GCSqGSIb3DQEBAQUA
A4GNADCBiQKBgQCrqkyt6J402HiT+P0J+/miu+gbc4pgu/VpmRp2hYoGabeaAqc+
YoEDmXGyKOEyXosl3J+5v7efFv9HSjmxzycggUxeSaDeBMa/WdLBmAmf02qVnqy4
Ec3cS4wFG8+j7V9Cu/r7gYNGY+PlCdsYpkg3z03Ud5mAJpoeTeosgY2KWwIDAQAB
o28wbTAdBgNVHQ4EFgQUlc1DH0pb/YqC+noFSRLuBh35rO4wHwYDVR0jBBgwFoAU
lc1DH0pb/YqC+noFSRLuBh35rO4wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzAR
hwR/AAABgglsb2NhbGhvc3QwDQYJKoZIhvcNAQELBQADgYEAE++yTp4RstvkVRmR
djpHWuxkYPjEUwFHVoeW79jGGmk6iJxhb6BhoQthBydNNFcpRo7pcgOiwdixyota
BJVKNm1AWwpaVkcgYkx0H9B+4cW9h0PgHhwqi9opedbySGQwiMJwdJQPsmSFVbur
qooidZazp6DqNKQ8JCw5WfvkHGI=
-----END CERTIFICATE-----`;
const WEAK_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAKuqTK3onjTYeJP4
/Qn7+aK76BtzimC79WmZGnaFigZpt5oCpz5igQOZcbIo4TJeiyXcn7m/t58W/0dK
ObHPJyCBTF5JoN4Exr9Z0sGYCZ/TapWerLgRzdxLjAUbz6PtX0K7+vuBg0Zj4+UJ
2ximSDfPTdR3mYAmmh5N6iyBjYpbAgMBAAECgYB3TzReBne2iOE9DudnQg6dkPXf
5my9kMUfcH6Y83UbwewOiVuNm07JnqMLzSe/J0CUvwLwSZQoaQZhmPACadRpuoLB
Kc4nBLOfwBRxQujdd/OrIOA9D0OhaHPw2mKEz+q8u0bCJgQCSR3TaXd09ArZ3CR0
r88s31nVpefgQcFVQQJBANjVR+97Y7vFxAGG9GL7xMbaiFjeXo5vWgJJUvUl6S2e
MztM2WCuDt1FCVsNOk70UjDeZJrdsAP1s3IOR0TBkHsCQQDKrGGLEzwv431MtLbW
HW1s/WItAdOYTn4r7/aK+l/WgIqPO+0OjJEis6w+5KDivxrpKrwwuXic25eUyAyX
0fehAkA2CDfLwnig0vA73TBK9igb0VsGoir33WGVjkYA1ribaH+luEm24MjNdKWX
Ld2ozRMqIFD7kmCJLBHSSyKRTJa/AkAiC50DIMMOhFdrCDxicWUNVu8kAleKET1u
ogu3QuHQhZ1A/F8Q/5nty2LW2c8Q5+tcWbptMOrK5rRq4MQEyNehAkAYMCzM2aHe
6xNisutqcSRl6hmpKdSgeM2HQwaGtlP861RxxtOKw8V/YoKU08D02jVD+cGYW+1B
IZb/65vebxad
-----END PRIVATE KEY-----`;

let server: Server;
let port: number;
let httpsServer: https.Server;
let httpsPort: number;
let weakHttpsServer: https.Server;
let weakHttpsPort: number;

before(async () => {
  const app = express();

  // The "main page" - collectSecurity is given its bodyText directly
  // (see baseFetch below), so this route only needs to answer the CORS
  // probe collectSecurity sends to the page's own URL.
  app.get("/page", (req, res) => {
    const origin = req.header("origin");
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin); // deliberately reflects whatever Origin it's sent
      res.set("Access-Control-Allow-Credentials", "true");
    }
    res.type("html").send("<html><body>ok</body></html>");
  });

  app.get("/wildcard-page", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Credentials", "true"); // unsafe/contradictory combination on purpose
    res.type("html").send("<html><body>ok</body></html>");
  });

  app.get("/safe-cors-page", (_req, res) => {
    // no CORS headers at all
    res.type("html").send("<html><body>ok</body></html>");
  });

  app.get("/.env", (_req, res) => res.type("text/plain").send("SECRET_KEY=leaked-for-test-purposes"));
  app.get("/backup/", (_req, res) => res.type("html").send("<html><head><title>Index of /backup/</title></head><body>Index of /backup/</body></html>"));
  app.get("/uploads/", (_req, res) => res.status(404).send("not found")); // deliberately NOT a listing, to confirm it isn't falsely flagged
  app.get("/app.js.map", (_req, res) => res.type("application/json").send(JSON.stringify({ version: 3, sources: ["app.js"], mappings: "AAAA" })));

  app.get("/leaky.js", (_req, res) =>
    res.type("application/javascript").send(`
      const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';
      const API_BASE = "http://localhost:4000/api";
      function noop() {}
    `),
  );
  app.get("/clean.js", (_req, res) => res.type("application/javascript").send(`function add(a, b) { return a + b; }`));

  app.get("/risky-methods-page", (_req, res) => res.type("html").send("<html><body>ok</body></html>"));
  app.options("/risky-methods-page", (_req, res) => {
    res.set("Allow", "GET,HEAD,OPTIONS,TRACE");
    res.status(204).end();
  });

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;

  // A separate, minimal HTTPS server (not Express - collectSecurity's
  // TLS probe is a raw tls.connect(), not an HTTP request, so all it
  // needs is something to complete a TLS handshake) presenting the
  // embedded self-signed certificate above.
  httpsServer = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", () => resolve()));
  httpsPort = (httpsServer.address() as any).port;
 
  weakHttpsServer = https.createServer({ key: WEAK_TLS_KEY, cert: WEAK_TLS_CERT }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  await new Promise<void>((resolve) => weakHttpsServer.listen(0, "127.0.0.1", () => resolve()));
  weakHttpsPort = (weakHttpsServer.address() as any).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => httpsServer.close(r));
  await new Promise((r) => weakHttpsServer.close(r));
});

function baseFetch(path: string, bodyText: string): FetchResult {
  const url = `http://127.0.0.1:${port}${path}`;
  return {
    requestedUrl: url,
    finalUrl: url,
    statusCode: 200,
    httpsUsed: false,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 5, totalDownloadMs: 8 },
    headers: {},
    bodyBytes: bodyText.length,
    bodyText,
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
    setCookieHeaders: [],
    redirectChain: [url],
  };
}

const BYPASS = new Set(["127.0.0.1"]);

test("CORS: a server that reflects an arbitrary Origin is detected", async () => {
  const fetchResult = baseFetch("/page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.cors.probeStatus, "checked");
  assert.equal(security.cors.reflectsArbitraryOrigin, true);
});

test("CORS: wildcard + Allow-Credentials is detected", async () => {
  const fetchResult = baseFetch("/wildcard-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.cors.probeStatus, "checked");
  assert.equal(security.cors.wildcardWithCredentialsAttempt, true);
  assert.equal(security.cors.reflectsArbitraryOrigin, false);
});

test("CORS: a server with no CORS headers at all is reported cleanly", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.cors.probeStatus, "checked");
  assert.equal(security.cors.allowOriginHeader, null);
  assert.equal(security.cors.reflectsArbitraryOrigin, false);
  assert.equal(security.cors.wildcardWithCredentialsAttempt, false);
});

test("info disclosure: an accidentally-exposed .env file is detected", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.infoDisclosure.probeStatus, "checked");
  const finding = security.infoDisclosure.findings.find((f) => f.path === "/.env");
  assert.ok(finding, "expected /.env to be reported as exposed");
  assert.equal(finding!.statusCode, 200);
});

test("info disclosure: a real directory listing is detected", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  const finding = security.infoDisclosure.findings.find((f) => f.path === "/backup/");
  assert.ok(finding, "expected /backup/ directory listing to be reported");
});

test("info disclosure: a checked-but-404 directory path is NOT falsely flagged", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  const finding = security.infoDisclosure.findings.find((f) => f.path === "/uploads/");
  assert.equal(finding, undefined);
});

test("info disclosure: a source map for an observed same-origin script is detected", async () => {
  const fetchResult = baseFetch("/safe-cors-page", `<html><head><script src="/app.js"></script></head><body>hi</body></html>`);
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  const finding = security.infoDisclosure.findings.find((f) => f.path === "/app.js.map");
  assert.ok(finding, "expected the source map for /app.js to be detected");
});

test("info disclosure: a cross-origin script is never probed (same-origin only)", async () => {
  const fetchResult = baseFetch("/safe-cors-page", `<html><head><script src="https://cdn.example.com/lib.js"></script></head><body>hi</body></html>`);
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.ok(!security.infoDisclosure.findings.some((f) => f.path.includes("cdn.example.com")));
});

test("secret scanning: a real secret embedded in a same-origin script is detected AND redacted end-to-end", async () => {
  const fetchResult = baseFetch("/safe-cors-page", `<html><head><script src="/leaky.js"></script></head><body>hi</body></html>`);
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.secretExposure.probeStatus, "checked");
  const finding = security.secretExposure.findings.find((f) => f.patternName === "AWS Access Key ID");
  assert.ok(finding, "expected the AWS key in /leaky.js to be detected");
  assert.equal(finding!.location, "/leaky.js");
  assert.ok(!finding!.redactedPreview.includes("AKIAABCDEFGHIJKLMNOP"), "the raw secret must never appear anywhere in the result");
  // scannedLocations = 1 (the page HTML itself) + 1 (leaky.js)
  assert.equal(security.secretExposure.scannedLocations, 2);
});

test("dev URL scanning: a localhost reference in a same-origin script is detected", async () => {
  const fetchResult = baseFetch("/safe-cors-page", `<html><head><script src="/leaky.js"></script></head><body>hi</body></html>`);
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  const finding = security.devUrlExposure.findings.find((f) => f.kind === "localhost");
  assert.ok(finding, "expected the localhost reference in /leaky.js to be detected");
  assert.equal(finding!.url, "http://localhost:4000/api");
});

test("secret scanning: a clean same-origin script produces no findings for that location", async () => {
  const fetchResult = baseFetch("/safe-cors-page", `<html><head><script src="/clean.js"></script></head><body>hi</body></html>`);
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.deepEqual(security.secretExposure.findings, []);
  assert.deepEqual(security.devUrlExposure.findings, []);
  assert.equal(security.secretExposure.scannedLocations, 2);
});

test("verification summary: reflects real probe outcomes, never claims 'verified' for something that didn't run", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.verification.cors, "verified");
  assert.equal(security.verification.infoDisclosure, "verified");
  assert.equal(security.verification.secretExposure, "verified");
  // the page here is http, not https, so the http->https probe is genuinely not applicable
  assert.equal(security.verification.redirectSecurity, "not_applicable");
});

test("HTTP methods: a server advertising TRACE via its Allow header is detected", async () => {
  const fetchResult = baseFetch("/risky-methods-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.httpMethods.probeStatus, "checked");
  assert.ok(security.httpMethods.allowedMethods.includes("TRACE"));
  assert.deepEqual(security.httpMethods.riskyMethodsExposed, ["TRACE"]);
});

test("HTTP methods: a normal page with no explicit OPTIONS handler reports no risky methods", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.httpMethods.probeStatus, "checked");
  assert.deepEqual(security.httpMethods.riskyMethodsExposed, []);
});

function baseWeakHttpsFetch(bodyText: string): FetchResult {
  const url = `https://127.0.0.1:${weakHttpsPort}/`;
  return {
    requestedUrl: url,
    finalUrl: url,
    statusCode: 200,
    httpsUsed: true,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 5, totalDownloadMs: 8 },
    headers: {},
    bodyBytes: bodyText.length,
    bodyText,
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
    setCookieHeaders: [],
    redirectChain: [url],
  };
}

function baseHttpsFetch(bodyText: string): FetchResult {
  const url = `https://127.0.0.1:${httpsPort}/`;
  return {
    requestedUrl: url,
    finalUrl: url,
    statusCode: 200,
    httpsUsed: true,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 5, totalDownloadMs: 8 },
    headers: {},
    bodyBytes: bodyText.length,
    bodyText,
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
    setCookieHeaders: [],
    redirectChain: [url],
  };
}

test("TLS: a real handshake against a self-signed cert reports the exact validation failure", async () => {
  const fetchResult = baseHttpsFetch("<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.tlsCertificate.probeStatus, "checked");
  assert.equal(security.tlsCertificate.authorized, false);
  assert.equal(security.tlsCertificate.authorizationError, "DEPTH_ZERO_SELF_SIGNED_CERT");
  // a REAL negotiated protocol from a REAL handshake - not guessed
  assert.ok(security.tlsCertificate.protocol === "TLSv1.3" || security.tlsCertificate.protocol === "TLSv1.2");
  assert.ok(security.tlsCertificate.validTo, "expected a real certificate expiry date to be captured");
});

test("TLS: not applicable when the page itself is plain http", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.tlsCertificate.probeStatus, "not_applicable");
  assert.equal(security.verification.tlsCertificate, "not_applicable");
});

test("TLS: a blocked host degrades to 'blocked', never throws, never claims authorized", async () => {
  const fetchResult: FetchResult = {
    requestedUrl: "https://internal-service.example/",
    finalUrl: "https://internal-service.example/",
    statusCode: 200,
    httpsUsed: true,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 1, totalDownloadMs: 1 },
    headers: {},
    bodyBytes: 10,
    bodyText: "<html></html>",
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
  };
  const security = await collectSecurity(fetchResult); // no testBypassHosts - .example is unresolvable/blocked
  assert.ok(["blocked", "error"].includes(security.tlsCertificate.probeStatus));
  assert.equal(security.tlsCertificate.authorized, null);
});

test("CAA: records present is reported correctly via an injected resolver", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const fakeCaa = (async () => [{ critical: 0, issue: "letsencrypt.org" }]) as any;
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS, dnsResolveCaaFn: fakeCaa });
  assert.equal(security.caaRecords.probeStatus, "checked");
  assert.equal(security.caaRecords.present, true);
  assert.ok(security.caaRecords.records[0].includes("letsencrypt.org"));
});

test("CAA: a genuine 'no records' DNS answer (ENODATA) is reported as checked+absent, not an error", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const fakeCaa = (async () => {
    const e: NodeJS.ErrnoException = new Error("no data");
    e.code = "ENODATA";
    throw e;
  }) as any;
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS, dnsResolveCaaFn: fakeCaa });
  assert.equal(security.caaRecords.probeStatus, "checked");
  assert.equal(security.caaRecords.present, false);
});

test("CAA: a genuine DNS query failure is reported as unverified, never conflated with 'no records'", async () => {
  const fetchResult = baseFetch("/safe-cors-page", "<html><body>hi</body></html>");
  const fakeCaa = (async () => {
    const e: NodeJS.ErrnoException = new Error("timed out");
    e.code = "ETIMEOUT";
    throw e;
  }) as any;
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS, dnsResolveCaaFn: fakeCaa });
  assert.equal(security.caaRecords.probeStatus, "error");
});

test("a blocked (non-bypassed, non-local) host degrades every probe to a non-throwing 'blocked'/'not_applicable' result", async () => {
  const fetchResult: FetchResult = {
    requestedUrl: "http://internal-service.example/page",
    finalUrl: "http://internal-service.example/page",
    statusCode: 200,
    httpsUsed: false,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 1, totalDownloadMs: 1 },
    headers: {},
    bodyBytes: 10,
    bodyText: "<html></html>",
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
  };
  // no testBypassHosts, no ALLOW_LOCAL_TARGETS - "internal-service.example"
  // will fail DNS resolution (or, if it somehow resolved, would still be
  // subject to the same guard) - either way collectSecurity must not throw.
  const security = await collectSecurity(fetchResult);
  assert.ok(["blocked", "error"].includes(security.cors.probeStatus));
  assert.ok(["blocked", "error"].includes(security.infoDisclosure.probeStatus));
});


test("TLS: a real 1024-bit RSA certificate reports the exact key size, real evidence not a guess", async () => {
  const fetchResult = baseWeakHttpsFetch("<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.tlsCertificate.probeStatus, "checked");
  assert.equal(security.tlsCertificate.publicKeyIsRsa, true);
  assert.equal(security.tlsCertificate.publicKeyBits, 1024);
});

test("TLS: the strong 2048-bit test server is correctly NOT reported as weak", async () => {
  const fetchResult = baseHttpsFetch("<html><body>hi</body></html>");
  const security = await collectSecurity(fetchResult, { testBypassHosts: BYPASS });
  assert.equal(security.tlsCertificate.publicKeyIsRsa, true);
  assert.equal(security.tlsCertificate.publicKeyBits, 2048);
});
