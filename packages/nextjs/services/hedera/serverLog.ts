type ServerLogLevel = "warn" | "error";

/** Node's fetch reports every network failure as "fetch failed" and keeps the real reason in `cause`. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.name}: ${error.message}${cause}`;
}

/**
 * One JSON line per event on stderr. Callers pass statuses and error messages only: request and
 * response bodies stay out of the logs.
 */
export function logServerEvent(
  level: ServerLogLevel,
  module: string,
  msg: string,
  fields: Record<string, string | number | null> = {},
): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, module, msg, ...fields })}\n`);
}
