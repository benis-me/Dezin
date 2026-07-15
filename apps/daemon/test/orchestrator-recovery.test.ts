import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerationTaskRecoverySummary } from "../../../packages/core/src/index.ts";
import {
  recoverGenerationPlans,
  type GenerationPlanRecoveryDeps,
} from "../src/orchestration/recovery.ts";

function recoverySummary(
  overrides: Partial<GenerationTaskRecoverySummary> = {},
): GenerationTaskRecoverySummary {
  return {
    planIds: [],
    retriedTaskIds: [],
    needsRebaseTaskIds: [],
    cancelledTaskIds: [],
    failedTaskIds: [],
    ...overrides,
  };
}

test("recoverGenerationPlans isolates each approved shell and continues startup recovery after a compile failure", async () => {
  const order: string[] = [];
  const compileError = new Error("proposal revision is no longer valid");
  const warnings: Array<{ context: { planId: string; error: unknown }; message: string }> = [];
  const deps = {
    store: {
      listApprovedGenerationPlanShells() {
        order.push("list-approved");
        return [
          { id: "plan-valid-before" },
          { id: "plan-invalid" },
          { id: "plan-valid-after" },
        ];
      },
      recoverExpiredGenerationTaskAttempts(now: number) {
        order.push(`recover-expired:${now}`);
        return recoverySummary({ planIds: ["plan-expired"] });
      },
    },
    planService: {
      compileAndEnqueueApprovedShell(planId: string) {
        order.push(`compile:${planId}`);
        if (planId === "plan-invalid") throw compileError;
      },
      async reconcileNeedsRebaseTasks() {
        order.push("reconcile-needs-rebase");
        return { planIds: ["plan-rebased"] };
      },
    },
    clock: {
      now() {
        order.push("clock-now");
        return 70_000;
      },
    },
    logger: {
      warn(context: { planId: string; error: unknown }, message: string) {
        warnings.push({ context, message });
      },
    },
  } satisfies GenerationPlanRecoveryDeps;

  const result = await recoverGenerationPlans(deps);

  assert.deepEqual(order, [
    "list-approved",
    "compile:plan-valid-before",
    "compile:plan-invalid",
    "compile:plan-valid-after",
    "clock-now",
    "recover-expired:70000",
    "reconcile-needs-rebase",
  ]);
  assert.deepEqual(warnings, [
    {
      context: { planId: "plan-invalid", error: compileError },
      message: "generation plan compilation failed during recovery",
    },
  ]);
  assert.deepEqual(result.planIds, ["plan-expired", "plan-rebased"]);
});

test("recoverGenerationPlans preserves lease dispositions while merging stable unique plan ids", async () => {
  const expired = recoverySummary({
    planIds: ["plan-expired", "plan-shared", "plan-expired"],
    retriedTaskIds: ["task-retried"],
    needsRebaseTaskIds: ["task-needs-rebase"],
    cancelledTaskIds: ["task-cancelled"],
    failedTaskIds: ["task-failed"],
  });
  let expiredRecoveryCalls = 0;
  let reconciliationCalls = 0;
  const deps = {
    store: {
      listApprovedGenerationPlanShells: () => [],
      recoverExpiredGenerationTaskAttempts(now: number) {
        expiredRecoveryCalls += 1;
        assert.equal(now, 80_000);
        return expired;
      },
    },
    planService: {
      compileAndEnqueueApprovedShell() {
        assert.fail("there are no approved shells to compile");
      },
      async reconcileNeedsRebaseTasks() {
        reconciliationCalls += 1;
        return {
          planIds: ["plan-shared", "plan-rebased", "plan-rebased"],
        };
      },
    },
    clock: { now: () => 80_000 },
    logger: {
      warn() {
        assert.fail("recovery should not warn without a shell compile failure");
      },
    },
  } satisfies GenerationPlanRecoveryDeps;

  const result = await recoverGenerationPlans(deps);

  assert.equal(expiredRecoveryCalls, 1);
  assert.equal(reconciliationCalls, 1);
  assert.deepEqual(result, {
    planIds: ["plan-expired", "plan-shared", "plan-rebased"],
    retriedTaskIds: ["task-retried"],
    needsRebaseTaskIds: ["task-needs-rebase"],
    cancelledTaskIds: ["task-cancelled"],
    failedTaskIds: ["task-failed"],
  });
});
