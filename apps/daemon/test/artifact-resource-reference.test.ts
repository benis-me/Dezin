import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store, type GenerationTaskAttemptClaim } from "../../../packages/core/src/index.ts";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import { stableStringify, type ContextPack } from "../src/context/context-types.ts";
import {
  createProductionArtifactResourceReferenceMaterializer,
  exactArtifactResourceReferences,
  fenceArtifactResourceCandidateTransaction,
  fenceArtifactResourceRunner,
} from "../src/orchestration/artifact-resource-reference.ts";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const VALID_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
  "base64",
);

interface ProjectReferenceFileFixture {
  readonly path: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly checksum: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

function projectReferencePayload(files: readonly ProjectReferenceFileFixture[]): Buffer {
  return Buffer.from(`${stableStringify({
    protocol: "dezin.project-reference-bundle.v1",
    source: {
      project: { id: "source-project", name: "Source", mode: "standard" },
      workspaceId: "source-workspace",
      snapshotId: "source-snapshot",
      artifactId: "source-artifact",
      artifactRevisionId: "source-revision",
    },
    design: {
      artifact: {},
      track: {},
      revision: {},
      kernelRevision: {},
      assembly: {},
      dependencies: [],
      resourcePins: [],
      graphNode: null,
      adjacentEdges: [],
      adjacentNodes: [],
      files,
    },
  })}\n`, "utf8");
}

function removeFixture(path: string): void {
  const makeWritable = (entry: string): void => {
    const metadata = lstatSync(entry, { throwIfNoEntry: false });
    if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) return;
    chmodSync(entry, 0o700);
    for (const name of readdirSync(entry)) makeWritable(join(entry, name));
  };
  makeWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function contextPack(input: {
  workspaceId: string;
  resourceId: string;
  revisionId: string;
  manifestChecksum: string;
  sourceType: "uploaded-file" | "project-reference";
}): ContextPack {
  const hash = "a".repeat(64);
  return {
    id: `context-pack-${hash}`,
    workspaceId: input.workspaceId,
    graphRevision: 1,
    target: { type: "artifact", id: "artifact-reference-target" },
    intent: "generate",
    messageChecksum: "b".repeat(64),
    items: [{
      ordinal: 0,
      contextClass: "explicit",
      ref: {
        kind: "resource",
        id: input.resourceId,
        resourceKind: "file",
        revisionId: input.revisionId,
      },
      resolvedKind: "resource-revision",
      content: "immutable file evidence",
      checksum: input.manifestChecksum,
      reason: "exact file revision",
      trustLevel: "untrusted",
      capabilities: [],
      boundary: {
        source: `resource-revision:${input.revisionId}`,
        readOnly: true,
        mayGrantCapabilities: false,
      },
      tokenEstimate: 8,
      provenance: {
        resourceId: input.resourceId,
        resourceRevisionId: input.revisionId,
        resourceKind: "file",
        manifestChecksum: input.manifestChecksum,
        source: { sourceType: input.sourceType },
      },
      provided: true,
    }],
    omissions: [],
    tokenEstimate: 8,
    manifestPath: "context-packs/test.json",
    hash,
    createdAt: 1,
  };
}

function claim(input: {
  workspaceId: string;
  resourceId: string;
  revisionId: string;
}): GenerationTaskAttemptClaim {
  return {
    task: {
      id: "task-reference-target",
      planId: "plan-reference-target",
      workspaceId: input.workspaceId,
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: input.workspaceId,
        id: "artifact-reference-target",
        trackId: "track-reference-target",
      },
      dependsOn: [],
      payload: {
        version: 2,
        brief: { proposalRationale: "Use the exact uploaded visual." },
        artifactPlan: {
          artifactId: "artifact-reference-target",
          artifactKind: "page",
          name: "Reference target",
          route: "/",
          sourceRoot: ".",
          defaultTrackId: "track-reference-target",
          targetInstruction: "Use the exact uploaded visual.",
          rationale: "Use the exact uploaded visual.",
          operation: "generate",
        },
        dependencyPlans: [],
        responsiveFrames: [{ id: "desktop", width: 1440, height: 900 }],
        capabilityDescriptors: [],
      },
      qaProfile: { requireVisualReview: false },
      resourceLimits: {
        maxAgentTurns: 1,
        maxRepairRounds: 0,
        maxOutputBytes: 1024 * 1024,
      },
      maxAttempts: 1,
      state: "running",
      pendingContextPolicy: null,
      currentAttempt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    attempt: {
      taskId: "task-reference-target",
      workspaceId: input.workspaceId,
      attempt: 1,
      executionMode: "full",
      target: {
        type: "artifact",
        workspaceId: input.workspaceId,
        id: "artifact-reference-target",
        trackId: "track-reference-target",
      },
      inputHash: "c".repeat(64),
      payload: {
        version: 2,
        brief: { proposalRationale: "Use the exact uploaded visual." },
        artifactPlan: {
          artifactId: "artifact-reference-target",
          artifactKind: "page",
          name: "Reference target",
          route: "/",
          sourceRoot: ".",
          defaultTrackId: "track-reference-target",
          targetInstruction: "Use the exact uploaded visual.",
          rationale: "Use the exact uploaded visual.",
          operation: "generate",
        },
        dependencyPlans: [],
        responsiveFrames: [{ id: "desktop", width: 1440, height: 900 }],
        capabilityDescriptors: [],
      },
      expectedSnapshotId: null,
      expectedGraphRevision: 1,
      contextPackId: `context-pack-${"a".repeat(64)}`,
      resourcePins: [{
        resourceId: input.resourceId,
        revisionId: input.revisionId,
        sourceTaskId: null,
      }],
      componentPins: [],
      sourceCommitHash: "d".repeat(40),
      sourceTreeHash: "e".repeat(40),
      state: "running",
      startedAt: 1,
      heartbeatAt: 1,
      createdAt: 1,
      completedAt: null,
      failure: null,
    },
  } as unknown as GenerationTaskAttemptClaim;
}

async function publishedFile(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  workspaceId: string;
  bytes: Buffer;
  mimeType: string;
  sourceType: "uploaded-file" | "project-reference";
}) {
  const resourceId = randomUUID();
  const revisionId = randomUUID();
  const sealed = await sealResourceRevisionPayload({
    storageRoot: input.dataDir,
    workspaceId: input.workspaceId,
    resourceId,
    revisionId,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });
  const workspace = input.store.workspace.getWorkspace(input.projectId)!;
  input.store.workspace.createPublishedResourceForProject(input.projectId, {
    resourceId,
    nodeId: randomUUID(),
    commandId: randomUUID(),
    kind: "file",
    title: "Exact reference",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    revision: {
      revisionId,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: "Exact reference",
      metadata: {
        mimeType: sealed.mimeType,
        byteLength: sealed.byteSize,
        payloadChecksum: sealed.payloadChecksum,
      },
      checksum: sealed.manifestChecksum,
      provenance: {
        sourceType: input.sourceType,
        sourceId: ".refs/reference.png",
      },
    },
    reason: "artifact-reference-fixture",
  });
  return { resourceId, revisionId, sealed };
}

