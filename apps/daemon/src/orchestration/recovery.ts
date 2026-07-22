import {
  GenerationPlanCompileError,
  type GenerationTaskRecoverySummary,
} from "../../../../packages/core/src/index.ts";

export interface GenerationPlanRecoveryDeps {
  store: {
    listApprovedGenerationPlanShells(): readonly { id: string }[];
    recoverExpiredGenerationTaskAttempts(now: number): GenerationTaskRecoverySummary;
  };
  planService: {
    compileAndEnqueueApprovedShell(planId: string): unknown | Promise<unknown>;
    reconcileNeedsRebaseTasks(): Promise<{ planIds: readonly string[] }>;
  };
  clock: { now(): number };
  logger: {
    warn(context: GenerationPlanRecoveryWarningContext, message: string): void;
  };
}

export type GenerationPlanRecoveryWarningContext =
  | { operation: "list-approved-shells"; error: unknown }
  | { operation: "compile-approved-shell"; planId: string; error: unknown }
  | { operation: "recover-expired-attempts"; error: unknown }
  | { operation: "reconcile-needs-rebase"; error: unknown };

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptyRecoverySummary(): GenerationTaskRecoverySummary {
  return {
    planIds: [],
    retriedTaskIds: [],
    needsRebaseTaskIds: [],
    cancelledTaskIds: [],
    failedTaskIds: [],
  };
}

function warn(
  deps: GenerationPlanRecoveryDeps,
  context: GenerationPlanRecoveryWarningContext,
  message: string,
): void {
  try {
    deps.logger.warn(context, message);
  } catch {
    // Startup observability is best-effort and cannot own durable recovery.
  }
}

/** Reconcile all correctness-critical durable Generation state before admission. */
export async function recoverGenerationPlans(
  deps: GenerationPlanRecoveryDeps,
): Promise<GenerationTaskRecoverySummary> {
  const admissionBlockers: unknown[] = [];
  let shells: readonly { id: string }[] = [];
  try {
    shells = deps.store.listApprovedGenerationPlanShells();
  } catch (error) {
    admissionBlockers.push(error);
    warn(
      deps,
      { operation: "list-approved-shells", error },
      "approved generation Plan scan failed during startup",
    );
  }

  for (const shell of shells) {
    try {
      await deps.planService.compileAndEnqueueApprovedShell(shell.id);
    } catch (error) {
      if (!(error instanceof GenerationPlanCompileError)) admissionBlockers.push(error);
      warn(
        deps,
        { operation: "compile-approved-shell", planId: shell.id, error },
        "generation plan compilation failed during recovery",
      );
    }
  }

  let expired = emptyRecoverySummary();
  try {
    expired = deps.store.recoverExpiredGenerationTaskAttempts(deps.clock.now());
  } catch (error) {
    warn(
      deps,
      { operation: "recover-expired-attempts", error },
      "expired generation Attempt recovery failed during startup",
    );
  }

  let rebased: { planIds: readonly string[] } = { planIds: [] };
  try {
    rebased = await deps.planService.reconcileNeedsRebaseTasks();
  } catch (error) {
    warn(
      deps,
      { operation: "reconcile-needs-rebase", error },
      "generation Task rebase reconciliation failed during startup",
    );
  }
  if (admissionBlockers.length > 0) {
    throw new AggregateError(
      admissionBlockers,
      "approved Generation Plan recovery did not reach a durable terminal or executable state",
    );
  }
  return {
    planIds: stableUnique([...expired.planIds, ...rebased.planIds]),
    retriedTaskIds: stableUnique(expired.retriedTaskIds),
    needsRebaseTaskIds: stableUnique(expired.needsRebaseTaskIds),
    cancelledTaskIds: stableUnique(expired.cancelledTaskIds),
    failedTaskIds: stableUnique(expired.failedTaskIds),
  };
}
