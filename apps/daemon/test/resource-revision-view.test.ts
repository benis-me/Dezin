import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store, type ResourceKind } from "../../../packages/core/src/index.ts";
import { snapshotBytes } from "../src/context/adapters/file.ts";
import { encodeSharinganCaptureResourceBundle } from "../src/orchestration/sharingan-capture-resource-bundle.ts";
import { readResourceRevisionView, ResourceRevisionViewError } from "../src/resource-revision-view.ts";
import {
  ResourceRevisionPayloadError,
  verifyBoundedResourcePayloadBytes,
} from "../src/resource-revision-payload.ts";
import { semanticSharinganCaptureFiles } from "./support/sharingan-capture-fixture.ts";
import {
  createResearchRevisionFixture,
  persistResearchRevisionFixtureContextPack,
} from "./support/research-resource-fixture.ts";

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-resource-view-"));
  const store = new Store();
  const project = store.createProject({ name: "Exact Resource views", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, project, workspace };
}

async function addRevision(
  f: Awaited<ReturnType<typeof fixture>>,
  input: {
    kind: ResourceKind;
    resourceId: string;
    revisionId: string;
    bytes: Uint8Array | ((identity: {
      workspaceId: string;
      resourceId: string;
      contextPack: ReturnType<typeof persistResearchRevisionFixtureContextPack> | null;
    }) => Uint8Array | Promise<Uint8Array>);
    mimeType: string;
    provenance?: Record<string, unknown> | ((identity: {
      workspaceId: string;
      resourceId: string;
      contextPack: ReturnType<typeof persistResearchRevisionFixtureContextPack> | null;
    }) => Record<string, unknown>);
    metadata?: Record<string, unknown> | ((identity: {
      workspaceId: string;
      resourceId: string;
      contextPack: ReturnType<typeof persistResearchRevisionFixtureContextPack> | null;
    }) => Record<string, unknown>);
  },
) {
  const current = f.store.workspace.getWorkspace(f.project.id)!;
  const created = f.store.workspace.createResourceForProject(f.project.id, {
    kind: input.kind,
    title: `${input.kind} view`,
    defaultPinPolicy: "pin-current",
    baseGraphRevision: current.graphRevision,
    expectedSnapshotId: current.activeSnapshotId,
  });
  const contextPack = input.kind === "research"
    ? persistResearchRevisionFixtureContextPack({
        store: f.store,
        manifestRoot: f.dataDir,
        workspaceId: f.workspace.id,
        resourceId: created.resource.id,
        graphRevision: f.store.workspace.getWorkspace(f.project.id)!.graphRevision,
      })
    : null;
  const identity = { workspaceId: f.workspace.id, resourceId: created.resource.id, contextPack };
  const bytes = typeof input.bytes === "function"
    ? await input.bytes(identity)
    : input.bytes;
  const provenance = typeof input.provenance === "function" ? input.provenance(identity) : input.provenance ?? {};
  const metadata = typeof input.metadata === "function" ? input.metadata(identity) : input.metadata ?? {};
  const snapshot = await snapshotBytes({
    workspaceId: f.workspace.id,
    resourceId: created.resource.id,
    revisionId: input.revisionId,
    kind: input.kind,
    workspaceRoot: f.dataDir,
    snapshotRoot: f.dataDir,
    source: { type: "owned-file", path: "unused", mimeType: input.mimeType },
    provenance,
    createdAt: Date.now(),
  }, bytes, input.mimeType);
  const revision = f.store.workspace.createResourceRevisionCandidateForProject(
    f.project.id,
    created.resource.id,
    {
      revisionId: snapshot.id,
      parentRevisionId: null,
      manifestPath: snapshot.manifestPath,
      summary: `Frozen ${input.kind}`,
      metadata: {
        mimeType: snapshot.mimeType,
        byteLength: snapshot.byteSize,
        payloadChecksum: snapshot.payloadChecksum,
        ...metadata,
      },
      checksum: snapshot.checksum,
      provenance: snapshot.provenance,
    },
  );
  return { resource: created.resource, revision, snapshot };
}

