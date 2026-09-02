/**
 * One choke point for daemon logging. Every line carries a level and an ISO
 * timestamp; `DEZIN_LOG_LEVEL` (debug | info | warn | error, default info)
 * filters what reaches stdout/stderr. Messages and structured fields are passed
 * through unchanged so existing tests that capture console output keep working.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = process.env.DEZIN_LOG_LEVEL?.trim().toLowerCase();
  return raw !== undefined && raw in ORDER ? ORDER[raw as LogLevel] : ORDER.info;
}

function emit(level: LogLevel, message: unknown, rest: unknown[]): void {
  if (ORDER[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${typeof message === "string" ? message : String(message)}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line, ...rest);
}

export const log = {
  debug: (message: unknown, ...rest: unknown[]): void => emit("debug", message, rest),
  info: (message: unknown, ...rest: unknown[]): void => emit("info", message, rest),
  warn: (message: unknown, ...rest: unknown[]): void => emit("warn", message, rest),
  error: (message: unknown, ...rest: unknown[]): void => emit("error", message, rest),
};
