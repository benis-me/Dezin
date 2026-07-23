import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  generationTaskVisualEvidenceFrameStorageSegment,
  persistGenerationTaskVisualEvidenceBatch,
  persistGenerationTaskSourceVisualEvidence,
  persistGenerationTaskVisualEvidence,
  resolveGenerationTaskSourceVisualEvidencePath,
  resolveGenerationTaskVisualEvidencePath,
} from "../src/orchestration/generation-task-visual-evidence.ts";
import {
  pngEvidenceOpenFlags,
} from "../src/png-evidence.ts";
import { sharinganFixturePng } from "./support/sharingan-capture-fixture.ts";

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

const sourceCapture = {
  scope: "source" as const,
  sourceAttemptId: "source-capture-attempt-1",
  width: 320,
  height: 320,
};

const sourceAuthority = {
  resourceId: "resource-sharingan-1",
  revisionId: "resource-revision-sharingan-1",
  revisionChecksum: "4".repeat(64),
};

function persistSourceEvidence(
  input: Omit<Parameters<typeof persistGenerationTaskSourceVisualEvidence>[0], "sourceAuthority">,
) {
  return persistGenerationTaskSourceVisualEvidence({ ...input, sourceAuthority });
}

function resolveSourceEvidencePath(
  input: Omit<Parameters<typeof resolveGenerationTaskSourceVisualEvidencePath>[0], "expectedSourceAuthority">,
) {
  return resolveGenerationTaskSourceVisualEvidencePath({
    ...input,
    expectedSourceAuthority: sourceAuthority,
  });
}

function captureIdentity(bytes: Buffer, width: number, height: number) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    width,
    height,
  };
}

const FRAME_PNG = sharinganFixturePng(frame.width, frame.height);
const FRAME_IDENTITY = captureIdentity(FRAME_PNG, frame.width, frame.height);
const SOURCE_PNG = sharinganFixturePng(sourceCapture.width, sourceCapture.height);
const SOURCE_IDENTITY = captureIdentity(SOURCE_PNG, sourceCapture.width, sourceCapture.height);

function forgedHeaderOnlyPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

test("PNG evidence open flags fail closed without both no-follow and non-blocking support", () => {
  assert.equal(pngEvidenceOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: undefined, O_NONBLOCK: 4 }), null);
  assert.equal(pngEvidenceOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 2, O_NONBLOCK: undefined }), null);
  assert.equal(pngEvidenceOpenFlags({ O_RDONLY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 }), 7);
});

test("PNG evidence FIFO verification returns promptly without opening a blocking stream", {
  skip: process.platform === "win32" || !existsSync("/usr/bin/mkfifo"),
}, (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-fifo-"));
  const fifo = join(dataDir, "evidence.png");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const created = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const moduleUrl = new URL("../src/png-evidence.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `import { readPngEvidenceFile } from ${JSON.stringify(moduleUrl)}; process.stdout.write(readPngEvidenceFile(${JSON.stringify(fifo)}) === undefined ? "rejected" : "accepted");`,
  ], { encoding: "utf8", timeout: 1_500 });
  assert.equal(child.signal, null, "FIFO verification must not block until the subprocess timeout");
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "rejected");
});

test("generation Task persistence rejects symlinked storage ancestors and EEXIST symlink substitution", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-linked-storage-"));
  const outside = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-outside-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, FRAME_PNG);
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  symlinkSync(outside, join(dataDir, "generation-task-evidence"), "dir");
  await assert.rejects(
    persistGenerationTaskVisualEvidence({
      dataDir,
      owner,
      frame,
      round: 0,
      sourcePath,
      expectedIdentity: FRAME_IDENTITY,
    }),
    /symlink|storage|directory/i,
  );
  assert.deepEqual(readFileSync(sourcePath), FRAME_PNG);
  assert.equal(existsSync(join(outside, owner.projectId)), false);

  rmSync(join(dataDir, "generation-task-evidence"));
  const descriptor = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 0,
    sourcePath,
    expectedIdentity: FRAME_IDENTITY,
  });
  assert.ok(descriptor);
  const storedPath = join(dataDir, ...descriptor.storageKey.split("/"));
  const outsidePath = join(outside, "same.png");
  renameSync(storedPath, outsidePath);
  symlinkSync(outsidePath, storedPath, "file");
  await assert.rejects(
    persistGenerationTaskVisualEvidence({
      dataDir,
      owner,
      frame,
      round: 0,
      sourcePath,
      expectedIdentity: FRAME_IDENTITY,
    }),
    /content verification|symlink|storage/i,
  );
});

