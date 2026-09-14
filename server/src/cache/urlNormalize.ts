/**
 * Deterministic cache key for a scan target. Two URLs that a human
 * would consider "the same page" should produce the same key: same
 * scheme+host+path, query params sorted (order shouldn't matter), no
 * trailing slash inconsistency, no fragment (fragments never reach the
 * server). The PageSpeed strategy (mobile/desktop) is part of the key
 * because it produces genuinely different results.
 */
export function normalizeCacheKey(rawUrl: string, strategy: "mobile" | "desktop"): string {
  const url = new URL(rawUrl);

  const host = url.hostname.toLowerCase();
  const port = url.port && url.port !== defaultPortFor(url.protocol) ? `:${url.port}` : "";
  let path = url.pathname.replace(/\/+$/, ""); // strip trailing slash(es)
  if (path === "") path = "/";

  const params = new URLSearchParams(url.search);
  params.sort();
  const query = params.toString();

  return `${url.protocol}//${host}${port}${path}${query ? `?${query}` : ""}::${strategy}`;
}

function defaultPortFor(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}

/** Normalizes a URL for crawl-time deduplication/navigation. */
export function normalizeCrawlUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  const params = new URLSearchParams(url.search);
  params.sort();
  url.search = params.toString();
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "" ? "/" : path;
  return url.href;
}
