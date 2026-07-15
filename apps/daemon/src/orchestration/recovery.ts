import type { GenerationTaskRecoverySummary } from "../../../../packages/core/src/index.ts";

export interface GenerationPlanRecoveryDeps {
  store: {
    listApprovedGenerationPlanShells(): readonly { id: string }[];
    recoverExpiredGenerationTaskAttempts(now: number): GenerationTaskRecoverySummary;
  };
  planService: {
    compileAndEnqueueApprovedShell(planId: string): unknown;
    reconcileNeedsRebaseTasks(): Promise<{ planIds: readonly string[] }>;
  };
  clock: { now(): number };
  logger: {
    warn(context: { planId: string; error: unknown }, message: string): void;
  };
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Reconcile all correctness-critical durable Generation state before admission. */
export async function recoverGenerationPlans(
  deps: GenerationPlanRecoveryDeps,
): Promise<GenerationTaskRecoverySummary> {
  for (const shell of deps.store.listApprovedGenerationPlanShells()) {
    try {
      deps.planService.compileAndEnqueueApprovedShell(shell.id);
    } catch (error) {
      deps.logger.warn(
        { planId: shell.id, error },
        "generation plan compilation failed during recovery",
      );
    }
  }

  const expired = deps.store.recoverExpiredGenerationTaskAttempts(deps.clock.now());
  const rebased = await deps.planService.reconcileNeedsRebaseTasks();
  return {
    planIds: stableUnique([...expired.planIds, ...rebased.planIds]),
    retriedTaskIds: stableUnique(expired.retriedTaskIds),
    needsRebaseTaskIds: stableUnique(expired.needsRebaseTaskIds),
    cancelledTaskIds: stableUnique(expired.cancelledTaskIds),
    failedTaskIds: stableUnique(expired.failedTaskIds),
  };
}