test("generation Task persistence rejects a path replaced after visual review", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-toctou-"));
  const sourcePath = join(dataDir, "frame.png");
  const reviewedBytes = sharinganFixturePng(frame.width, frame.height);
  const replacementBytes = sharinganFixturePng(frame.width + 1, frame.height);
  writeFileSync(sourcePath, replacementBytes);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const descriptor = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 1,
    sourcePath,
    expectedIdentity: captureIdentity(reviewedBytes, frame.width, frame.height),
  } as never);

  assert.equal(descriptor, undefined,
    "durable evidence must be byte-identical to the screenshot supplied to the reviewer");
});

test("generation Task persistence rejects undersized and structurally incomplete PNG evidence", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-invalid-png-"));
  const sourcePath = join(dataDir, "capture.png");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  writeFileSync(sourcePath, PNG_1X1);
  assert.equal(await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 0,
    sourcePath,
    expectedIdentity: captureIdentity(PNG_1X1, 1, 1),
  }), undefined, "a 1x1 PNG cannot prove a 390x844 Frame contract");

  const forgedFrame = forgedHeaderOnlyPng(frame.width, frame.height);
  writeFileSync(sourcePath, forgedFrame);
  assert.equal(await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 0,
    sourcePath,
    expectedIdentity: captureIdentity(forgedFrame, frame.width, frame.height),
  }), undefined, "an IHDR without valid CRC, IDAT, and IEND is not decodable evidence");

  const forgedSource = forgedHeaderOnlyPng(sourceCapture.width, sourceCapture.height);
  writeFileSync(sourcePath, forgedSource);
  assert.equal(await persistSourceEvidence({
    dataDir,
    owner,
    capture: sourceCapture,
    round: 0,
    sourcePath,
    expectedIdentity: captureIdentity(forgedSource, sourceCapture.width, sourceCapture.height),
  }), undefined, "source-scoped evidence must receive the same complete PNG validation");
});

test("generation Task resolution decodes stored PNG structure even when hash and length match", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-invalid-resolve-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const forged = forgedHeaderOnlyPng(frame.width, frame.height);
  const identity = captureIdentity(forged, frame.width, frame.height);
  const storageKey = [
    "generation-task-evidence",
    owner.projectId,
    owner.workspaceId,
    owner.planId,
    owner.taskId,
    `attempt-${owner.attempt}`,
    "visual",
    `round-0-${frame.id}-${identity.sha256}.png`,
  ].join("/");
  const storedPath = join(dataDir, ...storageKey.split("/"));
  mkdirSync(dirname(storedPath), { recursive: true });
  writeFileSync(storedPath, forged);

  await assert.rejects(resolveGenerationTaskVisualEvidencePath({
    dataDir,
    expectedOwner: owner,
    descriptor: {
      protocol: "dezin.generation-task-visual-evidence.v1",
      owner,
      frame,
      round: 0,
      mediaType: "image/png",
      sha256: identity.sha256,
      byteLength: identity.byteLength,
      storageKey,
    },
  }), /missing, empty, or content identity/i);
});

test("generation Task source visual evidence persists as an independent source-scoped descriptor", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-source-evidence-"));
  const sourcePath = join(dataDir, "source.png");
  writeFileSync(sourcePath, SOURCE_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const descriptor = await persistSourceEvidence({
    dataDir,
    owner,
    capture: sourceCapture,
    round: 1,
    sourcePath,
    expectedIdentity: SOURCE_IDENTITY,
  });

  assert.ok(descriptor);
  assert.equal(descriptor.protocol, "dezin.generation-task-source-visual-evidence.v1");
  assert.deepEqual(descriptor.owner, owner);
  assert.deepEqual(descriptor.capture, sourceCapture);
  assert.deepEqual(descriptor.sourceAuthority, sourceAuthority);
  assert.equal("frame" in descriptor, false, "source evidence must not masquerade as a Task Frame");
  assert.equal(descriptor.mediaType, "image/png");
  assert.equal(descriptor.byteLength, SOURCE_PNG.byteLength);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/);
  assert.match(
    descriptor.storageKey,
    /^generation-task-evidence\/project-1\/workspace-1\/plan-1\/task-checkout\/attempt-2\/visual\/round-1-source-[a-f0-9]{64}\.png$/,
  );
  const storedPath = await resolveSourceEvidencePath({
    dataDir,
    descriptor,
    expectedOwner: owner,
  });
  assert.equal(existsSync(storedPath), true);
  assert.deepEqual(readFileSync(storedPath), SOURCE_PNG);

  const repeated = await persistSourceEvidence({
    dataDir,
    owner,
    capture: sourceCapture,
    round: 1,
    sourcePath,
    expectedIdentity: SOURCE_IDENTITY,
  });
  assert.deepEqual(repeated, descriptor, "the same source capture resolves to the same immutable descriptor");
});

