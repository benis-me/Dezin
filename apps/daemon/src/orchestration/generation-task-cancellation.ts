import type { GenerationTaskAttemptClaim } from "../../../../packages/core/src/index.ts";

export type GenerationTaskCancellationCause = Readonly<
  | {
      reason: "plan-cancelled";
      planId: string;
      blockedByTaskId: null;
    }
  | {
      reason: "prerequisite-failed";
      planId: string;
      blockedByTaskId: string;
    }
>;

/**
 * Interprets only the coherent, durable Task + Attempt cancellation state.
 * The failed prerequisite identity is stored on the Task, while a user Plan
 * cancellation deliberately clears it.
 */
export function generationTaskCancellationCause(
  claim: GenerationTaskAttemptClaim,
): GenerationTaskCancellationCause | null {
  if (claim.task.status !== "cancel-requested"
    || claim.attempt.status !== "cancel-requested") return null;
  if (claim.task.blockedByTaskId !== null) {
    return Object.freeze({
      reason: "prerequisite-failed",
      planId: claim.attempt.planId,
      blockedByTaskId: claim.task.blockedByTaskId,
    });
  }
  return Object.freeze({
    reason: "plan-cancelled",
    planId: claim.attempt.planId,
    blockedByTaskId: null,
  });
}
