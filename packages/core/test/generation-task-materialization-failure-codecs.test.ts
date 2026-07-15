import assert from "node:assert/strict";
import test from "node:test";

import {
  asGenerationTaskMaterializationFailure,
  normalizeRecordGenerationTaskMaterializationFailureInput,
} from "../src/index.ts";

test("materialization failure input canonicalizes diagnostics and rejects unsupported state", () => {
  const input = normalizeRecordGenerationTaskMaterializationFailureInput({
    taskId: "  task-page-home  ",
    expectedFailureCount: 1,
    failureClass: "provider",
    error: {
      retryable: true,
      details: { z: 2, a: 1 },
      code: "provider-unavailable",
    },
    nextEligibleAt: 4_000,
  });

  assert.deepEqual(input, {
    taskId: "task-page-home",
    expectedFailureCount: 1,
    failureClass: "provider",
    error: {
      code: "provider-unavailable",
      details: { a: 1, z: 2 },
      retryable: true,
    },
    nextEligibleAt: 4_000,
  });
  assert.throws(
    () => normalizeRecordGenerationTaskMaterializationFailureInput({
      ...input,
      failureClass: "network",
    }),
    /failure class is unsupported/i,
  );
  assert.throws(
    () => normalizeRecordGenerationTaskMaterializationFailureInput({
      ...input,
      nextEligibleAt: Number.MAX_SAFE_INTEGER + 1,
    }),
    /next eligible at.*safe integer/i,
  );
  assert.throws(
    () => normalizeRecordGenerationTaskMaterializationFailureInput({
      ...input,
      expectedFailureCount: -1,
    }),
    /expected failure count.*safe integer/i,
  );
  assert.throws(
    () => normalizeRecordGenerationTaskMaterializationFailureInput({
      ...input,
      error: [],
    }),
    /error must be a JSON object/i,
  );
  assert.throws(
    () => normalizeRecordGenerationTaskMaterializationFailureInput({
      ...input,
      sequence: 1,
    }),
    /unsupported field sequence/i,
  );
});

test("materialization failure row codec enforces contiguous sequence and canonical durable timestamps", () => {
  const row = {
    task_id: "task-page-home",
    plan_id: "plan-1",
    workspace_id: "workspace-1",
    sequence: 2,
    failure_class: "storage",
    error_json: '{"code":"write-conflict","details":{"path":"state.db"}}',
    next_eligible_at: 2_000,
    created_at: 1_000,
  };

  assert.deepEqual(asGenerationTaskMaterializationFailure(row, 2), {
    taskId: "task-page-home",
    planId: "plan-1",
    workspaceId: "workspace-1",
    sequence: 2,
    failureClass: "storage",
    error: { code: "write-conflict", details: { path: "state.db" } },
    nextEligibleAt: 2_000,
    createdAt: 1_000,
  });
  assert.throws(
    () => asGenerationTaskMaterializationFailure(row, 1),
    /contiguous sequence/i,
  );
  assert.throws(
    () => asGenerationTaskMaterializationFailure({
      ...row,
      error_json: '{"details":{"path":"state.db"},"code":"write-conflict"}',
    }, 2),
    /error.*canonical JSON encoding/i,
  );
  assert.throws(
    () => asGenerationTaskMaterializationFailure({
      ...row,
      next_eligible_at: 999,
    }, 2),
    /next eligible at.*before.*created/i,
  );
  assert.throws(
    () => asGenerationTaskMaterializationFailure({
      ...row,
      sequence: Number.MAX_SAFE_INTEGER + 1,
    }, Number.MAX_SAFE_INTEGER),
    /sequence.*safe integer/i,
  );
  assert.throws(
    () => asGenerationTaskMaterializationFailure({
      ...row,
      created_at: -1,
    }, 2),
    /created at.*safe integer/i,
  );
});
