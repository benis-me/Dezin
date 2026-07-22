import type { GenerationPlanEventsPort } from "./generation-plan-events.ts";

/** Process-local controls are latency hints only; SQLite remains authoritative. */
export interface GenerationPlanRuntimeControl {
  requestTick(): void;
  requestCancellation?(projectId: string, planId: string): void;
}

/**
 * A committed Plan transition must never be reported as failed because an
 * in-memory wake-up observer threw. The scheduler poll and durable SSE replay
 * remain the correctness fallback for both failures.
 */
export function wakeGenerationPlan(
  events: GenerationPlanEventsPort | undefined,
  runtime: GenerationPlanRuntimeControl | undefined,
  planId: string,
): void {
  try {
    events?.notify(planId);
  } catch {
    // Wake-only observer; the durable event journal is authoritative.
  }
  try {
    runtime?.requestTick();
  } catch {
    // The bounded scheduler poll will observe the committed transition.
  }
}

export function requestGenerationPlanCancellation(
  runtime: GenerationPlanRuntimeControl | undefined,
  projectId: string,
  planId: string,
): void {
  try {
    runtime?.requestCancellation?.(projectId, planId);
  } catch {
    // The live worker observes cancel-requested at heartbeat/lease recovery.
  }
}
