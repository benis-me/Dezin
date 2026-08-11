import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureDurableDirectory,
  writeAtomic,
} from "../src/design/design-storage-primitives.ts";

test("Design authority directories and atomic files expose ordered fsync completion", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-durability-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const nested = join(dataDir, "projects", "project-a", "design");
  const durableDirectories: string[] = [];
  await ensureDurableDirectory(nested, {
    afterDirectoryDurable: (path) => { durableDirectories.push(path); },
  });
  assert.deepEqual(durableDirectories, [
    join(dataDir, "projects"),
    join(dataDir, "projects", "project-a"),
    nested,
  ]);

  const phases: string[] = [];
  const authority = join(nested, "project.json");
  await writeAtomic(authority, "authority\n", {
    afterAtomicPhase: (phase) => { phases.push(phase); },
  });
  assert.deepEqual(phases, ["temporary-file-synced", "parent-directory-synced"]);
  assert.equal(await readFile(authority, "utf8"), "authority\n");
});
