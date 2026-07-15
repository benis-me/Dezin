import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../../../packages/core/src/index.ts";
import { moodboardAssetPath } from "../src/project-moodboard-context.ts";
import {
  EXTERNAL_REFERENCE_FETCH_POLICY,
  ResourceRevisionSourceInputError,
  normalizeCreateResourceRevisionRequest,
  snapshotOwnedResourceRevisionSource,
  type SafeBoundedExternalFetcher,
} from "../src/resource-revision-source.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dezin-resource-source-"));
  const dataDir = join(root, "data");
  const snapshotRoot = join(root, "snapshots");
  await mkdir(dataDir, { recursive: true });
  const store = new Store();
  const project = store.createProject({ name: "Owned sources", mode: "standard" });
  const workspaceId = "workspace-1";
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, snapshotRoot, store, project, workspaceId };
}

function resource(id: string, kind: "moodboard" | "effect" | "file" | "asset" | "external-reference") {
  return { id, workspaceId: "workspace-1", kind };
}

test("Create Resource Revision request parser is exact and rejects client-authored durable fields", () => {
  assert.deepEqual(normalizeCreateResourceRevisionRequest({
    expectedHeadRevisionId: null,
    source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt" },
  }), {
    expectedHeadRevisionId: null,
    source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt" },
  });
  assert.deepEqual(normalizeCreateResourceRevisionRequest({
    expectedHeadRevisionId: "revision-1",
    source: { type: "moodboard", moodboardId: "moodboard-1" },
  }), {
    expectedHeadRevisionId: "revision-1",
    source: { type: "moodboard", moodboardId: "moodboard-1" },
  });

  for (const value of [
    {
      expectedHeadRevisionId: null,
      source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt" },
      manifestPath: "attacker/manifest.json",
    },
    {
      expectedHeadRevisionId: null,
      source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt", checksum: "0".repeat(64) },
    },
    {
      expectedHeadRevisionId: null,
      source: { type: "effect", effectId: "paper-texture", provenance: { trusted: true } },
    },
    {
      expectedHeadRevisionId: null,
      source: { type: "uploaded-file", uploadedFileId: "../secrets.txt" },
    },
    {
      expectedHeadRevisionId: null,
      source: { type: "uploaded-file", uploadedFileId: ".refs/nested/brief.txt" },
    },
    {
      expectedHeadRevisionId: null,
      source: { type: "external-reference", url: "https://example.com/brief?access_token=secret" },
    },
  ]) {
    assert.throws(() => normalizeCreateResourceRevisionRequest(value), ResourceRevisionSourceInputError);
  }
});

test("uploaded-file snapshots only the current Project's exact .refs basename", async (t) => {
  const f = await fixture(t);
  const refs = join(f.dataDir, "projects", f.project.id, ".refs");
  await mkdir(refs, { recursive: true });
  await writeFile(join(refs, "brief.txt"), "exact project-owned brief", "utf8");

  const result = await snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-file", "file"),
    revisionId: "revision-file",
    snapshotRoot: f.snapshotRoot,
    source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt" },
    createdAt: 10,
  });

  assert.equal((await readFile(result.snapshot.snapshotPath, "utf8")), "exact project-owned brief");
  assert.equal(result.summary, "Uploaded file: brief.txt");
  assert.deepEqual(result.metadata, {
    resourceKind: "file",
    payloadChecksum: result.snapshot.payloadChecksum,
    byteLength: 25,
    byteSize: 25,
    mimeType: "text/plain",
  });
  assert.equal(result.provenance.sourceType, "uploaded-file");
  assert.equal(result.provenance.sourceId, ".refs/brief.txt");
  assert.equal(result.provenance.adapter, "file");

  const foreign = f.store.createProject({ name: "Foreign", mode: "standard" });
  const foreignRefs = join(f.dataDir, "projects", foreign.id, ".refs");
  await mkdir(foreignRefs, { recursive: true });
  await writeFile(join(foreignRefs, "secret.txt"), "foreign", "utf8");
  await assert.rejects(() => snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-foreign", "file"),
    revisionId: "revision-foreign",
    snapshotRoot: f.snapshotRoot,
    source: { type: "uploaded-file", uploadedFileId: ".refs/secret.txt" },
    createdAt: 11,
  }), /unavailable/i);

  await symlink(join(foreignRefs, "secret.txt"), join(refs, "linked.txt"));
  await assert.rejects(() => snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-link", "file"),
    revisionId: "revision-link",
    snapshotRoot: f.snapshotRoot,
    source: { type: "uploaded-file", uploadedFileId: ".refs/linked.txt" },
    createdAt: 12,
  }), /symlink|escapes/i);

  const projectSecret = join(f.dataDir, "projects", f.project.id, "internal-secret.txt");
  await writeFile(projectSecret, "project internal secret", "utf8");
  await symlink("../internal-secret.txt", join(refs, "linked-inside.txt"));
  await assert.rejects(() => snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-inner-link", "file"),
    revisionId: "revision-inner-link",
    snapshotRoot: f.snapshotRoot,
    source: { type: "uploaded-file", uploadedFileId: ".refs/linked-inside.txt" },
    createdAt: 13,
  }), /symlink/i);

  const outsideSecret = join(f.root, "outside-secret.txt");
  await writeFile(outsideSecret, "outside hardlink secret", "utf8");
  await link(outsideSecret, join(refs, "hardlink.txt"));
  await assert.rejects(() => snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-hardlink", "file"),
    revisionId: "revision-hardlink",
    snapshotRoot: f.snapshotRoot,
    source: { type: "uploaded-file", uploadedFileId: ".refs/hardlink.txt" },
    createdAt: 14,
  }), /single-link/i);
});

