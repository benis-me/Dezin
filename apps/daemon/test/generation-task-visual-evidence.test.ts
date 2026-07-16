import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  persistGenerationTaskVisualEvidence,
  resolveGenerationTaskVisualEvidencePath,
} from "../src/orchestration/generation-task-visual-evidence.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const owner = {
  projectId: "project-1",
  workspaceId: "workspace-1",
  planId: "plan-1",
  taskId: "task-checkout",
  attempt: 2,
  candidateCommitHash: "1".repeat(40),
  candidateTreeHash: "2".repeat(40),
  contextPackId: `context-pack-${"3".repeat(64)}`,
  contextPackHash: "3".repeat(64),
};

const frame = {
  id: "checkout-mobile",
  name: "Checkout mobile",
  width: 390,
  height: 844,
  initialState: "summary",
  fixture: { cartCount: 2 },
  background: "#ffffff",
  frameAttemptId: "quality-round-1-checkout-mobile",
};

test("generation Task visual evidence is immutable, content-addressed, and bound to its exact owner and Frame", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, PNG_1X1);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const descriptor = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 1,
    sourcePath,
  });

  assert.ok(descriptor);
  assert.equal(descriptor!.protocol, "dezin.generation-task-visual-evidence.v1");
  assert.deepEqual(descriptor!.owner, owner);
  assert.deepEqual(descriptor!.frame, frame);
  assert.equal(descriptor!.mediaType, "image/png");
  assert.equal(descriptor!.byteLength, PNG_1X1.byteLength);
  assert.match(descriptor!.sha256, /^[a-f0-9]{64}$/);
  assert.match(
    descriptor!.storageKey,
    /^generation-task-evidence\/project-1\/workspace-1\/plan-1\/task-checkout\/attempt-2\/visual\/round-1-checkout-mobile-[a-f0-9]{64}\.png$/,
  );
  const storedPath = await resolveGenerationTaskVisualEvidencePath({ dataDir, descriptor: descriptor!, expectedOwner: owner });
  assert.equal(existsSync(storedPath), true);
  assert.deepEqual(readFileSync(storedPath), PNG_1X1);

  const repeated = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 1,
    sourcePath,
  });
  assert.deepEqual(repeated, descriptor, "the same immutable bytes and owner resolve to the same descriptor");
});

test("generation Task evidence resolution rejects cross-owner substitution and invalid or unavailable captures", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-ownership-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, PNG_1X1);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const descriptor = await persistGenerationTaskVisualEvidence({ dataDir, owner, frame, round: 0, sourcePath });
  assert.ok(descriptor);

  await assert.rejects(
    resolveGenerationTaskVisualEvidencePath({
      dataDir,
      descriptor: descriptor!,
      expectedOwner: { ...owner, projectId: "project-2" },
    }),
    /owner/i,
  );
  assert.equal(
    await persistGenerationTaskVisualEvidence({
      dataDir,
      owner,
      frame,
      round: 0,
      sourcePath: join(dataDir, "missing.png"),
    }),
    undefined,
  );
  const invalidPng = join(dataDir, "invalid.png");
  writeFileSync(invalidPng, Buffer.from("not a PNG"));
  assert.equal(
    await persistGenerationTaskVisualEvidence({ dataDir, owner, frame, round: 0, sourcePath: invalidPng }),
    undefined,
  );
  const storedPath = await resolveGenerationTaskVisualEvidencePath({
    dataDir,
    descriptor: descriptor!,
    expectedOwner: owner,
  });
  writeFileSync(storedPath, Buffer.alloc(0));
  await assert.rejects(
    resolveGenerationTaskVisualEvidencePath({ dataDir, descriptor: descriptor!, expectedOwner: owner }),
    /missing, empty, or content identity/i,
  );
  await assert.rejects(
    persistGenerationTaskVisualEvidence({
      dataDir,
      owner: { ...owner, taskId: "../other-task" },
      frame,
      round: 0,
      sourcePath,
    }),
    /Task id/i,
  );
});
