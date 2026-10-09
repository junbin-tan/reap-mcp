import { randomUUID } from "node:crypto";

export class AppError extends Error {
  readonly traceId = randomUUID();
  data: Record<string, unknown> | null = null;
  retryAfterMs = 5000;

  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly upstreamCode: string | null = null,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function contract(condition: unknown, message = "The provider returned an unexpected contract. No new purchase will be submitted."): asserts condition {
  if (!condition) throw new AppError("UPSTREAM_CONTRACT_ERROR", message, false, null, true);
}

export function asAppError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError("INTERNAL_ERROR", "The operation could not be completed. Check its saved status before retrying.", false, null, true);
}

export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  const permitted = new Set(["code", "trace_id", "mode", "transport", "port", "count", "upstream_code"]);
  const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => permitted.has(key)));
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...safe })}\n`);
}
