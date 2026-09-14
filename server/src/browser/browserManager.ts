import { chromium, type Browser } from "playwright";

/**
 * Lazily launches ONE shared headless Chromium process and reuses it
 * across scans - launching a whole new browser process per page would
 * be wasteful and is explicitly called out against in this feature's
 * brief ("the architecture must not launch an entirely new browser
 * process for every page unless there is a concrete reason"). Each
 * individual scan still gets its own isolated BrowserContext (its own
 * cookie jar / storage / cache), created and closed per call by
 * collectors/browserCollector.ts - only the underlying browser PROCESS
 * is shared. This mirrors the existing `sharedCachingProvider` pattern
 * in pipeline.ts (one process-wide instance, built lazily on first use).
 */

export type LaunchBrowserFn = () => Promise<Browser>;

const defaultLaunch: LaunchBrowserFn = () => chromium.launch({ headless: true });

let sharedBrowser: Browser | undefined;
let launchPromise: Promise<Browser> | undefined;

/**
 * Returns the shared browser, launching it on first use. `launchFn` is
 * injectable so tests can simulate a launch failure (or supply a
 * pre-configured browser) without needing a real, broken Chromium
 * install - see browserCollector.test.ts. Production call sites never
 * pass it.
 */
export async function getSharedBrowser(launchFn: LaunchBrowserFn = defaultLaunch): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;

  if (!launchPromise) {
    launchPromise = launchFn()
      .then((browser) => {
        sharedBrowser = browser;
        // if the browser process crashes/closes on its own, forget it so
        // the next call launches a fresh one instead of reusing a dead handle
        browser.on("disconnected", () => {
          if (sharedBrowser === browser) sharedBrowser = undefined;
        });
        return browser;
      })
      .finally(() => {
        launchPromise = undefined;
      });
  }
  return launchPromise;
}

/**
 * Explicit shutdown - used by tests' `after()` hooks and by the server's
 * graceful-shutdown handler (see server.ts) so a process restart never
 * leaves an orphan Chromium process behind.
 */
export async function closeSharedBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = undefined;
  launchPromise = undefined;
  if (browser) {
    try {
      await browser.close();
    } catch {
      // already closed/crashed - nothing to clean up
    }
  }
}

/** for tests only - lets a test assert on shared-browser state without exporting the variable itself */
export function isSharedBrowserConnected(): boolean {
  return sharedBrowser?.isConnected() ?? false;
}

// ---------------------------------------------------------------------
// A small counting semaphore, bounding how many scans can be running a
// browser page concurrently at once. Deliberately not a dependency
// (p-limit et al. would be overkill for ~20 lines of logic) - matches
// this project's existing "small, dependency-free helper" convention
// (see cache/, net/retry.ts, middleware/rateLimit.ts).
// ---------------------------------------------------------------------

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** for tests only */
  activeCount(): number {
    return this.active;
  }
}

const DEFAULT_MAX_CONCURRENCY = Number(process.env.BROWSER_MAX_CONCURRENCY) || 2;
const sharedLimiter = new ConcurrencyLimiter(DEFAULT_MAX_CONCURRENCY);

/** Runs `fn` under the process-wide browser concurrency limit (BROWSER_MAX_CONCURRENCY, default 2). */
export function withBrowserConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  return sharedLimiter.run(fn);
}
