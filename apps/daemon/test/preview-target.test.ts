import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { Store } from "../../../packages/core/src/index.ts";
import {
  createApp,
  createRuntimeSupervisor,
  type AppDeps,
} from "../src/app.ts";
import type { PreviewLeaseManager } from "../src/preview-lease.ts";
import { releaseProjectRuntime, type PreviewRuntimeOptions } from "../src/project-runtime.ts";
import { projectDir, serveFileFromBase } from "../src/serve-static.ts";
import {
  acquirePreviewTargetLease,
  parsePreviewTarget,
  revalidateResolvedPreviewTarget,
  resolvePreviewTarget,
  type PreviewTarget,
} from "../src/preview-target.ts";
import {
  buildRenderAssembly,
  materializeRenderAssembly,
  renderAssemblyMaterializer,
  stablePreviewHash,
} from "../src/render-assembly.ts";
import {
  MAX_RESOURCE_MANIFEST_BYTES,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
} from "../src/resource-revision-payload.ts";
import * as renderAssemblyModule from "../src/render-assembly.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function insertResourceRevisionFixture(
  store: Store,
  workspaceId: string,
  resourceId: string,
  revisionId: string,
  kind: "research" | "asset" = "research",
): void {
  store.db.prepare(
    `INSERT INTO resources (
       id, workspace_id, kind, title, head_revision_id, default_pin_policy,
       archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, 'follow-head', NULL, 1, 1)`,
  ).run(resourceId, workspaceId, kind, resourceId);
  store.db.prepare(
    `INSERT INTO resource_revisions (
       id, workspace_id, resource_id, sequence, manifest_path, summary,
       metadata_json, checksum, provenance_json, created_by_run_id, created_at
     ) VALUES (?, ?, ?, 1, ?, ?, '{}', ?, '{}', NULL, 2)`,
  ).run(
    revisionId,
    workspaceId,
    resourceId,
    `resources/${revisionId}.json`,
    `Summary ${revisionId}`,
    `checksum-${revisionId}`,
  );
}

function resourceStorageKey(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}