test("exact file Revision view verifies immutable bytes and projects a bounded text preview", async (t) => {
  const f = await fixture(t);
  const exact = await addRevision(f, {
    kind: "file",
    resourceId: "resource-file",
    revisionId: "revision-file",
    bytes: Buffer.from("Frozen launch brief\nDo not read the mutable upload.\n", "utf8"),
    mimeType: "text/plain",
    provenance: { sourceType: "uploaded-file", sourceId: ".refs/launch.txt" },
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });

  assert.equal(view.protocol, "dezin.resource-revision-view.v1");
  assert.equal(view.kind, "file");
  if (view.kind !== "file") assert.fail("expected file view");
  assert.equal(view.content.previewKind, "text");
  assert.equal(view.content.text, "Frozen launch brief\nDo not read the mutable upload.\n");
  assert.equal(view.content.fileName, "launch.txt");
  assert.equal(view.payload.mimeType, "text/plain");
  assert.equal(view.payload.byteLength, exact.snapshot.byteSize);
  assert.equal(view.payload.checksum, exact.snapshot.payloadChecksum);
  assert.equal(
    view.payload.downloadUrl,
    `/api/projects/${encodeURIComponent(f.project.id)}/resources/${encodeURIComponent(exact.resource.id)}/revisions/revision-file/payload?download=1`,
  );
});

test("invalid UTF-8 and oversized text payloads fail as controlled 422 boundaries", async (t) => {
  const f = await fixture(t);
  const invalidUtf8 = await addRevision(f, {
    kind: "file",
    resourceId: "resource-invalid-utf8",
    revisionId: "revision-invalid-utf8",
    bytes: Buffer.from("ok", "utf8"),
    mimeType: "text/plain",
  });
  await chmod(invalidUtf8.snapshot.snapshotPath, 0o644);
  await writeFile(invalidUtf8.snapshot.snapshotPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    readResourceRevisionView({
      store: f.store,
      dataDir: f.dataDir,
      projectId: f.project.id,
      resourceId: invalidUtf8.resource.id,
      revisionId: invalidUtf8.revision.id,
    }),
    (error: unknown) => error instanceof ResourceRevisionViewError
      && error.status === 422
      && /UTF-8|verification|payload/i.test(error.message),
  );

  await assert.rejects(
    verifyBoundedResourcePayloadBytes(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61), "text/plain"),
    (error: unknown) => error instanceof ResourceRevisionPayloadError
      && /bound|large|length|payload/i.test(error.message),
  );
});

test("exact Moodboard Revision view projects frozen nodes and checksum-bound image capabilities", async (t) => {
  const f = await fixture(t);
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const checksum = createHash("sha256").update(image).digest("hex");
  const bundle = {
    format: "dezin-moodboard-resource-bundle",
    version: 1,
    board: { id: "board-1", name: "Quiet utility", coverAssetId: "asset-1" },
    nodes: [
      { id: "note-1", type: "note", x: 12, y: 20, width: 240, height: 160, data: { text: "Measured hierarchy" } },
      { id: "image-1", type: "image", x: 280, y: 20, width: 320, height: 180, data: { assetId: "asset-1", label: "Hero reference" } },
    ],
    messages: [],
    assets: [{
      id: "asset-1",
      metadata: { kind: "image", fileName: "reference.png", mimeType: "image/png", width: 1, height: 1 },
      byteLength: image.byteLength,
      checksum,
      bytesBase64: image.toString("base64"),
    }],
  };
  const exact = await addRevision(f, {
    kind: "moodboard",
    resourceId: "resource-moodboard",
    revisionId: "revision-moodboard",
    bytes: Buffer.from(`${JSON.stringify(bundle)}\n`, "utf8"),
    mimeType: "application/json",
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });
  assert.equal(view.kind, "moodboard");
  if (view.kind !== "moodboard") assert.fail("expected Moodboard view");
  assert.deepEqual(view.content.board, { id: "board-1", name: "Quiet utility", coverAssetId: "asset-1" });
  assert.equal(view.content.nodes[0]?.text, "Measured hierarchy");
  assert.deepEqual(
    view.content.nodes.map(({ x, y, width, height }) => ({ x, y, width, height })),
    [
      { x: 12, y: 20, width: 240, height: 160 },
      { x: 280, y: 20, width: 320, height: 180 },
    ],
  );
  assert.equal(view.content.nodes[1]?.assetId, "asset-1");
  assert.equal(view.content.assets[0]?.checksum, checksum);
  assert.match(view.content.assets[0]?.url ?? "", /embedded-assets\/asset-1$/);
  assert.equal(view.content.nodesTruncated, false);
  assert.equal(view.content.assetsTruncated, false);
});

