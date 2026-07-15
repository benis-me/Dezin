import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { Store } from "../../../packages/core/src/index.ts";
import { getOrCreateArtifactThumbnail } from "../src/artifact-thumbnail.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, body])), 8 + body.length);
  return chunk;
}

function pngHeader(
  bitDepth: number,
  colorType: number,
  width = 1,
  height = 1,
  interlace: 0 | 1 = 0,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[12] = interlace;
  return pngChunk("IHDR", header);
}

function pngDocument(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngRgbaScanlines(width: number, height: number, interlace: 0 | 1): Buffer {
  const passes = interlace === 0
    ? [[0, 0, 1, 1] as const]
    : [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ] as const;
  const rows: Buffer[] = [];
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    for (let row = 0; row < passHeight; row += 1) rows.push(Buffer.alloc(1 + (passWidth * 4)));
  }
  return Buffer.concat(rows);
}

function structuredPng(width = 1, height = 1, interlace: 0 | 1 = 0): Buffer {
  return pngDocument([
    pngHeader(8, 6, width, height, interlace),
    pngChunk("IDAT", deflateSync(pngRgbaScanlines(width, height, interlace))),
  ]);
}

function renderedPng(
  target: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[0],
  bytes: Uint8Array = PNG,
) {
  return { bytes, contentType: "image/png" as const, targetChecksum: target.targetChecksum };
}