function testCrc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(testCrc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
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
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, interlace], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pngRgbaScanlines(width, height, interlace))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithInvalidCompressedData(width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([0])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithInvalidFilter(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([5, 0, 0, 0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithTrailingZlibBytes(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.concat([deflateSync(Buffer.alloc(5)), Buffer.from([0])])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithCorruptNativeCrc(): Buffer {
  const bytes = Buffer.from(structuredPng());
  const typeOffset = bytes.indexOf(Buffer.from("IDAT", "ascii"));
  const length = bytes.readUInt32BE(typeOffset - 4);
  const crcOffset = typeOffset + 4 + length;
  bytes.writeUInt8(bytes.readUInt8(crcOffset) ^ 0xff, crcOffset);
  return bytes;
}

function structuredGrayscalePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([1, 0, 0, 0, 0], 8);
  const rowBytes = Math.ceil(width / 8);
  const scanlines = Buffer.alloc(height * (rowBytes + 1));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function structuredJpeg(width = 1, height = 1): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function webpContainer(type: "VP8 " | "VP8L", data: Buffer): Buffer {
  const padding = data.length & 1;
  const chunk = Buffer.alloc(8 + data.length + padding);
  chunk.write(type, 0, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  const bytes = Buffer.alloc(12 + chunk.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  chunk.copy(bytes, 12);
  return bytes;
}

function structuredWebp(): Buffer {
  return webpContainer("VP8L", Buffer.from([0x2f, 0, 0, 0, 0]));
}

function insertResourcePayloadFixture(
  store: Store,
  dataDir: string,
  workspaceId: string,
  resourceId: string,
  revisionId: string,
  input: {
    kind?: "research" | "asset";
    mimeType: string;
    bytes: Uint8Array;
    manifestPath?: string;
    manifestChecksum?: string;
    payloadChecksum?: string;
  },
): { publicUrl: string; mountPath: string; manifestPath: string; payloadPath: string } {
  const workspaceKey = resourceStorageKey("dezin-resource-workspace-v1", workspaceId);
  const revisionKey = resourceStorageKey("dezin-resource-revision-v1", revisionId);
  const manifestPath = input.manifestPath ?? join(
    "resource-revisions",
    workspaceKey,
    revisionKey,
    "manifest.json",
  );
  const absoluteManifest = join(dataDir, manifestPath);
  const payloadPath = join(dirname(absoluteManifest), "payload.bin");
  const payloadChecksum = input.payloadChecksum
    ?? createHash("sha256").update(input.bytes).digest("hex");
  const manifestBytes = Buffer.from(`${JSON.stringify({
    protocol: "dezin-resource-revision-payload-v1",
    workspaceId,
    resourceId,
    resourceRevisionId: revisionId,
    payload: {
      file: "payload.bin",
      mimeType: input.mimeType,
      byteLength: input.bytes.byteLength,
      checksum: payloadChecksum,
    },
  }, null, 2)}\n`);
  mkdirSync(dirname(absoluteManifest), { recursive: true });
  writeFileSync(absoluteManifest, manifestBytes);
  writeFileSync(payloadPath, input.bytes);
  store.db.prepare(
    `INSERT INTO resources (
       id, workspace_id, kind, title, head_revision_id, default_pin_policy,
       archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, 'pin-current', NULL, 1, 1)`,
  ).run(resourceId, workspaceId, input.kind ?? "research", resourceId);
  store.db.prepare(
    `INSERT INTO resource_revisions (
       id, workspace_id, resource_id, sequence, manifest_path, summary,
       metadata_json, checksum, provenance_json, created_by_run_id, created_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, '{}', NULL, 2)`,
  ).run(
    revisionId,
    workspaceId,
    resourceId,
    manifestPath,
    `Summary ${revisionId}`,
    JSON.stringify({ mimeType: input.mimeType }),
    input.manifestChecksum ?? createHash("sha256").update(manifestBytes).digest("hex"),
  );
  const extension = input.mimeType === "image/png" ? "png" : input.mimeType === "text/plain" ? "txt" : "bin";
  const mountPath = `.dezin/resources/${revisionKey}/payload.${extension}`;
  return { publicUrl: `/${mountPath}`, mountPath, manifestPath: absoluteManifest, payloadPath };
}

async function fetchMaterializedFile(root: string, relativePath: string): Promise<{
  status: number;
  contentType: string | null;
  bytes: Buffer;
}> {
  const server = createServer((_, res) => {
    void serveFileFromBase(res, root, relativePath);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${relativePath}`);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface PreviewFixture {
  dataDir: string;
  root: string;
  store: Store;
  projectId: string;
  artifactId: string;
  trackId: string;
  snapshotId: string;
  headRevisionId: string | null;
  commit(source: string): { commitHash: string; sourceTreeHash: string };
  createRevision(input?: {
    producedByRunId?: string | null;
    source?: string;
    kernelRevisionId?: string;
    renderSpec?: Record<string, unknown>;
  }): {
    revisionId: string;
    snapshotId: string;
    commitHash: string;
    sourceTreeHash: string;
  };
  close(): void;
}

function createPreviewFixture(): PreviewFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-preview-target-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Preview targets", mode: "standard" });
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
  const root = projectDir(dataDir, project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin-test@example.invalid"]);

  const fixture: PreviewFixture = {
    dataDir,
    root,
    store,
    projectId: project.id,
    artifactId: artifact.id,
    trackId: track.id,
    snapshotId: bundle.activeSnapshot.id,
    headRevisionId: null,
    commit(source) {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        private: true,
        scripts: { dev: "vite" },
      }));
      writeFileSync(join(root, "index.html"), source);
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", `fixture ${source}`]);
      const commitHash = git(root, ["rev-parse", "HEAD"]);
      return { commitHash, sourceTreeHash: git(root, ["rev-parse", `${commitHash}^{tree}`]) };
    },
    createRevision(input = {}) {
      const source = input.source ?? `revision-${Date.now()}-${Math.random()}`;
      const committed = fixture.commit(source);
      const revision = store.workspace.createArtifactRevision({
        artifactId: artifact.id,
        trackId: track.id,
        parentRevisionId: fixture.headRevisionId,
        sourceCommitHash: committed.commitHash,
        sourceTreeHash: committed.sourceTreeHash,
        kernelRevisionId: input.kernelRevisionId ?? bundle.workspace.activeKernelRevisionId,
        renderSpec: input.renderSpec ?? { entry: "index.html", frames: [{ id: "desktop", width: 1440, height: 900 }] },
        quality: { state: "unassessed", score: null, findings: [] },
        producedByRunId: input.producedByRunId ?? null,
        dependencies: [],
        resourcePins: [],
      });
      const snapshot = store.workspace.publishArtifactRevision(revision.id, {
        expectedHeadRevisionId: fixture.headRevisionId,
        expectedSnapshotId: fixture.snapshotId,
      });
      fixture.headRevisionId = revision.id;
      fixture.snapshotId = snapshot.id;
      return {
        revisionId: revision.id,
        snapshotId: snapshot.id,
        ...committed,
      };
    },
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return fixture;
}

const componentFixtureRenderSpec = {
  entry: "index.html",
  componentFixture: {
    protocol: "dezin-component-fixture-v1",
    consumerGlobal: "__DEZIN_COMPONENT_FIXTURE__",
    variants: {
      compact: {
        states: {
          default: { props: { label: "Buy" }, background: "#ffffff" },
          hover: {
            props: { label: "Buy now", emphasis: "strong" },
            cssVariables: { "--button-background": "#7c3aed" },
            background: "#f5f3ff",
          },
        },
      },
    },
  },
} as const;

function addComponentArtifactRevisions(
  fixture: PreviewFixture,
  sources: readonly string[],
  options: {
    resourcePins?: Array<{ resourceId: string; resourceRevisionId: string }>;
  } = {},
): {
  componentArtifactId: string;
  componentTrackId: string;
  revisionIds: string[];
} {
  const beforeComponent = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!;
  const componentArtifactId = "component-artifact";
  const componentTrackId = "component-track";
  const graphResult = fixture.store.workspace.applyGraphCommands(fixture.projectId, {
    baseGraphRevision: beforeComponent.graph.revision,
    expectedSnapshotId: fixture.snapshotId,
    commands: [{
      id: "add-component",
      type: "add-node",
      node: {
        id: "component-node",
        kind: "component",
        name: "Button",
        artifactId: componentArtifactId,
        createIdentity: { initialTrackId: componentTrackId },
      },
    }],
  });
  fixture.snapshotId = graphResult.snapshot.id;
  const componentArtifact = fixture.store.workspace
    .getBundleByProjectId(fixture.projectId)!
    .artifacts.find((candidate) => candidate.id === componentArtifactId)!;
  const componentRoot = join(fixture.root, componentArtifact.sourceRoot);
  mkdirSync(componentRoot, { recursive: true });
  writeFileSync(join(componentRoot, "package.json"), JSON.stringify({
    private: true,
    scripts: { dev: "vite" },
  }));

  const revisionIds: string[] = [];
  let parentRevisionId: string | null = null;
  for (const [index, source] of sources.entries()) {
    writeFileSync(join(componentRoot, "index.html"), source);
    const committed = fixture.commit(`page-with-component-${index + 1}`);
    const revision = fixture.store.workspace.createArtifactRevision({
      artifactId: componentArtifactId,
      trackId: componentTrackId,
      parentRevisionId,
      sourceCommitHash: committed.commitHash,
      sourceTreeHash: committed.sourceTreeHash,
      kernelRevisionId: beforeComponent.workspace.activeKernelRevisionId,
      renderSpec: componentFixtureRenderSpec,
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: options.resourcePins ?? [],
    });
    const snapshot = fixture.store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: parentRevisionId,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.snapshotId = snapshot.id;
    parentRevisionId = revision.id;
    revisionIds.push(revision.id);
  }
  return { componentArtifactId, componentTrackId, revisionIds };
}

function createPageRevisionWithDependencies(
  fixture: PreviewFixture,
  dependencies: Array<{
    instanceId: string;
    componentArtifactId: string;
    componentRevisionId: string;
    variantKey?: string;
    stateKey?: string;
    overrides: Record<string, unknown>;
    createInstanceIdentity?: boolean;
    status?: "linked" | "detached";
  }>,
): string {
  const bundle = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!;
  const committed = fixture.commit(`page-dependencies-${JSON.stringify(dependencies)}`);
  return fixture.store.workspace.createArtifactRevision({
    artifactId: fixture.artifactId,
    trackId: fixture.trackId,
    parentRevisionId: fixture.headRevisionId,
    sourceCommitHash: committed.commitHash,
    sourceTreeHash: committed.sourceTreeHash,
    kernelRevisionId: bundle.workspace.activeKernelRevisionId,
    renderSpec: { entry: "index.html" },
    quality: { state: "unassessed", score: null, findings: [] },
    dependencies: dependencies.map(({
      createInstanceIdentity = true,
      status = "linked",
      ...dependency
    }) => ({
      ...dependency,
      ...(createInstanceIdentity ? { createInstanceIdentity: true } : {}),
      sourceLocator: {
        designNodeId: `${dependency.instanceId}-slot`,
        sourcePath: "index.html",
      },
      status,
    })),
    resourcePins: [],
  }).id;
}

function archiveArtifactNode(fixture: PreviewFixture, artifactId: string): void {
  const bundle = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!;
  const node = bundle.graph.nodes.find((candidate) => (
    candidate.kind !== "resource" && candidate.artifactId === artifactId
  ));
  assert.ok(node, `Artifact ${artifactId} must have an active Workspace node before archive`);
  const archived = fixture.store.workspace.applyGraphCommands(fixture.projectId, {
    baseGraphRevision: bundle.graph.revision,
    expectedSnapshotId: fixture.snapshotId,
    commands: [{
      id: `archive-${node.id}`,
      type: "archive-node",
      nodeId: node.id,
    }],
  });
  fixture.snapshotId = archived.snapshot.id;
}

async function withHttpServer(
  deps: Pick<AppDeps, "store" | "dataDir"> & Partial<AppDeps>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const runtimeSupervisor = deps.runtimeSupervisor
    ?? createRuntimeSupervisor({ store: deps.store, dataDir: deps.dataDir });
  const server = createApp({ ...deps, runtimeSupervisor });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("PreviewTarget parsing is exhaustive and rejects unknown transport fields", () => {
  const targets: PreviewTarget[] = [
    { kind: "artifact-current", projectId: "project", artifactId: "page", trackId: "track" },
    { kind: "artifact-revision", projectId: "project", revisionId: "revision" },
    { kind: "run-candidate", projectId: "project", runId: "run" },
    {
      kind: "generation-candidate",
      projectId: "project",
      artifactId: "page",
      planId: "plan",
      taskId: "task",
      attempt: 2,
    },
    { kind: "workspace-flow", projectId: "project", snapshotId: "snapshot", startArtifactId: "page" },
    { kind: "workspace-flow", projectId: "project", snapshotId: "snapshot", startArtifactId: "page", stateKey: "receipt" },
    {
      kind: "component-state",
      projectId: "project",
      revisionId: "revision",
      variantKey: "compact",
      stateKey: "hover",
    },
  ];

  assert.deepEqual(targets.map((target) => parsePreviewTarget(target)), targets);
  assert.throws(
    () => parsePreviewTarget({ ...targets[0], revisionId: "smuggled" }),
    /unexpected field revisionId/i,
  );
  assert.throws(
    () => parsePreviewTarget({ kind: "future", projectId: "project" }),
    /unsupported PreviewTarget kind/i,
  );
  assert.throws(
    () => parsePreviewTarget({ kind: "artifact-current", projectId: "", artifactId: "page" }),
    /projectId must be a non-empty string/i,
  );
  assert.throws(
    () => parsePreviewTarget({
      kind: "generation-candidate",
      projectId: "project",
      artifactId: "page",
      planId: "plan",
      taskId: "task",
      attempt: 0,
    }),
    /attempt must be a positive safe integer/i,
  );
});

test("workspace-flow stateKey resolves and revalidates only an exact frozen Revision RenderSpec state", async () => {
  const fixture = createPreviewFixture();
  try {
    const exact = fixture.createRevision({
      renderSpec: {
        entry: "index.html",
        frames: [
          { id: "desktop", name: "Desktop", width: 1440, height: 900 },
          { id: "receipt", name: "Receipt", width: 1440, height: 900, initialState: "receipt-ready" },
        ],
      },
    });
    const target = {
      kind: "workspace-flow" as const,
      projectId: fixture.projectId,
      snapshotId: exact.snapshotId,
      startArtifactId: fixture.artifactId,
      stateKey: "receipt-ready",
    };
    const resolved = await resolvePreviewTarget(fixture, target);
    const withoutState = await resolvePreviewTarget(fixture, {
      kind: "workspace-flow",
      projectId: fixture.projectId,
      snapshotId: exact.snapshotId,
      startArtifactId: fixture.artifactId,
    });

    assert.equal(resolved.revisionId, exact.revisionId);
    assert.equal(resolved.stateKey, "receipt-ready");
    assert.notEqual(resolved.targetKey, withoutState.targetKey);
    assert.deepEqual(revalidateResolvedPreviewTarget(fixture, resolved), resolved);
    await assert.rejects(
      resolvePreviewTarget(fixture, { ...target, stateKey: "missing-state" }),
      /RenderSpec state missing-state/i,
    );

    const multiViewport = fixture.createRevision({
      renderSpec: {
        entry: "index.html",
        frames: [
          { id: "desktop", name: "Desktop", width: 1440, height: 900, initialState: "checkout-ready" },
          { id: "mobile", name: "Mobile", width: 390, height: 844, initialState: "checkout-ready" },
        ],
      },
    });
    const multiViewportTarget = await resolvePreviewTarget(fixture, {
      kind: "workspace-flow",
      projectId: fixture.projectId,
      snapshotId: multiViewport.snapshotId,
      startArtifactId: fixture.artifactId,
      stateKey: "checkout-ready",
    });
    assert.equal(multiViewportTarget.stateKey, "checkout-ready");
    assert.deepEqual(revalidateResolvedPreviewTarget(fixture, multiViewportTarget), multiViewportTarget);
  } finally {
    fixture.close();
  }
});

test("current, revision, candidate, and flow targets resolve to immutable owned revisions", async () => {
  const fixture = createPreviewFixture();
  try {
    const first = fixture.createRevision();
    const current = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    assert.equal(current.revisionId, first.revisionId);
    assert.equal(current.snapshotId, first.snapshotId);
    assert.equal(current.sourceTreeHash, first.sourceTreeHash);

    const historical = await resolvePreviewTarget(fixture, {
      kind: "artifact-revision",
      projectId: fixture.projectId,
      revisionId: first.revisionId,
    });
    assert.equal(historical.revisionId, first.revisionId);
    assert.equal(historical.snapshotId, first.snapshotId);

    const flow = await resolvePreviewTarget(fixture, {
      kind: "workspace-flow",
      projectId: fixture.projectId,
      snapshotId: first.snapshotId,
      startArtifactId: fixture.artifactId,
    });
    assert.equal(flow.revisionId, first.revisionId);
    assert.equal(flow.snapshotId, first.snapshotId);

    const conversation = fixture.store.createConversation(fixture.projectId);
    const run = fixture.store.createRun(fixture.projectId, conversation.id);
    const second = fixture.createRevision({ producedByRunId: run.id });
    const candidate = await resolvePreviewTarget(fixture, {
      kind: "run-candidate",
      projectId: fixture.projectId,
      runId: run.id,
    });
    assert.equal(candidate.revisionId, second.revisionId);
    assert.equal(candidate.runId, run.id);

    assert.equal(current.revisionId, first.revisionId, "the first resolution remains immutable after Head moves");
    const nextCurrent = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    assert.equal(nextCurrent.revisionId, second.revisionId);
    assert.notEqual(nextCurrent.targetKey, current.targetKey);
  } finally {
    fixture.close();
  }
});

test("formal Revision previews reject unpublished candidates while run-candidate preview remains available", async () => {
  const fixture = createPreviewFixture();
  try {
    const published = fixture.createRevision();
    const conversation = fixture.store.createConversation(fixture.projectId);
    const run = fixture.store.createRun(fixture.projectId, conversation.id);
    const committed = fixture.commit("unpublished candidate preview");
    const candidate = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: published.revisionId,
      sourceCommitHash: committed.commitHash,
      sourceTreeHash: committed.sourceTreeHash,
      kernelRevisionId: fixture.store.workspace.getWorkspace(fixture.projectId)!.activeKernelRevisionId,
      renderSpec: { entry: "index.html", frames: [{ id: "desktop", width: 1440, height: 900 }] },
      quality: { state: "unassessed", score: null, findings: [] },
      producedByRunId: run.id,
      dependencies: [],
      resourcePins: [],
    });

    await assert.rejects(resolvePreviewTarget(fixture, {
      kind: "artifact-revision",
      projectId: fixture.projectId,
      revisionId: candidate.id,
    }), /published|Snapshot|formal Revision/i);
    const runCandidate = await resolvePreviewTarget(fixture, {
      kind: "run-candidate",
      projectId: fixture.projectId,
      runId: run.id,
    });
    assert.equal(runCandidate.revisionId, candidate.id);
    assert.equal(runCandidate.snapshotId, null);
  } finally {
    fixture.close();
  }
});

test("Generation candidate previews bind an unpublished Revision to one exact Attempt identity", async () => {
  const fixture = createPreviewFixture();
  try {
    const published = fixture.createRevision();
    const committed = fixture.commit("unpublished Generation candidate preview");
    const candidate = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: published.revisionId,
      sourceCommitHash: committed.commitHash,
      sourceTreeHash: committed.sourceTreeHash,
      kernelRevisionId: fixture.store.workspace.getWorkspace(fixture.projectId)!.activeKernelRevisionId,
      renderSpec: { entry: "index.html", frames: [{ id: "desktop", width: 1440, height: 900 }] },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [],
    });
    const attempt = {
      planId: "plan-candidate",
      taskId: "task-candidate",
      workspaceId: fixture.store.workspace.getWorkspace(fixture.projectId)!.id,
      attempt: 2,
      status: "candidate-ready",
      target: {
        type: "artifact",
        workspaceId: fixture.store.workspace.getWorkspace(fixture.projectId)!.id,
        id: fixture.artifactId,
        trackId: fixture.trackId,
      },
      candidateRevisionId: candidate.id,
      candidateResourceRevisionId: null,
      candidateEvidence: { protocol: "dezin.artifact-run.v1" },
      candidateEvidenceHash: "e".repeat(64),
    };
    fixture.store.workspace.getGenerationTaskAttemptForProject = (() => attempt) as never;

    const resolved = await resolvePreviewTarget(fixture, {
      kind: "generation-candidate",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      planId: attempt.planId,
      taskId: attempt.taskId,
      attempt: attempt.attempt,
    });
    assert.equal(resolved.revisionId, candidate.id);
    assert.equal(resolved.snapshotId, null);
    assert.deepEqual(resolved.generationCandidate, {
      planId: attempt.planId,
      taskId: attempt.taskId,
      attempt: attempt.attempt,
      evidenceHash: attempt.candidateEvidenceHash,
    });

    attempt.candidateEvidenceHash = "f".repeat(64);
    assert.throws(
      () => revalidateResolvedPreviewTarget(fixture, resolved),
      /immutable assembly/i,
    );
  } finally {
    fixture.close();
  }
});

test("explicit historical Track preview rejects a forged unpublished Head", async () => {
  const fixture = createPreviewFixture();
  try {
    const published = fixture.createRevision();
    const committed = fixture.commit("unpublished historical Track candidate");
    const candidate = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: published.revisionId,
      sourceCommitHash: committed.commitHash,
      sourceTreeHash: committed.sourceTreeHash,
      kernelRevisionId: fixture.store.workspace.getWorkspace(fixture.projectId)!.activeKernelRevisionId,
      renderSpec: { entry: "index.html", frames: [{ id: "desktop", width: 1440, height: 900 }] },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [],
    });
    const fork = fixture.store.workspace.forkArtifactTrackForProject(
      fixture.projectId,
      fixture.artifactId,
      {
        sourceRevisionId: published.revisionId,
        name: "Active fork",
        expectedHeadRevisionId: published.revisionId,
        expectedSnapshotId: published.snapshotId,
      },
    );
    assert.notEqual(fork.track.id, fixture.trackId);

    fixture.store.db.prepare(
      "UPDATE artifact_tracks SET head_revision_id = ? WHERE id = ?",
    ).run(candidate.id, fixture.trackId);

    await assert.rejects(resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
    }), /published|Snapshot|formal Revision/i);
  } finally {
    fixture.close();
  }
});

test("preview resolution and lease revalidation never build the full Workspace history bundle", async () => {
  const fixture = createPreviewFixture();
  try {
    const historical = fixture.createRevision();
    const current = fixture.createRevision();
    const originalBundle = fixture.store.workspace.getBundleByProjectId.bind(fixture.store.workspace);
    const originalSnapshots = fixture.store.workspace.listSnapshots.bind(fixture.store.workspace);
    const originalRevisions = fixture.store.workspace.listRevisions.bind(fixture.store.workspace);
    fixture.store.workspace.getBundleByProjectId = (() => assert.fail(
      "Preview Target must not build a full Workspace history bundle",
    )) as typeof fixture.store.workspace.getBundleByProjectId;
    fixture.store.workspace.listSnapshots = (() => assert.fail(
      "Preview Target must not scan Snapshot history",
    )) as typeof fixture.store.workspace.listSnapshots;
    fixture.store.workspace.listRevisions = (() => assert.fail(
      "Preview Target must not scan Artifact Revision history",
    )) as typeof fixture.store.workspace.listRevisions;
    try {
      const flow = await resolvePreviewTarget(fixture, {
        kind: "workspace-flow",
        projectId: fixture.projectId,
        snapshotId: historical.snapshotId,
        startArtifactId: fixture.artifactId,
      });
      assert.equal(flow.revisionId, historical.revisionId);
      assert.equal(flow.snapshotId, historical.snapshotId);

      const active = await resolvePreviewTarget(fixture, {
        kind: "artifact-current",
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
      });
      assert.equal(active.revisionId, current.revisionId);
      assert.deepEqual(revalidateResolvedPreviewTarget(fixture, flow), flow);
      assert.deepEqual(revalidateResolvedPreviewTarget(fixture, active), active);
    } finally {
      fixture.store.workspace.getBundleByProjectId = originalBundle;
      fixture.store.workspace.listSnapshots = originalSnapshots;
      fixture.store.workspace.listRevisions = originalRevisions;
    }
  } finally {
    fixture.close();
  }
});

test("current Preview uses shallow Snapshot pins while historical replay keeps full lineage validation", async () => {
  const fixture = createPreviewFixture();
  try {
    const first = fixture.createRevision({ source: "<main>First</main>" });
    const second = fixture.createRevision({ source: "<main>Second</main>" });
    const resolvedSecond = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    const third = fixture.createRevision({ source: "<main>Third</main>" });
    fixture.store.db.exec("DROP TRIGGER workspace_snapshot_update_immutable");
    fixture.store.db.prepare("UPDATE workspace_snapshots SET provenance_json = '{' WHERE id = ?")
      .run(first.snapshotId);

    assert.deepEqual(revalidateResolvedPreviewTarget(fixture, resolvedSecond), resolvedSecond);
    const lease = await acquirePreviewTargetLease({
      ...fixture,
      ensureDevServer: async () => ({
        leaseId: "shallow-current-lease",
        url: "http://127.0.0.1:4312",
        bridgeNonce: "shallow_current_preview_bridge_nonce_abcdefghijklmnopqrstuvwxyz0123456789",
        expiresAt: 99_000,
        release: async () => {},
      }),
    }, resolvedSecond);
    assert.equal(lease.resolved.revisionId, second.revisionId);
    await lease.release();

    const current = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    assert.equal(current.revisionId, third.revisionId);
    await assert.rejects(
      resolvePreviewTarget(fixture, {
        kind: "workspace-flow",
        projectId: fixture.projectId,
        snapshotId: third.snapshotId,
        startArtifactId: fixture.artifactId,
      }),
      /JSON|provenance/i,
    );
    await assert.rejects(
      resolvePreviewTarget(fixture, {
        kind: "artifact-revision",
        projectId: fixture.projectId,
        revisionId: third.revisionId,
      }),
      /JSON|provenance/i,
    );
  } finally {
    fixture.close();
  }
});

test("current Preview builds a bounded leaf closure without decoding Artifact ancestors", async () => {
  const fixture = createPreviewFixture();
  try {
    const first = fixture.createRevision({ source: "<main>Ancestor</main>" });
    const second = fixture.createRevision({ source: "<main>Current</main>" });
    fixture.store.db.exec("DROP TRIGGER artifact_revision_update_immutable");
    fixture.store.db.prepare("UPDATE artifact_revisions SET render_spec_json = '{' WHERE id = ?")
      .run(first.revisionId);

    const fullReads = {
      artifactRevision: 0,
      kernelRevision: 0,
      dependencies: 0,
      resourcePins: 0,
    };
    const originalArtifactRevision = fixture.store.workspace.getArtifactRevision.bind(fixture.store.workspace);
    const originalKernelRevision = fixture.store.workspace.getKernelRevision.bind(fixture.store.workspace);
    const originalDependencies = fixture.store.workspace.listArtifactRevisionDependencies.bind(fixture.store.workspace);
    const originalResourcePins = fixture.store.workspace.listArtifactRevisionResourcePins.bind(fixture.store.workspace);
    fixture.store.workspace.getArtifactRevision = ((revisionId: string) => {
      fullReads.artifactRevision += 1;
      return originalArtifactRevision(revisionId);
    }) as typeof fixture.store.workspace.getArtifactRevision;
    fixture.store.workspace.getKernelRevision = ((revisionId: string) => {
      fullReads.kernelRevision += 1;
      return originalKernelRevision(revisionId);
    }) as typeof fixture.store.workspace.getKernelRevision;
    fixture.store.workspace.listArtifactRevisionDependencies = ((revisionId: string) => {
      fullReads.dependencies += 1;
      return originalDependencies(revisionId);
    }) as typeof fixture.store.workspace.listArtifactRevisionDependencies;
    fixture.store.workspace.listArtifactRevisionResourcePins = ((revisionId: string) => {
      fullReads.resourcePins += 1;
      return originalResourcePins(revisionId);
    }) as typeof fixture.store.workspace.listArtifactRevisionResourcePins;
    let current: Awaited<ReturnType<typeof resolvePreviewTarget>>;
    try {
      current = await resolvePreviewTarget(fixture, {
        kind: "artifact-current",
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
      });
      assert.deepEqual(revalidateResolvedPreviewTarget(fixture, current), current);
      const lease = await acquirePreviewTargetLease({
        ...fixture,
        ensureDevServer: async () => ({
          leaseId: "bounded-current-lease",
          url: "http://127.0.0.1:4312",
          bridgeNonce: "bounded_current_preview_bridge_nonce_abcdefghijklmnopqrstuvwxyz0123456789",
          expiresAt: 99_000,
          release: async () => {},
        }),
      }, current);
      await lease.release();
    } finally {
      fixture.store.workspace.getArtifactRevision = originalArtifactRevision;
      fixture.store.workspace.getKernelRevision = originalKernelRevision;
      fixture.store.workspace.listArtifactRevisionDependencies = originalDependencies;
      fixture.store.workspace.listArtifactRevisionResourcePins = originalResourcePins;
    }
    assert.equal(current!.revisionId, second.revisionId);
    assert.deepEqual(fullReads, {
      artifactRevision: 0,
      kernelRevision: 0,
      dependencies: 0,
      resourcePins: 0,
    });
    await assert.rejects(
      resolvePreviewTarget(fixture, {
        kind: "artifact-revision",
        projectId: fixture.projectId,
        revisionId: second.revisionId,
      }),
      /JSON|render spec/i,
    );
    await assert.rejects(
      resolvePreviewTarget(fixture, {
        kind: "workspace-flow",
        projectId: fixture.projectId,
        snapshotId: second.snapshotId,
        startArtifactId: fixture.artifactId,
      }),
      /JSON|render spec/i,
    );
  } finally {
    fixture.close();
  }
});

test("archiving an Artifact preserves explicit Revision and historical Snapshot replay while current fails closed", async () => {
  const fixture = createPreviewFixture();
  try {
    const historicalRevision = fixture.createRevision();
    const explicitBeforeArchive = await resolvePreviewTarget(fixture, {
      kind: "artifact-revision",
      projectId: fixture.projectId,
      revisionId: historicalRevision.revisionId,
    });
    const flowBeforeArchive = await resolvePreviewTarget(fixture, {
      kind: "workspace-flow",
      projectId: fixture.projectId,
      snapshotId: historicalRevision.snapshotId,
      startArtifactId: fixture.artifactId,
    });

    archiveArtifactNode(fixture, fixture.artifactId);

    await assert.rejects(
      resolvePreviewTarget(fixture, {
        kind: "artifact-current",
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
      }),
      (error: unknown) => error instanceof Error && error.name === "PreviewTargetNotFoundError",
    );
    const explicitAfterArchive = await resolvePreviewTarget(fixture, {
      kind: "artifact-revision",
      projectId: fixture.projectId,
      revisionId: historicalRevision.revisionId,
    });
    const flowAfterArchive = await resolvePreviewTarget(fixture, {
      kind: "workspace-flow",
      projectId: fixture.projectId,
      snapshotId: historicalRevision.snapshotId,
      startArtifactId: fixture.artifactId,
    });
    assert.equal(explicitAfterArchive.targetKey, explicitBeforeArchive.targetKey);
    assert.equal(flowAfterArchive.targetKey, flowBeforeArchive.targetKey);
    assert.deepEqual(
      revalidateResolvedPreviewTarget(fixture, explicitBeforeArchive),
      explicitBeforeArchive,
    );
    assert.deepEqual(
      revalidateResolvedPreviewTarget(fixture, flowBeforeArchive),
      flowBeforeArchive,
    );
  } finally {
    fixture.close();
  }
});

test("RenderAssembly identity is stable and pins the exact Kernel and dependency closure", async () => {
  const fixture = createPreviewFixture();
  try {
    const first = fixture.createRevision();
    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-revision",
      projectId: fixture.projectId,
      revisionId: first.revisionId,
    });
    const one = buildRenderAssembly(fixture.store, resolved);
    const two = buildRenderAssembly(fixture.store, resolved);

    assert.deepEqual(two, one);
    assert.equal(one.rootRevision.id, first.revisionId);
    assert.equal(one.revisions.length, 1);
    assert.equal(one.kernelRevisions.length, 1);
    assert.equal(one.kernelRevisions[0]!.id, one.rootRevision.kernelRevisionId);
    assert.equal(one.dependencyLockHash, resolved.dependencyLockHash);
    assert.equal(one.assemblyHash, resolved.assemblyHash);
    assert.match(one.runtimeKey, new RegExp(`^${fixture.projectId}:version:preview-target-`));
  } finally {
    fixture.close();
  }
});

test("stablePreviewHash uses locale-independent UTF-16 code-unit ordering", () => {
  assert.equal(
    stablePreviewHash("dezin-locale-independent-vector-v1", {
      z: 1,
      "ä": 2,
      a: 3,
      A: 4,
      "😀": 5,
      "\ue000": 6,
      nested: { "İ": 7, i: 8, I: 9 },
    }),
    "d1a73d092be2e2f7cadd8b846ebeb4be6afb216653f71df954f6320c923f8529",
  );
});

test("RenderAssembly hashing and source traversal never delegate ordering to the host locale", async () => {
  const fixture = createPreviewFixture();
  const bounded = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 60_000,
    maxIdleEntries: 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
    now: () => 42,
  });
  const localeCompareDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "localeCompare")!;
  try {
    mkdirSync(join(fixture.root, "ordering"), { recursive: true });
    writeFileSync(join(fixture.root, "ordering", "ä.txt"), "umlaut");
    writeFileSync(join(fixture.root, "ordering", "A.txt"), "upper");
    writeFileSync(join(fixture.root, "ordering", "😀.txt"), "astral");
    const revision = fixture.createRevision();
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    Object.defineProperty(String.prototype, "localeCompare", {
      ...localeCompareDescriptor,
      value() {
        throw new Error("render ordering consulted localeCompare");
      },
    });

    const artifactDir = await materializeRenderAssembly(fixture, assembly);
    assert.equal(readFileSync(join(artifactDir, "ordering", "A.txt"), "utf8"), "upper");
    const firstOwner = await bounded.acquire(fixture, assembly);
    await firstOwner.release();
    const secondRevision = fixture.createRevision({ source: "second-locale-independent-assembly" });
    const secondAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: secondRevision.revisionId,
    });
    const secondOwner = await bounded.acquire(fixture, secondAssembly);
    await secondOwner.release();
  } finally {
    Object.defineProperty(String.prototype, "localeCompare", localeCompareDescriptor);
    await bounded.dispose();
    fixture.close();
  }
});

test("materialized assemblies expose and synchronously apply the exact Kernel render context", async () => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getWorkspace(fixture.projectId)!;
    const parentKernel = fixture.store.workspace.getKernelRevision(workspace.activeKernelRevisionId)!;
    const kernel = fixture.store.workspace.createKernelRevision({
      workspaceId: workspace.id,
      parentRevisionId: parentKernel.id,
      tokens: { "--brand-accent": "#7c3aed", radius: 14 },
      typography: { display: { family: "Söhne", weight: 650 }, body: { family: "Inter" } },
      sharedAssetRevisionIds: [],
      brief: "Editorial product system",
      terminology: { cta: "primary action" },
      exclusions: ["generic dashboard"],
      responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
      qualityProfile: parentKernel.qualityProfile,
    });
    const kernelSnapshot = fixture.store.workspace.publishKernelRevision(kernel.id, {
      expectedKernelRevisionId: parentKernel.id,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.snapshotId = kernelSnapshot.id;
    const source = "<!doctype html><html><head></head><body><main>Kernel preview</main></body></html>";
    const revision = fixture.createRevision({
      kernelRevisionId: kernel.id,
      source,
    });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    const artifactDir = await materializeRenderAssembly(fixture, assembly);
    const context = JSON.parse(readFileSync(join(artifactDir, ".dezin", "render-context.json"), "utf8")) as {
      version: number;
      assemblyHash: string;
      kernel: unknown;
      kernels: unknown[];
    };
    const html = readFileSync(join(artifactDir, "index.html"), "utf8");
    const bootstrap = readFileSync(join(artifactDir, ".dezin", "render-context.js"), "utf8");

    assert.equal(context.version, 1);
    assert.equal(context.assemblyHash, assembly.assemblyHash);
    assert.deepEqual(context.kernel, kernel);
    assert.deepEqual(context.kernels, [kernel]);
    assert.equal(html, source, "render context remains a runtime sidecar and never mutates immutable source");
    assert.match(bootstrap, /__DEZIN_RENDER_CONTEXT__/);
    assert.match(bootstrap, /Object\.freeze/, "the checksum-verified Kernel fallback must remain immutable at runtime");
    assert.match(bootstrap, /--brand-accent/);
    assert.match(bootstrap, /#7c3aed/);
    assert.match(bootstrap, /Söhne/);
  } finally {
    fixture.close();
  }
});

test("RenderAssembly materializes and serves exact Artifact pins and Kernel shared Asset payloads", async () => {
  const fixture = createPreviewFixture();
  try {
    const bundle = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!;
    const researchBytes = Buffer.from("Pinned research evidence\n", "utf8");
    const researchPayload = insertResourcePayloadFixture(
      fixture.store,
      fixture.dataDir,
      bundle.workspace.id,
      "research-resource",
      "research-resource-v1",
      { mimeType: "text/plain", bytes: researchBytes },
    );
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const sharedPayload = insertResourcePayloadFixture(
      fixture.store,
      fixture.dataDir,
      bundle.workspace.id,
      "shared-asset",
      "shared-asset-v1",
      { kind: "asset", mimeType: "image/png", bytes: imageBytes },
    );
    const parentKernel = fixture.store.workspace.getKernelRevision(bundle.workspace.activeKernelRevisionId)!;
    const assetKernel = fixture.store.workspace.createKernelRevision({
      workspaceId: bundle.workspace.id,
      parentRevisionId: parentKernel.id,
      tokens: parentKernel.tokens,
      typography: parentKernel.typography,
      sharedAssetRevisionIds: ["shared-asset-v1"],
      brief: parentKernel.brief,
      terminology: parentKernel.terminology,
      exclusions: parentKernel.exclusions,
      responsiveFrames: parentKernel.responsiveFrames,
      qualityProfile: parentKernel.qualityProfile,
    });
    const assetSource = fixture.commit(`<!doctype html><img src="${sharedPayload.publicUrl}">`);
    const assetRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: fixture.headRevisionId,
      sourceCommitHash: assetSource.commitHash,
      sourceTreeHash: assetSource.sourceTreeHash,
      kernelRevisionId: assetKernel.id,
      renderSpec: { entry: "index.html" },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [{ resourceId: "research-resource", resourceRevisionId: "research-resource-v1" }],
    });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: assetRevision.id,
    }, { dataDir: fixture.dataDir });
    assert.deepEqual(
      assembly.resourcePayloads.map((payload) => payload.resourceRevisionId),
      ["research-resource-v1", "shared-asset-v1"],
    );
    assert.deepEqual(assembly.kernelRevisions[0]?.sharedAssetRevisionIds, ["shared-asset-v1"]);
    assert.equal(assembly.resourcePayloads.find(
      (payload) => payload.resourceRevisionId === "research-resource-v1",
    )?.mountPath, researchPayload.mountPath);
    assert.equal(assembly.resourcePayloads.find(
      (payload) => payload.resourceRevisionId === "shared-asset-v1",
    )?.publicUrl, sharedPayload.publicUrl);

    const artifactDir = await materializeRenderAssembly(fixture, assembly);
    assert.deepEqual(readFileSync(join(artifactDir, researchPayload.mountPath)), researchBytes);
    assert.deepEqual(readFileSync(join(artifactDir, sharedPayload.mountPath)), imageBytes);
    const served = await fetchMaterializedFile(artifactDir, sharedPayload.mountPath);
    assert.equal(served.status, 200);
    assert.match(served.contentType ?? "", /^image\/png/);
    assert.deepEqual(served.bytes, imageBytes);

    const context = JSON.parse(
      readFileSync(join(artifactDir, ".dezin", "render-context.json"), "utf8"),
    ) as { resourcePayloads?: Array<{ resourceRevisionId: string; publicUrl: string }> };
    assert.deepEqual(context.resourcePayloads, assembly.resourcePayloads);
  } finally {
    fixture.close();
  }
});

test("Resource manifest reads stay bounded when the opened inode grows in place after fstat", (context) => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    const payload = insertResourcePayloadFixture(
      fixture.store,
      fixture.dataDir,
      workspace.id,
      "growing-manifest-resource",
      "growing-manifest-resource-v1",
      { kind: "asset", mimeType: "text/plain", bytes: Buffer.from("bounded payload\n") },
    );
    const manifestIdentity = fs.statSync(payload.manifestPath);
    const originalReadSync = fs.readSync.bind(fs);
    let grew = false;
    context.mock.method(fs, "readSync", ((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      const openedIdentity = fs.fstatSync(fd);
      if (!grew
        && openedIdentity.dev === manifestIdentity.dev
        && openedIdentity.ino === manifestIdentity.ino) {
        grew = true;
        fs.appendFileSync(payload.manifestPath, Buffer.alloc(MAX_RESOURCE_MANIFEST_BYTES, 0x20));
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);

    assert.throws(
      () => resolveResourceRevisionPayloadDescriptor({
        store: fixture.store,
        dataDir: fixture.dataDir,
        workspaceId: workspace.id,
        resourceRevisionId: "growing-manifest-resource-v1",
      }),
      /manifest size is out of bounds/i,
    );
    assert.equal(grew, true, "the race must grow the already-opened manifest inode before its first read");
  } finally {
    fixture.close();
  }
});

test("RenderAssembly refuses manifest or payload drift, MIME mismatch, and daemon storage symlink escape", async () => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const payload = insertResourcePayloadFixture(
      fixture.store,
      fixture.dataDir,
      workspace.id,
      "tampered-resource",
      "tampered-resource-v1",
      { kind: "asset", mimeType: "image/png", bytes: imageBytes },
    );
    const source = fixture.commit("tampered-resource");
    const revision = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: fixture.headRevisionId,
      sourceCommitHash: source.commitHash,
      sourceTreeHash: source.sourceTreeHash,
      kernelRevisionId: workspace.activeKernelRevisionId,
      renderSpec: { entry: "index.html" },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [{ resourceId: "tampered-resource", resourceRevisionId: "tampered-resource-v1" }],
    });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.id,
    }, { dataDir: fixture.dataDir });
    writeFileSync(payload.payloadPath, Buffer.alloc(imageBytes.byteLength, 2));
    await assert.rejects(
      materializeRenderAssembly(fixture, assembly),
      /payload checksum/i,
    );

    const outside = join(fixture.dataDir, "outside-resource.bin");
    writeFileSync(outside, Buffer.alloc(64, 1));
    rmSync(payload.payloadPath);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, payload.payloadPath);
    assert.throws(
      () => buildRenderAssembly(fixture.store, {
        projectId: fixture.projectId,
        revisionId: revision.id,
      }, { dataDir: fixture.dataDir }),
      /symlink|escapes/i,
    );

    insertResourcePayloadFixture(
      fixture.store,
      fixture.dataDir,
      workspace.id,
      "bad-manifest-resource",
      "bad-manifest-resource-v1",
      {
        kind: "asset",
        mimeType: "image/png",
        bytes: imageBytes,
        manifestChecksum: "0".repeat(64),
      },
    );
    const badManifestRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: fixture.headRevisionId,
      sourceCommitHash: source.commitHash,
      sourceTreeHash: source.sourceTreeHash,
      kernelRevisionId: workspace.activeKernelRevisionId,
      renderSpec: { entry: "index.html" },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [{ resourceId: "bad-manifest-resource", resourceRevisionId: "bad-manifest-resource-v1" }],
    });
    assert.throws(
      () => buildRenderAssembly(fixture.store, {
        projectId: fixture.projectId,
        revisionId: badManifestRevision.id,
      }, { dataDir: fixture.dataDir }),
      /manifest checksum/i,
    );

    insertResourcePayloadFixture(
      fixture.store,
      fixture.dataDir,
      workspace.id,
      "bad-mime-resource",
      "bad-mime-resource-v1",
      { kind: "asset", mimeType: "image/png", bytes: Buffer.alloc(64, 3) },
    );
    const badMimeRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: fixture.headRevisionId,
      sourceCommitHash: source.commitHash,
      sourceTreeHash: source.sourceTreeHash,
      kernelRevisionId: workspace.activeKernelRevisionId,
      renderSpec: { entry: "index.html" },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [{ resourceId: "bad-mime-resource", resourceRevisionId: "bad-mime-resource-v1" }],
    });
    const badMimeAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: badMimeRevision.id,
    }, { dataDir: fixture.dataDir });
    await assert.rejects(materializeRenderAssembly(fixture, badMimeAssembly), /declared MIME/i);
  } finally {
    fixture.close();
  }
});

test("Resource payload MIME validation rejects truncated image structures and SVG polyglots", async (t) => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    const truncatedPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from("IHDR", "ascii"),
      Buffer.alloc(8),
    ]);
    const truncatedWebp = Buffer.alloc(16);
    truncatedWebp.write("RIFF", 0, "ascii");
    truncatedWebp.writeUInt32LE(8, 4);
    truncatedWebp.write("WEBP", 8, "ascii");
    const cases = [
      { label: "png", mimeType: "image/png", bytes: truncatedPng },
      { label: "png-invalid-deflate", mimeType: "image/png", bytes: pngWithInvalidCompressedData() },
      { label: "png-trailing-zlib", mimeType: "image/png", bytes: pngWithTrailingZlibBytes() },
      { label: "png-invalid-filter", mimeType: "image/png", bytes: pngWithInvalidFilter() },
      { label: "png-native-crc-corruption", mimeType: "image/png", bytes: pngWithCorruptNativeCrc() },
      { label: "jpeg", mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
      { label: "gif", mimeType: "image/gif", bytes: Buffer.from("GIF89a", "ascii") },
      { label: "webp", mimeType: "image/webp", bytes: truncatedWebp },
      { label: "svg-truncated", mimeType: "image/svg+xml", bytes: Buffer.from("<svg><g>", "utf8") },
      {
        label: "svg-polyglot",
        mimeType: "image/svg+xml",
        bytes: Buffer.from("<svg></svg><script>alert(1)</script>", "utf8"),
      },
    ] as const;
    for (const invalid of cases) {
      await t.test(invalid.label, async () => {
        const resourceId = `invalid-structure-${invalid.label}`;
        const revisionId = `${resourceId}-v1`;
        insertResourcePayloadFixture(
          fixture.store,
          fixture.dataDir,
          workspace.id,
          resourceId,
          revisionId,
          { kind: "asset", mimeType: invalid.mimeType, bytes: invalid.bytes },
        );
        const descriptor = resolveResourceRevisionPayloadDescriptor({
          store: fixture.store,
          dataDir: fixture.dataDir,
          workspaceId: workspace.id,
          resourceRevisionId: revisionId,
        });
        await assert.rejects(
          verifyResourceRevisionPayload(fixture.dataDir, descriptor),
          /declared MIME/i,
        );
      });
    }
  } finally {
    fixture.close();
  }
});

test("Resource payload MIME validation accepts bounded complete image structures", async (t) => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    const cases = [
      { label: "png", mimeType: "image/png", bytes: structuredPng() },
      { label: "png-adam7", mimeType: "image/png", bytes: structuredPng(9, 9, 1) },
      { label: "png-grayscale-1bit", mimeType: "image/png", bytes: structuredGrayscalePng(9, 9) },
      {
        label: "svg",
        mimeType: "image/svg+xml",
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>', "utf8"),
      },
    ] as const;
    for (const valid of cases) {
      await t.test(valid.label, async () => {
        const resourceId = `valid-structure-${valid.label}`;
        const revisionId = `${resourceId}-v1`;
        insertResourcePayloadFixture(
          fixture.store,
          fixture.dataDir,
          workspace.id,
          resourceId,
          revisionId,
          { kind: "asset", mimeType: valid.mimeType, bytes: valid.bytes },
        );
        const descriptor = resolveResourceRevisionPayloadDescriptor({
          store: fixture.store,
          dataDir: fixture.dataDir,
          workspaceId: workspace.id,
          resourceRevisionId: revisionId,
        });
        await verifyResourceRevisionPayload(fixture.dataDir, descriptor);
      });
    }
  } finally {
    fixture.close();
  }
});

test("legacy Resource Viewer compatibility accepts bounded real JPEG, GIF, and WebP containers", async (t) => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    const cases = [
      {
        label: "jpeg-baseline",
        mimeType: "image/jpeg",
        bytes: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z", "base64"),
      },
      {
        label: "jpeg-progressive",
        mimeType: "image/jpeg",
        bytes: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABigy4/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=", "base64"),
      },
      {
        label: "gif",
        mimeType: "image/gif",
        bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
      },
      {
        label: "webp-lossy",
        mimeType: "image/webp",
        bytes: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AA/vuU", "base64"),
      },
      {
        label: "webp-lossless",
        mimeType: "image/webp",
        bytes: Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
      },
    ] as const;
    for (const compatible of cases) {
      await t.test(compatible.label, async () => {
        const resourceId = `legacy-viewer-${compatible.label}`;
        const revisionId = `${resourceId}-v1`;
        insertResourcePayloadFixture(
          fixture.store,
          fixture.dataDir,
          workspace.id,
          resourceId,
          revisionId,
          { kind: "asset", mimeType: compatible.mimeType, bytes: compatible.bytes },
        );
        const descriptor = resolveResourceRevisionPayloadDescriptor({
          store: fixture.store,
          dataDir: fixture.dataDir,
          workspaceId: workspace.id,
          resourceRevisionId: revisionId,
        });
        await verifyResourceRevisionPayload(fixture.dataDir, descriptor);
      });
    }
  } finally {
    fixture.close();
  }
});

test("legacy Resource Viewer gives deterministic AVIF migration guidance instead of trusting ftyp", async () => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    const resourceId = "legacy-viewer-avif";
    const revisionId = `${resourceId}-v1`;
    insertResourcePayloadFixture(
      fixture.store,
      fixture.dataDir,
      workspace.id,
      resourceId,
      revisionId,
      {
        kind: "asset",
        mimeType: "image/avif",
        bytes: Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]),
      },
    );
    const descriptor = resolveResourceRevisionPayloadDescriptor({
      store: fixture.store,
      dataDir: fixture.dataDir,
      workspaceId: workspace.id,
      resourceRevisionId: revisionId,
    });
    await assert.rejects(
      verifyResourceRevisionPayload(fixture.dataDir, descriptor),
      /legacy Resource Viewer.*AVIF.*re-import.*PNG or SVG/i,
    );
  } finally {
    fixture.close();
  }
});

test("Resource payload MIME validation enforces positive dimensions and exact terminal boundaries", async (t) => {
  const fixture = createPreviewFixture();
  try {
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    const zeroGif = Buffer.from(gif);
    zeroGif.writeUInt16LE(0, 6);
    const oversizedGif = Buffer.from(gif);
    oversizedGif.writeUInt16LE(8_193, 6);
    oversizedGif.writeUInt16LE(8_192, 8);
    const vp8 = Buffer.alloc(10);
    vp8.set([0x9d, 0x01, 0x2a], 3);
    vp8.writeUInt16LE(0, 6);
    vp8.writeUInt16LE(1, 8);
    const oversizedVp8 = Buffer.alloc(10);
    oversizedVp8.set([0x9d, 0x01, 0x2a], 3);
    oversizedVp8.writeUInt16LE(8_193, 6);
    oversizedVp8.writeUInt16LE(8_192, 8);
    const cases = [
      { label: "png-zero-width", mimeType: "image/png", bytes: structuredPng(0, 1) },
      { label: "png-over-dimension-budget", mimeType: "image/png", bytes: structuredPng(16_385, 1) },
      {
        label: "png-over-pixel-budget",
        mimeType: "image/png",
        bytes: structuredGrayscalePng(8_193, 8_192),
      },
      { label: "jpeg-zero-width", mimeType: "image/jpeg", bytes: structuredJpeg(0, 1) },
      { label: "jpeg-over-dimension-budget", mimeType: "image/jpeg", bytes: structuredJpeg(16_385, 1) },
      { label: "jpeg-over-pixel-budget", mimeType: "image/jpeg", bytes: structuredJpeg(8_193, 8_192) },
      { label: "gif-zero-screen", mimeType: "image/gif", bytes: zeroGif },
      { label: "gif-over-pixel-budget", mimeType: "image/gif", bytes: oversizedGif },
      { label: "webp-zero-width", mimeType: "image/webp", bytes: webpContainer("VP8 ", vp8) },
      { label: "webp-over-pixel-budget", mimeType: "image/webp", bytes: webpContainer("VP8 ", oversizedVp8) },
      { label: "png-after-iend", mimeType: "image/png", bytes: Buffer.concat([structuredPng(), Buffer.from("x")]) },
      { label: "jpeg-after-eoi", mimeType: "image/jpeg", bytes: Buffer.concat([structuredJpeg(), Buffer.from("x")]) },
      { label: "gif-after-trailer", mimeType: "image/gif", bytes: Buffer.concat([gif, Buffer.from("x")]) },
      { label: "webp-after-riff", mimeType: "image/webp", bytes: Buffer.concat([structuredWebp(), Buffer.from("x")]) },
      {
        label: "svg-active-content",
        mimeType: "image/svg+xml",
        bytes: Buffer.from("<svg><script>alert(1)</script></svg>", "utf8"),
      },
      {
        label: "svg-over-complexity-budget",
        mimeType: "image/svg+xml",
        bytes: Buffer.from(`<svg><path d="${"M0 0 ".repeat(220_000)}" /></svg>`, "utf8"),
      },
    ] as const;
    for (const invalid of cases) {
      await t.test(invalid.label, async () => {
        const resourceId = `invalid-invariant-${invalid.label}`;
        const revisionId = `${resourceId}-v1`;
        insertResourcePayloadFixture(
          fixture.store,
          fixture.dataDir,
          workspace.id,
          resourceId,
          revisionId,
          { kind: "asset", mimeType: invalid.mimeType, bytes: invalid.bytes },
        );
        const descriptor = resolveResourceRevisionPayloadDescriptor({
          store: fixture.store,
          dataDir: fixture.dataDir,
          workspaceId: workspace.id,
          resourceRevisionId: revisionId,
        });
        await assert.rejects(
          verifyResourceRevisionPayload(fixture.dataDir, descriptor),
          /declared MIME/i,
        );
      });
    }
  } finally {
    fixture.close();
  }
});

test("an aborted materialization cannot delete an immediate retry winner", { timeout: 20_000 }, async () => {
  const fixture = createPreviewFixture();
  try {
    const bulk = join(fixture.root, "bulk");
    mkdirSync(bulk, { recursive: true });
    for (let index = 0; index < 3_000; index += 1) {
      writeFileSync(join(bulk, `entry-${String(index).padStart(5, "0")}.txt`), `entry ${index}\n`);
    }
    const revision = fixture.createRevision({ source: "atomic materialization" });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    const controller = new AbortController();
    const first = materializeRenderAssembly(fixture, assembly, controller.signal);
    const sharedBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      assembly.assemblyHash,
    );
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const worktrees = git(fixture.root, ["worktree", "list", "--porcelain"]);
      if (worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length > 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const publishedEarly = existsSync(sharedBase);

    controller.abort(new DOMException("caller left", "AbortError"));
    await assert.rejects(first, (error: unknown) => error instanceof Error && error.name === "AbortError");

    const retryPath = await materializeRenderAssembly(fixture, assembly);
    assert.equal(
      publishedEarly,
      false,
      "an incomplete assembly is never published at its stable cache path",
    );
    assert.equal(readFileSync(join(retryPath, "index.html"), "utf8"), "atomic materialization");
    assert.equal(readFileSync(join(retryPath, "bulk", "entry-02999.txt"), "utf8"), "entry 2999\n");
  } finally {
    fixture.close();
  }
});

test("materialized assemblies obey refcounts and bounded idle capacity", async () => {
  const fixture = createPreviewFixture();
  try {
    const createMaterializer = Reflect.get(
      renderAssemblyModule,
      "createRenderAssemblyMaterializer",
    ) as undefined | ((options: {
      idleTtlMs: number;
      maxIdleEntries: number;
      maxBytes: number;
    }) => {
      acquire(
        deps: { dataDir: string },
        assembly: ReturnType<typeof buildRenderAssembly>,
      ): Promise<{ artifactDir: string; release(): Promise<void> }>;
      dispose(): Promise<void>;
    });
    assert.equal(typeof createMaterializer, "function", "RenderAssembly exposes a bounded materializer");
    const materializer = createMaterializer!({
      idleTtlMs: 60_000,
      maxIdleEntries: 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    const firstRevision = fixture.createRevision({ source: "bounded-a" });
    const firstAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: firstRevision.revisionId,
    });
    const secondRevision = fixture.createRevision({ source: "bounded-b" });
    const secondAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: secondRevision.revisionId,
    });
    const thirdRevision = fixture.createRevision({ source: "bounded-c" });
    const thirdAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: thirdRevision.revisionId,
    });

    const active = await materializer.acquire(fixture, firstAssembly);
    const firstStableBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      firstAssembly.assemblyHash,
    );
    const idleOne = await materializer.acquire(fixture, secondAssembly);
    const secondStableBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      secondAssembly.assemblyHash,
    );
    await idleOne.release();
    const idleTwo = await materializer.acquire(fixture, thirdAssembly);
    const thirdStableBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      thirdAssembly.assemblyHash,
    );
    await idleTwo.release();

    assert.equal(existsSync(firstStableBase), true, "an active assembly is never evicted");
    assert.equal(existsSync(secondStableBase), false, "the oldest idle assembly is evicted at capacity");
    assert.equal(existsSync(thirdStableBase), true, "the newest idle assembly remains cached");

    const sameActive = await materializer.acquire(fixture, firstAssembly);
    await active.release();
    assert.equal(existsSync(firstStableBase), true, "one remaining ref still protects the assembly");
    await sameActive.release();
    await materializer.dispose();
    assert.equal(existsSync(firstStableBase), false);
    assert.equal(existsSync(thirdStableBase), false);
  } finally {
    fixture.close();
  }
});

test("concurrent materializer acquires share one refcount before either caller can evict", async () => {
  const fixture = createPreviewFixture();
  try {
    const revision = fixture.createRevision({ source: "concurrent-retention" });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    const materializer = renderAssemblyModule.createRenderAssemblyMaterializer({
      idleTtlMs: 60_000,
      maxIdleEntries: 0,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    const [releasedFirst, active] = await Promise.all([
      materializer.acquire(fixture, assembly),
      materializer.acquire(fixture, assembly),
    ]);
    const stableBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      assembly.assemblyHash,
    );
    await releasedFirst.release();
    assert.equal(existsSync(stableBase), true, "the other concurrent ref still owns the assembly");
    await active.release();
    assert.equal(existsSync(stableBase), false, "the zero-idle policy evicts after the final ref");
    await materializer.dispose();
  } finally {
    fixture.close();
  }
});

test("releasing an immutable preview disposes runtime state and releases its assembly ref", { timeout: 20_000 }, async () => {
  const fixture = createPreviewFixture();
  let configPath = "";
  try {
    writeFileSync(join(fixture.root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: { "": {} },
    }));
    const revision = fixture.createRevision({ source: "bounded-runtime" });
    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-revision",
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    const manager: PreviewLeaseManager = {
      async acquire(_scope, _projectDir, options) {
        configPath = options?.configPath ?? "";
        return {
          leaseId: "bounded-runtime-lease",
          url: "http://127.0.0.1:4319/",
          bridgeNonce: "bounded_runtime_bridge_nonce_abcdefghijklmnopqrstuvwxyz0123456789",
          expiresAt: 10_000,
          release: async () => {
            await options?.onEntryDispose?.();
            await options?.onLeaseRelease?.();
          },
        };
      },
      async renew() { return null; },
      async release() { return false; },
      async stopScope() {},
      async stopAll() {},
      activeCount() { return 0; },
    };

    const lease = await acquirePreviewTargetLease({
      ...fixture,
      previewLeaseManager: manager,
    }, resolved);
    assert.ok(configPath);
    assert.equal(existsSync(configPath), true);
    const assemblyBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      resolved.assemblyHash,
    );
    assert.equal(existsSync(assemblyBase), true);

    await lease.release();
    await renderAssemblyMaterializer.dispose();
    assert.equal(existsSync(dirname(configPath)), false, "historical Vite config is removed on entry disposal");
    assert.equal(existsSync(assemblyBase), false, "released assembly becomes evictable");
  } finally {
    await releaseProjectRuntime(fixture.projectId);
    await renderAssemblyMaterializer.dispose();
    fixture.close();
  }
});

test("RenderAssembly fails closed when two Page instances pin different Revisions of one Component Artifact", () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const component = addComponentArtifactRevisions(fixture, [
      "<!doctype html><script>document.body.textContent=String(window.__DEZIN_COMPONENT_FIXTURE__.props.label)</script>",
      "<!doctype html><script>document.body.textContent='v2:'+String(window.__DEZIN_COMPONENT_FIXTURE__.props.label)</script>",
    ]);
    const [revisionOne, revisionTwo] = component.revisionIds;
    const pageRevisionId = createPageRevisionWithDependencies(fixture, [
      {
        instanceId: "instance-a",
        componentArtifactId: component.componentArtifactId,
        componentRevisionId: revisionOne!,
        variantKey: "compact",
        stateKey: "default",
        overrides: { label: "First" },
      },
      {
        instanceId: "instance-b",
        componentArtifactId: component.componentArtifactId,
        componentRevisionId: revisionTwo!,
        variantKey: "compact",
        stateKey: "hover",
        overrides: { label: "Second" },
      },
    ]);

    assert.throws(
      () => buildRenderAssembly(fixture.store, {
        projectId: fixture.projectId,
        revisionId: pageRevisionId,
      }),
      (error: unknown) => error instanceof Error
        && error.name === "ComponentRevisionBindingConflictError"
        && /instance-a/i.test(error.message)
        && /instance-b/i.test(error.message),
    );
  } finally {
    fixture.close();
  }
});

test("plain linked Component pins resolve and materialize their exact Revision source", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const firstSource = "<!doctype html><main data-revision='one'>Pinned component one</main>";
    const secondSource = "<!doctype html><main data-revision='two'>Moving Component Head</main>";
    const component = addComponentArtifactRevisions(fixture, [firstSource, secondSource]);
    const pinnedRevisionId = component.revisionIds[0]!;
    const pageRevisionId = createPageRevisionWithDependencies(fixture, [{
      instanceId: "plain-component-import",
      componentArtifactId: component.componentArtifactId,
      componentRevisionId: pinnedRevisionId,
      overrides: {},
    }]);
    const published = fixture.store.workspace.publishArtifactRevision(pageRevisionId, {
      expectedHeadRevisionId: fixture.headRevisionId,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.headRevisionId = pageRevisionId;
    fixture.snapshotId = published.id;

    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-revision",
      projectId: fixture.projectId,
      revisionId: pageRevisionId,
    });
    const assembly = buildRenderAssembly(fixture.store, resolved);
    assert.deepEqual(
      assembly.revisions.map((revision) => revision.id),
      [pageRevisionId, pinnedRevisionId],
    );
    assert.equal(assembly.dependencies.length, 1);

    const artifactDir = await materializeRenderAssembly(fixture, assembly);
    const componentArtifact = fixture.store.workspace
      .getBundleByProjectId(fixture.projectId)!
      .artifacts.find((artifact) => artifact.id === component.componentArtifactId)!;
    assert.equal(
      readFileSync(join(artifactDir, componentArtifact.sourceRoot, "index.html"), "utf8"),
      firstSource,
      "the assembly replaces the moving Component Head source with the exact pinned Revision",
    );
  } finally {
    fixture.close();
  }
});

test("plain linked pins remain executable throughout a nested Component closure", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const child = addComponentArtifactRevisions(fixture, [
      "<!doctype html><button>Nested exact child</button>",
    ]);
    const beforeParent = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!;
    const parentArtifactId = "plain-parent-component-artifact";
    const parentTrackId = "plain-parent-component-track";
    const graphResult = fixture.store.workspace.applyGraphCommands(fixture.projectId, {
      baseGraphRevision: beforeParent.graph.revision,
      expectedSnapshotId: fixture.snapshotId,
      commands: [{
        id: "add-plain-parent-component",
        type: "add-node",
        node: {
          id: "plain-parent-component-node",
          kind: "component",
          name: "Plain card",
          artifactId: parentArtifactId,
          createIdentity: { initialTrackId: parentTrackId },
        },
      }],
    });
    fixture.snapshotId = graphResult.snapshot.id;
    const parentArtifact = fixture.store.workspace
      .getBundleByProjectId(fixture.projectId)!
      .artifacts.find((candidate) => candidate.id === parentArtifactId)!;
    const parentRoot = join(fixture.root, parentArtifact.sourceRoot);
    mkdirSync(parentRoot, { recursive: true });
    writeFileSync(join(parentRoot, "index.html"), "<!doctype html><main>Plain parent</main>");
    const committed = fixture.commit("plain-parent-with-linked-child");
    const parentRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: parentArtifactId,
      trackId: parentTrackId,
      parentRevisionId: null,
      sourceCommitHash: committed.commitHash,
      sourceTreeHash: committed.sourceTreeHash,
      kernelRevisionId: beforeParent.workspace.activeKernelRevisionId,
      renderSpec: { entry: "index.html" },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [{
        instanceId: "plain-nested-button",
        componentArtifactId: child.componentArtifactId,
        componentRevisionId: child.revisionIds[0]!,
        createInstanceIdentity: true,
        sourceLocator: { designNodeId: "plain-nested-button-slot", sourcePath: "index.html" },
        overrides: {},
        status: "linked",
      }],
      resourcePins: [],
    });

    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: parentRevision.id,
    });
    assert.deepEqual(
      assembly.revisions.map((revision) => revision.id),
      [parentRevision.id, child.revisionIds[0]!],
    );
    assert.ok(await materializeRenderAssembly(fixture, assembly));
  } finally {
    fixture.close();
  }
});

test("Page Component instance state and overrides fail closed without an exact runtime adapter", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const component = addComponentArtifactRevisions(fixture, [
      "<!doctype html><script>document.body.textContent=String(window.__DEZIN_COMPONENT_FIXTURE__.props.label)</script>",
    ]);
    const componentRevisionId = component.revisionIds[0]!;
    for (const dependency of [
      { instanceId: "instance-variant-only", variantKey: "compact", overrides: {} },
      { instanceId: "instance-state-only", stateKey: "default", overrides: {} },
      { instanceId: "instance-override-only", overrides: { label: "Buy" } },
    ]) {
      const revisionId = createPageRevisionWithDependencies(fixture, [{
        componentArtifactId: component.componentArtifactId,
        componentRevisionId,
        ...dependency,
      }]);
      assert.throws(
        () => buildRenderAssembly(fixture.store, {
          projectId: fixture.projectId,
          revisionId,
        }),
        (error: unknown) => error instanceof Error
          && error.name === "ComponentInstanceRuntimeContractError"
          && error.message.includes(dependency.instanceId)
          && /runtime adapter/i.test(error.message),
      );
    }
    const defaultPageRevisionId = createPageRevisionWithDependencies(fixture, [{
      instanceId: "instance-a",
      componentArtifactId: component.componentArtifactId,
      componentRevisionId,
      variantKey: "compact",
      stateKey: "default",
      overrides: { label: "Buy" },
    }]);
    const hoverPageRevisionId = createPageRevisionWithDependencies(fixture, [{
      instanceId: "instance-a",
      componentArtifactId: component.componentArtifactId,
      componentRevisionId,
      variantKey: "compact",
      stateKey: "hover",
      overrides: { label: "Buy now", emphasis: "strong" },
      createInstanceIdentity: false,
    }]);

    for (const revisionId of [defaultPageRevisionId, hoverPageRevisionId]) {
      assert.throws(
        () => buildRenderAssembly(fixture.store, {
          projectId: fixture.projectId,
          revisionId,
        }),
        (error: unknown) => error instanceof Error
          && error.name === "ComponentInstanceRuntimeContractError"
          && /runtime adapter/i.test(error.message),
      );
    }
    const snapshot = fixture.store.workspace.publishArtifactRevision(hoverPageRevisionId, {
      expectedHeadRevisionId: fixture.headRevisionId,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.headRevisionId = hoverPageRevisionId;
    fixture.snapshotId = snapshot.id;
    await assert.rejects(
      resolvePreviewTarget(fixture, {
        kind: "artifact-revision",
        projectId: fixture.projectId,
        revisionId: hoverPageRevisionId,
      }),
      (error: unknown) => error instanceof Error
        && error.name === "PreviewTargetConflictError"
        && /runtime adapter/i.test(error.message),
    );
  } finally {
    fixture.close();
  }
});

test("instance semantics anywhere in a linked Component closure fail closed without an exact runtime adapter", () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const child = addComponentArtifactRevisions(fixture, [
      "<!doctype html><script>document.body.textContent=String(window.__DEZIN_COMPONENT_FIXTURE__.props.label)</script>",
    ]);
    const beforeParent = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!;
    const parentArtifactId = "parent-component-artifact";
    const parentTrackId = "parent-component-track";
    const graphResult = fixture.store.workspace.applyGraphCommands(fixture.projectId, {
      baseGraphRevision: beforeParent.graph.revision,
      expectedSnapshotId: fixture.snapshotId,
      commands: [{
        id: "add-parent-component",
        type: "add-node",
        node: {
          id: "parent-component-node",
          kind: "component",
          name: "Card",
          artifactId: parentArtifactId,
          createIdentity: { initialTrackId: parentTrackId },
        },
      }],
    });
    fixture.snapshotId = graphResult.snapshot.id;
    const parentArtifact = fixture.store.workspace
      .getBundleByProjectId(fixture.projectId)!
      .artifacts.find((candidate) => candidate.id === parentArtifactId)!;
    const parentRoot = join(fixture.root, parentArtifact.sourceRoot);
    mkdirSync(parentRoot, { recursive: true });
    writeFileSync(join(parentRoot, "index.html"), "<!doctype html><main>Card</main>");
    const committed = fixture.commit("parent-component-with-linked-child");
    const parentRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: parentArtifactId,
      trackId: parentTrackId,
      parentRevisionId: null,
      sourceCommitHash: committed.commitHash,
      sourceTreeHash: committed.sourceTreeHash,
      kernelRevisionId: beforeParent.workspace.activeKernelRevisionId,
      renderSpec: { entry: "index.html" },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [{
        instanceId: "nested-button",
        componentArtifactId: child.componentArtifactId,
        componentRevisionId: child.revisionIds[0]!,
        createInstanceIdentity: true,
        variantKey: "compact",
        stateKey: "default",
        sourceLocator: { designNodeId: "nested-button-slot", sourcePath: "index.html" },
        overrides: { label: "Nested" },
        status: "linked",
      }],
      resourcePins: [],
    });

    assert.throws(
      () => buildRenderAssembly(fixture.store, {
        projectId: fixture.projectId,
        revisionId: parentRevision.id,
      }),
      (error: unknown) => error instanceof Error
        && error.name === "ComponentInstanceRuntimeContractError"
        && /dependency closure/i.test(error.message),
    );
  } finally {
    fixture.close();
  }
});

test("detached dependencies do not enter the executable Revision closure, hash, or Resource pins", () => {
  const fixture = createPreviewFixture();
  try {
    const rootRevision = fixture.createRevision();
    const workspace = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!.workspace;
    insertResourceRevisionFixture(
      fixture.store,
      workspace.id,
      "detached-resource",
      "detached-resource-v1",
    );
    const child = addComponentArtifactRevisions(
      fixture,
      ["<!doctype html><main>Detached child</main>"],
      { resourcePins: [{ resourceId: "detached-resource", resourceRevisionId: "detached-resource-v1" }] },
    );
    const baseline = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: rootRevision.revisionId,
    });
    const detachedPageRevisionId = createPageRevisionWithDependencies(fixture, [{
      instanceId: "detached-button",
      componentArtifactId: child.componentArtifactId,
      componentRevisionId: child.revisionIds[0]!,
      variantKey: "compact",
      stateKey: "default",
      overrides: { label: "Detached" },
      status: "detached",
    }]);

    const detached = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: detachedPageRevisionId,
    });
    assert.deepEqual(detached.revisions.map((revision) => revision.id), [detachedPageRevisionId]);
    assert.deepEqual(detached.dependencies, []);
    assert.deepEqual(detached.resourcePins, []);
    assert.equal(detached.dependencyLockHash, baseline.dependencyLockHash);
  } finally {
    fixture.close();
  }
});

test("archiving a historical linked dependency does not replace the runtime-contract conflict with archive drift", () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const child = addComponentArtifactRevisions(fixture, [
      "<!doctype html><script>document.body.textContent=String(window.__DEZIN_COMPONENT_FIXTURE__.props.label)</script>",
    ]);
    const pageRevisionId = createPageRevisionWithDependencies(fixture, [{
      instanceId: "historical-button",
      componentArtifactId: child.componentArtifactId,
      componentRevisionId: child.revisionIds[0]!,
      variantKey: "compact",
      stateKey: "default",
      overrides: { label: "Historical" },
    }]);
    const published = fixture.store.workspace.publishArtifactRevision(pageRevisionId, {
      expectedHeadRevisionId: fixture.headRevisionId,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.headRevisionId = pageRevisionId;
    fixture.snapshotId = published.id;
    const assertRuntimeContractConflict = (): void => assert.throws(
      () => buildRenderAssembly(fixture.store, {
        projectId: fixture.projectId,
        revisionId: pageRevisionId,
      }),
      (error: unknown) => error instanceof Error
        && error.name === "ComponentInstanceRuntimeContractError",
    );
    assertRuntimeContractConflict();

    archiveArtifactNode(fixture, child.componentArtifactId);

    assertRuntimeContractConflict();
  } finally {
    fixture.close();
  }
});

test("Component fixture consumer validation rejects comments and string literals", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const component = addComponentArtifactRevisions(fixture, [
      `<!doctype html><html><body>
        <!-- window.__DEZIN_COMPONENT_FIXTURE__ is documented here -->
        <script>
          const documentation = "window.__DEZIN_COMPONENT_FIXTURE__";
          /* window.__DEZIN_COMPONENT_FIXTURE__.props.label */
          document.body.textContent = documentation;
        </script>
      </body></html>`,
    ]);
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: component.revisionIds[0]!,
      componentState: { variantKey: "compact", stateKey: "default" },
    });

    await assert.rejects(
      materializeRenderAssembly(fixture, assembly),
      (error: unknown) => error instanceof Error
        && error.name === "ComponentFixtureContractError"
        && /does not consume window\.__DEZIN_COMPONENT_FIXTURE__/i.test(error.message),
    );
  } finally {
    fixture.close();
  }
});

test("component-state assemblies retain exact Component Revision pins", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const beforeComponent = fixture.store.workspace.getBundleByProjectId(fixture.projectId)!;
    const componentArtifactId = "component-artifact";
    const componentTrackId = "component-track";
    const graphResult = fixture.store.workspace.applyGraphCommands(fixture.projectId, {
      baseGraphRevision: beforeComponent.graph.revision,
      expectedSnapshotId: fixture.snapshotId,
      commands: [{
        id: "add-component",
        type: "add-node",
        node: {
          id: "component-node",
          kind: "component",
          name: "Button",
          artifactId: componentArtifactId,
          createIdentity: { initialTrackId: componentTrackId },
        },
      }],
    });
    fixture.snapshotId = graphResult.snapshot.id;
    const componentArtifact = fixture.store.workspace
      .getBundleByProjectId(fixture.projectId)!
      .artifacts.find((candidate) => candidate.kind === "component")!;
    const componentRoot = join(fixture.root, componentArtifact.sourceRoot);
    mkdirSync(componentRoot, { recursive: true });
    writeFileSync(join(componentRoot, "package.json"), JSON.stringify({ private: true, scripts: { dev: "vite" } }));
    writeFileSync(
      join(componentRoot, "index.html"),
      "<!doctype html><html><head></head><body><script>document.body.textContent=String(window.__DEZIN_COMPONENT_FIXTURE__.props.label)</script></body></html>",
    );
    const componentCommit = fixture.commit("page-with-component-v1");
    const componentRenderSpec = {
      entry: "index.html",
      componentFixture: {
        protocol: "dezin-component-fixture-v1",
        consumerGlobal: "__DEZIN_COMPONENT_FIXTURE__",
        variants: {
          compact: {
            states: {
              default: { props: { label: "Buy" }, background: "#ffffff" },
              hover: {
                props: { label: "Buy now", emphasis: "strong" },
                cssVariables: { "--button-background": "#7c3aed" },
                background: "#f5f3ff",
              },
            },
          },
        },
      },
    };
    const componentRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: componentArtifactId,
      trackId: componentTrackId,
      parentRevisionId: null,
      sourceCommitHash: componentCommit.commitHash,
      sourceTreeHash: componentCommit.sourceTreeHash,
      kernelRevisionId: beforeComponent.workspace.activeKernelRevisionId,
      renderSpec: componentRenderSpec,
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [],
    });
    const componentSnapshot = fixture.store.workspace.publishArtifactRevision(componentRevision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.snapshotId = componentSnapshot.id;

    const componentTarget = await resolvePreviewTarget(fixture, {
      kind: "component-state",
      projectId: fixture.projectId,
      revisionId: componentRevision.id,
      variantKey: "compact",
      stateKey: "hover",
    });
    assert.equal(componentTarget.artifactKind, "component");
    assert.equal(componentTarget.variantKey, "compact");
    assert.equal(componentTarget.stateKey, "hover");
    const defaultComponentTarget = await resolvePreviewTarget(fixture, {
      kind: "component-state",
      projectId: fixture.projectId,
      revisionId: componentRevision.id,
      variantKey: "compact",
      stateKey: "default",
    });
    assert.notEqual(
      componentTarget.assemblyHash,
      defaultComponentTarget.assemblyHash,
      "each exact Component state receives an isolated assembly/runtime identity",
    );
    await assert.rejects(
      resolvePreviewTarget(fixture, {
        kind: "component-state",
        projectId: fixture.projectId,
        revisionId: componentRevision.id,
        variantKey: "compact",
        stateKey: "pressed",
      }),
      (error: unknown) => error instanceof Error && error.name === "PreviewTargetConflictError",
    );
    const componentAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: componentRevision.id,
      componentState: { variantKey: "compact", stateKey: "hover" },
    });
    const componentDir = await materializeRenderAssembly(fixture, componentAssembly);
    const componentContext = JSON.parse(
      readFileSync(join(componentDir, ".dezin", "render-context.json"), "utf8"),
    ) as { componentFixture?: unknown };
    const componentHtml = readFileSync(join(componentDir, "index.html"), "utf8");
    const componentBootstrap = readFileSync(join(componentDir, ".dezin", "render-context.js"), "utf8");
    assert.deepEqual(componentContext.componentFixture, {
      protocol: "dezin-component-fixture-v1",
      variantKey: "compact",
      stateKey: "hover",
      props: { label: "Buy now", emphasis: "strong" },
      cssVariables: { "--button-background": "#7c3aed" },
      background: "#f5f3ff",
    });
    assert.match(componentHtml, /__DEZIN_COMPONENT_FIXTURE__/);
    assert.match(componentBootstrap, /data-dezin-component-state/);
    assert.match(componentBootstrap, /--button-background/);

    const pageCommit = fixture.commit("page-pins-component-v1");
    const pageRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.artifactId,
      trackId: fixture.trackId,
      parentRevisionId: fixture.headRevisionId,
      sourceCommitHash: pageCommit.commitHash,
      sourceTreeHash: pageCommit.sourceTreeHash,
      kernelRevisionId: beforeComponent.workspace.activeKernelRevisionId,
      renderSpec: { entry: "index.html" },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [{
        instanceId: "button-instance",
        componentArtifactId,
        componentRevisionId: componentRevision.id,
        createInstanceIdentity: true,
        variantKey: "compact",
        stateKey: "default",
        sourceLocator: { designNodeId: "button-slot", sourcePath: "index.html" },
        overrides: { label: "Buy" },
        status: "linked",
      }],
      resourcePins: [],
    });
    const pageSnapshot = fixture.store.workspace.publishArtifactRevision(pageRevision.id, {
      expectedHeadRevisionId: fixture.headRevisionId,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.headRevisionId = pageRevision.id;
    fixture.snapshotId = pageSnapshot.id;

    writeFileSync(join(componentRoot, "index.html"), "component-v2");
    const componentCommitTwo = fixture.commit("page-with-component-v2");
    const componentRevisionTwo = fixture.store.workspace.createArtifactRevision({
      artifactId: componentArtifactId,
      trackId: componentTrackId,
      parentRevisionId: componentRevision.id,
      sourceCommitHash: componentCommitTwo.commitHash,
      sourceTreeHash: componentCommitTwo.sourceTreeHash,
      kernelRevisionId: beforeComponent.workspace.activeKernelRevisionId,
      renderSpec: componentRenderSpec,
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [],
    });
    const componentSnapshotTwo = fixture.store.workspace.publishArtifactRevision(componentRevisionTwo.id, {
      expectedHeadRevisionId: componentRevision.id,
      expectedSnapshotId: fixture.snapshotId,
    });
    fixture.snapshotId = componentSnapshotTwo.id;
    const unsupportedFixtureAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: componentRevisionTwo.id,
      componentState: { variantKey: "compact", stateKey: "default" },
    });
    await assert.rejects(
      materializeRenderAssembly(fixture, unsupportedFixtureAssembly),
      /does not consume window\.__DEZIN_COMPONENT_FIXTURE__/i,
    );

    assert.throws(
      () => buildRenderAssembly(fixture.store, {
        projectId: fixture.projectId,
        revisionId: pageRevision.id,
      }),
      (error: unknown) => error instanceof Error
        && error.name === "ComponentInstanceRuntimeContractError",
    );
  } finally {
    fixture.close();
  }
});

test("current is resolved before an artifact-scoped preview lease is acquired", async () => {
  const fixture = createPreviewFixture();
  try {
    const first = fixture.createRevision();
    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    const second = fixture.createRevision();
    const expectedFirstSource = git(fixture.root, ["show", `${first.commitHash}:index.html`]);
    const calls: Array<{
      projectDir: string;
      runtimeKey: string;
      options: unknown;
    }> = [];
    const lease = await acquirePreviewTargetLease({
      ...fixture,
      ensureDevServer: async (_projectId, artifactDir, runtimeKey, _signal, _manager, options) => {
        assert.ok(runtimeKey);
        calls.push({ projectDir: artifactDir, runtimeKey, options });
        assert.equal(git(fixture.root, ["show", `${first.commitHash}:index.html`]), expectedFirstSource);
        assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(artifactDir, "index.html"), "utf8")), expectedFirstSource);
        return {
          leaseId: "lease-first",
          url: "http://127.0.0.1:4310",
          bridgeNonce: "first_preview_bridge_nonce_abcdefghijklmnopqrstuvwxyz0123456789",
          expiresAt: 99_000,
          release: async () => {},
        };
      },
    }, resolved);

    assert.equal(lease.resolved.revisionId, first.revisionId);
    assert.notEqual(lease.resolved.revisionId, second.revisionId);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.runtimeKey, new RegExp(resolved.assemblyHash));
    const options = calls[0]!.options as PreviewRuntimeOptions;
    assert.equal(options.immutableSource, true);
    assert.equal(options.disposeOnIdle, true);
    assert.equal(typeof options.onLeaseRelease, "function");
    assert.equal(typeof options.onEntryDispose, "function");
    assert.deepEqual(options.runtimeIdentity, {
      artifactId: fixture.artifactId,
      revisionId: first.revisionId,
      sourceTreeHash: first.sourceTreeHash,
      dependencyLockHash: resolved.dependencyLockHash,
    });
  } finally {
    fixture.close();
  }
});

test("lease acquisition rejects a tampered resolved identity before starting runtime", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    let started = false;
    await assert.rejects(
      acquirePreviewTargetLease({
        ...fixture,
        ensureDevServer: async () => {
          started = true;
          throw new Error("must not start");
        },
      }, { ...resolved, dependencyLockHash: "tampered" }),
      /resolved Preview Target no longer matches its immutable assembly/i,
    );
    assert.equal(started, false);
  } finally {
    fixture.close();
  }
});

test("an abort after runtime handoff releases the exact acquired lease", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    const controller = new AbortController();
    let releases = 0;
    await assert.rejects(
      acquirePreviewTargetLease({
        ...fixture,
        ensureDevServer: async () => {
          controller.abort(new DOMException("request closed", "AbortError"));
          return {
            leaseId: "lease-aborted",
            url: "http://127.0.0.1:4311",
            bridgeNonce: "aborted_preview_bridge_nonce_abcdefghijklmnopqrstuvwxyz0123456789",
            expiresAt: 99_000,
            release: async () => { releases += 1; },
          };
        },
      }, resolved, controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(releases, 1);
  } finally {
    fixture.close();
  }
});

test("PreviewTarget HTTP resolve and lease routes preserve the immutable DTO", async () => {
  const fixture = createPreviewFixture();
  try {
    const revision = fixture.createRevision();
    let starts = 0;
    await withHttpServer({
      ...fixture,
      ensureDevServer: async () => {
        starts += 1;
        return {
          leaseId: "lease-http",
          url: "http://127.0.0.1:4312/#dezin-bridge=http_bridge_nonce_0123456789abcdefghijklmno",
          bridgeNonce: "http_bridge_nonce_0123456789abcdefghijklmno",
          expiresAt: 123_000,
          release: async () => {},
        };
      },
    }, async (base) => {
      const resolvedResponse = await fetch(
        `${base}/api/projects/${fixture.projectId}/preview-targets/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target: {
              kind: "artifact-current",
              projectId: fixture.projectId,
              artifactId: fixture.artifactId,
            },
          }),
        },
      );
      assert.equal(resolvedResponse.status, 200);
      const { resolved } = await resolvedResponse.json() as {
        resolved: Awaited<ReturnType<typeof resolvePreviewTarget>>;
      };
      assert.equal(resolved.version, 1);
      assert.equal(resolved.revisionId, revision.revisionId);
      assert.equal(resolved.artifactKind, "page");

      const leaseResponse = await fetch(
        `${base}/api/projects/${fixture.projectId}/preview-targets/leases`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resolved }),
        },
      );
      const leaseBody = await leaseResponse.text();
      assert.equal(leaseResponse.status, 201, leaseBody);
      const lease = JSON.parse(leaseBody) as {
        leaseId: string;
        url: string;
        bridgeNonce: string;
        expiresAt: number;
        resolved: typeof resolved;
      };
      assert.equal(lease.leaseId, "lease-http");
      assert.equal(lease.bridgeNonce, "http_bridge_nonce_0123456789abcdefghijklmno");
      assert.deepEqual(lease.resolved, resolved);
      assert.equal(starts, 1);
    });
  } finally {
    fixture.close();
  }
});

