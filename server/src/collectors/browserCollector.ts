import * as cheerio from "cheerio";
import { errors as playwrightErrors, type Browser, type BrowserContext, type CDPSession, type Page, type Request as PwRequest } from "playwright";
import { assertHostAllowed, CollectorError, parseAndValidateUrl } from "./httpCollector.js";
import { getSharedBrowser, withBrowserConcurrencyLimit, type LaunchBrowserFn } from "../browser/browserManager.js";
import { logEvent } from "../logging/logger.js";
import { detectRuntimeFindings } from "../analysis/runtimeFindings.js";
import { requestManifest } from "../technology/detect/extendedSignals.js";
import type {
  ConsoleLevel,
  RuntimeConsoleMessage,
  RuntimeContentComparison,
  RuntimeDomSnapshot,
  RuntimeFormInfo,
  RuntimeJsError,
  RuntimeNetworkRequest,
  RuntimeScreenshot,
  RuntimeVerificationEvidence,
  RuntimeVerificationReport,
} from "../types.js";

/**
 * Real-browser (headless Chromium, via Playwright) runtime verification.
 * Executes the target page's JavaScript and reports what actually
 * happened - errors, network failures, the rendered DOM, forms, and
 * (optionally) a screenshot. This is a MEASURE step, same philosophy as
 * httpCollector.ts/htmlCollector.ts/accessibilityCollector.ts: no
 * judgment calls happen here, only fact collection. See
 * analysis/runtimeFindings.ts for the ANALYZE step.
 *
 * SSRF: see the CDP Fetch.requestPaused handler inside runOnePage()
 * below - every single request the browser makes (navigation AND every subresource/XHR/fetch initiated by
 * the page's own JavaScript) is validated against the SAME
 * assertHostAllowed() guard httpCollector.ts uses, not just the initial
 * navigation. This is deliberately broader than collectHttp's
 * per-hop-only check: a headless browser executes attacker-controlled
 * JavaScript on our infrastructure, and that JavaScript can itself call
 * fetch()/XHR against an internal address and exfiltrate the response
 * into the visible DOM (title, text content) or even into a
 * screenshot's rendered pixels - a risk that doesn't exist for the
 * plain HTTP collector, which never executes anything.
 *
 * IMPORTANT IMPLEMENTATION NOTE (verified empirically, not assumed):
 * this guard is implemented via the raw Chrome DevTools Protocol
 * `Fetch` domain (`context.newCDPSession()` + `Fetch.requestPaused`),
 * NOT Playwright's higher-level `page.route()`. A real headless-Chromium
 * run in this project's environment showed that `page.route()`
 * (tested at both page- and context-scope) is invoked exactly ONCE for
 * a navigation that gets server-side redirected - it does NOT get
 * re-invoked for the redirect TARGET, even though the navigation
 * silently follows it through to a real response. This was confirmed
 * with a minimal reproduction (two local HTTP servers, a 302 between
 * them) BEFORE writing this code, and is a genuinely serious gap for
 * an SSRF guard specifically, not a cosmetic one: a hop-based
 * `route()` guard would silently let a redirect through unblocked in
 * this environment. The raw CDP `Fetch.requestPaused` event, by
 * contrast, was confirmed (same reproduction) to fire once per actual
 * hop, including the redirect target, for both navigation and
 * subresource requests, and coexists correctly with Playwright's own
 * `page.on('request'|'response'|'requestfailed')` listeners used below
 * for evidence collection. See PROJECT_PROGRESS.md's Session 6 entry
 * for the full diagnostic trail.
 */

const DEFAULT_NAV_TIMEOUT_MS = Number(process.env.BROWSER_NAV_TIMEOUT_MS) || 15_000;
const DEFAULT_SETTLE_MS = Number(process.env.BROWSER_SETTLE_MS) || 1_000;
const DEFAULT_SCREENSHOT_ENABLED = process.env.BROWSER_SCREENSHOT_ENABLED === "true";
const DEFAULT_MAX_DOM_TEXT_CHARS = Number(process.env.BROWSER_MAX_DOM_TEXT_CHARS) || 20_000;
const [DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT] = parseViewport(process.env.BROWSER_VIEWPORT);

