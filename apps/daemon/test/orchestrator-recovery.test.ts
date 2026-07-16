import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerationTaskRecoverySummary } from "../../../packages/core/src/index.ts";
import {
  recoverGenerationPlans,
  type GenerationPlanRecoveryDeps,
  type GenerationPlanRecoveryWarningContext,
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
  const warnings: Array<{ context: GenerationPlanRecoveryWarningContext; message: string }> = [];
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
      warn(context: GenerationPlanRecoveryWarningContext, message: string) {
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
      context: {
        operation: "compile-approved-shell",
        planId: "plan-invalid",
        error: compileError,
      },
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

test("recoverGenerationPlans isolates asynchronous compilation per approved shell", async () => {
  const order: string[] = [];
  const compileError = new Error("async compile failed");
  const warnings: Array<{ context: unknown; message: string }> = [];
  const deps = {
    store: {
      listApprovedGenerationPlanShells: () => [
        { id: "plan-before" },
        { id: "plan-bad" },
        { id: "plan-after" },
      ],
      recoverExpiredGenerationTaskAttempts: () => recoverySummary(),
    },
    planService: {
      async compileAndEnqueueApprovedShell(planId: string) {
        order.push(`compile:${planId}`);
        if (planId === "plan-bad") throw compileError;
      },
      async reconcileNeedsRebaseTasks() {
        return { planIds: [] };
      },
    },
    clock: { now: () => 90_000 },
    logger: {
      warn(context: unknown, message: string) {
        warnings.push({ context, message });
      },
    },
  } satisfies GenerationPlanRecoveryDeps;

  await recoverGenerationPlans(deps);

  assert.deepEqual(order, ["compile:plan-before", "compile:plan-bad", "compile:plan-after"]);
  assert.deepEqual(warnings, [{
    context: {
      operation: "compile-approved-shell",
      planId: "plan-bad",
      error: compileError,
    },
    message: "generation plan compilation failed during recovery",
  }]);
});

test("recoverGenerationPlans observes expired-attempt recovery failure and still reconciles rebase work", async () => {
  const order: string[] = [];
  const expiredError = new Error("sqlite busy during lease recovery");
  const warnings: Array<{ context: unknown; message: string }> = [];
  const deps = {
    store: {
      listApprovedGenerationPlanShells: () => [],
      recoverExpiredGenerationTaskAttempts() {
        order.push("recover-expired");
        throw expiredError;
      },
    },
    planService: {
      compileAndEnqueueApprovedShell() {},
      async reconcileNeedsRebaseTasks() {
        order.push("reconcile-needs-rebase");
        return { planIds: ["plan-rebased"] };
      },
    },
    clock: { now: () => 100_000 },
    logger: {
      warn(context: unknown, message: string) {
        warnings.push({ context, message });
      },
    },
  } satisfies GenerationPlanRecoveryDeps;

  const summary = await recoverGenerationPlans(deps);

  assert.deepEqual(order, ["recover-expired", "reconcile-needs-rebase"]);
  assert.deepEqual(summary.planIds, ["plan-rebased"]);
  assert.deepEqual(warnings, [{
    context: { operation: "recover-expired-attempts", error: expiredError },
    message: "expired generation Attempt recovery failed during startup",
  }]);
});

test("recoverGenerationPlans observes shell-list and rebase failures without discarding completed lease recovery", async () => {
  const listError = new Error("approved shell scan failed");
  const rebaseError = new Error("rebase adapter unavailable");
  const warnings: Array<{ context: unknown; message: string }> = [];
  const deps = {
    store: {
      listApprovedGenerationPlanShells() {
        throw listError;
      },
      recoverExpiredGenerationTaskAttempts: () => recoverySummary({
        planIds: ["plan-expired"],
        retriedTaskIds: ["task-retried"],
      }),
    },
    planService: {
      compileAndEnqueueApprovedShell() {
        assert.fail("no shell can be compiled after the list operation failed");
      },
      async reconcileNeedsRebaseTasks() {
        throw rebaseError;
      },
    },
    clock: { now: () => 110_000 },
    logger: {
      warn(context: unknown, message: string) {
        warnings.push({ context, message });
      },
    },
  } satisfies GenerationPlanRecoveryDeps;

  const summary = await recoverGenerationPlans(deps);

  assert.deepEqual(summary, {
    planIds: ["plan-expired"],
    retriedTaskIds: ["task-retried"],
    needsRebaseTaskIds: [],
    cancelledTaskIds: [],
    failedTaskIds: [],
  });
  assert.deepEqual(warnings, [
    {
      context: { operation: "list-approved-shells", error: listError },
      message: "approved generation Plan scan failed during startup",
    },
    {
      context: { operation: "reconcile-needs-rebase", error: rebaseError },
      message: "generation Task rebase reconciliation failed during startup",
    },
  ]);
});