test("devserver acquisition and renewal preserve the bridge capability", async () => {
  const fixture = createPreviewFixture();
  const bridgeNonce = "devserver_bridge_nonce_0123456789abcdefghij";
  try {
    fixture.createRevision();
    const manager: PreviewLeaseManager = {
      async acquire() { throw new Error("not used"); },
      async renew(leaseId) {
        return leaseId === "devserver-lease"
          ? {
            leaseId,
            url: `http://127.0.0.1:4320/#dezin-bridge=${bridgeNonce}`,
            bridgeNonce,
            expiresAt: 222_000,
            release: async () => {},
          }
          : null;
      },
      async release() { return true; },
      async stopScope() {},
      async stopAll() {},
      activeCount() { return 0; },
    };
    await withHttpServer({
      ...fixture,
      previewLeaseManager: manager,
      ensureDevServer: async () => ({
        leaseId: "devserver-lease",
        url: `http://127.0.0.1:4320/#dezin-bridge=${bridgeNonce}`,
        bridgeNonce,
        expiresAt: 222_000,
        release: async () => {},
      }),
    }, async (base) => {
      const acquired = await fetch(`${base}/api/projects/${fixture.projectId}/devserver`);
      const acquiredBody = await acquired.text();
      assert.equal(acquired.status, 200, acquiredBody);
      assert.equal((JSON.parse(acquiredBody) as { bridgeNonce?: string }).bridgeNonce, bridgeNonce);

      const renewed = await fetch(`${base}/api/preview-leases/devserver-lease`, { method: "PATCH" });
      assert.equal(renewed.status, 200);
      assert.equal((await renewed.json() as { bridgeNonce?: string }).bridgeNonce, bridgeNonce);
    });
  } finally {
    fixture.close();
  }
});

