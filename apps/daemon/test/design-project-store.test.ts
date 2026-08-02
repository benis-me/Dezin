import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesignProject,
  getDesignProject,
  listDesignProjects,
  updateDesignProject,
} from "../src/design/design-project-store.ts";
import { mutateDesignCanvas } from "../src/design/design-storage.ts";

test("Design Project recency follows durable Canvas activity and drives list order", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-project-recency-"));
  try {
    const older = await createDesignProject(dataDir, { name: "Older project" }, 1_000);
    const newer = await createDesignProject(dataDir, { name: "Newer project" }, 2_000);

    await mutateDesignCanvas(dataDir, older.projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "page-home", kind: "page" } }],
    }, 3_000);

    const listed = await listDesignProjects(dataDir);
    assert.deepEqual(listed.map((project) => project.projectId), [older.projectId, newer.projectId]);
    assert.equal(listed[0]?.updatedAt, 3_000);
    assert.equal((await getDesignProject(dataDir, older.projectId))?.updatedAt, 3_000);

    const canvasAfterOlderClock = await mutateDesignCanvas(dataDir, older.projectId, {
      expectedRevision: 1,
      intents: [{ type: "set-viewport", viewport: { x: 16, y: 24, zoom: 1.1 } }],
    }, 2_000);
    assert.equal(canvasAfterOlderClock.updatedAt, 3_000, "Canvas activity timestamps are monotonic");
    assert.equal((await getDesignProject(dataDir, older.projectId))?.updatedAt, 3_000);
    assert.equal((await listDesignProjects(dataDir))[0]?.projectId, older.projectId);

    const renamed = await updateDesignProject(dataDir, older.projectId, { name: "Renamed project" }, 2_500);
    assert.equal(renamed.updatedAt, 3_000, "metadata edits cannot move Project recency behind Canvas activity");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
