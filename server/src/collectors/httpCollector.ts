import { lookup as dnsLookup } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { FetchResult } from "../types.js";

/**
 * Internal error taxonomy. Kept intentionally small and specific to what
 * this collector can actually distinguish - see PROJECT_PROGRESS.md for
 * why PageSpeed-side errors use the separate ProviderStatus enum instead
 * of duplicating a second parallel error-code system here.
 */
export type CollectorErrorCode =
  | "INVALID_URL"
  | "BLOCKED_HOST"
  | "DNS_ERROR"
  | "TARGET_TIMEOUT"
  | "TARGET_UNREACHABLE"
  | "NON_HTML";

export class CollectorError extends Error {
  constructor(
    message: string,
    public readonly code: CollectorErrorCode,
  ) {
    super(message);
    this.name = "CollectorError";
  }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.TARGET_FETCH_TIMEOUT) || 10_000;
const MAX_BODY_BYTES = 5_000_000; // 5MB safety cap
const MAX_REDIRECTS = 5;

/** IPv4 ranges that must never be reachable from the public scanner. */
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipToInt("0.0.0.0"), ipToInt("0.255.255.255")], // "this" network
  [ipToInt("10.0.0.0"), ipToInt("10.255.255.255")], // RFC1918
  [ipToInt("100.64.0.0"), ipToInt("100.127.255.255")], // carrier-grade NAT
  [ipToInt("127.0.0.0"), ipToInt("127.255.255.255")], // loopback
  [ipToInt("169.254.0.0"), ipToInt("169.254.255.255")], // link-local (incl. cloud metadata)
  [ipToInt("172.16.0.0"), ipToInt("172.31.255.255")], // RFC1918
  [ipToInt("192.0.0.0"), ipToInt("192.0.0.255")], // IETF protocol assignments
  [ipToInt("192.0.2.0"), ipToInt("192.0.2.255")], // TEST-NET-1
  [ipToInt("192.168.0.0"), ipToInt("192.168.255.255")], // RFC1918
  [ipToInt("198.18.0.0"), ipToInt("198.19.255.255")], // benchmarking
  [ipToInt("224.0.0.0"), ipToInt("255.255.255.255")], // multicast + reserved
];

export function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
  const n = ipToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * Expands an IPv6 address string into its 8 16-bit groups, handling
 * `::` compression and an embedded dotted-decimal IPv4 tail. Returns
 * null if the string isn't a syntactically valid IPv6 address.
 *
 * This exists because Node's URL parser (per the WHATWG URL Standard)
 * ALWAYS canonicalizes an embedded IPv4 address into pure hex groups -
 * e.g. `[::ffff:127.0.0.1]` becomes hostname `[::ffff:7f00:1]`, never
 * the dotted form - so any check that only recognizes the dotted form
 * (a regex like `^::ffff:\d+\.\d+\.\d+\.\d+$`) never actually matches
 * what the URL parser hands us. Working on the expanded 16-bit groups
 * is representation-independent: it doesn't matter whether the address
 * arrived as hex, dotted-tail, compressed, or upper/lower case.
 */
