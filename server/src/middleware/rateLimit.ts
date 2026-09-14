import type { NextFunction, Request, Response } from "express";
import { logEvent } from "../logging/logger.js";

export interface RateLimiterOptions {
  /** max requests allowed per window, per key */
  max: number;
  /** window length in ms */
  windowMs: number;
  /** derives the bucket key from a request - defaults to req.ip */
  keyFn?: (req: Request) => string;
  /** injectable for deterministic tests - defaults to Date.now */
  now?: () => number;
}

/**
 * Simple in-memory fixed-window rate limiter. One Map entry per key
 * (typically per client IP); resets on its own once the window elapses,
 * no external store required. Good enough for a single-process MVP -
 * swap for a Redis-backed limiter (same middleware signature) if this
 * ever runs behind more than one server instance.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const now = options.now ?? Date.now;
  const keyFn = options.keyFn ?? ((req: Request) => req.ip ?? "unknown");
  const hits = new Map<string, { count: number; resetAt: number }>();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const key = keyFn(req);
    const t = now();

    let entry = hits.get(key);
    if (!entry || t >= entry.resetAt) {
      entry = { count: 0, resetAt: t + options.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, options.max - entry.count);
    res.setHeader("X-RateLimit-Limit", String(options.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));

    if (entry.count > options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      logEvent("rate_limit_rejected", { key, retryAfterSeconds });
      res.status(429).json({
        error: "Too many analysis requests. Please slow down and try again shortly.",
        code: "RATE_LIMITED",
        retryAfterSeconds,
      });
      return;
    }

    next();
  };
}