// Hardcoded safety caps (not env-configurable) - matches this project's
// existing precedent of hardcoding safety limits rather than making
// every single number configurable (see MAX_BODY_BYTES/MAX_REDIRECTS in
// httpCollector.ts). Overridable via options for tests only.
const DEFAULT_MAX_REQUESTS_RECORDED = 200;
const DEFAULT_MAX_CONSOLE_MESSAGES_RECORDED = 100;
const DEFAULT_MAX_JS_ERRORS_RECORDED = 50;
const MAX_STACK_CHARS = 2_000;
const MAX_CONSOLE_TEXT_CHARS = 500;
const MAX_URL_CHARS_RECORDED = 2_000;

// Below this many visible characters in the RAW (pre-JS) HTML, the page
// is considered "sparse" - a candidate for JS-dependent content.
const RAW_SPARSE_TEXT_THRESHOLD = 200;

function parseViewport(raw: string | undefined): [number, number] {
  const match = raw?.match(/^(\d+)x(\d+)$/i);
  if (match) return [Number(match[1]), Number(match[2])];
  return [1280, 800];
}

function normalizeConsoleLevel(playwrightType: string): ConsoleLevel {
  if (playwrightType === "error") return "error";
  if (playwrightType === "warning") return "warning";
  if (playwrightType === "info" || playwrightType === "debug") return playwrightType;
  return "log";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface CollectRuntimeOptions {
  /** hard cap on navigation + settle time, in ms. Default: BROWSER_NAV_TIMEOUT_MS or 15000. */
  timeoutMs?: number;
  /**
   * A bounded, fixed extra wait AFTER the page's load event, to let
   * JS-driven content finish populating - deliberately NOT `waitUntil:
   * "networkidle"` (a page can legitimately keep an analytics/WebSocket
   * connection open forever, which would make every scan hang for the
   * full navigation timeout). Default: BROWSER_SETTLE_MS or 1000ms.
   */
  settleMs?: number;
  viewport?: { width: number; height: number };
  /** Default: BROWSER_SCREENSHOT_ENABLED env var (off unless explicitly set to "true") - screenshots are resource-heavy. */
  screenshot?: boolean;
  /** Caps the rendered-DOM text sample size. Default: BROWSER_MAX_DOM_TEXT_CHARS or 20000. */
  maxDomTextChars?: number;
  /**
   * The raw (pre-JS) HTML body, if already fetched (e.g. by
   * collectHttp() in the same pipeline run) - enables the "likely
   * JS-dependent content" comparison signal without a second fetch of
   * the target. Omit to skip that comparison (contentComparison will be
   * null in the returned evidence).
   */
  rawHtmlForComparison?: string;
  /** injectable for tests - see browser/browserManager.ts */
  launchFn?: LaunchBrowserFn;
  /** injectable for tests - forwarded to the SSRF guard, see httpCollector.ts */
  dnsLookupFn?: Parameters<typeof assertHostAllowed>[1];
  /** TEST-ONLY escape hatch - see httpCollector.ts's CollectHttpOptions.testBypassHosts for the full rationale. Never read from an env var, never passed by any production call site. */
  testBypassHosts?: ReadonlySet<string>;
  /** test-only overrides for the hardcoded recording caps above, so cap behavior itself can be tested without spinning up hundreds of real resources */
  maxRequestsRecorded?: number;
  maxConsoleMessagesRecorded?: number;
  maxJsErrorsRecorded?: number;
}

/**
 * Runs a real headless-Chromium pass over `rawUrl` and returns typed
 * runtime evidence. Throws CollectorError (same class/taxonomy as
 * collectHttp) on invalid/blocked/unreachable targets, launch failure,
 * navigation failure, or timeout - a browser failure must never
 * silently look like a successful scan. See runBrowserVerification()
 * for the non-throwing wrapper used by the pipeline.
 */
export async function collectRuntime(rawUrl: string, options: CollectRuntimeOptions = {}): Promise<RuntimeVerificationEvidence> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const viewport = options.viewport ?? { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
  const screenshotEnabled = options.screenshot ?? DEFAULT_SCREENSHOT_ENABLED;
  const maxDomTextChars = options.maxDomTextChars ?? DEFAULT_MAX_DOM_TEXT_CHARS;
  const maxRequestsRecorded = options.maxRequestsRecorded ?? DEFAULT_MAX_REQUESTS_RECORDED;
  const maxConsoleMessagesRecorded = options.maxConsoleMessagesRecorded ?? DEFAULT_MAX_CONSOLE_MESSAGES_RECORDED;
  const maxJsErrorsRecorded = options.maxJsErrorsRecorded ?? DEFAULT_MAX_JS_ERRORS_RECORDED;

  // Validated up front, same as collectHttp - fails fast, before ever
  // touching the browser/concurrency limiter, for a malformed URL or an
  // obviously-blocked bare-IP/hostname target.
  const startUrl = parseAndValidateUrl(rawUrl);
  await assertHostAllowed(startUrl.hostname, options.dnsLookupFn, options.testBypassHosts);

  return withBrowserConcurrencyLimit(() =>
    runOnePage(startUrl, rawUrl, {
      timeoutMs,
      settleMs,
      viewport,
      screenshotEnabled,
      maxDomTextChars,
      maxRequestsRecorded,
      maxConsoleMessagesRecorded,
      maxJsErrorsRecorded,
      rawHtmlForComparison: options.rawHtmlForComparison,
      launchFn: options.launchFn,
      dnsLookupFn: options.dnsLookupFn,
      testBypassHosts: options.testBypassHosts,
    }),
  );
}

interface RunOnePageConfig {
  timeoutMs: number;
  settleMs: number;
  viewport: { width: number; height: number };
  screenshotEnabled: boolean;
  maxDomTextChars: number;
  maxRequestsRecorded: number;
  maxConsoleMessagesRecorded: number;
  maxJsErrorsRecorded: number;
  rawHtmlForComparison?: string;
  launchFn?: LaunchBrowserFn;
  dnsLookupFn?: Parameters<typeof assertHostAllowed>[1];
  testBypassHosts?: ReadonlySet<string>;
}

async function runOnePage(startUrl: URL, rawUrl: string, cfg: RunOnePageConfig): Promise<RuntimeVerificationEvidence> {
  let browser: Browser;
  try {
    browser = await getSharedBrowser(cfg.launchFn);
  } catch (err) {
    throw new CollectorError(`Could not launch the browser: ${(err as Error).message}`, "BROWSER_LAUNCH_FAILED");
  }

  const start = performance.now();
  // Declared outside the try block (but only ASSIGNED inside it) so the
  // finally block below can safely close it whenever it exists,
  // including if context/page creation itself is what failed.
  let context: BrowserContext | undefined;

  try {
    context = await browser.newContext({
      viewport: cfg.viewport,
      userAgent: "A2Z-Web-Insight-Browser/0.1 (+https://a2z-web-insight.example/bot)",
    });
    const page = await context.newPage();

    const jsErrors: RuntimeJsError[] = [];
    const consoleMessages: RuntimeConsoleMessage[] = [];
    const requestRecords = new Map<PwRequest, { record: RuntimeNetworkRequest; hostname: string }>();
    let blockedNavigation: CollectorError | undefined;

    // Per-call DNS/guard memoization - a real page can reference the same
    // CDN host dozens of times; without this every image/script would
    // trigger its own DNS lookup.
    const hostDecisionCache = new Map<string, Promise<void>>();
    function checkHost(hostname: string): Promise<void> {
      let pending = hostDecisionCache.get(hostname);
      if (!pending) {
        pending = assertHostAllowed(hostname, cfg.dnsLookupFn, cfg.testBypassHosts);
        hostDecisionCache.set(hostname, pending);
      }
      return pending;
    }

    page.on("pageerror", (err) => {
      if (jsErrors.length < cfg.maxJsErrorsRecorded) {
        jsErrors.push({ message: err.message, stack: err.stack ? truncate(err.stack, MAX_STACK_CHARS) : null, source: "pageerror" });
      }
    });

    page.on("console", (msg) => {
      const level = normalizeConsoleLevel(msg.type());
      const text = truncate(msg.text(), MAX_CONSOLE_TEXT_CHARS);
      if (consoleMessages.length < cfg.maxConsoleMessagesRecorded) {
        consoleMessages.push({ level, text });
      }
      if (level === "error" && jsErrors.length < cfg.maxJsErrorsRecorded) {
        jsErrors.push({ message: text, stack: null, source: "console-error" });
      }
    });

    function baseRecord(req: PwRequest, hostname: string): RuntimeNetworkRequest {
      return {
        url: truncate(req.url(), MAX_URL_CHARS_RECORDED),
        resourceType: req.resourceType(),
        method: req.method(),
        isFirstParty: false, // finalized after navigation settles, once we know the final hostname
        status: null,
        ok: null,
        failureReason: null,
        outcome: "success",
      };
    }

    function recordFor(req: PwRequest): { record: RuntimeNetworkRequest; hostname: string } | undefined {
      const existing = requestRecords.get(req);
      if (existing) return existing;
      if (requestRecords.size >= cfg.maxRequestsRecorded) return undefined;
      let hostname = "";
      try {
        hostname = new URL(req.url()).hostname;
      } catch {
        // non-network URL (data:/blob:/about:) - keep an empty hostname, never first-party
      }
      const entry = { record: baseRecord(req, hostname), hostname };
      requestRecords.set(req, entry);
      return entry;
    }

    page.on("requestfailed", (req) => {
      const entry = recordFor(req);
      if (!entry) return;
      entry.record.outcome = "failed";
      entry.record.failureReason = req.failure()?.errorText ?? "unknown failure";
    });

    page.on("response", (resp) => {
      const req = resp.request();
      const entry = recordFor(req);
      if (!entry) return;
      entry.record.status = resp.status();
      entry.record.ok = resp.ok();
      if (!resp.ok() && entry.record.outcome === "success") {
        entry.record.outcome = "failed";
        entry.record.failureReason = `HTTP ${resp.status()}`;
      }
    });

    // SSRF guard, applied to EVERY request the page makes - not just
    // navigation - via the raw CDP Fetch domain rather than
    // page.route(). See the module-level comment for the empirical
    // reason: page.route() does not get re-invoked for a navigation's
    // redirect target in this environment, but Fetch.requestPaused does.
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    cdpSession.on("Fetch.requestPaused", async (evt) => {
      const requestId = evt.requestId;
      const isDocument = evt.resourceType === "Document";
      let target: URL;
      try {
        target = new URL(evt.request.url);
      } catch {
        await failRequest(cdpSession, requestId);
        return;
      }

      if (target.protocol === "data:" || target.protocol === "blob:" || target.protocol === "about:") {
        await continueRequest(cdpSession, requestId);
        return;
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        if (isDocument && !blockedNavigation) {
          blockedNavigation = new CollectorError(`Navigation to an unsupported URL was blocked`, "INVALID_URL");
        }
        await failRequest(cdpSession, requestId);
        return;
      }

      try {
        await checkHost(target.hostname);
      } catch (err) {
        if (isDocument && !blockedNavigation) {
          blockedNavigation = err instanceof CollectorError ? err : new CollectorError("Navigation target blocked", "BLOCKED_HOST");
        }
        await failRequest(cdpSession, requestId);
        return;
      }
      await continueRequest(cdpSession, requestId);
    });

    let httpStatus: number | null = null;
    let navigationOk = false;
    try {
      const response = await page.goto(startUrl.href, { timeout: cfg.timeoutMs, waitUntil: "load" });
      if (blockedNavigation) throw blockedNavigation; // navigation "resolved" onto a Chromium error page after our own abort
      httpStatus = response ? response.status() : null;
      navigationOk = !!response && response.status() < 400;
    } catch (err) {
      if (err instanceof CollectorError) throw err;
      if (blockedNavigation) throw blockedNavigation;
      if (err instanceof playwrightErrors.TimeoutError || /timeout/i.test((err as Error).message ?? "")) {
        throw new CollectorError(`Browser navigation to ${rawUrl} timed out after ${cfg.timeoutMs}ms`, "BROWSER_TIMEOUT");
      }
      throw new CollectorError(`Browser navigation to ${rawUrl} failed: ${(err as Error).message}`, "BROWSER_NAVIGATION_FAILED");
    }

    // Bounded, fixed settle wait for JS-driven content - see settleMs doc above.
    await page.waitForTimeout(cfg.settleMs);
    if (blockedNavigation) throw blockedNavigation; // a blocked in-page redirect could have fired during the settle wait

    const finalUrl = page.url();
    const finalHostname = safeHostname(finalUrl);
    for (const entry of requestRecords.values()) {
      entry.record.isFirstParty = entry.hostname !== "" && entry.hostname === finalHostname;
    }

    const domSnapshot = await collectDomSnapshot(page, cfg.maxDomTextChars);
    const runtimeTechnology = await collectTechnologyRuntime(page);
    const forms = await collectForms(page, finalUrl);
    const screenshot = await collectScreenshot(page, cfg.screenshotEnabled, cfg.viewport);
    const contentComparison = buildContentComparison(cfg.rawHtmlForComparison, domSnapshot.visibleTextLength);

    const totalMs = Math.round(performance.now() - start);

    return {
      requestedUrl: rawUrl,
      finalUrl,
      httpStatus,
      navigationOk,
      jsErrors,
      consoleMessages,
      requests: [...requestRecords.values()].map((e) => e.record),
      forms,
      domSnapshot,
      contentComparison,
      screenshot,
      timing: { navigationMs: totalMs, totalMs },
      viewport: cfg.viewport,
      engine: "chromium",
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof CollectorError) throw err;
    throw new CollectorError(`Runtime verification failed for ${rawUrl}: ${(err as Error).message}`, "RUNTIME_COLLECTION_FAILED");
  } finally {
    // Always close the per-scan context, even on failure - this is what
    // keeps the shared browser PROCESS reusable/leak-free across scans;
    // see browser/browserManager.ts.
    if (context) {
      try {
        await context.close();
      } catch {
        // already closing/closed
      }
    }
  }
}

/**
 * Both CDP calls are wrapped defensively: the underlying request can
 * legitimately finish, get cancelled by the page, or the target can
 * navigate away between our (async, DNS-lookup-involving) guard check
 * and this call - in all of those cases the CDP command fails with an
 * "Invalid InterceptionId"-style error that's safe to ignore, not a
 * real problem worth surfacing.
 */
async function continueRequest(cdp: CDPSession, requestId: string): Promise<void> {
  try {
    await cdp.send("Fetch.continueRequest", { requestId });
  } catch {
    // request already resolved/cancelled - nothing to do
  }
}

async function failRequest(cdp: CDPSession, requestId: string): Promise<void> {
  try {
    await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
  } catch {
    // request already resolved/cancelled - nothing to do
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function collectTechnologyRuntime(page: Page): Promise<{
  globals: string[];
  domMarkers: string[];
  versions: Record<string, string>;
  presentSelectors: string[];
  presentJsProperties: Record<string, string | boolean>;
}> {
  const manifest = requestManifest();
  // Only resolve the allowlisted selectors/properties requested by the
  // technology registry. Never serialize arbitrary DOM properties or values.
  return page.evaluate((requested: { selectors: string[]; jsProperties: string[] }) => {
    const g = globalThis as any;
    const globals: string[] = [];
    const versions: Record<string, string> = {};
    for (const name of ["React", "jQuery", "Vue", "ng", "__NEXT_DATA__", "__NUXT__"]) {
      try {
        if (name in g) globals.push(name);
      } catch {
        // ignore inaccessible globals
      }
    }
    try {
      const reactVersion = typeof g.React?.version === "string" ? g.React.version : "";
      if (reactVersion) versions.react = reactVersion;
    } catch {}
    try {
      const jqueryVersion = typeof g.jQuery?.fn?.jquery === "string" ? g.jQuery.fn.jquery : "";
      if (jqueryVersion) versions.jquery = jqueryVersion;
    } catch {}
    try {
      const vueVersion = typeof g.Vue?.version === "string" ? g.Vue.version : "";
      if (vueVersion) versions.vue = vueVersion;
    } catch {}

    const domMarkers = new Set<string>();
    try {
      const elements = document.querySelectorAll("*");
      const cap = Math.min(elements.length, 5000);
      for (let i = 0; i < cap; i++) {
        const el = elements[i] as any;
        for (const key of Object.getOwnPropertyNames(el)) {
          if (/^__react(?:Container|Fiber|Props)\$/.test(key)) {
            domMarkers.add(key.slice(0, 40));
            break;
          }
        }
      }
    } catch {}

    const presentSelectors: string[] = [];
    for (const selector of requested.selectors) {
      try {
        if (document.querySelector(selector)) presentSelectors.push(selector);
      } catch {
        // Invalid selectors are ignored, not surfaced as detections.
      }
    }

    const presentJsProperties: Record<string, string | boolean> = {};
    const getPath = (path: string): any => {
      let value: any = g;
      for (const part of path.split(".")) {
        if (part === "window" || part === "globalThis") continue;
        if (value == null) return undefined;
        value = value[part];
      }
      return value;
    };
    for (const property of requested.jsProperties) {
      const value = getPath(property);
      if (value === undefined || value === null) continue;
      if (typeof value === "string" || typeof value === "boolean") {
        presentJsProperties[property] = value;
      } else {
        presentJsProperties[property] = true;
      }
    }

    return {
      globals: globals.sort(),
      domMarkers: [...domMarkers].sort(),
      versions,
      presentSelectors: [...new Set(presentSelectors)].sort(),
      presentJsProperties,
    };
  }, { selectors: manifest.selectors, jsProperties: manifest.jsProperties });
}
async function collectDomSnapshot(page: Page, maxChars: number): Promise<RuntimeDomSnapshot> {
  // NOTE ON TYPES: this callback runs INSIDE the browser (Playwright
  // serializes it), where `document`/`HTMLElement` genuinely exist at
  // runtime. This project's tsconfig.json intentionally has no "dom" in
  // its `lib` array (a shared, global config file this feature does not
  // own/modify), so the callback body below deliberately goes through
  // `globalThis as any` rather than referencing `document`/`HTMLElement`
  // as ambient globals - this keeps the callback typecheck-safe under
  // this project's existing lib configuration without any project-wide
  // config change.
  return page.evaluate((cap: number) => {
    const doc = (globalThis as any).document;
    const body = doc?.body;
    const text: string = body ? body.innerText || "" : "";
    const hasMedia = doc.querySelectorAll("img, video, canvas, svg").length > 0;
    return {
      visibleTextLength: text.length,
      visibleTextSample: text.slice(0, cap),
      elementCount: doc.querySelectorAll("*").length,
      hasBodyContent: text.trim().length > 0 || hasMedia,
    };
  }, maxChars);
}

/**
 * Static, non-interactive form inspection - reads attributes only, NEVER
 * fills in or submits anything (this feature must not trigger real-world
 * side effects like sending an email or placing an order).
 */
async function collectForms(page: Page, finalUrl: string): Promise<RuntimeFormInfo[]> {
  // Same DOM-typing note as collectDomSnapshot() above.
  return page.evaluate((pageHref: string) => {
    const doc = (globalThis as any).document;
    const isHttpsPage = pageHref.startsWith("https://");
    return Array.from(doc.forms).map((form: any) => {
      const rawAction = form.getAttribute("action");
      let resolvedAction: string | null = null;
      try {
        resolvedAction = rawAction ? new URL(rawAction, pageHref).href : pageHref;
      } catch {
        resolvedAction = rawAction;
      }
      const actionIsInsecureHttp = isHttpsPage && !!resolvedAction && resolvedAction.startsWith("http://");
      const hasSubmitControl = !!form.querySelector('button:not([type="button"]):not([type="reset"]), input[type="submit"]');
      return {
        action: resolvedAction,
        method: (form.getAttribute("method") || "get").toLowerCase(),
        isHttpsPage,
        actionIsInsecureHttp,
        hasSubmitControl,
      };
    });
  }, finalUrl);
}

async function collectScreenshot(
  page: Page,
  enabled: boolean,
  viewport: { width: number; height: number },
): Promise<RuntimeScreenshot> {
  if (!enabled) return { enabled: false, viewport };
  try {
    const buf = await page.screenshot({ type: "png" });
    return { enabled: true, base64Png: buf.toString("base64"), viewport };
  } catch {
    // capture attempted but failed (e.g. page in a broken state) - report
    // the attempt honestly rather than silently omitting the field
    return { enabled: true, viewport };
  }
}

function buildContentComparison(rawHtml: string | undefined, renderedVisibleTextLength: number): RuntimeContentComparison | null {
  if (rawHtml === undefined) return null;
  // Measure ONLY visible body text, matching what document.body.innerText
  // measures on the rendered side - without stripping <script>/<style>
  // and <head>, a page's inline JS/CSS source or <title> text would
  // inflate this and make the "sparse raw HTML" signal meaningless.
  const $ = cheerio.load(rawHtml);
  $("script, style, head").remove();
  const rawVisibleText = $("body").text().replace(/\s+/g, " ").trim();
  const rawHtmlVisibleTextLength = rawVisibleText.length;
  return {
    rawHtmlVisibleTextLength,
    renderedVisibleTextLength,
    likelyJsDependentContent: rawHtmlVisibleTextLength < RAW_SPARSE_TEXT_THRESHOLD && renderedVisibleTextLength >= RAW_SPARSE_TEXT_THRESHOLD,
  };
}

/**
 * Non-throwing wrapper, mirroring pipeline.ts's safeAnalyzePerformance()
 * / PageSpeedProvider's "never throws" contract: every failure mode
 * (blocked target, launch failure, navigation failure, timeout, an
 * unexpected exception) resolves to a RuntimeVerificationReport with
 * status "error" instead of throwing, so a caller (the pipeline) can
 * always continue. A browser failure never silently becomes a
 * successful scan - status is always explicit.
 */
export async function runBrowserVerification(rawUrl: string, options: CollectRuntimeOptions = {}): Promise<RuntimeVerificationReport> {
  logEvent("browser_scan_started", { url: rawUrl });
  try {
    const evidence = await collectRuntime(rawUrl, options);
    const findings = detectRuntimeFindings(evidence);
    logEvent("browser_scan_completed", {
      url: rawUrl,
      finalUrl: evidence.finalUrl,
      jsErrorCount: evidence.jsErrors.length,
      failedRequestCount: evidence.requests.filter((r) => r.outcome === "failed").length,
      findingCount: findings.length,
    });
    return { status: "completed", evidence, findings };
  } catch (err) {
    if (err instanceof CollectorError) {
      logEvent("browser_scan_failed", { url: rawUrl, code: err.code, reason: err.message });
      return { status: "error", errorMessage: err.message, errorCode: err.code, evidence: null, findings: [] };
    }
    logEvent("browser_scan_failed", { url: rawUrl, code: "RUNTIME_COLLECTION_FAILED", reason: "unexpected exception" });
    return {
      status: "error",
      errorMessage: "Browser verification failed unexpectedly.",
      errorCode: "RUNTIME_COLLECTION_FAILED",
      evidence: null,
      findings: [],
    };
  }
}