export function expandIPv6Groups(rawAddr: string): number[] | null {
  const addr = rawAddr.split("%")[0]; // strip a zone id like %eth0, if present
  const parts = addr.split("::");
  if (parts.length > 2) return null; // more than one "::" is never valid

  function parseGroups(segment: string): number[] | null {
    if (segment === "") return [];
    const raw = segment.split(":");
    const groups: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const g = raw[i];
      if (i === raw.length - 1 && g.includes(".")) {
        // embedded dotted-decimal IPv4 tail, e.g. "0:0:0:0:0:ffff:127.0.0.1"
        const octets = g.split(".");
        if (octets.length !== 4) return null;
        const nums = octets.map(Number);
        if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        groups.push((nums[0] << 8) | nums[1]);
        groups.push((nums[2] << 8) | nums[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  }

  if (parts.length === 1) {
    const groups = parseGroups(parts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parseGroups(parts[0]);
  const tail = parseGroups(parts[1]);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

function ipv4FromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Checks a fully-expanded IPv6 address (8 groups) against every
 * private/internal/tunneling range we care about. See expandIPv6Groups
 * for why this operates on parsed groups rather than string patterns.
 */
function isPrivateIPv6Groups(g: number[]): boolean {
  const allZero = g.every((x) => x === 0);
  if (allZero) return true; // :: (unspecified)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true; // ::1 (loopback)
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (ULA)

  // IPv4-mapped ::ffff:0:0/96 - embedded IPv4 lives in the last 32 bits
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPrivateIPv4(ipv4FromGroups(g[6], g[7]));
  }
  // IPv4-compatible (deprecated) ::a.b.c.d - first 6 groups zero, no ffff marker
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIPv4(ipv4FromGroups(g[6], g[7]));
  }
  // NAT64 well-known prefix 64:ff9b::/96 - embeds an IPv4 in the last 32 bits
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIPv4(ipv4FromGroups(g[6], g[7]));
  }
  // 6to4 2002::/16 - embeds an IPv4 directly in the next 32 bits (groups 1-2)
  if (g[0] === 0x2002) {
    return isPrivateIPv4(ipv4FromGroups(g[1], g[2]));
  }

  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6Groups(ip.toLowerCase());
  // an address we can't even parse can't be connected to as written either;
  // let it fall through to DNS resolution / the real fetch, which will
  // fail on its own rather than us guessing.
  if (!groups) return false;
  return isPrivateIPv6Groups(groups);
}

export function isPrivateIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

const BLOCKED_HOSTNAME_PATTERNS = [/^localhost$/i, /\.local$/i, /^0\.0\.0\.0$/];

/**
 * SSRF guard, applied to every hop (initial request AND every redirect
 * target - a redirect to an internal address is the classic bypass for a
 * hostname-string-only check). Layers:
 *   1. hostname pattern check (cheap, catches the obvious cases)
 *   2. bare IP literal check, covering every representation Node's URL
 *      parser will accept and canonicalize (hex/octal/decimal IPv4,
 *      IPv4-mapped/compatible/6to4/NAT64 IPv6) - see expandIPv6Groups.
 *   3. DNS resolution + IP-range check (catches DNS rebinding: a public
 *      hostname that resolves to a private/loopback/link-local address,
 *      e.g. the cloud metadata endpoint at 169.254.169.254)
 * `ALLOW_LOCAL_TARGETS=true` bypasses all of the above, for local
 * development and the mock-site integration tests only - never set in
 * production. `testBypassHosts` is a SEPARATE, narrower escape hatch
 * used only by the test suite to construct genuine end-to-end redirect
 * tests without real DNS/network control (see httpCollectorSecurity.test.ts) -
 * it is never read from an environment variable or any user-controllable
 * input, and production call sites never pass it, so it cannot weaken
 * production behavior.
 */
export async function assertHostAllowed(
  hostname: string,
  dnsLookupFn: typeof dnsLookup = dnsLookup,
  testBypassHosts?: ReadonlySet<string>,
): Promise<void> {
  if (process.env.ALLOW_LOCAL_TARGETS === "true") return;
  if (testBypassHosts?.has(hostname)) return;

  if (BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(hostname))) {
    throw new CollectorError(`Target host "${hostname}" is not allowed`, "BLOCKED_HOST");
  }
  // a bare IP literal in the URL - check it directly, no DNS needed
  if (isPrivateIp(hostname.replace(/^\[|\]$/g, ""))) {
    throw new CollectorError(`Target host "${hostname}" is not allowed`, "BLOCKED_HOST");
  }

  let addresses: { address: string }[];
  try {
    addresses = await dnsLookupFn(hostname, { all: true });
  } catch {
    throw new CollectorError(`Could not resolve host "${hostname}"`, "DNS_ERROR");
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new CollectorError(`Target host "${hostname}" resolves to a private network address`, "BLOCKED_HOST");
    }
  }
}

export function parseAndValidateUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CollectorError(`"${rawUrl}" is not a valid URL`, "INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CollectorError("Only http:// and https:// URLs are supported", "INVALID_URL");
  }
  return url;
}