test("PreviewTarget HTTP validates envelopes and path ownership before migration or runtime", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-preview-target-http-invalid-"));
  const store = new Store(join(dataDir, "store.db"));
  try {
    const project = store.createProject({ name: "Unmigrated preview", mode: "standard" });
    let starts = 0;
    await withHttpServer({
      store,
      dataDir,
      ensureDevServer: async () => {
        starts += 1;
        throw new Error("must not start");
      },
    }, async (base) => {
      const malformed = await fetch(`${base}/api/projects/${project.id}/preview-targets/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: { kind: "artifact-current", projectId: project.id, artifactId: "artifact" },
          unexpected: true,
        }),
      });
      assert.equal(malformed.status, 400);
      assert.equal(store.workspace.getWorkspace(project.id), null);

      const mismatched = await fetch(`${base}/api/projects/${project.id}/preview-targets/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: { kind: "artifact-current", projectId: "another-project", artifactId: "artifact" },
        }),
      });
      assert.equal(mismatched.status, 404);
      assert.equal(store.workspace.getWorkspace(project.id), null);
      assert.equal(starts, 0);
    });
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("PreviewTarget HTTP rejects a tampered resolved assembly with a structured conflict", async () => {
  const fixture = createPreviewFixture();
  try {
    fixture.createRevision();
    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    let starts = 0;
    await withHttpServer({
      ...fixture,
      ensureDevServer: async () => {
        starts += 1;
        throw new Error("must not start");
      },
    }, async (base) => {
      const response = await fetch(
        `${base}/api/projects/${fixture.projectId}/preview-targets/leases`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resolved: { ...resolved, dependencyLockHash: "tampered" },
          }),
        },
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { code?: string }).code, "preview_target_conflict");
      assert.equal(starts, 0);
    });
  } finally {
    fixture.close();
  }
});

