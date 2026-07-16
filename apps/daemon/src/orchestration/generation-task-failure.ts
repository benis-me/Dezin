import type { GenerationTaskFailureClass } from "../../../../packages/core/src/index.ts";
import { BlockedContextError } from "../context/context-types.ts";

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

export function reflectedGenerationTaskErrorString(error: unknown, key: string): string | null {
  try {
    const candidate = error !== null && (typeof error === "object" || typeof error === "function")
      ? Reflect.get(error, key)
      : null;
    return typeof candidate === "string" ? candidate : null;
  } catch {
    return null;
  }
}

function isBlockedContextError(error: unknown): boolean {
  try {
    return error instanceof BlockedContextError;
  } catch {
    return false;
  }
}

export function classifyGenerationTaskError(
  error: unknown,
  fallback: GenerationTaskFailureClass = "unknown",
): GenerationTaskFailureClass {
  const name = reflectedGenerationTaskErrorString(error, "name");
  if (isBlockedContextError(error) || name === "BlockedContextError" || name === "ContextIntegrityError") {
    return "context";
  }
  const declared = reflectedGenerationTaskErrorString(error, "failureClass");
  if (declared !== null && GENERATION_TASK_FAILURE_CLASSES.has(declared as GenerationTaskFailureClass)) {
    return declared as GenerationTaskFailureClass;
  }
  const code = reflectedGenerationTaskErrorString(error, "code");
  if (code !== null && (code.startsWith("SQLITE_")
    || code === "EIO" || code === "ENOSPC" || code === "EROFS" || code === "EMFILE")) {
    return "storage";
  }
  return fallback;
}