test("Moodboard and Asset sources freeze complete owned structure and exact Asset bytes", async (t) => {
  const f = await fixture(t);
  const board = f.store.createMoodboard({ name: "Editorial system" });
  f.store.replaceMoodboardNodes(board.id, [{
    id: "note-1",
    type: "note",
    x: 10,
    y: 20,
    width: 240,
    height: 180,
    data: { text: "Use strict rhythm" },
  }]);
  const asset = f.store.createMoodboardAsset(board.id, {
    kind: "image",
    fileName: "reference.png",
    mimeType: "image/png",
    width: 12,
    height: 8,
    source: "upload",
  });
  const assetBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const assetPath = moodboardAssetPath(f.dataDir, board.id, asset);
  await mkdir(join(assetPath, ".."), { recursive: true });
  await writeFile(assetPath, assetBytes);
  const firstConversation = f.store.ensureMoodboardConversation(board.id);
  f.store.addMoodboardMessage(board.id, "user", "First direction", firstConversation.id);
  const secondConversation = f.store.createMoodboardConversation(board.id, "Alternative");
  f.store.addMoodboardMessage(board.id, "assistant", "Second direction", secondConversation.id);

  const moodboard = await snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-moodboard", "moodboard"),
    revisionId: "revision-moodboard",
    snapshotRoot: f.snapshotRoot,
    source: { type: "moodboard", moodboardId: board.id },
    createdAt: 20,
  });
  const bundle = JSON.parse(await readFile(moodboard.snapshot.snapshotPath, "utf8")) as {
    board: { id: string; conversations: Array<{ id: string }> };
    nodes: Array<{ id: string; data: { text: string } }>;
    messages: Array<{ id: string; conversationId: string; content: string }>;
    assets: Array<{ id: string; bytesBase64: string }>;
  };
  assert.equal(bundle.board.id, board.id);
  assert.deepEqual(bundle.board.conversations.map(({ id }) => id), [firstConversation.id, secondConversation.id]);
  assert.equal(bundle.nodes[0]?.data.text, "Use strict rhythm");
  assert.deepEqual(bundle.messages.map(({ content }) => content), ["First direction", "Second direction"]);
  assert.deepEqual(Buffer.from(bundle.assets[0]!.bytesBase64, "base64"), assetBytes);
  assert.equal(moodboard.provenance.sourceType, "moodboard");
  assert.equal(moodboard.provenance.sourceId, board.id);

  const frozenAsset = await snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-asset", "asset"),
    revisionId: "revision-asset",
    snapshotRoot: f.snapshotRoot,
    source: { type: "asset", assetId: asset.id },
    createdAt: 21,
  });
  assert.deepEqual(await readFile(frozenAsset.snapshot.snapshotPath), assetBytes);
  assert.equal(frozenAsset.metadata.mimeType, "image/png");
  assert.equal(frozenAsset.provenance.sourceId, asset.id);
});

