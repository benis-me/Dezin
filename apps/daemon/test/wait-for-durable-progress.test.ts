import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForDurableProgress } from "./support/wait-for-durable-progress.ts";

test("durable progress renews the idle watchdog until the condition settles", async () => {
  let now = 0;
  let version = 0;
  let settled = false;

  const result = await waitForDurableProgress({
    description: "test operation",
    read: () => ({ version, settled }),
    isSettled: (state) => state.settled,
    fingerprint: (state) => String(state.version),
    idleTimeoutMs: 10,
    hardTimeoutMs: 50,
    pollMs: 1,
    now: () => now,
    wait: async () => {
      now += 6;
      version += 1;
      if (now >= 18) settled = true;
    },
  });

  assert.deepEqual(result, { version: 3, settled: true });
});

test("durable progress wait fails after the idle watchdog sees no change", async () => {
  let now = 0;

  await assert.rejects(
    waitForDurableProgress({
      description: "idle operation",
      read: () => ({ version: 0 }),
      isSettled: () => false,
      fingerprint: (state) => String(state.version),
      idleTimeoutMs: 10,
      hardTimeoutMs: 50,
      pollMs: 1,
      now: () => now,
      wait: async () => { now += 6; },
    }),
    /idle operation made no durable progress for 10 ms/,
  );
});

test("durable progress cannot extend the hard deadline", async () => {
  let now = 0;
  let version = 0;

  await assert.rejects(
    waitForDurableProgress({
      description: "bounded operation",
      read: () => ({ version }),
      isSettled: () => false,
      fingerprint: (state) => String(state.version),
      idleTimeoutMs: 10,
      hardTimeoutMs: 15,
      pollMs: 1,
      now: () => now,
      wait: async () => {
        now += 6;
        version += 1;
      },
    }),
    /bounded operation exceeded the 15 ms hard deadline/,
  );
});