test("artifact-scoped runtime injects the picker into real HTML without mutating its assembly", async () => {
  const fixture = createPreviewFixture();
  const rawHtml = `<!doctype html><html><head></head><body><button data-dezin-id="cta" data-dezin-source-path="src/App.tsx">Buy</button></body></html>`;
  try {
    writeFileSync(join(fixture.root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: { "": {} },
    }));
    fixture.createRevision({ source: rawHtml });
    const resolved = await resolvePreviewTarget(fixture, {
      kind: "artifact-current",
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
    });
    let transformed = "";
    let materializedHtml = "";
    let generatedConfigPath = "";
    const manager: PreviewLeaseManager = {
      async acquire(_scope, artifactDir, options) {
        materializedHtml = readFileSync(join(artifactDir, "index.html"), "utf8");
        generatedConfigPath = options?.configPath ?? "";
        assert.ok(generatedConfigPath, "historical artifact previews always receive a bridge config");
        const configModule = await import(`${pathToFileURL(generatedConfigPath).href}?test=${Date.now()}`);
        const config = await configModule.default({ command: "serve", mode: "test" });
        const plugins = (config.plugins ?? []).flat(Infinity) as Array<{
          name?: string;
          transformIndexHtml?: (html: string) => string;
        }>;
        const picker = plugins.find((plugin) => plugin?.name === "dezin-picker");
        assert.ok(picker?.transformIndexHtml);
        transformed = picker.transformIndexHtml(materializedHtml);
        return {
          leaseId: "lease-bridge",
          url: "http://127.0.0.1:4313",
          bridgeNonce: "bridge_preview_nonce_abcdefghijklmnopqrstuvwxyz0123456789",
          expiresAt: 123_000,
          release: async () => {},
        };
      },
      async renew() { return null; },
      async release() { return true; },
      async stopScope() {},
      async stopAll() {},
      activeCount() { return 0; },
    };

    const lease = await acquirePreviewTargetLease({
      ...fixture,
      previewLeaseManager: manager,
    }, resolved);
    assert.equal(lease.leaseId, "lease-bridge");
    assert.equal(materializedHtml, rawHtml);
    assert.equal(readFileSync(join(fixture.root, "index.html"), "utf8"), rawHtml);
    assert.equal(existsSync(join(fixture.root, "vite.config.js")), false);
    assert.match(transformed, /data-dezin-render-context src="\/\.dezin\/render-context\.js"/);
    assert.ok(
      transformed.indexOf("data-dezin-render-context") < transformed.indexOf("data-dezin-runtime-probe"),
      "the blocking immutable render context is installed before preview/app scripts",
    );
    assert.match(transformed, /data-dezin-bridge/);
    assert.match(transformed, /type:'element-selected'/);
    assert.match(transformed, /type:'element-cleared'/);
    assert.match(transformed, /designNodeId/);
    assert.match(transformed, /sourcePath/);
    assert.notEqual(generatedConfigPath.startsWith(fixture.root), true);
  } finally {
    await releaseProjectRuntime(fixture.projectId);
    fixture.close();
  }
});