test("Effect source freezes complete built-in and custom definitions", async (t) => {
  const f = await fixture(t);
  const builtIn = await snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-effect", "effect"),
    revisionId: "revision-effect",
    snapshotRoot: f.snapshotRoot,
    source: { type: "effect", effectId: "paper-texture" },
    createdAt: 30,
  });
  const builtInPayload = JSON.parse(await readFile(builtIn.snapshot.snapshotPath, "utf8")) as {
    definition: { id: string; origin: string; code: string; parameters: unknown[]; presets: unknown[] };
  };
  assert.equal(builtInPayload.definition.id, "paper-texture");
  assert.equal(builtInPayload.definition.origin, "built-in");
  assert.ok(builtInPayload.definition.code.length > 20);
  assert.ok(builtInPayload.definition.parameters.length > 0);
  assert.ok(builtInPayload.definition.presets.length > 0);

  const longUnicodeName = `${"a".repeat(199)}😀trailing`;
  const custom = f.store.createEffect({
    name: longUnicodeName,
    code: "function renderEffect(ctx) { ctx.fillRect(0, 0, 1, 1); }",
    parameters: [{ id: "amount", label: "Amount", type: "number", defaultValue: 0.5 }],
    presets: [{ id: "default", name: "Default", values: { amount: 0.5 } }],
  });
  const customResult = await snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-custom-effect", "effect"),
    revisionId: "revision-custom-effect",
    snapshotRoot: f.snapshotRoot,
    source: { type: "effect", effectId: custom.id },
    createdAt: 31,
  });
  const customPayload = JSON.parse(await readFile(customResult.snapshot.snapshotPath, "utf8")) as {
    definition: { id: string; origin: string; code: string; parameters: unknown[]; presets: unknown[] };
  };
  assert.equal(customPayload.definition.id, custom.id);
  assert.equal(customPayload.definition.origin, "custom");
  assert.equal(customPayload.definition.code, custom.code);
  assert.equal(customResult.summary, `Effect: ${"a".repeat(199)}😀`);
  assert.deepEqual(customPayload.definition.parameters, custom.parameters);
  assert.deepEqual(customPayload.definition.presets, custom.presets);
});

test("external references fail closed without a trusted bounded fetcher and pass full SSRF policy to injection", async (t) => {
  const f = await fixture(t);
  const input = {
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-external", "external-reference"),
    revisionId: "revision-external",
    snapshotRoot: f.snapshotRoot,
    source: { type: "external-reference" as const, url: "https://example.com/reference" },
    createdAt: 40,
  };
  await assert.rejects(() => snapshotOwnedResourceRevisionSource(input), /fail-closed|fetcher/i);

  let observedPolicy: unknown;
  const fetchExternal: SafeBoundedExternalFetcher = async (request) => {
    observedPolicy = request;
    return {
      finalUrl: "https://cdn.example.com/reference.txt",
      status: 200,
      mimeType: "text/plain",
      bytes: Buffer.from("bounded external evidence", "utf8"),
    };
  };
  const result = await snapshotOwnedResourceRevisionSource({ ...input, fetchExternal });
  const { signal, ...observedWithoutSignal } = observedPolicy as { signal: AbortSignal } & Record<string, unknown>;
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(observedWithoutSignal, {
    url: input.source.url,
    ...EXTERNAL_REFERENCE_FETCH_POLICY,
  });
  assert.equal(await readFile(result.snapshot.snapshotPath, "utf8"), "bounded external evidence");
  assert.equal(result.provenance.fetchBoundary, "injected-bounded-representation");

  await assert.rejects(() => snapshotOwnedResourceRevisionSource({
    ...input,
    revisionId: "revision-private",
    source: { type: "external-reference", url: "http://127.0.0.1/admin" },
    fetchExternal,
  }), /public|private|loopback/i);
});

test("source kind must match the Resource kind before any snapshot is created", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: { ...resource("resource-foreign-workspace", "effect"), workspaceId: "workspace-foreign" },
    revisionId: "revision-foreign-workspace",
    snapshotRoot: f.snapshotRoot,
    source: { type: "effect", effectId: "paper-texture" },
    createdAt: 49,
  }), /Workspace ownership does not match/i);
  await assert.rejects(() => snapshotOwnedResourceRevisionSource({
    store: f.store,
    dataDir: f.dataDir,
    projectId: f.project.id,
    workspaceId: f.workspaceId,
    resource: resource("resource-wrong-kind", "file"),
    revisionId: "revision-wrong-kind",
    snapshotRoot: f.snapshotRoot,
    source: { type: "effect", effectId: "paper-texture" },
    createdAt: 50,
  }), /does not match/i);
  await assert.rejects(() => readFile(join(
    f.snapshotRoot,
    "workspaces",
    f.workspaceId,
    "resource-revisions",
    "revision-wrong-kind",
    "manifest.json",
  )), /ENOENT/);
});
