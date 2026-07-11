import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessGroupCleanupError, terminateOwnedProcessGroup } from "../src/process-group.ts";

test("terminateOwnedProcessGroup surfaces a group that survives SIGKILL", async () => {
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(
    terminateOwnedProcessGroup({
      label: "fixture",
      termGraceMs: 1,
      killGraceMs: 1,
      pollMs: 1,
      signal: (value) => signals.push(value),
      isAlive: () => true,
    }),
    (error) => error instanceof ProcessGroupCleanupError && error.code === "PROCESS_GROUP_CLEANUP_FAILED",
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
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
