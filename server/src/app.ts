import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRouter } from "./routes/analyze.js";
import { analyzeSiteRouter } from "./routes/analyzeSite.js";
import { createRateLimiter, type RateLimiterOptions } from "./middleware/rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, "../../client");

const DEFAULT_RATE_LIMIT = Number(process.env.ANALYZE_RATE_LIMIT) || 30;
const DEFAULT_RATE_WINDOW_MS = (Number(process.env.ANALYZE_RATE_WINDOW) || 60) * 1000;
const DEFAULT_SITE_RATE_LIMIT = Number(process.env.ANALYZE_SITE_RATE_LIMIT) || 5;
const DEFAULT_SITE_RATE_WINDOW_MS = (Number(process.env.ANALYZE_SITE_RATE_WINDOW) || 300) * 1000;

export interface CreateAppOptions {
  /**
   * Override the /api/analyze rate limiter. Pass `false` to disable it
   * entirely (used by tests that need to fire many requests and would
   * otherwise be flaky against a shared default limit). Defaults to an
   * env-configured limiter (ANALYZE_RATE_LIMIT / ANALYZE_RATE_WINDOW).
   */
  rateLimiter?: RateLimiterOptions | false;
  siteRateLimiter?: RateLimiterOptions | false;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  app.set("trust proxy", true); // so req.ip reflects X-Forwarded-For behind a real proxy/load balancer

  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

  const rateLimiterOptions = options.rateLimiter ?? { max: DEFAULT_RATE_LIMIT, windowMs: DEFAULT_RATE_WINDOW_MS };
  if (rateLimiterOptions !== false) {
    app.use("/api/analyze", createRateLimiter(rateLimiterOptions));
  }
  const siteRateLimiterOptions = options.siteRateLimiter ?? { max: DEFAULT_SITE_RATE_LIMIT, windowMs: DEFAULT_SITE_RATE_WINDOW_MS };
  if (siteRateLimiterOptions !== false) {
    app.use("/api/analyze-site", createRateLimiter(siteRateLimiterOptions));
  }
  app.use("/api", analyzeRouter);
  app.use("/api", analyzeSiteRouter);

  // Serve the static dashboard frontend.
  app.use(express.static(clientDir));

  // Catches body-parser errors (oversized/malformed JSON bodies) and any
  // other error that reaches here, so the client always gets a clean
  // JSON error instead of Express's default HTML error page or a crash.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 500;
    console.error("Unhandled request error:", err instanceof Error ? err.message : err);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: status === 413 ? "Request body too large." : "Invalid request.",
      code: status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
    });
  };
  app.use(errorHandler);

  return app;
}
