import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesignProject,
  ensureDesignProjectAtId,
  getDesignProject,
  listDesignProjects,
  updateDesignProject,
} from "../src/design/design-project-store.ts";
import { mutateDesignCanvas } from "../src/design/design-storage.ts";

test("a known Design Project identity is initialized once and replays exactly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-project-known-id-"));
  const projectId = "5bcbad3f-d184-4d3b-b7bd-b640e526e429";
  try {
    const first = await ensureDesignProjectAtId(dataDir, {
      projectId,
      name: "Durable bootstrap",
      createdAt: 1_000,
    });
    const replay = await ensureDesignProjectAtId(dataDir, {
      projectId,
      name: "Durable bootstrap",
      createdAt: 1_000,
    });

    assert.deepEqual(replay, first);
    assert.deepEqual(await getDesignProject(dataDir, projectId), first);
    assert.deepEqual((await listDesignProjects(dataDir)).map((project) => project.projectId), [projectId]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a known Design Project identity cannot be rebound to different metadata", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-project-known-id-conflict-"));
  const projectId = "6b76861b-fb37-447d-ac0a-439acc3125dd";
  try {
    await ensureDesignProjectAtId(dataDir, {
      projectId,
      name: "Original",
      createdAt: 1_000,
    });

    await assert.rejects(
      ensureDesignProjectAtId(dataDir, {
        projectId,
        name: "Different",
        createdAt: 1_000,
      }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "conflict",
    );
    assert.equal((await getDesignProject(dataDir, projectId))?.name, "Original");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

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
