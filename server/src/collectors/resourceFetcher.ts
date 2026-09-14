import { setTimeout as sleep } from "node:timers/promises";
import { assertHostAllowed, parseAndValidateUrl } from "./httpCollector.js";

/**
 * Fetches a plain-text/XML auxiliary resource (robots.txt, an XML
 * sitemap) that is NOT expected to be text/html, so it cannot go
 * through collectHttp() (which intentionally rejects non-HTML
 * responses). This reuses the exact same SSRF guard as collectHttp
 * (assertHostAllowed / parseAndValidateUrl) rather than duplicating
 * or weakening it, and follows redirects manually so every hop is
 * re-validated, matching collectHttp's behavior.
 *
 * This is deliberately NOT a general-purpose crawler fetcher - it is
 * scoped to the small set of well-known SEO resource URLs (robots.txt,
 * sitemap.xml and its children) that the SEO analysis layer needs for
 * itself. Main Claude's multi-page crawler owns fetching page content.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.TARGET_FETCH_TIMEOUT) || 10_000;
const MAX_BODY_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

export interface ResourceFetchResult {
  ok: boolean;
  statusCode: number | null;
  finalUrl: string | null;
  bodyText: string | null;
  headers: Record<string, string>;
  error?: string;
}

export interface ResourceHeadResult {
  ok: boolean;
  statusCode: number | null;
  finalUrl: string | null;
  headers: Record<string, string>;
  error?: string;
}

/**
 * HEAD-only probe for a sub-resource (script/stylesheet/image/font),
 * used by collectors/resourceProbe.ts to get real Content-Length/
 * Cache-Control/Content-Encoding/Content-Type without downloading the
 * resource body. Same SSRF guard and manual-redirect-revalidation
 * pattern as fetchTextResource() above, kept as a separate function
 * (rather than a `method` option on fetchTextResource) so that
 * function's existing GET-with-body-cap contract, already depended on
 * by robotsCollector.ts/sitemapCollector.ts, stays untouched.
 */
export async function fetchResourceHead(rawUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ResourceHeadResult> {
  let currentUrl: URL;
  try {
    currentUrl = parseAndValidateUrl(rawUrl);
    await assertHostAllowed(currentUrl.hostname);
  } catch (err) {
    return { ok: false, statusCode: null, finalUrl: null, headers: {}, error: (err as Error).message };
  }

  const controller = new AbortController();
  const timeout = sleep(timeoutMs).then(() => controller.abort());

  try {
    let response: Response;
    let redirectCount = 0;
    for (;;) {
      response = await fetch(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "A2Z-Web-Insight/0.1 (+https://a2z-web-insight.example/bot)" },
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get("location");
      if (!isRedirect || !location) break;

      redirectCount += 1;
      if (redirectCount > MAX_REDIRECTS) {
        return { ok: false, statusCode: response.status, finalUrl: currentUrl.href, headers: {}, error: "Too many redirects" };
      }
      const nextUrl = parseAndValidateUrl(new URL(location, currentUrl).href);
      await assertHostAllowed(nextUrl.hostname);
      currentUrl = nextUrl;
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return { ok: true, statusCode: response.status, finalUrl: currentUrl.href, headers };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, statusCode: null, finalUrl: currentUrl.href, headers: {}, error: "Request timed out" };
    }
    return { ok: false, statusCode: null, finalUrl: currentUrl.href, headers: {}, error: (err as Error).message };
  } finally {
    timeout.catch(() => {});
  }
}

export async function fetchTextResource(rawUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ResourceFetchResult> {
  let currentUrl: URL;
  try {
    currentUrl = parseAndValidateUrl(rawUrl);
    await assertHostAllowed(currentUrl.hostname);
  } catch (err) {
    return { ok: false, statusCode: null, finalUrl: null, bodyText: null, headers: {}, error: (err as Error).message };
  }

  const controller = new AbortController();
  const timeout = sleep(timeoutMs).then(() => controller.abort());

  try {
    let response: Response;
    let redirectCount = 0;
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
        return { ok: false, statusCode: response.status, finalUrl: currentUrl.href, bodyText: null, headers: {}, error: "Too many redirects" };
      }
      const nextUrl = parseAndValidateUrl(new URL(location, currentUrl).href);
      await assertHostAllowed(nextUrl.hostname);
      currentUrl = nextUrl;
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, statusCode: response.status, finalUrl: currentUrl.href, bodyText: null, headers, error: `HTTP ${response.status}` };
    }

    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return { ok: false, statusCode: response.status, finalUrl: currentUrl.href, bodyText: null, headers, error: "Response too large" };
    }
    const bodyText = Buffer.from(buf).toString("utf-8");
    return { ok: true, statusCode: response.status, finalUrl: currentUrl.href, bodyText, headers };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, statusCode: null, finalUrl: currentUrl.href, bodyText: null, headers: {}, error: "Request timed out" };
    }
    return { ok: false, statusCode: null, finalUrl: currentUrl.href, bodyText: null, headers: {}, error: (err as Error).message };
  } finally {
    timeout.catch(() => {});
  }
}
