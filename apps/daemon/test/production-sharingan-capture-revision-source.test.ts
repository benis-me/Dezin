import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import {
  checksumBytes,
  estimateContextTokens,
  stableStringify,
  type ContextPack,
} from "../src/context/context-types.ts";
import { freezeResourceExecutionProfile } from "../src/orchestration/production-generation-context.ts";
import type { ResourceGenerationAdapterInput } from "../src/orchestration/resource-task-executor.ts";
import { createProductionResourceGenerationImplementations } from "../src/orchestration/production-resource-generators.ts";
import { ProductionSharinganCaptureRevisionMaterializer } from "../src/orchestration/sharingan-capture-revision-materializer.ts";
import {
  ProductionSharinganCaptureRevisionBundleSourceError,
  createProductionSharinganCaptureRevisionBundleSource,
} from "../src/orchestration/production-sharingan-capture-revision-source.ts";
import { encodeSharinganCaptureResourceBundle } from "../src/orchestration/sharingan-capture-resource-bundle.ts";
import {
  semanticSharinganCaptureFiles,
  sharinganFixturePng,
} from "./support/sharingan-capture-fixture.ts";

const CONSUMING_CONTEXT_HASH = "a".repeat(64);
const ARTIFACT_CONTEXT_HASH = "b".repeat(64);
const PNG = sharinganFixturePng();

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-sharingan-source-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const store = new Store();
  const project = store.createProject({ name: "Exact Sharingan source", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "sharingan-capture",
    title: "Source capture",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, store, project, workspace, created };
}

function input(
  workspaceId: string,
  resourceId: string,
  contextPackId: string,
): ResourceGenerationAdapterInput {
  return {
    taskId: "capture-task",
    planId: "capture-plan",
    attempt: 1,
    inputHash: "d".repeat(64),
    workspaceId,
    resourceId,
    parentRevisionId: null,
    contextPackId,
    operation: "create",
    nodeId: "capture-node",
    title: "Source capture",
    resourceKind: "sharingan-capture",
    brief: {
      proposalRationale: "Freeze exact source evidence.",
      assumptions: [],
      targetInstructions: { operation: "create", kind: "sharingan-capture", title: "Source capture" },
    },
    capabilityDescriptors: [{ id: "browser", kind: "browser", required: true }],
    signal: new AbortController().signal,
  };
}

function resourceContextPack(
  f: Awaited<ReturnType<typeof fixture>>,
  resourceId: string,
): ContextPack {
  const executionProfile = freezeResourceExecutionProfile({
    ownership: {
      projectId: f.project.id,
      workspaceId: f.workspace.id,
      planId: "capture-plan",
      taskId: "capture-task",
      targetResourceId: resourceId,
    },
    resourceKind: "sharingan-capture",
    adapter: {
      id: "dezin.resource-adapter.sharingan-capture",
      version: 1,
      kind: "sharingan-capture",
    },
    settings: f.store.getSettings(),
  });
  const targetContent = stableStringify({
    protocol: "dezin.generation-target-context.v2",
    projectId: f.project.id,
    workspaceId: f.workspace.id,
    planId: "capture-plan",
    taskId: "capture-task",
    taskKind: "resource",
    target: { type: "resource", workspaceId: f.workspace.id, id: resourceId },
    payload: {
      version: 2,
      operation: {
        operation: "create",
        nodeId: "capture-node",
        resourceId,
        kind: "sharingan-capture",
        title: "Source capture",
        revisionPolicy: { kind: "generate" },
      },
      brief: {
        proposalRationale: "Freeze exact source evidence.",
        assumptions: [],
        targetInstructions: {
          operation: "create",
          kind: "sharingan-capture",
          title: "Source capture",
        },
      },
      capabilityDescriptors: [{ id: "browser", kind: "browser", required: true }],
      adapter: executionProfile.adapter,
    },
    capabilities: ["browser"],
    qaProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
    resourceLimits: {
      timeoutMs: 60_000,
      maxAgentTurns: 1,
      maxRepairRounds: 0,
      maxOutputBytes: 8 * 1024 * 1024,
      capacityClasses: ["browser"],
    },
    expectedSnapshotId: f.workspace.activeSnapshotId,
    graphRevision: f.workspace.graphRevision,
    kernelRevisionId: f.workspace.activeKernelRevisionId,
    resourceExecutionProfile: executionProfile,
  });
  const targetItem = {
    ordinal: 0,
    contextClass: "target" as const,
    ref: { kind: "inline" as const, id: resourceId },
    resolvedKind: "inline" as const,
    content: targetContent,
    checksum: checksumBytes(targetContent),
    reason: "exact immutable Generation Task target contract and Resource execution profile",
    trustLevel: "trusted" as const,
    capabilities: [],
    boundary: {
      source: "generation-task:capture-task",
      readOnly: true as const,
      mayGrantCapabilities: false as const,
    },
    tokenEstimate: estimateContextTokens(targetContent),
    provenance: {
      projectId: f.project.id,
      workspaceId: f.workspace.id,
      planId: "capture-plan",
      taskId: "capture-task",
      targetResourceId: resourceId,
      resourceExecutionProfileChecksum: executionProfile.checksum,
      expectedSnapshotId: f.workspace.activeSnapshotId,
      graphRevision: f.workspace.graphRevision,
      kernelRevisionId: f.workspace.activeKernelRevisionId,
    },
    provided: true as const,
  };
  const body = {
    protocol: "dezin-context-pack-v1" as const,
    workspaceId: f.workspace.id,
    graphRevision: f.workspace.graphRevision,
    target: { type: "resource" as const, id: resourceId },
    intent: "generate" as const,
    messageChecksum: "c".repeat(64),
    items: [targetItem],
    omissions: [],
    tokenEstimate: targetItem.tokenEstimate,
  };
  const hash = checksumBytes(stableStringify(body));
  return {
    ...body,
    id: `context-pack-${hash}`,
    manifestPath: `context-packs/${hash}.json`,
    hash,
    createdAt: 1,
  };
}