test("exact Effect Revision view exposes a declarative fixture without evaluating frozen code", async (t) => {
  const f = await fixture(t);
  const payload = {
    format: "dezin-effect-resource",
    version: 1,
    definition: {
      id: "grain-effect",
      name: "Quiet grain",
      origin: "custom",
      category: "texture",
      summary: "A restrained surface treatment.",
      parameters: [
        { id: "amount", label: "Amount", type: "number", defaultValue: 0.35, min: 0, max: 1, step: 0.05 },
        { id: "animate", label: "Animate", type: "boolean", defaultValue: false },
      ],
      presets: [{ id: "subtle", name: "Subtle", values: { amount: 0.2, animate: false } }],
      code: "globalThis.__effectViewerExecuted = true;",
    },
  };
  const exact = await addRevision(f, {
    kind: "effect",
    resourceId: "resource-effect",
    revisionId: "revision-effect",
    bytes: Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"),
    mimeType: "application/json",
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });
  assert.equal(view.kind, "effect");
  if (view.kind !== "effect") assert.fail("expected Effect view");
  assert.equal((globalThis as Record<string, unknown>).__effectViewerExecuted, undefined);
  assert.equal(view.content.definition.code, payload.definition.code);
  assert.deepEqual(view.content.fixture, {
    width: 640,
    height: 360,
    timesMs: [0, 500, 1_000],
    values: { amount: 0.35, animate: false },
  });
});

test("exact Asset Revision view exposes verified media dimensions and frozen source identity", async (t) => {
  const f = await fixture(t);
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const exact = await addRevision(f, {
    kind: "asset",
    resourceId: "resource-asset",
    revisionId: "revision-asset",
    bytes: image,
    mimeType: "image/png",
    provenance: { sourceType: "asset", sourceId: "moodboard-asset-7" },
    metadata: { width: 1, height: 1, fileName: "frozen-reference.png" },
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });
  assert.equal(view.kind, "asset");
  if (view.kind !== "asset") assert.fail("expected Asset view");
  assert.equal(view.content.mediaKind, "image");
  assert.equal(view.content.width, 1);
  assert.equal(view.content.height, 1);
  assert.equal(view.content.sourceType, "asset");
  assert.equal(view.content.sourceId, "moodboard-asset-7");
  assert.match(view.payload.url ?? "", /revision-asset\/payload$/);
});

test("exact text Asset Revision exposes a bounded UTF-8 projection", async (t) => {
  const f = await fixture(t);
  const exact = await addRevision(f, {
    kind: "asset",
    resourceId: "resource-text-asset",
    revisionId: "revision-text-asset",
    bytes: Buffer.from("Frozen typography specimen.\n", "utf8"),
    mimeType: "text/plain",
    provenance: { sourceType: "asset", sourceId: "asset-typography" },
    metadata: { fileName: "specimen.txt" },
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });
  assert.equal(view.kind, "asset");
  if (view.kind !== "asset") assert.fail("expected Asset view");
  assert.equal(view.content.mediaKind, "text");
  assert.equal(view.content.text, "Frozen typography specimen.\n");
  assert.equal(view.content.textTruncated, false);
});