/** @deprecated kept as an alias for parseAndValidateUrl for call-site compatibility */
export const validateUrl = parseAndValidateUrl;

export interface CollectHttpOptions {
  timeoutMs?: number;
  /** injectable for tests */
  dnsLookupFn?: typeof dnsLookup;
  /**
   * TEST-ONLY escape hatch: a set of hostnames exempt from the SSRF
   * guard for this call, regardless of what they are. Never read from
   * an environment variable, never passed by any production call site
   * (pipeline.ts does not set it) - it exists solely so tests can
   * construct a genuine end-to-end request through collectHttp's real
   * redirect loop (hitting a real local test server) while still
   * exercising the real, unmodified guard against a *different*
   * hostname (e.g. the redirect target). See httpCollectorSecurity.test.ts.
   */
  testBypassHosts?: ReadonlySet<string>;
}

/**
 * Fetches a single URL and captures deterministic, measured facts about
 * the response: status, timing, headers, size, and the raw HTML body.
 * No interpretation happens here - this is the MEASURE step.
 *
 * Redirects are followed manually (not via fetch's `redirect: "follow"`)
 * so every hop can be re-validated against the SSRF guard - a page that
 * redirects to an internal address must not be silently followed there.
 */
export async function collectHttp(rawUrl: string, options: CollectHttpOptions = {}): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dnsLookupFn = options.dnsLookupFn ?? dnsLookup;
  const testBypassHosts = options.testBypassHosts;

  let currentUrl = parseAndValidateUrl(rawUrl);
  await assertHostAllowed(currentUrl.hostname, dnsLookupFn, testBypassHosts);

  const controller = new AbortController();
  const timeout = sleep(timeoutMs).then(() => controller.abort());

  const start = performance.now();
  let response: Response;
  let redirectCount = 0;
  const redirectChain: string[] = [currentUrl.href];

  try {
    for (;;) {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "A2Z-Web-Insight/0.1 (+https://a2z-web-insight.example/bot)",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get("location");
      if (!isRedirect || !location) break;

      redirectCount += 1;
      if (redirectCount > MAX_REDIRECTS) {
        throw new CollectorError(`Too many redirects (>${MAX_REDIRECTS}) starting from ${rawUrl}`, "TARGET_UNREACHABLE");
      }

      const nextUrl = parseAndValidateUrl(new URL(location, currentUrl).href);
      await assertHostAllowed(nextUrl.hostname, dnsLookupFn, testBypassHosts);
      currentUrl = nextUrl;
      redirectChain.push(currentUrl.href);
    }
  } catch (err) {
    if (err instanceof CollectorError) throw err;
    if (controller.signal.aborted) {
      throw new CollectorError(`Request to ${rawUrl} timed out after ${timeoutMs}ms`, "TARGET_TIMEOUT");
    }
    throw new CollectorError(`Could not reach ${rawUrl}: ${(err as Error).message}`, "TARGET_UNREACHABLE");
  }
  // fetch() resolving = headers received = our approximate TTFB marker.
  const ttfbMark = performance.now();

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    clearTimeoutRace(timeout);
    throw new CollectorError(`URL did not return HTML (content-type: ${contentType || "unknown"})`, "NON_HTML");
  }

  let buf: ArrayBuffer;
  try {
    buf = await response.arrayBuffer();
  } catch {
    clearTimeoutRace(timeout);
    if (controller.signal.aborted) {
      throw new CollectorError(`Request to ${rawUrl} timed out after ${timeoutMs}ms`, "TARGET_TIMEOUT");
    }
    throw new CollectorError(`Could not read response body from ${rawUrl}`, "TARGET_UNREACHABLE");
  }
  const totalMark = performance.now();
  clearTimeoutRace(timeout);

  if (buf.byteLength > MAX_BODY_BYTES) {
    throw new CollectorError("Response body exceeded the 5MB safety cap", "TARGET_UNREACHABLE");
  }

  const bodyText = Buffer.from(buf).toString("utf-8");

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const setCookieHeaders = response.headers.getSetCookie?.() ?? [];

  return {
    requestedUrl: rawUrl,
    finalUrl: currentUrl.href,
    statusCode: response.status,
    httpsUsed: currentUrl.protocol === "https:",
    redirected: redirectCount > 0,
    redirectCount,
    timing: {
      approxTtfbMs: Math.round(ttfbMark - start),
      totalDownloadMs: Math.round(totalMark - start),
    },
    headers,
    bodyBytes: buf.byteLength,
    bodyText,
    contentType,
    fetchedAt: new Date().toISOString(),
    setCookieHeaders,
    redirectChain,
  };
}