test("Artifact Agent sidecar exposes exact uploaded PNG bytes and hides them from candidate commits", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-reference-"));
  const worktreeDir = join(dataDir, "candidate");
  const store = new Store(join(dataDir, "store.sqlite"));
  try {
    const project = store.createProject({ name: "Artifact references", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const exact = await publishedFile({
      store,
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      bytes: VALID_PNG,
      mimeType: "image/png",
      sourceType: "uploaded-file",
    });
    await mkdir(worktreeDir, { recursive: true });
    git(worktreeDir, "init", "-q");
    git(worktreeDir, "config", "user.name", "Fixture");
    git(worktreeDir, "config", "user.email", "fixture@dezin.local");
    await writeFile(join(worktreeDir, "index.html"), "<main>base</main>\n");
    git(worktreeDir, "add", "index.html");
    git(worktreeDir, "commit", "-q", "-m", "base");
    const pack = contextPack({
      workspaceId: workspace.id,
      resourceId: exact.resourceId,
      revisionId: exact.revisionId,
      manifestChecksum: exact.sealed.manifestChecksum,
      sourceType: "uploaded-file",
    });
    const references = exactArtifactResourceReferences({
      claim: claim({
        workspaceId: workspace.id,
        resourceId: exact.resourceId,
        revisionId: exact.revisionId,
      }),
      contextPack: pack,
    });
    const fence = await createProductionArtifactResourceReferenceMaterializer({
      store,
      dataDir,
    }).materializeExactReferences({
      references,
      worktreeDir,
      signal: AbortSignal.timeout(5_000),
    });
    assert.ok(fence);
    const mounted = fence.references[0]!;
    assert.deepEqual(await readFile(join(worktreeDir, mounted.payloadPath)), VALID_PNG);
    assert.deepEqual(
      [...(await readFile(join(worktreeDir, mounted.payloadPath))).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    let bytesReadByRunner: Buffer | null = null;
    const runner = fenceArtifactResourceRunner({
      id: "reference-reader",
      async runTurn(input) {
        bytesReadByRunner = await readFile(join(input.projectDir, mounted.payloadPath));
        return { text: "read exact visual", artifactHtml: "<main>done</main>" };
      },
    }, fence, AbortSignal.timeout(5_000));
    await runner.runTurn({
      systemPrompt: "Use exact references.",
      message: "Generate.",
      projectDir: worktreeDir,
    });
    assert.deepEqual(bytesReadByRunner, VALID_PNG);

    let visibleDuringCommit = true;
    const transaction = fenceArtifactResourceCandidateTransaction({
      dir: worktreeDir,
      attemptRef: "refs/dezin/generation-attempts/artifacts/reference",
      async fingerprint() { return "f".repeat(64); },
      async commit() {
        visibleDuringCommit = existsSync(join(worktreeDir, fence.mountPath));
        git(worktreeDir, "commit", "-q", "--allow-empty", "-m", "candidate");
        return {
          commitHash: git(worktreeDir, "rev-parse", "HEAD"),
          treeHash: git(worktreeDir, "rev-parse", "HEAD^{tree}"),
        };
      },
      async restore() {},
      async dispose() {},
    }, fence);
    await transaction.commit("exact reference", AbortSignal.timeout(5_000));
    assert.equal(visibleDuringCommit, false);
    assert.doesNotMatch(git(worktreeDir, "ls-tree", "-r", "--name-only", "HEAD"), /\.dezin\/references/);
    assert.equal(existsSync(join(worktreeDir, mounted.payloadPath)), true);

    const tamperingRunner = fenceArtifactResourceRunner({
      id: "reference-tamper",
      async runTurn(input) {
        const path = join(input.projectDir, mounted.payloadPath);
        await chmod(path, 0o644);
        await writeFile(path, Buffer.alloc(VALID_PNG.byteLength, 0x42));
        throw new Error("provider failed after mutating its exact input");
      },
    }, fence, AbortSignal.timeout(5_000));
    await assert.rejects(
      tamperingRunner.runTurn({
        systemPrompt: "Use exact references.",
        message: "Generate.",
        projectDir: worktreeDir,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && (error as Error & { code?: string }).code === "sidecar-mutated"
      ),
    );
    await transaction.dispose();
    assert.equal(existsSync(join(worktreeDir, fence.mountPath)), false);
  } finally {
    store.close();
    removeFixture(dataDir);
  }
});

test("Artifact Agent sidecar exposes exact uploaded JPEG bytes instead of prompt-only metadata", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-jpeg-reference-"));
  const candidateWorktreeDir = join(dataDir, "candidate");
  const worktreeDir = join(
    candidateWorktreeDir,
    "workspaces",
    "workspace-1",
    "artifacts",
    "artifact-1",
  );
  const store = new Store(join(dataDir, "store.sqlite"));
  try {
    const project = store.createProject({ name: "JPEG Artifact reference", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const exact = await publishedFile({
      store,
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      bytes: VALID_JPEG,
      mimeType: "image/jpeg",
      sourceType: "uploaded-file",
    });
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(join(worktreeDir, ".sharingan"));
    await writeFile(
      join(worktreeDir, ".sharingan", "pages.json"),
      "{\"protocol\":\"dezin.sharingan.fixture.v1\"}\n",
    );
    const fence = await createProductionArtifactResourceReferenceMaterializer({ store, dataDir })
      .materializeExactReferences({
        references: exactArtifactResourceReferences({
          claim: claim({
            workspaceId: workspace.id,
            resourceId: exact.resourceId,
            revisionId: exact.revisionId,
          }),
          contextPack: contextPack({
            workspaceId: workspace.id,
            resourceId: exact.resourceId,
            revisionId: exact.revisionId,
            manifestChecksum: exact.sealed.manifestChecksum,
            sourceType: "uploaded-file",
          }),
        }),
        worktreeDir,
        signal: AbortSignal.timeout(5_000),
      });
    assert.ok(fence);
    const bytes = await readFile(join(worktreeDir, fence.references[0]!.payloadPath));
    assert.deepEqual(bytes, VALID_JPEG);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.equal(existsSync(join(candidateWorktreeDir, ".dezin", "references")), false);
    assert.equal(
      await readFile(join(worktreeDir, ".sharingan", "pages.json"), "utf8"),
      "{\"protocol\":\"dezin.sharingan.fixture.v1\"}\n",
    );
    await fence.dispose();
    assert.equal(
      await readFile(join(worktreeDir, ".sharingan", "pages.json"), "utf8"),
      "{\"protocol\":\"dezin.sharingan.fixture.v1\"}\n",
    );
  } finally {
    store.close();
    removeFixture(dataDir);
  }
});

test("Artifact Agent project-reference sidecar extracts exact shared and component bytes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-project-reference-"));
  const worktreeDir = join(dataDir, "candidate");
  const store = new Store(join(dataDir, "store.sqlite"));
  try {
    const project = store.createProject({ name: "Project references", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const files: Array<{
      path: string;
      mimeType: string;
      byteLength: number;
      checksum: string;
      encoding: "utf8" | "base64";
      content: string;
    }> = [
      { path: "src/page.tsx", content: "export const Page = () => <Card />;\\n" },
      { path: "src/components/Card.tsx", content: "export const Card = () => <article>Exact card</article>;\\n" },
      { path: "src/shared/tokens.css", content: ":root { --accent: #FF4D00; }\\n" },
    ].map((file) => {
      const bytes = Buffer.from(file.content, "utf8");
      return {
        path: file.path,
        mimeType: file.path.endsWith(".css") ? "text/css" : "text/typescript",
        byteLength: bytes.byteLength,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        encoding: "utf8",
        content: file.content,
      };
    });
    const sharedBinary = Buffer.alloc(6_400 * 1024, 0x5a);
    files.push({
      path: "src/shared/hero-reference.bin",
      mimeType: "application/octet-stream",
      byteLength: sharedBinary.byteLength,
      checksum: createHash("sha256").update(sharedBinary).digest("hex"),
      encoding: "base64",
      content: sharedBinary.toString("base64"),
    });
    files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const payload = projectReferencePayload(files);
    assert.ok(payload.byteLength > 8 * 1024 * 1024, "fixture must exercise the compound JSON override");
    const exact = await publishedFile({
      store,
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      bytes: payload,
      mimeType: "application/json",
      sourceType: "project-reference",
    });
    await mkdir(worktreeDir, { recursive: true });
    const pack = contextPack({
      workspaceId: workspace.id,
      resourceId: exact.resourceId,
      revisionId: exact.revisionId,
      manifestChecksum: exact.sealed.manifestChecksum,
      sourceType: "project-reference",
    });
    const references = exactArtifactResourceReferences({
      claim: claim({
        workspaceId: workspace.id,
        resourceId: exact.resourceId,
        revisionId: exact.revisionId,
      }),
      contextPack: pack,
    });
    const fence = await createProductionArtifactResourceReferenceMaterializer({
      store,
      dataDir,
    }).materializeExactReferences({
      references,
      worktreeDir,
      signal: AbortSignal.timeout(5_000),
    });
    assert.ok(fence);
    const projectRoot = fence.references[0]!.projectRoot!;
    assert.equal(
      await readFile(join(worktreeDir, projectRoot, "src/components/Card.tsx"), "utf8"),
      "export const Card = () => <article>Exact card</article>;\\n",
    );
    assert.equal(
      await readFile(join(worktreeDir, projectRoot, "src/shared/tokens.css"), "utf8"),
      ":root { --accent: #FF4D00; }\\n",
    );
    assert.deepEqual(
      await readFile(join(worktreeDir, projectRoot, "src/shared/hero-reference.bin")),
      sharedBinary,
    );
    await fence.dispose();
  } finally {
    store.close();
    removeFixture(dataDir);
  }
});

test("Artifact Agent project-reference materialization rejects unsafe paths, types, digests, and budgets", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-project-reference-adversarial-"));
  const store = new Store(join(dataDir, "store.sqlite"));
  try {
    const project = store.createProject({ name: "Adversarial Project references", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const emptyChecksum = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    const scenarios: ReadonlyArray<{
      readonly name: string;
      readonly files: readonly ProjectReferenceFileFixture[];
      readonly error: RegExp;
    }> = [
      {
        name: "path traversal",
        files: [{
          path: "../escape.bin",
          mimeType: "application/octet-stream",
          byteLength: 1,
          checksum: createHash("sha256").update(Buffer.from([0x41])).digest("hex"),
          encoding: "base64",
          content: Buffer.from([0x41]).toString("base64"),
        }],
        error: /unsafe file path/i,
      },
      {
        name: "immutable inner checksum drift",
        files: [{
          path: "src/reference.bin",
          mimeType: "application/octet-stream",
          byteLength: 3,
          checksum: "0".repeat(64),
          encoding: "base64",
          content: Buffer.from("abc").toString("base64"),
        }],
        error: /bytes do not match.*exact digest/i,
      },
      {
        name: "invalid file MIME type",
        files: [{
          path: "src/reference.bin",
          mimeType: "not-a-mime",
          byteLength: 1,
          checksum: createHash("sha256").update(Buffer.from([0x42])).digest("hex"),
          encoding: "base64",
          content: Buffer.from([0x42]).toString("base64"),
        }],
        error: /metadata is invalid/i,
      },
      {
        name: "per-file byte budget overflow",
        files: [{
          path: "src/reference.bin",
          mimeType: "application/octet-stream",
          byteLength: (16 * 1024 * 1024) + 1,
          checksum: emptyChecksum,
          encoding: "base64",
          content: "",
        }],
        error: /metadata is invalid/i,
      },
      {
        name: "file-count overflow",
        files: Array.from({ length: 513 }, (_, index) => ({
          path: `src/file-${index.toString().padStart(4, "0")}.bin`,
          mimeType: "application/octet-stream",
          byteLength: 0,
          checksum: emptyChecksum,
          encoding: "base64" as const,
          content: "",
        })),
        error: /file list is invalid/i,
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      await t.test(scenario.name, async () => {
        const worktreeDir = join(dataDir, `candidate-${index}`);
        const payload = projectReferencePayload(scenario.files);
        const exact = await publishedFile({
          store,
          dataDir,
          projectId: project.id,
          workspaceId: workspace.id,
          bytes: payload,
          mimeType: "application/json",
          sourceType: "project-reference",
        });
        await mkdir(worktreeDir, { recursive: true });
        const references = exactArtifactResourceReferences({
          claim: claim({
            workspaceId: workspace.id,
            resourceId: exact.resourceId,
            revisionId: exact.revisionId,
          }),
          contextPack: contextPack({
            workspaceId: workspace.id,
            resourceId: exact.resourceId,
            revisionId: exact.revisionId,
            manifestChecksum: exact.sealed.manifestChecksum,
            sourceType: "project-reference",
          }),
        });
        await assert.rejects(
          createProductionArtifactResourceReferenceMaterializer({ store, dataDir })
            .materializeExactReferences({
              references,
              worktreeDir,
              signal: AbortSignal.timeout(5_000),
            }),
          scenario.error,
        );
        assert.equal(existsSync(join(worktreeDir, ".dezin", "references")), false);
        assert.equal(existsSync(join(dataDir, "escape.bin")), false);
      });
    }
  } finally {
    store.close();
    removeFixture(dataDir);
  }
});

test("Artifact Agent reference materialization rejects a symlinked reserved parent without writing outside cwd", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-reference-symlink-"));
  const worktreeDir = join(dataDir, "candidate");
  const outsideDir = join(dataDir, "outside");
  const store = new Store(join(dataDir, "store.sqlite"));
  try {
    const project = store.createProject({ name: "Symlink reference boundary", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const exact = await publishedFile({
      store,
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      bytes: VALID_PNG,
      mimeType: "image/png",
      sourceType: "uploaded-file",
    });
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(worktreeDir, ".dezin"), "dir");
    const references = exactArtifactResourceReferences({
      claim: claim({
        workspaceId: workspace.id,
        resourceId: exact.resourceId,
        revisionId: exact.revisionId,
      }),
      contextPack: contextPack({
        workspaceId: workspace.id,
        resourceId: exact.resourceId,
        revisionId: exact.revisionId,
        manifestChecksum: exact.sealed.manifestChecksum,
        sourceType: "uploaded-file",
      }),
    });
    await assert.rejects(
      createProductionArtifactResourceReferenceMaterializer({ store, dataDir })
        .materializeExactReferences({
          references,
          worktreeDir,
          signal: AbortSignal.timeout(5_000),
        }),
      /parent path is unsafe/i,
    );
    assert.equal(existsSync(join(outsideDir, "references")), false);
  } finally {
    store.close();
    removeFixture(dataDir);
  }
});

test("Artifact Agent sidecar rejects sealed payload tampering and ignores unrelated Research resources", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-reference-tamper-"));
  const worktreeDir = join(dataDir, "candidate");
  const store = new Store(join(dataDir, "store.sqlite"));
  try {
    const project = store.createProject({ name: "Tamper reference", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const exact = await publishedFile({
      store,
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      bytes: VALID_PNG,
      mimeType: "image/png",
      sourceType: "uploaded-file",
    });
    await mkdir(worktreeDir, { recursive: true });
    const pack = contextPack({
      workspaceId: workspace.id,
      resourceId: exact.resourceId,
      revisionId: exact.revisionId,
      manifestChecksum: exact.sealed.manifestChecksum,
      sourceType: "uploaded-file",
    });
    const exactClaim = claim({
      workspaceId: workspace.id,
      resourceId: exact.resourceId,
      revisionId: exact.revisionId,
    });
    await chmod(exact.sealed.payloadPath, 0o644);
    await writeFile(exact.sealed.payloadPath, Buffer.alloc(VALID_PNG.byteLength, 0x41));
    await assert.rejects(
      createProductionArtifactResourceReferenceMaterializer({ store, dataDir }).materializeExactReferences({
        references: exactArtifactResourceReferences({ claim: exactClaim, contextPack: pack }),
        worktreeDir,
        signal: AbortSignal.timeout(5_000),
      }),
      /checksum|bytes do not match/i,
    );

    const researchPack: ContextPack = {
      ...structuredClone(pack),
      items: [{
        ...structuredClone(pack.items[0]!),
        ref: {
          kind: "resource",
          id: exact.resourceId,
          resourceKind: "research",
          revisionId: exact.revisionId,
        },
        provenance: {
          ...structuredClone(pack.items[0]!.provenance),
          resourceKind: "research",
        },
      }],
    };
    const unrelated = exactArtifactResourceReferences({ claim: exactClaim, contextPack: researchPack });
    assert.deepEqual(unrelated, []);
    const fence = await createProductionArtifactResourceReferenceMaterializer({ store, dataDir })
      .materializeExactReferences({
        references: unrelated,
        worktreeDir,
        signal: AbortSignal.timeout(5_000),
      });
    assert.equal(fence, null);
    assert.equal(existsSync(join(worktreeDir, ".dezin", "references")), false);
  } finally {
    store.close();
    removeFixture(dataDir);
  }
});

test("Artifact file references fail closed on omission, duplicate evidence, or Attempt pin substitution", () => {
  const workspaceId = randomUUID();
  const resourceId = randomUUID();
  const revisionId = randomUUID();
  const pack = contextPack({
    workspaceId,
    resourceId,
    revisionId,
    manifestChecksum: "9".repeat(64),
    sourceType: "uploaded-file",
  });
  const exactClaim = claim({ workspaceId, resourceId, revisionId });

  assert.throws(
    () => exactArtifactResourceReferences({
      claim: exactClaim,
      contextPack: {
        ...pack,
        omissions: [{
          ref: {
            kind: "resource",
            id: resourceId,
            resourceKind: "file",
            revisionId,
          },
          contextClass: "explicit",
          reason: "budget",
          tokenEstimate: 1,
        }],
      },
    }),
    /omitted/i,
  );
  assert.throws(
    () => exactArtifactResourceReferences({
      claim: exactClaim,
      contextPack: {
        ...pack,
        items: [
          pack.items[0]!,
          { ...structuredClone(pack.items[0]!), ordinal: 1 },
        ],
      },
    }),
    /duplicate/i,
  );
  assert.throws(
    () => exactArtifactResourceReferences({
      claim: {
        ...exactClaim,
        attempt: {
          ...exactClaim.attempt,
          resourcePins: [{
            ordinal: 0,
            resourceId,
            revisionId: randomUUID(),
            sourceTaskId: null,
          }],
        },
      },
      contextPack: pack,
    }),
    /does not match.*Attempt pin/i,
  );
});
