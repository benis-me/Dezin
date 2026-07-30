import type { GenerationPlan } from "../../lib/api.ts";

const INTERNAL_FAILURE_DETAIL =
  /\/(?:Users|home|private|tmp|var|opt|usr|Applications|Volumes)(?:\/[^\s/),;:'"]+)+|\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{32,})\b/gi;

export function publicFailureMessage(value: string): string {
  return value.replace(INTERNAL_FAILURE_DETAIL, (detail) => {
    if (!detail.startsWith("/")) return "internal reference";
    const name = detail.split("/").at(-1) ?? "";
    return /^[a-zA-Z0-9._-]{1,80}$/.test(name) ? name : "local path";
  });
}

export function generationPlanFailureMessage(
  plan: Pick<GenerationPlan, "compileError">,
): string | null {
  if (plan.compileError === null) return null;
  const message = plan.compileError.message;
  return typeof message === "string" && message.trim().length > 0
    ? publicFailureMessage(message.trim())
    : "The approved proposal could not be compiled.";
}