function runThumbnailChild(script: string): Promise<{ rendered: boolean; cacheHit: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--experimental-sqlite",
      "--no-warnings",
      "--input-type=module",
      "-e",
      script,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`thumbnail child exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as { rendered: boolean; cacheHit: boolean });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createThumbnailFixture(options: {
  frames?: Array<Record<string, unknown>>;
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-thumbnail-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Artifact thumbnail", mode: "standard" });
  store.ensureMainVariant(project.id);
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const bundle = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    project: { ...facts.project, mode: "standard" },
    variants: facts.variants,
    successfulRuns: [],
  });
  const artifact = bundle.artifacts[0]!;
  const track = bundle.tracks.find((candidate) => candidate.id === artifact.activeTrackId)!;
  const revision = store.workspace.createArtifactRevision({
    artifactId: artifact.id,
    trackId: track.id,
    parentRevisionId: null,
    sourceCommitHash: "commit-one",
    sourceTreeHash: "tree-one",
    kernelRevisionId: bundle.workspace.activeKernelRevisionId,
    renderSpec: {
      entry: "index.html",
      thumbnailFrameId: "desktop",
      frames: options.frames ?? [
        {
          id: "desktop",
          name: "Desktop",
          width: 1440,
          height: 900,
          initialState: "ready",
          fixture: { theme: { name: "light" }, rows: [{ id: "one" }] },
        },
        { id: "mobile", name: "Mobile", width: 390, height: 844 },
      ],
    },
    quality: { state: "unassessed", score: null, findings: [] },
    dependencies: [],
    resourcePins: [],
  });
  const snapshot = store.workspace.publishArtifactRevision(revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: bundle.activeSnapshot.id,
  });
  return {
    dataDir,
    store,
    projectId: project.id,
    artifactId: artifact.id,
    revision,
    snapshot,
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("thumbnail cache binds immutable Revision, canonical RenderSpec, required frame, and state", async () => {
  const fixture = createThumbnailFixture();
  try {
    let renders = 0;
    const render = async (target: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[0]) => {
      renders += 1;
      assert.equal(target.revisionId, fixture.revision.id);
      assert.equal(target.frame.id, "desktop");
      assert.equal(target.stateKey, "ready");
      assert.equal(target.sourceTreeHash, "tree-one");
      return renderedPng(target);
    };

    const first = await getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    }, render);
    const second = await getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    }, render);

    assert.equal(renders, 1);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(first.cacheKey, second.cacheKey);
    assert.equal(first.renderSpecChecksum, second.renderSpecChecksum);
    assert.deepEqual(first.bytes, PNG);
    assert.deepEqual(second.bytes, PNG);
  } finally {
    fixture.close();
  }
});

test("a corrupt cache envelope is never served and is replaced by a verified render", async () => {
  const fixture = createThumbnailFixture();
  try {
    let renders = 0;
    const first = await getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    }, (target) => {
      renders += 1;
      return renderedPng(target);
    });
    const path = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      first.cacheKey.slice(0, 2),
      `${first.cacheKey}.bin`,
    );
    writeFileSync(path, "corrupt");
    const replacement = Buffer.from(PNG);
    const second = await getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    }, (target) => {
      renders += 1;
      return renderedPng(target, replacement);
    });
    assert.equal(renders, 2);
    assert.equal(second.cacheHit, false);
    assert.deepEqual(second.bytes, replacement);
  } finally {
    fixture.close();
  }
});

test("concurrent requests coalesce while different required frame or state targets never alias", async () => {
  const fixture = createThumbnailFixture();
  try {
    let renders = 0;
    const render = async (target: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[0]) => {
      renders += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return renderedPng(target);
    };
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const [leader, follower] = await Promise.all([
      getOrCreateArtifactThumbnail(input, render),
      getOrCreateArtifactThumbnail(input, render),
    ]);
    assert.equal(renders, 1);
    assert.equal(leader.cacheKey, follower.cacheKey);
    assert.equal([leader.cacheHit, follower.cacheHit].filter(Boolean).length, 1);

    const mobile = await getOrCreateArtifactThumbnail({
      ...input,
      requiredFrameId: "mobile",
      requiredStateKey: null,
    }, render);
    const mobileHover = await getOrCreateArtifactThumbnail({
      ...input,
      requiredFrameId: "mobile",
      requiredStateKey: "hover",
    }, render);
    assert.equal(renders, 3);
    assert.notEqual(mobile.cacheKey, leader.cacheKey);
    assert.notEqual(mobileHover.cacheKey, mobile.cacheKey);
    assert.equal(mobile.target.frame.id, "mobile");
    assert.equal(mobile.target.stateKey, null);
    assert.equal(mobileHover.target.stateKey, "hover");
  } finally {
    fixture.close();
  }
});

test("single-flight cancellation is per waiter and aborts shared work only after every waiter leaves", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const leaderController = new AbortController();
    const followerController = new AbortController();
    let started!: () => void;
    let release!: () => void;
    const rendererStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const renderer = (
      target: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[0],
      context: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[1],
    ) => new Promise<ReturnType<typeof renderedPng>>((resolve, reject) => {
      const onAbort = () => reject(context.signal?.reason ?? new Error("shared render aborted"));
      context.signal?.addEventListener("abort", onAbort, { once: true });
      release = () => {
        context.signal?.removeEventListener("abort", onAbort);
        resolve(renderedPng(target));
      };
      started();
    });
    const leader = getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "shared-waiters",
      signal: leaderController.signal,
    }, renderer);
    await rendererStarted;
    const followerOutcome = getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "shared-waiters",
      signal: followerController.signal,
    }, renderer).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    leaderController.abort(new Error("leader-only cancellation"));
    await assert.rejects(leader, /leader-only cancellation/i);
    release();
    const follower = await followerOutcome;
    if ("error" in follower) throw follower.error;
    assert.deepEqual(follower.value.bytes, PNG);

    const allLeader = new AbortController();
    const allFollower = new AbortController();
    let allStarted!: () => void;
    const allRendererStarted = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    let sharedAborts = 0;
    const abortingRenderer = (
      target: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[0],
      context: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[1],
    ) => new Promise<ReturnType<typeof renderedPng>>((resolve, reject) => {
      context.signal?.addEventListener("abort", () => {
        sharedAborts += 1;
        reject(context.signal?.reason ?? new Error("shared render aborted"));
      }, { once: true });
      allStarted();
      void target;
      void resolve;
    });
    const allLeaderOutcome = getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "all-waiters-cancel",
      signal: allLeader.signal,
    }, abortingRenderer).then(() => "fulfilled", () => "rejected");
    await allRendererStarted;
    const allFollowerOutcome = getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "all-waiters-cancel",
      signal: allFollower.signal,
    }, abortingRenderer).then(() => "fulfilled", () => "rejected");
    await new Promise((resolve) => setTimeout(resolve, 30));
    allLeader.abort(new Error("first waiter left"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sharedAborts, 0);
    allFollower.abort(new Error("last waiter left"));
    assert.deepEqual(await Promise.all([allLeaderOutcome, allFollowerOutcome]), ["rejected", "rejected"]);
    assert.equal(sharedAborts, 1);
  } finally {
    fixture.close();
  }
});

test("all-waiter cancellation releases a flight even when its renderer ignores abort", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "ignored-renderer-abort",
    };
    const abandonedController = new AbortController();
    let started!: () => void;
    let releaseAbandoned!: () => void;
    const rendererStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const abandoned = getOrCreateArtifactThumbnail({
      ...input,
      signal: abandonedController.signal,
    }, (target) => new Promise<ReturnType<typeof renderedPng>>((resolve) => {
      releaseAbandoned = () => resolve(renderedPng(target));
      started();
    }));
    await rendererStarted;
    abandonedController.abort(new Error("abandoned thumbnail waiter"));
    await assert.rejects(abandoned, /abandoned thumbnail waiter/i);

    const recoveryController = new AbortController();
    const timeout = setTimeout(() => recoveryController.abort(new Error("abandoned flight retained its lock")), 500);
    try {
      const recovered = await getOrCreateArtifactThumbnail({
        ...input,
        signal: recoveryController.signal,
      }, (target) => renderedPng(target));
      assert.deepEqual(recovered.bytes, PNG);
    } finally {
      clearTimeout(timeout);
      releaseAbandoned();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    fixture.close();
  }
});

test("cancelled non-cooperative renderers continue to occupy the global render limit until they settle", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const controllers = [new AbortController(), new AbortController()];
    const releases: Array<() => void> = [];
    let started = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => { bothStarted = resolve; });
    const abandoned = controllers.map((controller, index) => getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: `non-cooperative-${index}`,
      signal: controller.signal,
    }, (target) => new Promise<ReturnType<typeof renderedPng>>((resolve) => {
      releases.push(() => resolve(renderedPng(target)));
      started += 1;
      if (started === 2) bothStarted();
    })));
    await ready;
    for (const controller of controllers) controller.abort(new Error("caller left non-cooperative render"));
    await Promise.all(abandoned.map((request) => assert.rejects(request, /caller left non-cooperative render/i)));

    const queuedController = new AbortController();
    const timeout = setTimeout(() => queuedController.abort(new Error("third render stayed queued")), 100);
    let thirdRendererStarted = false;
    try {
      await assert.rejects(getOrCreateArtifactThumbnail({
        ...input,
        requiredStateKey: "must-remain-queued",
        signal: queuedController.signal,
      }, (target) => {
        thirdRendererStarted = true;
        return renderedPng(target);
      }), /third render stayed queued/i);
      assert.equal(thirdRendererStarted, false, "two still-running renderer promises must retain both semaphore slots");
    } finally {
      clearTimeout(timeout);
      for (const release of releases) release();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const recovered = await getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "renderer-slots-recovered",
    }, (target) => renderedPng(target));
    assert.deepEqual(recovered.bytes, PNG);
  } finally {
    fixture.close();
  }
});

test("thumbnail ownership and image validation fail closed before anything is cached", async () => {
  const fixture = createThumbnailFixture();
  try {
    let renders = 0;
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: "another-artifact",
      revisionId: fixture.revision.id,
    }, (target) => {
      renders += 1;
      return renderedPng(target);
    }), /owned immutable Artifact Revision thumbnail target was not found/i);
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredFrameId: "tablet",
    }, (target) => {
      renders += 1;
      return renderedPng(target);
    }), /required thumbnail frame tablet/i);
    assert.equal(renders, 0);

    const validInput = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    await assert.rejects(getOrCreateArtifactThumbnail(validInput, (target) => {
      renders += 1;
      return renderedPng(target, Buffer.from("not-an-image"));
    }), /bounded decodable PNG image/i);
    const valid = await getOrCreateArtifactThumbnail(validInput, (target) => {
      renders += 1;
      return renderedPng(target);
    });
    assert.equal(renders, 2);
    assert.equal(valid.cacheHit, false);
  } finally {
    fixture.close();
  }
});

test("renderer must attest the exact immutable target checksum", async () => {
  const fixture = createThumbnailFixture();
  try {
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    }, () => ({
      bytes: PNG,
      contentType: "image/png",
      targetChecksum: "0".repeat(64),
    })), /target checksum/i);
  } finally {
    fixture.close();
  }
});

test("renderer receives a deeply cloned and frozen render target", async () => {
  const fixture = createThumbnailFixture();
  try {
    const result = await getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    }, (target) => {
      const fixtureValue = target.frame.fixture as { theme: { name: string }; rows: Array<{ id: string }> };
      assert.ok(Object.isFrozen(target));
      assert.ok(Object.isFrozen(target.frame));
      assert.ok(Object.isFrozen(fixtureValue));
      assert.ok(Object.isFrozen(fixtureValue.theme));
      assert.ok(Object.isFrozen(fixtureValue.rows));
      assert.throws(() => {
        fixtureValue.theme.name = "dark";
      }, TypeError);
      assert.throws(() => {
        fixtureValue.rows[0]!.id = "mutated";
      }, TypeError);
      return renderedPng(target);
    });
    assert.equal((result.target.frame.fixture as { theme: { name: string } }).theme.name, "light");
  } finally {
    fixture.close();
  }
});

test("thumbnail validation rejects a signature-only truncated image", async () => {
  const fixture = createThumbnailFixture();
  try {
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    }, (target) => ({
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
      contentType: "image/jpeg" as never,
      targetChecksum: target.targetChecksum,
    })), /bounded decodable PNG image/i);
  } finally {
    fixture.close();
  }
});

test("thumbnail validation rejects plausible headers without decodable JPEG or WebP pixels", async () => {
  const fixture = createThumbnailFixture();
  try {
    const fakeJpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
      0xff, 0xda, 0x00, 0x02, 0x00,
      0xff, 0xd9,
    ]);
    const fakeWebp = Buffer.alloc(26);
    fakeWebp.write("RIFF", 0, "ascii");
    fakeWebp.writeUInt32LE(18, 4);
    fakeWebp.write("WEBP", 8, "ascii");
    fakeWebp.write("VP8L", 12, "ascii");
    fakeWebp.writeUInt32LE(5, 16);
    fakeWebp[20] = 0x2f;
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const results = await Promise.allSettled([
      getOrCreateArtifactThumbnail({ ...input, requiredStateKey: "fake-jpeg" }, (target) => ({
        bytes: fakeJpeg,
        contentType: "image/jpeg" as never,
        targetChecksum: target.targetChecksum,
      })),
      getOrCreateArtifactThumbnail({ ...input, requiredStateKey: "fake-webp" }, (target) => ({
        bytes: fakeWebp,
        contentType: "image/webp" as never,
        targetChecksum: target.targetChecksum,
      })),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  } finally {
    fixture.close();
  }
});

test("RenderSpec frames over the pixel budget are rejected before the renderer runs", async () => {
  const fixture = createThumbnailFixture({
    frames: [{ id: "oversized", width: 8_193, height: 8_192 }],
  });
  try {
    let rendered = false;
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredFrameId: "oversized",
    }, (target) => {
      rendered = true;
      return renderedPng(target);
    }), /frame.*(?:dimensions|pixel)|pixel.*budget/i);
    assert.equal(rendered, false);
  } finally {
    fixture.close();
  }
});

test("PNG validation rejects bytes after the consumed zlib stream inside IDAT", async () => {
  const fixture = createThumbnailFixture();
  try {
    const scanlines = Buffer.from([0, 0, 0, 0, 0]);
    const png = pngDocument([
      pngHeader(8, 6),
      pngChunk("IDAT", Buffer.concat([
        deflateSync(scanlines),
        Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      ])),
    ]);
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "trailing-idat-zlib",
    }, (target) => renderedPng(target, png)), /bounded decodable PNG image/i);
  } finally {
    fixture.close();
  }
});

test("PNG validation rejects more than 4096 chunks", async () => {
  const fixture = createThumbnailFixture();
  try {
    const ancillary = pngChunk("vpAg", Buffer.alloc(0));
    const png = pngDocument([
      pngHeader(8, 6),
      ...Array.from({ length: 4_094 }, () => ancillary),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    ]);
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "over-png-chunk-budget",
    }, (target) => renderedPng(target, png)), /bounded decodable PNG image/i);
  } finally {
    fixture.close();
  }
});

test("streaming PNG validation accepts Adam7 and rejects an invalid scanline filter", async () => {
  const fixture = createThumbnailFixture();
  try {
    const adam7 = structuredPng(9, 9, 1);
    const accepted = await getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "adam7-valid",
    }, (target) => renderedPng(target, adam7));
    assert.deepEqual(accepted.bytes, adam7);

    const invalidFilter = pngDocument([
      pngHeader(8, 6),
      pngChunk("IDAT", deflateSync(Buffer.from([5, 0, 0, 0, 0]))),
    ]);
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "invalid-filter",
    }, (target) => renderedPng(target, invalidFilter)), /bounded decodable PNG image/i);
  } finally {
    fixture.close();
  }
});

test("distinct cache-hit validations share a bounded global slot queue and queued aborts are prompt", async () => {
  const fixture = createThumbnailFixture();
  try {
    const large = structuredPng(4_096, 4_096);
    const states = ["validation-large-a", "validation-large-b", "validation-small"] as const;
    for (const state of states) {
      await getOrCreateArtifactThumbnail({
        store: fixture.store,
        dataDir: fixture.dataDir,
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
        revisionId: fixture.revision.id,
        requiredStateKey: state,
      }, (target) => renderedPng(target, state === "validation-small" ? PNG : large));
    }
    const cachedInput = (state: typeof states[number], signal?: AbortSignal) => ({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: state,
      ...(signal === undefined ? {} : { signal }),
    });
    const rendererMustNotRun = () => {
      throw new Error("cache-hit renderer must not run");
    };
    const completions: string[] = [];
    const first = getOrCreateArtifactThumbnail(
      cachedInput("validation-large-a"),
      rendererMustNotRun,
    ).then((value) => { completions.push("large-a"); return value; });
    const second = getOrCreateArtifactThumbnail(
      cachedInput("validation-large-b"),
      rendererMustNotRun,
    ).then((value) => { completions.push("large-b"); return value; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const third = getOrCreateArtifactThumbnail(
      cachedInput("validation-small"),
      rendererMustNotRun,
    ).then((value) => { completions.push("small"); return value; });
    await Promise.all([first, second, third]);
    assert.notEqual(completions[0], "small", "a third validation must wait for a bounded global slot");

    const queuedController = new AbortController();
    const blockers = [
      getOrCreateArtifactThumbnail(cachedInput("validation-large-a"), rendererMustNotRun),
      getOrCreateArtifactThumbnail(cachedInput("validation-large-b"), rendererMustNotRun),
    ];
    await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = getOrCreateArtifactThumbnail(
      cachedInput("validation-small", queuedController.signal),
      rendererMustNotRun,
    );
    queuedController.abort(new Error("queued validation cancelled"));
    await assert.rejects(queued, /queued validation cancelled/i);
    await Promise.all(blockers);
  } finally {
    fixture.close();
  }
});

test("PNG validation rejects missing palettes, split IDAT runs, and unknown critical chunks", async () => {
  const fixture = createThumbnailFixture();
  try {
    const indexedWithoutPalette = pngDocument([
      pngHeader(8, 3),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    ]);
    const compressed = deflateSync(Buffer.from([0, 0, 255]));
    const split = Math.max(1, Math.floor(compressed.length / 2));
    const splitImageData = pngDocument([
      pngHeader(8, 4),
      pngChunk("IDAT", compressed.subarray(0, split)),
      pngChunk("tEXt", Buffer.from("gap", "ascii")),
      pngChunk("IDAT", compressed.subarray(split)),
    ]);
    const unknownCriticalChunk = pngDocument([
      pngHeader(8, 4),
      pngChunk("ABCD", Buffer.alloc(0)),
      pngChunk("IDAT", compressed),
    ]);
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const results = await Promise.allSettled([
      ["missing-palette", indexedWithoutPalette],
      ["split-idat", splitImageData],
      ["unknown-critical", unknownCriticalChunk],
    ].map(([requiredStateKey, bytes]) => getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: requiredStateKey as string,
    }, (target) => renderedPng(target, bytes as Buffer))));
    assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected", "rejected"]);
  } finally {
    fixture.close();
  }
});

test("large PNG inflation yields to cancellation instead of blocking the daemon event loop", async () => {
  const fixture = createThumbnailFixture();
  try {
    const width = 8_192;
    const height = 8_191;
    const scanlines = Buffer.alloc(height * (width * 2 + 1));
    const largePng = pngDocument([
      pngHeader(16, 0, width, height),
      pngChunk("IDAT", deflateSync(scanlines)),
    ]);
    const controller = new AbortController();
    let abortDelay = Number.POSITIVE_INFINITY;
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "cancel-large-inflate",
      signal: controller.signal,
    }, (target) => {
      const startedAt = performance.now();
      setTimeout(() => {
        abortDelay = performance.now() - startedAt;
        controller.abort(new Error("cancelled during PNG inflation"));
      }, 0);
      return renderedPng(target, largePng);
    }), /cancelled during PNG inflation/i);
    assert.ok(abortDelay < 50, `cancellation timer was blocked for ${abortDelay.toFixed(1)}ms`);
  } finally {
    fixture.close();
  }
});

test("an aborted thumbnail request never reaches the renderer", async () => {
  const fixture = createThumbnailFixture();
  try {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let renders = 0;
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      signal: controller.signal,
    }, (target) => {
      renders += 1;
      return renderedPng(target);
    }), /cancelled|abort/i);
    assert.equal(renders, 0);
  } finally {
    fixture.close();
  }
});

test("a process-global semaphore bounds concurrent renders across cache keys", async () => {
  const fixture = createThumbnailFixture();
  try {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    let twoStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      twoStarted = resolve;
    });
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const pending = ["one", "two", "three"].map((requiredStateKey) => getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey,
    }, async (target) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active >= 2) twoStarted();
      await gate;
      active -= 1;
      return renderedPng(target);
    }));
    await Promise.race([
      started,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("two renders did not start")), 1_000)),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all(pending);
    assert.equal(maxActive, 2);
  } finally {
    fixture.close();
  }
});

test("thumbnail cache writes respect a caller-supplied byte budget", async () => {
  const fixture = createThumbnailFixture();
  try {
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      cacheBudgetBytes: 64,
    }, (target) => renderedPng(target)), /cache budget/i);
  } finally {
    fixture.close();
  }
});

test("thumbnail cache replacement budget counts the final envelope instead of the corrupt file twice", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "budget-replacement",
    };
    const seeded = await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target));
    const path = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      seeded.cacheKey.slice(0, 2),
      `${seeded.cacheKey}.bin`,
    );
    const envelopeBytes = readFileSync(path).length;
    writeFileSync(path, Buffer.alloc(2_048));
    const replaced = await getOrCreateArtifactThumbnail({
      ...input,
      cacheBudgetBytes: envelopeBytes + 512,
    }, (target) => renderedPng(target));
    assert.equal(replaced.cacheHit, false);
    assert.deepEqual(replaced.bytes, PNG);
  } finally {
    fixture.close();
  }
});

test("thumbnail cache refuses a symlinked cache root instead of writing outside dataDir", async () => {
  const fixture = createThumbnailFixture();
  const outside = mkdtempSync(join(tmpdir(), "dezin-thumbnail-outside-"));
  try {
    symlinkSync(outside, join(fixture.dataDir, "cache"), "dir");
    await assert.rejects(getOrCreateArtifactThumbnail({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "symlinked-cache-root",
    }, (target) => renderedPng(target)), /cache directory|symlink/i);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("thumbnail quota never subtracts an external target reached through a symlink", async () => {
  const fixture = createThumbnailFixture();
  const outside = mkdtempSync(join(tmpdir(), "dezin-thumbnail-target-"));
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "symlinked-budget-target",
    };
    const seeded = await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target));
    const root = join(fixture.dataDir, "cache", "artifact-thumbnails", "v1");
    const path = join(root, seeded.cacheKey.slice(0, 2), `${seeded.cacheKey}.bin`);
    const envelopeBytes = readFileSync(path).length;
    rmSync(path, { force: true });
    writeFileSync(join(root, "orphan.bin"), Buffer.alloc(4_096));
    const outsideTarget = join(outside, "external.bin");
    writeFileSync(outsideTarget, Buffer.alloc(16_384));
    symlinkSync(outsideTarget, path, "file");

    await assert.rejects(getOrCreateArtifactThumbnail({
      ...input,
      cacheBudgetBytes: envelopeBytes + 512,
    }, (target) => renderedPng(target)), /cache budget/i);
    assert.equal(readFileSync(outsideTarget).length, 16_384);
  } finally {
    fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("thumbnail cache reads never trust an envelope reached through a final-file symlink", async () => {
  const fixture = createThumbnailFixture();
  const outside = mkdtempSync(join(tmpdir(), "dezin-thumbnail-read-link-"));
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "symlinked-cache-read",
    };
    const seeded = await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target));
    const path = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      seeded.cacheKey.slice(0, 2),
      `${seeded.cacheKey}.bin`,
    );
    const externalEnvelope = join(outside, "external-envelope.bin");
    writeFileSync(externalEnvelope, readFileSync(path));
    rmSync(path, { force: true });
    symlinkSync(externalEnvelope, path, "file");
    let renders = 0;

    const result = await getOrCreateArtifactThumbnail(input, (target) => {
      renders += 1;
      return renderedPng(target);
    });
    assert.equal(result.cacheHit, false);
    assert.equal(renders, 1);
    assert.deepEqual(readFileSync(externalEnvelope), readFileSync(path));
  } finally {
    fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("renderer-time shard replacement is rejected before an external cache target is touched", async () => {
  const fixture = createThumbnailFixture();
  const outside = mkdtempSync(join(tmpdir(), "dezin-thumbnail-render-race-"));
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "renderer-shard-replacement",
    };
    const seeded = await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target));
    const root = join(fixture.dataDir, "cache", "artifact-thumbnails", "v1");
    const shard = join(root, seeded.cacheKey.slice(0, 2));
    const path = join(shard, `${seeded.cacheKey}.bin`);
    const movedShard = `${shard}.moved`;
    const outsideTarget = join(outside, `${seeded.cacheKey}.bin`);
    writeFileSync(path, "corrupt");
    writeFileSync(outsideTarget, "external-sentinel");

    await assert.rejects(getOrCreateArtifactThumbnail(input, (target) => {
      renameSync(shard, movedShard);
      symlinkSync(outside, shard, "dir");
      return renderedPng(target);
    }), /cache directory|symbolic link/i);
    assert.equal(readFileSync(outsideTarget, "utf8"), "external-sentinel");
  } finally {
    fixture.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("thumbnail cache budget includes orphan temporary and lock files", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const seeded = await getOrCreateArtifactThumbnail({ ...input, requiredStateKey: "budget-seed" }, (target) => renderedPng(target));
    const root = join(fixture.dataDir, "cache", "artifact-thumbnails", "v1");
    const seededPath = join(root, seeded.cacheKey.slice(0, 2), `${seeded.cacheKey}.bin`);
    const envelopeBytes = readFileSync(seededPath).length;
    rmSync(seededPath, { force: true });
    writeFileSync(join(root, "orphan.tmp"), Buffer.alloc(100));
    writeFileSync(join(root, "orphan.lock"), Buffer.alloc(100));
    await assert.rejects(getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "budget-target",
      cacheBudgetBytes: envelopeBytes + 150,
    }, (target) => renderedPng(target)), /cache budget/i);
  } finally {
    fixture.close();
  }
});

test("canonical cache locking coalesces corrupt-cache repair through path aliases", async () => {
  const fixture = createThumbnailFixture();
  const aliasDir = `${fixture.dataDir}-alias`;
  try {
    symlinkSync(fixture.dataDir, aliasDir, "dir");
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const seeded = await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target));
    const path = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      seeded.cacheKey.slice(0, 2),
      `${seeded.cacheKey}.bin`,
    );
    writeFileSync(path, "corrupt");

    let renders = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const render = async (target: Parameters<Parameters<typeof getOrCreateArtifactThumbnail>[1]>[0]) => {
      renders += 1;
      await gate;
      return renderedPng(target);
    };
    const requests = [
      getOrCreateArtifactThumbnail(input, render),
      getOrCreateArtifactThumbnail({ ...input, dataDir: aliasDir }, render),
    ];
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all(requests);
    assert.equal(renders, 1);
    assert.equal(results.filter((result) => result.cacheHit).length, 1);
    assert.deepEqual(results[0]!.bytes, PNG);
    assert.deepEqual(results[1]!.bytes, PNG);
  } finally {
    rmSync(aliasDir, { force: true });
    fixture.close();
  }
});

test("cache locking reclaims only old dead-owner locks and never steals a live lock", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const orphanedSeed = await getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "orphaned-reclaim",
    }, (target) => renderedPng(target));
    const orphanedPath = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      orphanedSeed.cacheKey.slice(0, 2),
      `${orphanedSeed.cacheKey}.bin`,
    );
    rmSync(orphanedPath, { force: true });
    writeFileSync(`${orphanedPath}.lock`, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-reclaimer-owner",
      createdAt: Date.now() - 60_000,
    }));
    linkSync(`${orphanedPath}.lock`, `${orphanedPath}.lock.reclaim`);
    const orphanedController = new AbortController();
    const orphanedTimeout = setTimeout(
      () => orphanedController.abort(new Error("orphaned reclaim marker was not recovered")),
      1_000,
    );
    try {
      const recovered = await getOrCreateArtifactThumbnail({
        ...input,
        requiredStateKey: "orphaned-reclaim",
        signal: orphanedController.signal,
      }, (target) => renderedPng(target));
      assert.deepEqual(recovered.bytes, PNG);
    } finally {
      clearTimeout(orphanedTimeout);
    }

    const takeoverSeed = await getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "orphaned-reclaim-takeover",
    }, (target) => renderedPng(target));
    const takeoverPath = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      takeoverSeed.cacheKey.slice(0, 2),
      `${takeoverSeed.cacheKey}.bin`,
    );
    rmSync(takeoverPath, { force: true });
    const deadMarker = (token: string) => JSON.stringify({
      pid: 2_147_483_647,
      token,
      createdAt: Date.now() - 60_000,
    });
    writeFileSync(`${takeoverPath}.lock`, deadMarker("takeover-original"));
    linkSync(`${takeoverPath}.lock`, `${takeoverPath}.lock.reclaim`);
    writeFileSync(`${takeoverPath}.lock.reclaim-owner`, deadMarker("takeover-owner"));
    writeFileSync(`${takeoverPath}.lock.reclaim-takeover`, deadMarker("takeover-guard"));
    const takeoverController = new AbortController();
    const takeoverTimeout = setTimeout(
      () => takeoverController.abort(new Error("orphaned reclaim takeover was not recovered")),
      1_000,
    );
    try {
      const recovered = await getOrCreateArtifactThumbnail({
        ...input,
        requiredStateKey: "orphaned-reclaim-takeover",
        signal: takeoverController.signal,
      }, (target) => renderedPng(target));
      assert.deepEqual(recovered.bytes, PNG);
    } finally {
      clearTimeout(takeoverTimeout);
    }

    const staleSeed = await getOrCreateArtifactThumbnail({ ...input, requiredStateKey: "stale-lock" }, (target) => renderedPng(target));
    const stalePath = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      staleSeed.cacheKey.slice(0, 2),
      `${staleSeed.cacheKey}.bin`,
    );
    rmSync(stalePath, { force: true });
    writeFileSync(`${stalePath}.lock`, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      createdAt: Date.now() - 60_000,
    }));
    const staleController = new AbortController();
    const staleTimeout = setTimeout(() => staleController.abort(new Error("stale lock was not reclaimed")), 1_000);
    let staleRenders = 0;
    try {
      const repaired = await getOrCreateArtifactThumbnail({
        ...input,
        requiredStateKey: "stale-lock",
        signal: staleController.signal,
      }, (target) => {
        staleRenders += 1;
        return renderedPng(target);
      });
      assert.deepEqual(repaired.bytes, PNG);
      assert.equal(staleRenders, 1);
    } finally {
      clearTimeout(staleTimeout);
    }

    const liveSeed = await getOrCreateArtifactThumbnail({ ...input, requiredStateKey: "live-lock" }, (target) => renderedPng(target));
    const livePath = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      liveSeed.cacheKey.slice(0, 2),
      `${liveSeed.cacheKey}.bin`,
    );
    rmSync(livePath, { force: true });
    const liveLock = JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: Date.now() - 60_000 });
    writeFileSync(`${livePath}.lock`, liveLock);
    const liveController = new AbortController();
    setTimeout(() => liveController.abort(new Error("live lock wait cancelled")), 100);
    let liveRenders = 0;
    await assert.rejects(getOrCreateArtifactThumbnail({
      ...input,
      requiredStateKey: "live-lock",
      signal: liveController.signal,
    }, (target) => {
      liveRenders += 1;
      return renderedPng(target);
    }), /live lock wait cancelled/i);
    assert.equal(liveRenders, 0);
    assert.equal(readFileSync(`${livePath}.lock`, "utf8"), liveLock);
  } finally {
    fixture.close();
  }
});

test("cache locking recovers a takeover-only marker left after its reclaim owner was removed", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      requiredStateKey: "takeover-only-crash",
    };
    const seeded = await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target));
    const cachePath = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      seeded.cacheKey.slice(0, 2),
      `${seeded.cacheKey}.bin`,
    );
    rmSync(cachePath, { force: true });
    const takeoverPath = `${cachePath}.lock.reclaim-takeover`;
    writeFileSync(takeoverPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "takeover-after-owner-removal",
      createdAt: Date.now() - 60_000,
    }));
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("takeover-only crash marker was not recovered")),
      1_000,
    );
    let renders = 0;
    try {
      const recovered = await getOrCreateArtifactThumbnail({ ...input, signal: controller.signal }, (target) => {
        renders += 1;
        return renderedPng(target);
      });
      assert.deepEqual(recovered.bytes, PNG);
      assert.equal(renders, 1);
      assert.throws(() => readFileSync(takeoverPath), { code: "ENOENT" });
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    fixture.close();
  }
});

test("separate processes repair one corrupt cache entry without deleting the winner", async () => {
  const fixture = createThumbnailFixture();
  try {
    const input = {
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
    };
    const seeded = await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target));
    const path = join(
      fixture.dataDir,
      "cache",
      "artifact-thumbnails",
      "v1",
      seeded.cacheKey.slice(0, 2),
      `${seeded.cacheKey}.bin`,
    );
    writeFileSync(path, "corrupt");
    const script = `
      import { Store } from "../../packages/core/src/index.ts";
      import { getOrCreateArtifactThumbnail } from "./src/artifact-thumbnail.ts";
      const store = new Store(${JSON.stringify(join(fixture.dataDir, "store.db"))});
      let rendered = false;
      try {
        const result = await getOrCreateArtifactThumbnail({
          store,
          dataDir: ${JSON.stringify(fixture.dataDir)},
          projectId: ${JSON.stringify(fixture.projectId)},
          artifactId: ${JSON.stringify(fixture.artifactId)},
          revisionId: ${JSON.stringify(fixture.revision.id)},
        }, async (target) => {
          rendered = true;
          await new Promise((resolve) => setTimeout(resolve, 400));
          return {
            bytes: Buffer.from(${JSON.stringify(PNG.toString("base64"))}, "base64"),
            contentType: "image/png",
            targetChecksum: target.targetChecksum,
          };
        });
        console.log(JSON.stringify({ rendered, cacheHit: result.cacheHit }));
      } finally {
        store.close();
      }
    `;
    const results = await Promise.all([runThumbnailChild(script), runThumbnailChild(script)]);
    assert.equal(results.filter((result) => result.rendered).length, 1);
    assert.equal(results.filter((result) => result.cacheHit).length, 1);
    assert.deepEqual((await getOrCreateArtifactThumbnail(input, (target) => renderedPng(target))).bytes, PNG);
  } finally {
    fixture.close();
  }
});