test("exact External Reference Revision view reads only the frozen response and final source identity", async (t) => {
  const f = await fixture(t);
  const exact = await addRevision(f, {
    kind: "external-reference",
    resourceId: "resource-external",
    revisionId: "revision-external",
    bytes: Buffer.from("Frozen response captured at publication time.", "utf8"),
    mimeType: "text/plain",
    provenance: {
      sourceType: "external-reference",
      sourceId: "https://example.com/original",
      sourceUrl: "https://example.com/original",
      finalUrl: "https://cdn.example.com/final",
      status: 200,
      fetchBoundary: "injected-bounded-representation",
    },
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });
  assert.equal(view.kind, "external-reference");
  if (view.kind !== "external-reference") assert.fail("expected External Reference view");
  assert.equal(view.content.sourceUrl, "https://example.com/original");
  assert.equal(view.content.finalUrl, "https://cdn.example.com/final");
  assert.equal(view.content.status, 200);
  assert.equal(view.content.text, "Frozen response captured at publication time.");
  assert.equal(view.payload.url, null, "frozen text is rendered as text, never as an online iframe");
});

test("exact Sharingan Capture Revision reuses semantic validation and projects frozen screenshot evidence", async (t) => {
  const f = await fixture(t);
  const exact = await addRevision(f, {
    kind: "sharingan-capture",
    resourceId: "resource-sharingan",
    revisionId: "revision-sharingan",
    bytes: ({ workspaceId, resourceId }) => encodeSharinganCaptureResourceBundle({
      scope: {
        taskId: "task-sharingan",
        planId: "plan-sharingan",
        attempt: 1,
        inputHash: "a".repeat(64),
        workspaceId,
        resourceId,
        parentRevisionId: null,
        contextPackId: "context-sharingan",
        operation: "create",
        nodeId: "node-sharingan",
        title: "Captured checkout",
        resourceKind: "sharingan-capture",
      },
      source: {
        requestedUrl: "https://example.com/checkout",
        finalUrl: "https://example.com/checkout",
        capturedAt: 123,
      },
      exporter: { id: "dezin-sharingan-capture", version: 1 },
      files: semanticSharinganCaptureFiles({
        requestedUrl: "https://example.com/checkout",
        finalUrl: "https://example.com/checkout",
        marker: "Checkout source",
      }),
      maxOutputBytes: 64 * 1024 * 1024,
    }).bytes,
    mimeType: "application/json",
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });
  assert.equal(view.kind, "sharingan-capture");
  if (view.kind !== "sharingan-capture") assert.fail("expected Sharingan view");
  assert.deepEqual(view.content.source, {
    requestedUrl: "https://example.com/checkout",
    finalUrl: "https://example.com/checkout",
    capturedAt: 123,
  });
  assert.equal(view.content.pages[0]?.title, "Checkout source");
  assert.deepEqual(view.content.pages[0]?.viewport, { width: 1440, height: 900 });
  assert.deepEqual(view.content.pages[0]?.styleTokens.colors, ["rgb(17, 17, 17)"]);
  assert.match(view.content.pages[0]?.screenshots[0]?.url ?? "", /embedded-assets\//);
  assert.ok((view.content.pages[0]?.dom.nodeCount ?? 0) >= 2);
});

test("unified exact Research Revision view preserves the verified provenance projection", async (t) => {
  const f = await fixture(t);
  const exact = await addRevision(f, {
    kind: "research",
    resourceId: "resource-research",
    revisionId: "revision-research",
    bytes: ({ workspaceId, resourceId, contextPack }) => Buffer.from(
      `${JSON.stringify(createResearchRevisionFixture({ workspaceId, resourceId, contextPack: contextPack! }).bundle)}\n`,
      "utf8",
    ),
    mimeType: "application/json",
    metadata: ({ workspaceId, resourceId, contextPack }) => createResearchRevisionFixture({
      workspaceId, resourceId, contextPack: contextPack!,
    }).metadata,
    provenance: ({ workspaceId, resourceId, contextPack }) => createResearchRevisionFixture({
      workspaceId, resourceId, contextPack: contextPack!,
    }).provenance,
  });

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });
  assert.equal(view.kind, "research");
  if (view.kind !== "research") assert.fail("expected Research view");
  assert.equal(view.content.qualityState, "grounded");
  assert.equal(view.content.sources[0]?.verification, "verified");
  assert.match(view.content.sources[0]?.receiptId ?? "", /^research-evidence-[a-f0-9]{64}$/);
  assert.deepEqual(view.content.directions[0]?.findingIds, ["finding-comparison", "finding-summary"]);
});

