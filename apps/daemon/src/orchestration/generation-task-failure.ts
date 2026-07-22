import { types as nodeUtilTypes } from "node:util";

import type { GenerationTaskFailureClass } from "../../../../packages/core/src/index.ts";

const MAX_PRIMARY_ERROR_DEPTH = 8;
const MAX_CLEANUP_FAILURE_COUNT = 8;

export class GenerationTaskDeadlineExceededError extends Error {
  readonly code = "generation-task-deadline-exceeded";
  readonly failureClass = "agent-transport";
  readonly taskId: string;
  readonly attempt: number;
  readonly timeoutMs: number;

  constructor(input: { taskId: string; attempt: number; timeoutMs: number }) {
    if (input.taskId.length === 0
      || !Number.isSafeInteger(input.attempt) || input.attempt <= 0
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new TypeError("Generation Task deadline identity and timeout must be valid");
    }
    super("Generation Task exceeded its frozen execution deadline");
    this.name = "GenerationTaskDeadlineExceededError";
    this.taskId = input.taskId;
    this.attempt = input.attempt;
    this.timeoutMs = input.timeoutMs;
    Object.freeze(this);
  }
}

export const GENERATION_TASK_FAILURE_CLASSES: ReadonlySet<GenerationTaskFailureClass> = new Set([
  "context",
  "adapter",
  "storage",
  "provider",
  "agent-transport",
  "build-infrastructure",
  "design",
  "build",
  "qa",
  "publication-conflict",
  "cancelled",
  "unknown",
]);

function isSafelyInspectable(value: unknown): value is object {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return !nodeUtilTypes.isProxy(value);
  } catch {
    return false;
  }
}

export function reflectedGenerationTaskErrorValue(error: unknown, key: string): unknown {
  if (!isSafelyInspectable(error)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function reflectedGenerationTaskErrorString(error: unknown, key: string): string | null {
  const candidate = reflectedGenerationTaskErrorValue(error, key);
  return typeof candidate === "string" ? candidate : null;
}

function safeArrayLength(value: unknown): number | null {
  if (!isSafelyInspectable(value)) return null;
  try {
    if (!Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    return descriptor !== undefined && "value" in descriptor
      && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
      ? descriptor.value as number
      : null;
  } catch {
    return null;
  }
}

function safeArrayFirst(value: unknown): unknown {
  if (!isSafelyInspectable(value)) return undefined;
  try {
    if (!Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "0");
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export interface GenerationTaskErrorInspection {
  readonly primary: unknown;
  readonly cleanupFailureCount: number;
  readonly truncated: boolean;
}

/**
 * Follows only a cleanup-Aggregate shape with an own data-valued `errors`
 * Array containing a primary plus at least one cleanup failure. `cause` is
 * accepted only when it is the same value as `errors[0]`; otherwise the first
 * error is authoritative. Accessors, Proxies, ordinary Error causes, cycles,
 * and over-deep chains fail closed without reflection side effects.
 */
export function inspectGenerationTaskError(error: unknown): GenerationTaskErrorInspection {
  let primary = error;
  let cleanupFailureCount = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth < MAX_PRIMARY_ERROR_DEPTH; depth += 1) {
    if (isSafelyInspectable(primary)) {
      if (seen.has(primary)) {
        truncated = true;
        break;
      }
      seen.add(primary);
    }
    const errors = reflectedGenerationTaskErrorValue(primary, "errors");
    const errorCount = safeArrayLength(errors);
    if (errorCount === null || errorCount < 2) break;
    const remaining = MAX_CLEANUP_FAILURE_COUNT - cleanupFailureCount;
    const additional = errorCount - 1;
    cleanupFailureCount += Math.min(remaining, additional);
    if (additional > remaining) truncated = true;
    const first = safeArrayFirst(errors);
    const cause = reflectedGenerationTaskErrorValue(primary, "cause");
    const next = cause !== undefined && cause === first ? cause : first;
    if (next === undefined || next === primary) break;
    primary = next;
    if (depth === MAX_PRIMARY_ERROR_DEPTH - 1) truncated = true;
  }
  return Object.freeze({ primary, cleanupFailureCount, truncated });
}

export function classifyGenerationTaskError(
  error: unknown,
  fallback: GenerationTaskFailureClass = "unknown",
): GenerationTaskFailureClass {
  const primary = inspectGenerationTaskError(error).primary;
  const name = reflectedGenerationTaskErrorString(primary, "name");
  if (name === "BlockedContextError" || name === "ContextIntegrityError") {
    return "context";
  }
  const declared = reflectedGenerationTaskErrorString(primary, "failureClass");
  if (declared !== null && GENERATION_TASK_FAILURE_CLASSES.has(declared as GenerationTaskFailureClass)) {
    return declared as GenerationTaskFailureClass;
  }
  const code = reflectedGenerationTaskErrorString(primary, "code");
  if (code !== null && (code.startsWith("SQLITE_")
    || code === "EIO" || code === "ENOSPC" || code === "EROFS" || code === "EMFILE")) {
    return "storage";
  }
  return fallback;
}
