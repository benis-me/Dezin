import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessGroupCleanupError, terminateOwnedProcessGroup } from "../src/process-group.ts";

test("terminateOwnedProcessGroup surfaces a group that survives SIGKILL", async () => {
  const signals: NodeJS.Signals[] = [];
  let alive = true;
  let cleanupError: ProcessGroupCleanupError | undefined;
  await assert.rejects(
    terminateOwnedProcessGroup({
      label: "fixture",
      termGraceMs: 1,
      killGraceMs: 1,
      pollMs: 1,
      signal: (value) => signals.push(value),
      isAlive: () => alive,
    }),
    (error) => {
      if (error instanceof ProcessGroupCleanupError) cleanupError = error;
      return error instanceof ProcessGroupCleanupError && error.code === "PROCESS_GROUP_CLEANUP_FAILED";
    },
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  alive = false;
  await cleanupError!.whenGone;
});

test("terminateOwnedProcessGroup resolves only after the group is gone", async () => {
  let alive = true;
  await terminateOwnedProcessGroup({
    label: "fixture",
    termGraceMs: 1,
    killGraceMs: 10,
    pollMs: 1,
    signal: (value) => {
      if (value === "SIGKILL") alive = false;
    },
    isAlive: () => alive,
  });
  assert.equal(alive, false);
});
