/**
 * Structured JSON logger. Writes to stdout for Railway to ingest.
 */

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    process.env.NODE_ENV !== "production" && emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
};
