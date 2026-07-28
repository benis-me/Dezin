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
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
    const payload = Buffer.from(`${stableStringify({
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