test("an archived Research Resource keeps its exact immutable Revision readable", async (t) => {
  const f = await fixture(t);
  const exact = await addRevision(f, {
    kind: "research",
    resourceId: "resource-archived-research",
    revisionId: "revision-archived-research",
    bytes: ({ workspaceId, resourceId, contextPack }) => Buffer.from(
      `${JSON.stringify(createResearchRevisionFixture({ workspaceId, resourceId, contextPack: contextPack! }).bundle)}\n`,
      "utf8",
    ),
    mimeType: "application/json",
    metadata: ({ workspaceId, resourceId, contextPack }) => createResearchRevisionFixture({
      workspaceId, resourceId, contextPack: contextPack!,
    }).metadata,
    provenance: ({ workspaceId, resourceId, contextPack }) => createResearchRevisionFixture({
      workspaceId, resourceId, contextPack: contextPack!,
    }).provenance,
  });
  const beforePublish = f.store.workspace.getWorkspace(f.project.id)!;
  const published = f.store.workspace.publishResourceRevisionForProject(
    f.project.id,
    exact.resource.id,
    exact.revision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: beforePublish.activeSnapshotId,
      reason: "Publish archived Research fixture",
    },
  );
  const beforeArchive = f.store.workspace.getWorkspace(f.project.id)!;
  const archived = f.store.workspace.updateResourceForProject(f.project.id, exact.resource.id, {
    action: "archive",
    baseGraphRevision: beforeArchive.graphRevision,
    expectedSnapshotId: published.id,
    consumerImpactConfirmed: true,
  });
  assert.ok(archived.resource.archivedAt !== null);

  const view = await readResourceRevisionView({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
  });

  assert.equal(view.kind, "research");
  assert.equal(view.resource.archivedAt, archived.resource.archivedAt);
  assert.equal(view.revision.id, exact.revision.id);
});

test("Research projection rejects non-canonical receipts, missing attestations, and credential-bearing locators", async (t) => {
  const f = await fixture(t);
  const cases = [
    {
      id: "receipt",
      fixture: (workspaceId: string, resourceId: string, contextPack: NonNullable<ReturnType<typeof persistResearchRevisionFixtureContextPack>>) => {
        const value = createResearchRevisionFixture({ workspaceId, resourceId, contextPack });
        value.bundle.receipts[0]!.checksum = "0".repeat(64);
        return value;
      },
      metadata: true,
    },
    {
      id: "metadata",
      fixture: (workspaceId: string, resourceId: string, contextPack: NonNullable<ReturnType<typeof persistResearchRevisionFixtureContextPack>>) => createResearchRevisionFixture({ workspaceId, resourceId, contextPack }),
      metadata: false,
    },
    {
      id: "locator",
      fixture: (workspaceId: string, resourceId: string, contextPack: NonNullable<ReturnType<typeof persistResearchRevisionFixtureContextPack>>) => createResearchRevisionFixture({
        workspaceId,
        resourceId,
        contextPack,
        verifiedLocator: "https://example.test/study?access_token=not-for-the-viewer",
      }),
      metadata: true,
    },
  ] as const;
  for (const item of cases) {
    const exact = await addRevision(f, {
      kind: "research",
      resourceId: `resource-invalid-${item.id}`,
      revisionId: `revision-invalid-${item.id}`,
      bytes: ({ workspaceId, resourceId, contextPack }) => Buffer.from(
        `${JSON.stringify(item.fixture(workspaceId, resourceId, contextPack!).bundle)}\n`,
        "utf8",
      ),
      mimeType: "application/json",
      metadata: ({ workspaceId, resourceId, contextPack }) => item.metadata
        ? item.fixture(workspaceId, resourceId, contextPack!).metadata
        : {},
      provenance: ({ workspaceId, resourceId, contextPack }) => item.fixture(
        workspaceId,
        resourceId,
        contextPack!,
      ).provenance,
    });
    await assert.rejects(
      readResourceRevisionView({
        store: f.store,
        dataDir: f.dataDir,
        projectId: f.project.id,
        resourceId: exact.resource.id,
        revisionId: exact.revision.id,
      }),
      (error: unknown) => error instanceof ResourceRevisionViewError && error.status === 422,
      item.id,
    );
  }
});