test("a restarted materializer inventories persistent assemblies before enforcing idle TTL", async () => {
  const fixture = createPreviewFixture();
  const materializer = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 1_000,
    maxIdleEntries: 100,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  try {
    const staleBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      "a".repeat(64),
    );
    mkdirSync(join(staleBase, "source"), { recursive: true });
    writeFileSync(join(staleBase, "source", "stale.txt"), "stale");
    const staleAt = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(staleBase, staleAt, staleAt);

    const revision = fixture.createRevision({ source: "restart-ttl-owner" });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    const active = await materializer.acquire(fixture, assembly);

    assert.equal(existsSync(staleBase), false, "expired persistent entries are removed on first use");
    assert.equal(
      existsSync(join(fixture.dataDir, "render-assemblies", fixture.projectId, assembly.assemblyHash)),
      true,
      "the assembly being acquired is protected from startup pruning",
    );
    await active.release();
  } finally {
    await materializer.dispose();
    fixture.close();
  }
});

test("a restarted materializer removes interrupted atomic staging directories", async () => {
  const fixture = createPreviewFixture();
  const materializer = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 60_000,
    maxIdleEntries: 100,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  try {
    const revision = fixture.createRevision({ source: "restart-staging-owner" });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    const cacheRoot = join(fixture.dataDir, "render-assemblies", fixture.projectId);
    const interruptedStaging = join(cacheRoot, `${assembly.assemblyHash}.tmp-crashed-daemon`);
    const unrelatedDirectory = join(cacheRoot, `x${assembly.assemblyHash}.tmp-not-an-assembly`);
    mkdirSync(join(interruptedStaging, "source"), { recursive: true });
    writeFileSync(join(interruptedStaging, "source", "orphan.txt"), "orphan");
    mkdirSync(unrelatedDirectory, { recursive: true });

    const active = await materializer.acquire(fixture, assembly);

    assert.equal(
      existsSync(interruptedStaging),
      false,
      "restart inventory removes staging left behind by an interrupted atomic publish",
    );
    assert.equal(
      existsSync(unrelatedDirectory),
      true,
      "restart inventory preserves directories outside the assembly staging namespace",
    );
    await active.release();
  } finally {
    await materializer.dispose();
    fixture.close();
  }
});

