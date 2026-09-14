import * as cheerio from "cheerio";
import { analyzeTechnology } from "../technology/technologyIntelligence.js";
import type { TechnologyInput, TechnologyIntelligence } from "../technology/types.js";
import type {
  FetchResult,
  ResourceIntelligence,
  RuntimeVerificationEvidence,
  RobotsTxtAnalysis,
} from "../types.js";

function cookieNamesFromSetCookie(headers: string[] | undefined): string[] {
  const names = new Set<string>();
  for (const header of headers ?? []) {
    const match = header.match(/^\s*([^=;\s]+)\s*=/);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

function absoluteUrl(raw: string, pageUrl: string): string | null {
  try {
    const url = new URL(raw, pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Builds technology evidence strictly from measurements A-to-Z already has.
 * The forensic engine performs no network or browser I/O of its own.
 */
export function collectTechnologyIntelligence(
  fetchResult: FetchResult,
  runtime?: RuntimeVerificationEvidence | null,
  resourceIntelligence?: ResourceIntelligence | null,
  robotsTxt?: RobotsTxtAnalysis | null,
): TechnologyIntelligence {
  const pageUrl = fetchResult.finalUrl;
  const $ = cheerio.load(fetchResult.bodyText);

  const metaTags = $("meta")
    .map((_, el) => ({
      name: $(el).attr("name"),
      property: $(el).attr("property"),
      content: $(el).attr("content") ?? "",
    }))
    .get()
    .filter((m) => m.content.length > 0);

  const scriptUrls = $("script[src]")
    .map((_, el) => absoluteUrl($(el).attr("src") ?? "", pageUrl))
    .get()
    .filter((x): x is string => Boolean(x));

  const stylesheetUrls = $('link[rel="stylesheet"][href]')
    .map((_, el) => absoluteUrl($(el).attr("href") ?? "", pageUrl))
    .get()
    .filter((x): x is string => Boolean(x));

  const resourceUrls = $("script[src], link[href], img[src], iframe[src], source[src], source[srcset], video[src], audio[src]")
    .map((_, el) => {
      const raw = $(el).attr("src") ?? $(el).attr("href") ?? $(el).attr("srcset")?.split(",")[0]?.trim() ?? "";
      return absoluteUrl(raw.split(/\s+/)[0] ?? "", pageUrl);
    })
    .get()
    .filter((x): x is string => Boolean(x));

  for (const entry of resourceIntelligence?.entries ?? []) {
    if (entry.url) resourceUrls.push(entry.url);
  }

  const allResourceUrls = [...new Set(resourceUrls)];
  const requestHosts = new Set<string>();
  for (const url of allResourceUrls) {
    const host = hostOf(url);
    if (host) requestHosts.add(host);
  }
  for (const request of runtime?.requests ?? []) {
    const host = hostOf(request.url);
    if (host) requestHosts.add(host);
  }

  const rootAttributes = $("html").first().get(0)
    ? Object.entries($("html").first().get(0)!.attribs ?? {}).map(([name, value]) => ({ name, value: value ?? "" }))
    : [];

  const xhrHosts = (runtime?.requests ?? [])
    .filter((request) => request.resourceType === "xhr" || request.resourceType === "fetch")
    .map((request) => hostOf(request.url))
    .filter((x): x is string => Boolean(x));

  const inlineScripts = $("script:not([src])")
    .map((_, el) => $(el).text())
    .get()
    .filter(Boolean);

  const cssText = $("style")
    .map((_, el) => $(el).text())
    .get()
    .filter(Boolean);

  const input: TechnologyInput = {
    url: pageUrl,
    html: fetchResult.bodyText,
    metaTags,
    headers: fetchResult.headers,
    cookieNames: cookieNamesFromSetCookie(fetchResult.setCookieHeaders),
    scriptUrls: [...new Set(scriptUrls)],
    stylesheetUrls: [...new Set(stylesheetUrls)],
    resourceUrls: allResourceUrls,
    requestHosts: [...requestHosts].sort(),
    domAttributes: rootAttributes,
    robotsTxt: robotsTxt?.raw ?? undefined,
    inlineScripts,
    cssText,
    xhrHosts: [...new Set(xhrHosts)].sort(),
    presentSelectors: runtime?.runtimeTechnology?.presentSelectors,
    presentJsProperties: runtime?.runtimeTechnology?.presentJsProperties,
    runtime: runtime ? {
      globals: runtime.runtimeTechnology?.globals,
      domMarkers: runtime.runtimeTechnology?.domMarkers,
      versions: runtime.runtimeTechnology?.versions,
    } : undefined,
  };

  return analyzeTechnology(input);
}
