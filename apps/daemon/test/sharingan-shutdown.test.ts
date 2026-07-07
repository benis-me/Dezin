import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProbeSession, closeAllSharinganSessions } from "../src/sharingan-handler.ts";

test("closeAllSharinganSessions closes every live session in the capture registry", async () => {
  const id = "shutdown-guard";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-shutdown-"));
  let closed = 0;
  const fake = { close: async () => { closed += 1; } } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  const open = async () => fake;

  // Open a probe session (phase -> "probing", c.session live, c.probeTimer armed).
  await ensureProbeSession(id, dataDir, open);
  assert.equal(closed, 0);

  await closeAllSharinganSessions();
  assert.equal(closed, 1, "shutdown must close every live session in the capture registry");
});