function captureExport(request: any, marker: string) {
  return {
    protocol: "dezin.sharingan-capture-export.v1" as const,
    scope: request.scope,
    exporter: { id: "dezin-sharingan-capture", version: 1 as const },
    source: { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", capturedAt: 10 },
    files: semanticSharinganCaptureFiles({ marker }),
  };
}

async function bundleBytes(
  f: Awaited<ReturnType<typeof fixture>>,
  resourceId: string,
  marker: string,
): Promise<{ readonly bytes: Uint8Array; readonly contextPackId: string }> {
  const contextPack = resourceContextPack(f, resourceId);
  const implementations = createProductionResourceGenerationImplementations({
    contextPacks: {
      get: (workspaceId, contextPackId) => workspaceId === f.workspace.id
        && contextPackId === contextPack.id
        ? contextPack
        : null,
    },
    agent: { async generateStructured() { throw new Error("not used"); } },
    sharinganCaptures: { async exportExactCapture(request) { return captureExport(request, marker); } },
  });
  return {
    bytes: (await implementations["sharingan-capture"]!(
      input(f.workspace.id, resourceId, contextPack.id),
    )).bytes,
    contextPackId: contextPack.id,
  };
}

async function persistRevision(f: Awaited<ReturnType<typeof fixture>>, revisionId: string, marker: string) {
  const generated = await bundleBytes(f, f.created.resource.id, marker);
  const sealed = await sealResourceRevisionPayload({
    storageRoot: f.dataDir,
    workspaceId: f.workspace.id,
    resourceId: f.created.resource.id,
    revisionId,
    mimeType: "application/json",
    bytes: generated.bytes,
  });
  const revision = f.store.workspace.createResourceRevisionCandidateForProject(
    f.project.id,
    f.created.resource.id,
    {
      revisionId,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: `Capture ${marker}`,
      metadata: { mimeType: sealed.mimeType, byteSize: sealed.byteSize, payloadChecksum: sealed.payloadChecksum },
      checksum: sealed.manifestChecksum,
      provenance: { exporter: "fixture", marker },
    },
  );
  return { sealed, revision, producingContextPackId: generated.contextPackId };
}

function reference(
  f: Awaited<ReturnType<typeof fixture>>,
  revisionId: string,
  checksum: string,
  contextPackHash = CONSUMING_CONTEXT_HASH,
) {
  return {
    workspaceId: f.workspace.id,
    contextPackId: `context-pack-${contextPackHash}`,
    contextPackHash,
    resourceId: f.created.resource.id,
    revisionId,
    revisionChecksum: checksum,
  };
}

test("exact ResourceRevision source binds the consuming Artifact pack independently from the Resource pack", async (t) => {
  const f = await fixture(t);
  const old = await persistRevision(f, "capture-revision-old", "old-exact");
  const newer = await persistRevision(f, "capture-revision-new", "newest-live");
  assert.notEqual(old.revision.checksum, newer.revision.checksum);
  const destination = join(f.root, "destination");
  await mkdir(destination);
  const source = createProductionSharinganCaptureRevisionBundleSource({ store: f.store, dataDir: f.dataDir });

  const artifactReference = reference(
    f,
    old.revision.id,
    old.revision.checksum,
    ARTIFACT_CONTEXT_HASH,
  );
  assert.notEqual(
    artifactReference.contextPackId,
    old.producingContextPackId,
    "the consuming Artifact pack must not be the Resource Task pack frozen in the bundle",
  );
  const receipt = await source.materializeExactRevision({
    reference: artifactReference,
    destinationDir: destination,
    signal: new AbortController().signal,
  });

  assert.equal(receipt.protocol, "dezin.sharingan-capture-materialization.v2");
  assert.deepEqual({
    workspaceId: receipt.workspaceId,
    contextPackId: receipt.contextPackId,
    contextPackHash: receipt.contextPackHash,
    resourceId: receipt.resourceId,
    revisionId: receipt.revisionId,
    revisionChecksum: receipt.revisionChecksum,
  }, artifactReference);
  assert.equal(receipt.files.length, 8);
  assert.deepEqual(receipt.files.map((file) => file.path), [
    ".sharingan/entry/assets.json",
    ".sharingan/entry/dom.json",
    ".sharingan/entry/render-map.json",
    ".sharingan/entry/shot.png",
    ".sharingan/entry/styles.json",
    ".sharingan/pages.json",
    ".sharingan/probe.mjs",
    "public/_assets/source.png",
  ]);
  assert.match(await readFile(join(destination, ".sharingan", "pages.json"), "utf8"), /old-exact/);
  assert.doesNotMatch(await readFile(join(destination, ".sharingan", "pages.json"), "utf8"), /newest-live/);
  assert.equal((await readFile(join(destination, ".sharingan", "entry", "shot.png"))).equals(PNG), true);
  assert.equal((await readFile(join(destination, "public", "_assets", "source.png"))).equals(sharinganFixturePng(64, 64)), true);

  const worktree = join(f.root, "candidate-worktree");
  await mkdir(worktree);
  const materializer = new ProductionSharinganCaptureRevisionMaterializer({ source });
  const fence = await materializer.materializeExactRevision({
    reference: artifactReference,
    worktreeDir: worktree,
    signal: new AbortController().signal,
  });
  assert.deepEqual(fence.reference, artifactReference);
  await fence.verify(new AbortController().signal);
  assert.match(await readFile(join(worktree, ".sharingan", "pages.json"), "utf8"), /old-exact/);
  assert.equal((await readFile(join(worktree, "public", "_assets", "source.png"))).equals(sharinganFixturePng(64, 64)), true);
  await fence.dispose();
});

test("exact ResourceRevision source rejects checksum substitution and leaves destination empty", async (t) => {
  const f = await fixture(t);
  const old = await persistRevision(f, "capture-revision-old", "old-exact");
  const destination = join(f.root, "destination");
  await mkdir(destination);
  const source = createProductionSharinganCaptureRevisionBundleSource({ store: f.store, dataDir: f.dataDir });

  await assert.rejects(
    () => source.materializeExactRevision({
      reference: reference(f, old.revision.id, "f".repeat(64)),
      destinationDir: destination,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionSharinganCaptureRevisionBundleSourceError
      && error.code === "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
  );
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(destination)), []);
});

test("exact ResourceRevision source still rejects a bundle with substituted Resource scope", async (t) => {
  const f = await fixture(t);
  const revisionId = "capture-revision-substituted-resource";
  const sealed = await sealResourceRevisionPayload({
    storageRoot: f.dataDir,
    workspaceId: f.workspace.id,
    resourceId: f.created.resource.id,
    revisionId,
    mimeType: "application/json",
    bytes: (await bundleBytes(f, "resource-substituted", "wrong-resource")).bytes,
  });
  const revision = f.store.workspace.createResourceRevisionCandidateForProject(
    f.project.id,
    f.created.resource.id,
    {
      revisionId,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: "Substituted Resource scope",
      metadata: { mimeType: sealed.mimeType },
      checksum: sealed.manifestChecksum,
      provenance: {},
    },
  );
  const destination = join(f.root, "destination");
  await mkdir(destination);
  const source = createProductionSharinganCaptureRevisionBundleSource({ store: f.store, dataDir: f.dataDir });

  await assert.rejects(
    () => source.materializeExactRevision({
      reference: reference(f, revision.id, revision.checksum, ARTIFACT_CONTEXT_HASH),
      destinationDir: destination,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionSharinganCaptureRevisionBundleSourceError
      && error.code === "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
  );
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(destination)), []);
});

test("exact ResourceRevision source refuses non-empty destinations and unsafe bundle paths", async (t) => {
  const f = await fixture(t);
  const old = await persistRevision(f, "capture-revision-old", "old-exact");
  const nonEmpty = join(f.root, "non-empty");
  await mkdir(nonEmpty);
  await writeFile(join(nonEmpty, "owner.txt"), "owned");
  const source = createProductionSharinganCaptureRevisionBundleSource({ store: f.store, dataDir: f.dataDir });
  await assert.rejects(
    () => source.materializeExactRevision({
      reference: reference(f, old.revision.id, old.revision.checksum),
      destinationDir: nonEmpty,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionSharinganCaptureRevisionBundleSourceError
      && error.code === "SHARINGAN_CAPTURE_DESTINATION_INVALID",
  );
  assert.equal(await readFile(join(nonEmpty, "owner.txt"), "utf8"), "owned");

  const malicious = JSON.parse(Buffer.from(
    (await bundleBytes(f, f.created.resource.id, "unsafe")).bytes,
  ).toString("utf8"));
  malicious.files.push({ path: "../escape.txt", mode: 292, byteLength: 4, checksum: "0".repeat(64), bytesBase64: "ZXZpbA==" });
  const sealed = await sealResourceRevisionPayload({
    storageRoot: f.dataDir,
    workspaceId: f.workspace.id,
    resourceId: f.created.resource.id,
    revisionId: "capture-revision-malicious",
    mimeType: "application/json",
    bytes: Buffer.from(JSON.stringify(malicious)),
  });
  const revision = f.store.workspace.createResourceRevisionCandidateForProject(f.project.id, f.created.resource.id, {
    revisionId: "capture-revision-malicious",
    parentRevisionId: null,
    manifestPath: sealed.manifestPath,
    summary: "malicious",
    metadata: { mimeType: sealed.mimeType },
    checksum: sealed.manifestChecksum,
    provenance: {},
  });
  const empty = join(f.root, "empty");
  await mkdir(empty);
  await assert.rejects(
    () => source.materializeExactRevision({
      reference: reference(f, revision.id, revision.checksum),
      destinationDir: empty,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionSharinganCaptureRevisionBundleSourceError
      && error.code === "SHARINGAN_CAPTURE_BUNDLE_INVALID",
  );
});

test("exact ResourceRevision readback rejects fake pixels, empty evidence, and viewport substitution before copy", async (t) => {
  const cases = [
    ["fake-png", semanticSharinganCaptureFiles({ screenshotBytes: Buffer.from("fake PNG bytes") })],
    ["fake-local-png", semanticSharinganCaptureFiles({ assetBytes: Buffer.from("fake local PNG bytes") })],
    ["empty-dom", semanticSharinganCaptureFiles({ dom: [] })],
    ["empty-styles", semanticSharinganCaptureFiles({
      styles: { colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] },
    })],
    ["empty-render-map", semanticSharinganCaptureFiles({ renderMap: {} })],
    ["viewport-mismatch", semanticSharinganCaptureFiles({
      renderMap: {
        viewport: { width: 1280, height: 720 },
        document: { width: 1280, height: 1800 },
        elements: [{
          selector: "body",
          tag: "body",
          box: { x: 0, y: 0, w: 1280, h: 1800 },
          style: { display: "block" },
        }],
      },
    })],
  ] as const;
  for (const [label, files] of cases) {
    await t.test(label, async (subtest) => {
      const f = await fixture(subtest);
      const revisionId = `capture-revision-${label}`;
      const bytes = encodeSharinganCaptureResourceBundle({
        scope: {
          taskId: "capture-task-invalid",
          planId: "capture-plan-invalid",
          attempt: 1,
          inputHash: "e".repeat(64),
          workspaceId: f.workspace.id,
          resourceId: f.created.resource.id,
          parentRevisionId: null,
          contextPackId: "context-pack-invalid",
          operation: "create",
          nodeId: "capture-node-invalid",
          title: "Invalid capture",
          resourceKind: "sharingan-capture",
        },
        source: {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          capturedAt: 10,
        },
        exporter: { id: "fixture", version: 1 },
        files,
        maxOutputBytes: 1024 * 1024,
      }).bytes;
      const sealed = await sealResourceRevisionPayload({
        storageRoot: f.dataDir,
        workspaceId: f.workspace.id,
        resourceId: f.created.resource.id,
        revisionId,
        mimeType: "application/json",
        bytes,
      });
      const revision = f.store.workspace.createResourceRevisionCandidateForProject(
        f.project.id,
        f.created.resource.id,
        {
          revisionId,
          parentRevisionId: null,
          manifestPath: sealed.manifestPath,
          summary: "Semantically invalid capture",
          metadata: { mimeType: sealed.mimeType },
          checksum: sealed.manifestChecksum,
          provenance: {},
        },
      );
      const destination = join(f.root, "destination");
      await mkdir(destination);
      const source = createProductionSharinganCaptureRevisionBundleSource({
        store: f.store,
        dataDir: f.dataDir,
      });
      await assert.rejects(
        () => source.materializeExactRevision({
          reference: reference(f, revision.id, revision.checksum),
          destinationDir: destination,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof ProductionSharinganCaptureRevisionBundleSourceError
          && error.code === "SHARINGAN_CAPTURE_BUNDLE_INVALID",
      );
      assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(destination)), []);
    });
  }
});
