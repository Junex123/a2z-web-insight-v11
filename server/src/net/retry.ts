/**
 * A small, generic retry helper for transient external-call failures.
 * Deliberately not a library dependency - this is ~20 lines because the
 * need is simple: retry a bounded number of times, with backoff, only
 * for errors the caller says are worth retrying.
 */
export interface RetryOptions {
  /** number of retry attempts AFTER the first try (0 = no retries) */
  maxRetries: number;
  /** base delay in ms; actual delay is baseDelayMs * 2^attempt */
  baseDelayMs: number;
  /** decides whether a given failure is worth retrying */
  shouldRetry: (error: unknown, attempt: number) => boolean;
  /** injectable for deterministic tests - defaults to a real setTimeout wait */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= options.maxRetries || !options.shouldRetry(err, attempt)) {
        throw err;
      }
      await sleep(options.baseDelayMs * 2 ** attempt);
      attempt += 1;
    }
  }
}