test("a restarted materializer enforces persistent entry and byte capacity", async () => {
  const fixture = createPreviewFixture();
  const entryBounded = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 60_000,
    maxIdleEntries: 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  const byteBounded = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 60_000,
    maxIdleEntries: 100,
    maxBytes: 1,
  });
  try {
    const cacheRoot = join(fixture.dataDir, "render-assemblies", fixture.projectId);
    const oldestBase = join(cacheRoot, "b".repeat(64));
    const newerBase = join(cacheRoot, "c".repeat(64));
    for (const [base, value] of [[oldestBase, "old"], [newerBase, "new"]] as const) {
      mkdirSync(join(base, "source"), { recursive: true });
      writeFileSync(join(base, "source", "cached.txt"), value.repeat(128));
    }
    const { utimes } = await import("node:fs/promises");
    const now = Date.now();
    await utimes(oldestBase, new Date(now - 2_000), new Date(now - 2_000));
    await utimes(newerBase, new Date(now - 1_000), new Date(now - 1_000));

    const entryRevision = fixture.createRevision({ source: "restart-entry-owner" });
    const entryAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: entryRevision.revisionId,
    });
    const entryOwner = await entryBounded.acquire(fixture, entryAssembly);
    assert.equal(existsSync(oldestBase), false, "the persistent LRU is pruned to maxIdleEntries");
    assert.equal(existsSync(newerBase), true, "the newest persistent idle entry survives the entry cap");
    await entryOwner.release();
    await entryBounded.dispose();

    const oversizedBase = join(cacheRoot, "d".repeat(64));
    mkdirSync(join(oversizedBase, "source"), { recursive: true });
    writeFileSync(join(oversizedBase, "source", "cached.txt"), "oversized".repeat(128));

    const byteRevision = fixture.createRevision({ source: "restart-byte-owner" });
    const byteAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: byteRevision.revisionId,
    });
    const byteOwner = await byteBounded.acquire(fixture, byteAssembly);
    assert.equal(existsSync(oversizedBase), false, "persistent idle bytes count toward maxBytes");
    assert.equal(
      existsSync(join(cacheRoot, byteAssembly.assemblyHash)),
      true,
      "an active owner remains available even when it alone exceeds maxBytes",
    );
    await byteOwner.release();
  } finally {
    await entryBounded.dispose();
    await byteBounded.dispose();
    fixture.close();
  }
});

