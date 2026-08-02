import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllSharinganSessions,
  ensureProbeSession,
  releaseSharinganProject,
} from "../src/sharingan-handler.ts";

async function beforeDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${deadlineMs}ms deadline`)), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("closeAllSharinganSessions closes every live session in the capture registry", async () => {
  const id = "shutdown-guard";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-shutdown-"));
  let closed = 0;
  const fake = { close: async () => { closed += 1; } } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  const open = async () => fake;

  await ensureProbeSession(id, dataDir, open);
  assert.equal(closed, 0);

  await closeAllSharinganSessions();
  assert.equal(closed, 1, "shutdown must close every live session in the capture registry");
});

test("project release aborts a stuck opener, meets its deadline, and closes a late tombstoned session", async () => {
  const id = `shutdown-stuck-open-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-stuck-open-"));
  let openerSignal: AbortSignal | undefined;
  let resolveOpen!: (session: import("../src/sharingan-browser.ts").SharinganSession) => void;
  const opening = ensureProbeSession(id, dataDir, (_url, options) => {
    openerSignal = (options as typeof options & { signal?: AbortSignal }).signal;
    return new Promise((resolve) => {
      resolveOpen = resolve;
    });
  });
  await Promise.resolve();

  const startedAt = Date.now();
  await beforeDeadline(releaseSharinganProject(id), 750);
  assert.ok(Date.now() - startedAt < 750, "release is bounded even when open() ignores abort");
  assert.equal(openerSignal?.aborted, true, "release aborts the tracked opener operation");

  let lateCloses = 0;
  const lateSession = {
    close: async () => { lateCloses += 1; },
  } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  resolveOpen(lateSession);
  await assert.rejects(opening, /capture scope released/);
  assert.equal(lateCloses, 1, "a session resolving after release is closed by the old generation tombstone");

  let freshCloses = 0;
  const freshSession = {
    close: async () => { freshCloses += 1; },
  } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  assert.equal(await ensureProbeSession(id, dataDir, async () => freshSession), freshSession);
  await releaseSharinganProject(id);
  assert.equal(freshCloses, 1, "a new generation for the same project owns its session independently");
  assert.equal(lateCloses, 1, "the late old-generation session is never closed twice");
});
