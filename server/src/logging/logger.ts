/**
 * Minimal structured logging. Deliberately not a dependency (pino/winston
 * etc. would be overkill for "log a handful of events as JSON lines") -
 * this is a ~30 line wrapper around console.log that guarantees a
 * consistent shape and gives callers nowhere to accidentally pass a
 * secret: the field type only accepts primitives, so an API key object
 * or a raw Error can't be spread into it by accident.
 */
export type LogEvent =
  | "scan_started"
  | "scan_completed"
  | "scan_failed"
  | "cache_hit"
  | "cache_miss"
  | "pagespeed_request"
  | "pagespeed_failure"
  | "rate_limit_rejected"
  | "target_timeout";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const SENSITIVE_KEY_PATTERN = /key|token|secret|password|authorization|cookie/i;

function redact(fields: LogFields): LogFields {
  const clean: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    clean[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[redacted]" : v;
  }
  return clean;
}

export function logEvent(event: LogEvent, fields: LogFields = {}): void {
  const line = {
    ts: new Date().toISOString(),
    event,
    ...redact(fields),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