test("an abort immediately after atomic publish leaves no untracked assembly", async () => {
  const fixture = createPreviewFixture();
  const materializer = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 60_000,
    maxIdleEntries: 0,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  try {
    const revision = fixture.createRevision({ source: "abort-after-publish" });
    const assembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: revision.revisionId,
    });
    const controller = new AbortController();
    const published = materializeRenderAssembly(fixture, assembly);
    const abortWhenPublished = published.then(() => {
      controller.abort(new DOMException("caller left after publish", "AbortError"));
    });
    const acquisition = materializer.acquire(fixture, assembly, controller.signal);

    await abortWhenPublished;
    await assert.rejects(
      acquisition,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(
      existsSync(join(fixture.dataDir, "render-assemblies", fixture.projectId, assembly.assemblyHash)),
      false,
      "a rejected acquisition cannot strand a stable base outside the retention ledger",
    );
  } finally {
    await materializer.dispose();
    fixture.close();
  }
});

test("persistent inventory cannot evict an assembly owned by another materializer", async () => {
  const fixture = createPreviewFixture();
  const ownerMaterializer = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 60_000,
    maxIdleEntries: 100,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  const pruningMaterializer = renderAssemblyModule.createRenderAssemblyMaterializer({
    idleTtlMs: 60_000,
    maxIdleEntries: 0,
    maxBytes: 0,
  });
  try {
    const ownedRevision = fixture.createRevision({ source: "cross-materializer-owner" });
    const ownedAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: ownedRevision.revisionId,
    });
    const owned = await ownerMaterializer.acquire(fixture, ownedAssembly);
    const ownedBase = join(
      fixture.dataDir,
      "render-assemblies",
      fixture.projectId,
      ownedAssembly.assemblyHash,
    );

    const otherRevision = fixture.createRevision({ source: "cross-materializer-pruner" });
    const otherAssembly = buildRenderAssembly(fixture.store, {
      projectId: fixture.projectId,
      revisionId: otherRevision.revisionId,
    });
    const other = await pruningMaterializer.acquire(fixture, otherAssembly);

    assert.equal(existsSync(ownedBase), true, "a live owner protects the stable base across inventories");
    assert.equal(readFileSync(join(owned.artifactDir, "index.html"), "utf8"), "cross-materializer-owner");
    await other.release();
    await owned.release();
  } finally {
    await pruningMaterializer.dispose();
    await ownerMaterializer.dispose();
    fixture.close();
  }
});