// avoid unhandled rejection noise from the loser of the timeout race
function clearTimeoutRace(p: Promise<unknown>) {
  p.catch(() => {});
}

export interface TextResourceResult {
  statusCode: number;
  finalUrl: string;
  bodyText: string;
  ok: boolean; // true for a 2xx response
}

/**
 * Fetches a plain-text/XML resource (robots.txt, sitemap.xml) through
 * the SAME SSRF guard, per-hop redirect revalidation, and timeout
 * logic as collectHttp above - but WITHOUT collectHttp's HTML-only
 * content-type requirement (robots.txt is text/plain, sitemap.xml is
 * application/xml, and some servers mislabel either) and without
 * throwing on failure: callers here (crawler/robots.ts,
 * crawler/sitemap.ts) treat "couldn't get it" as "proceed
 * conservatively", not as a hard scan failure the way a bad target URL
 * is for the primary single-page scan. Returns null only for
 * network-level failure (blocked host, DNS error, timeout, redirect
 * loop/limit, oversized body, unreadable body) - a real HTTP response,
 * even a 404 or 500, is still returned so callers can distinguish
 * "genuinely absent" (404) from "temporarily unavailable" (5xx/timeout).
 */
export async function fetchTextResource(rawUrl: string, options: CollectHttpOptions = {}): Promise<TextResourceResult | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dnsLookupFn = options.dnsLookupFn ?? dnsLookup;
  const testBypassHosts = options.testBypassHosts;

  let currentUrl: URL;
  try {
    currentUrl = parseAndValidateUrl(rawUrl);
    await assertHostAllowed(currentUrl.hostname, dnsLookupFn, testBypassHosts);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeout = sleep(timeoutMs).then(() => controller.abort());

  let response: Response;
  let redirectCount = 0;
  try {
    for (;;) {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "A2Z-Web-Insight/0.1 (+https://a2z-web-insight.example/bot)",
          Accept: "text/plain,application/xml,text/xml,*/*",
        },
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get("location");
      if (!isRedirect || !location) break;

      redirectCount += 1;
      if (redirectCount > MAX_REDIRECTS) {
        clearTimeoutRace(timeout);
        return null;
      }

      let nextUrl: URL;
      try {
        nextUrl = parseAndValidateUrl(new URL(location, currentUrl).href);
        await assertHostAllowed(nextUrl.hostname, dnsLookupFn, testBypassHosts);
      } catch {
        clearTimeoutRace(timeout);
        return null;
      }
      currentUrl = nextUrl;
    }
  } catch {
    clearTimeoutRace(timeout);
    return null;
  }

  let buf: ArrayBuffer;
  try {
    buf = await response.arrayBuffer();
  } catch {
    clearTimeoutRace(timeout);
    return null;
  }
  clearTimeoutRace(timeout);
  if (buf.byteLength > MAX_BODY_BYTES) return null;

  return {
    statusCode: response.status,
    finalUrl: currentUrl.href,
    bodyText: Buffer.from(buf).toString("utf-8"),
    ok: response.status >= 200 && response.status < 300,
  };
}