test("generation Task source evidence rejects unsafe capture identity, dimensions, ownership, and storage substitution", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-source-evidence-safety-"));
  const sourcePath = join(dataDir, "source.png");
  writeFileSync(sourcePath, SOURCE_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const descriptor = await persistSourceEvidence({
    dataDir,
    owner,
    capture: sourceCapture,
    round: 0,
    sourcePath,
    expectedIdentity: SOURCE_IDENTITY,
  });
  assert.ok(descriptor);

  await assert.rejects(
    persistSourceEvidence({
      dataDir,
      owner,
      capture: { ...sourceCapture, sourceAttemptId: "../other-source" },
      round: 0,
      sourcePath,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    /Source Attempt id/i,
  );
  await assert.rejects(
    persistSourceEvidence({
      dataDir,
      owner,
      capture: { ...sourceCapture, width: 0 },
      round: 0,
      sourcePath,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    /capture/i,
  );
  await assert.rejects(
    persistSourceEvidence({
      dataDir,
      owner,
      capture: { ...sourceCapture, height: 16_385 },
      round: 0,
      sourcePath,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    /capture/i,
  );
  assert.equal(
    await persistSourceEvidence({
      dataDir,
      owner,
      capture: { ...sourceCapture, width: sourceCapture.width + 1 },
      round: 0,
      sourcePath,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    undefined,
    "source evidence must cover the full declared source viewport width",
  );
  assert.equal(
    await persistSourceEvidence({
      dataDir,
      owner,
      capture: { ...sourceCapture, height: sourceCapture.height + 1 },
      round: 0,
      sourcePath,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    undefined,
    "source evidence must cover the full declared source viewport height",
  );
  await assert.rejects(
    persistSourceEvidence({
      dataDir,
      owner,
      capture: sourceCapture,
      round: -1,
      sourcePath,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    /persistence input/i,
  );
  await assert.rejects(
    resolveSourceEvidencePath({
      dataDir,
      descriptor: descriptor!,
      expectedOwner: { ...owner, projectId: "project-2" },
    }),
    /owner/i,
  );
  await assert.rejects(
    resolveSourceEvidencePath({
      dataDir,
      descriptor: { ...descriptor!, storageKey: `${descriptor!.storageKey}.substituted` },
      expectedOwner: owner,
    }),
    /storage ownership/i,
  );
  await assert.rejects(
    resolveGenerationTaskSourceVisualEvidencePath({
      dataDir,
      descriptor: {
        ...descriptor!,
        sourceAuthority: { ...sourceAuthority, resourceId: "resource-sharingan-foreign" },
      },
      expectedOwner: owner,
      expectedSourceAuthority: sourceAuthority,
    }),
    /authority|descriptor or owner/i,
  );
  await assert.rejects(
    persistGenerationTaskSourceVisualEvidence({
      dataDir,
      owner,
      capture: sourceCapture,
      sourceAuthority: { ...sourceAuthority, revisionChecksum: "not-a-checksum" },
      round: 0,
      sourcePath,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    /authority/i,
  );
  await assert.rejects(
    resolveSourceEvidencePath({
      dataDir,
      descriptor: {
        ...descriptor!,
        capture: { ...descriptor!.capture, width: sourceCapture.width + 1 },
      },
      expectedOwner: owner,
    }),
    /content identity/i,
  );

  assert.equal(
    await persistSourceEvidence({
      dataDir,
      owner,
      capture: sourceCapture,
      round: 0,
      sourcePath: join(dataDir, "missing.png"),
      expectedIdentity: SOURCE_IDENTITY,
    }),
    undefined,
  );
  const invalidPng = join(dataDir, "invalid-source.png");
  writeFileSync(invalidPng, Buffer.from("not a PNG"));
  assert.equal(
    await persistSourceEvidence({
      dataDir,
      owner,
      capture: sourceCapture,
      round: 0,
      sourcePath: invalidPng,
      expectedIdentity: SOURCE_IDENTITY,
    }),
    undefined,
  );

  const storedPath = await resolveSourceEvidencePath({
    dataDir,
    descriptor: descriptor!,
    expectedOwner: owner,
  });
  rmSync(storedPath);
  writeFileSync(storedPath, Buffer.alloc(0));
  await assert.rejects(
    resolveSourceEvidencePath({
      dataDir,
      descriptor: descriptor!,
      expectedOwner: owner,
    }),
    /missing, empty, or content identity/i,
  );
});

test("generation Task visual evidence is immutable, content-addressed, and bound to its exact owner and Frame", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, FRAME_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const descriptor = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 1,
    sourcePath,
    expectedIdentity: FRAME_IDENTITY,
  });

  assert.ok(descriptor);
  assert.equal(descriptor!.protocol, "dezin.generation-task-visual-evidence.v1");
  assert.deepEqual(descriptor!.owner, owner);
  assert.deepEqual(descriptor!.frame, frame);
  assert.equal(descriptor!.mediaType, "image/png");
  assert.equal(descriptor!.byteLength, FRAME_PNG.byteLength);
  assert.match(descriptor!.sha256, /^[a-f0-9]{64}$/);
  assert.match(
    descriptor!.storageKey,
    /^generation-task-evidence\/project-1\/workspace-1\/plan-1\/task-checkout\/attempt-2\/visual\/round-1-checkout-mobile-[a-f0-9]{64}\.png$/,
  );
  const storedPath = await resolveGenerationTaskVisualEvidencePath({ dataDir, descriptor: descriptor!, expectedOwner: owner });
  assert.equal(existsSync(storedPath), true);
  assert.deepEqual(readFileSync(storedPath), FRAME_PNG);

  const repeated = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 1,
    sourcePath,
    expectedIdentity: FRAME_IDENTITY,
  });
  assert.deepEqual(repeated, descriptor, "the same immutable bytes and owner resolve to the same descriptor");
});

test("generation Task evidence preserves Viewer-compatible Unicode state and rich backgrounds", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-viewer-frame-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, FRAME_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const richFrame = {
    ...frame,
    initialState: "Empty state / 空",
    fixture: { locale: "zh-CN", empty: true },
    background: `linear-gradient(135deg, ${Array.from({ length: 24 }, (_, index) => (
      `rgb(${index}, ${index + 1}, ${index + 2}) ${index * 4}%`
    )).join(", ")})`,
  };
  assert.ok(richFrame.background.length > 128 && richFrame.background.length < 4_096);

  const descriptor = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame: richFrame,
    round: 2,
    sourcePath,
    expectedIdentity: FRAME_IDENTITY,
  });
  assert.ok(descriptor);
  assert.deepEqual(descriptor.frame, richFrame);
  const resolved = await resolveGenerationTaskVisualEvidencePath({
    dataDir,
    descriptor,
    expectedOwner: owner,
  });
  assert.deepEqual(readFileSync(resolved), FRAME_PNG);
});

test("generation Task evidence preserves Unicode and spaced Frame ids without storage collisions", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-frame-ids-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, FRAME_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const values = [
    { id: "a-b", frameAttemptId: "quality-round-3-frame-0" },
    { id: "a b", frameAttemptId: "quality-round-4-frame-0" },
    { id: "桌面 / 主", frameAttemptId: "quality-round-5-frame-0" },
  ] as const;
  const storageKeys: string[] = [];
  for (const [index, value] of values.entries()) {
    const exactFrame = {
      ...frame,
      ...value,
      name: `Frame ${index} / 画板`,
      initialState: "Empty state / 空",
      background: "linear-gradient(135deg, #fff, #eef2ff)",
    };
    const descriptor = await persistGenerationTaskVisualEvidence({
      dataDir,
      owner,
      frame: exactFrame,
      round: index + 3,
      sourcePath,
      expectedIdentity: FRAME_IDENTITY,
    });
    assert.ok(descriptor);
    storageKeys.push(descriptor.storageKey);
    assert.equal(descriptor.frame.id, value.id);
    assert.equal(
      descriptor.storageKey.includes(
        `-${generationTaskVisualEvidenceFrameStorageSegment(value.id)}-`,
      ),
      true,
    );
    const resolved = await resolveGenerationTaskVisualEvidencePath({
      dataDir,
      descriptor,
      expectedOwner: owner,
    });
    assert.deepEqual(readFileSync(resolved), FRAME_PNG);
  }
  assert.equal(generationTaskVisualEvidenceFrameStorageSegment("a-b"), "a-b");
  assert.equal(
    generationTaskVisualEvidenceFrameStorageSegment("a b"),
    `frame-${createHash("sha256").update("a b", "utf8").digest("hex")}`,
  );
  assert.notEqual(storageKeys[0], storageKeys[1]);
});

test("generation Task evidence batch rolls back only files created by the failed batch", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-batch-rollback-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, FRAME_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const preexistingFrame = { ...frame, id: "preexisting", frameAttemptId: "quality-round-6-frame-0" };
  const createdFrame = { ...frame, id: "created", frameAttemptId: "quality-round-6-frame-1" };
  const rejectedFrame = { ...frame, id: "rejected", frameAttemptId: "quality-round-6-frame-2" };
  const preexisting = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame: preexistingFrame,
    round: 6,
    sourcePath,
    expectedIdentity: FRAME_IDENTITY,
  });
  assert.ok(preexisting);

  await assert.rejects(
    persistGenerationTaskVisualEvidenceBatch({
      dataDir,
      owner,
      round: 6,
      signal: new AbortController().signal,
      frames: [
        { frame: preexistingFrame, sourcePath, expectedIdentity: FRAME_IDENTITY },
        { frame: createdFrame, sourcePath, expectedIdentity: FRAME_IDENTITY },
        {
          frame: rejectedFrame,
          sourcePath,
          expectedIdentity: { ...FRAME_IDENTITY, sha256: "0".repeat(64) },
        },
      ],
    }),
    /empty, unavailable, or changed/i,
  );

  const preexistingPath = join(dataDir, ...preexisting.storageKey.split("/"));
  const createdPath = join(
    dataDir,
    "generation-task-evidence",
    owner.projectId,
    owner.workspaceId,
    owner.planId,
    owner.taskId,
    `attempt-${owner.attempt}`,
    "visual",
    `round-6-${createdFrame.id}-${FRAME_IDENTITY.sha256}.png`,
  );
  assert.equal(existsSync(preexistingPath), true, "preexisting content must never be rolled back");
  assert.equal(existsSync(createdPath), false, "new content from the failed batch must be removed");
});

test("generation Task evidence batch rolls back a completed prefix when abort is observed", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-batch-abort-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, FRAME_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const abort = new Error("abort after first durable file");
  let reads = 0;
  const signal = {
    get aborted() {
      reads += 1;
      return reads >= 3;
    },
    reason: abort,
  } as AbortSignal;

  await assert.rejects(persistGenerationTaskVisualEvidenceBatch({
    dataDir,
    owner,
    round: 7,
    signal,
    frames: [
      {
        frame: { ...frame, id: "abort-first", frameAttemptId: "quality-round-7-frame-0" },
        sourcePath,
        expectedIdentity: FRAME_IDENTITY,
      },
      {
        frame: { ...frame, id: "abort-second", frameAttemptId: "quality-round-7-frame-1" },
        sourcePath,
        expectedIdentity: FRAME_IDENTITY,
      },
    ],
  }), (error) => error === abort);

  const firstPath = join(
    dataDir,
    "generation-task-evidence",
    owner.projectId,
    owner.workspaceId,
    owner.planId,
    owner.taskId,
    `attempt-${owner.attempt}`,
    "visual",
    `round-7-abort-first-${FRAME_IDENTITY.sha256}.png`,
  );
  assert.equal(existsSync(firstPath), false);
});

test("generation Task evidence resolution rejects cross-owner substitution and invalid or unavailable captures", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-evidence-ownership-"));
  const sourcePath = join(dataDir, "frame.png");
  writeFileSync(sourcePath, FRAME_PNG);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const descriptor = await persistGenerationTaskVisualEvidence({
    dataDir,
    owner,
    frame,
    round: 0,
    sourcePath,
    expectedIdentity: FRAME_IDENTITY,
  });
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
      expectedIdentity: FRAME_IDENTITY,
    }),
    undefined,
  );
  const invalidPng = join(dataDir, "invalid.png");
  writeFileSync(invalidPng, Buffer.from("not a PNG"));
  assert.equal(
    await persistGenerationTaskVisualEvidence({
      dataDir,
      owner,
      frame,
      round: 0,
      sourcePath: invalidPng,
      expectedIdentity: FRAME_IDENTITY,
    }),
    undefined,
  );
  const storedPath = await resolveGenerationTaskVisualEvidencePath({
    dataDir,
    descriptor: descriptor!,
    expectedOwner: owner,
  });
  rmSync(storedPath);
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
      expectedIdentity: FRAME_IDENTITY,
    }),
    /Task id/i,
  );
});
