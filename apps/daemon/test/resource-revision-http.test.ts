import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { snapshotBytes } from "../src/context/adapters/file.ts";

async function withServer(run: (input: {
  base: string;
  dataDir: string;
  store: Store;
}) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-resource-revision-http-"));
  const store = new Store(join(dataDir, "store.db"));
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({ store, dataDir, runtimeSupervisor });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("Resource exact view, payload, and 50+ keyset history stay independently bounded", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Resource HTTP", mode: "standard" });
    const foreignProject = store.createProject({ name: "Foreign Resource HTTP", mode: "standard" });
    assert.equal((await fetch(`${base}/api/projects/${project.id}/workspace`)).status, 200);
    assert.equal((await fetch(`${base}/api/projects/${foreignProject.id}/workspace`)).status, 200);
    const workspace = store.workspace.getWorkspace(project.id)!;
    const created = store.workspace.createResourceForProject(project.id, {
      kind: "file",
      title: "Frozen brief",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: workspace.graphRevision,
      expectedSnapshotId: workspace.activeSnapshotId,
    });
    const bytes = Buffer.from("Exact immutable brief\n", "utf8");
    const snapshot = await snapshotBytes({
      workspaceId: workspace.id,
      resourceId: created.resource.id,
      revisionId: "resource-http-exact",
      kind: "file",
      workspaceRoot: dataDir,
      snapshotRoot: dataDir,
      source: { type: "owned-file", path: "unused", mimeType: "text/plain" },
      provenance: { sourceType: "uploaded-file", sourceId: ".refs/brief.txt" },
      createdAt: Date.now(),
    }, bytes, "text/plain");
    const exact = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
      revisionId: snapshot.id,
      parentRevisionId: null,
      manifestPath: snapshot.manifestPath,
      summary: "Exact brief",
      metadata: { mimeType: snapshot.mimeType, byteLength: snapshot.byteSize },
      checksum: snapshot.checksum,
      provenance: snapshot.provenance,
    });
    for (let index = 2; index <= 55; index += 1) {
      store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
        revisionId: `resource-http-${String(index).padStart(2, "0")}`,
        parentRevisionId: null,
        manifestPath: `unused/${index}/manifest.json`,
        summary: `Revision ${index}`,
        metadata: {},
        checksum: String(index % 10).repeat(64),
        provenance: {},
      });
    }

    const viewResponse = await fetch(
      `${base}/api/projects/${project.id}/resources/${created.resource.id}/revisions/${exact.id}`,
    );
    const viewBody = await viewResponse.text();
    assert.equal(viewResponse.status, 200, viewBody);
    const view = JSON.parse(viewBody) as {
      kind: string;
      content: { text: string };
      payload: { downloadUrl: string };
    };
    assert.equal(view.kind, "file");
    assert.equal(view.content.text, bytes.toString("utf8"));

    const payloadResponse = await fetch(`${base}${view.payload.downloadUrl}`);
    assert.equal(payloadResponse.status, 200);
    assert.equal(await payloadResponse.text(), bytes.toString("utf8"));
    assert.equal(payloadResponse.headers.get("x-content-type-options"), "nosniff");
    assert.match(payloadResponse.headers.get("content-security-policy") ?? "", /sandbox.*script-src 'none'/);
    assert.match(payloadResponse.headers.get("content-disposition") ?? "", /^attachment;/);

    const firstHistory = await fetch(
      `${base}/api/projects/${project.id}/resources/${created.resource.id}/history`,
    );
    assert.equal(firstHistory.status, 200);
    const firstPage = await firstHistory.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(firstPage.items.length, 20);
    assert.ok(firstPage.nextCursor);
    const secondPage = await fetch(
      `${base}/api/projects/${project.id}/resources/${created.resource.id}/history?limit=20&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    ).then((response) => response.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    const thirdPage = await fetch(
      `${base}/api/projects/${project.id}/resources/${created.resource.id}/history?limit=20&cursor=${encodeURIComponent(secondPage.nextCursor!)}`,
    ).then((response) => response.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(secondPage.items.length, 20);
    assert.equal(thirdPage.items.length, 15);
    assert.equal(new Set([...firstPage.items, ...secondPage.items, ...thirdPage.items].map(({ id }) => id)).size, 55);

    const badCursor = await fetch(
      `${base}/api/projects/${project.id}/resources/${created.resource.id}/history?cursor=e30`,
    );
    assert.equal(badCursor.status, 400);
    const foreign = await fetch(
      `${base}/api/projects/${foreignProject.id}/resources/${created.resource.id}/revisions/${exact.id}`,
    );
    assert.equal(foreign.status, 404);

    await chmod(snapshot.snapshotPath, 0o644);
    await writeFile(snapshot.snapshotPath, Buffer.from("Corrupt immutable bytes", "utf8"));
    const corrupt = await fetch(`${base}${view.payload.downloadUrl}`);
    assert.equal(corrupt.status, 422);
    assert.match(JSON.stringify(await corrupt.json()), /checksum|integrity|length/i);
  });
});

test("Moodboard embedded Asset route is opaque, checksum-bound, and scriptless", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Moodboard HTTP", mode: "standard" });
    assert.equal((await fetch(`${base}/api/projects/${project.id}/workspace`)).status, 200);
    const workspace = store.workspace.getWorkspace(project.id)!;
    const created = store.workspace.createResourceForProject(project.id, {
      kind: "moodboard",
      title: "Frozen references",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: workspace.graphRevision,
      expectedSnapshotId: workspace.activeSnapshotId,
    });
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const imageChecksum = createHash("sha256").update(image).digest("hex");
    const bundle = Buffer.from(`${JSON.stringify({
      format: "dezin-moodboard-resource-bundle",
      version: 1,
      board: { id: "board-http", name: "Frozen references", coverAssetId: "asset-http" },
      nodes: [{ id: "image-http", type: "image", data: { assetId: "asset-http" } }],
      messages: [],
      assets: [{
        id: "asset-http",
        metadata: { kind: "image", fileName: "reference.png", mimeType: "image/png", width: 1, height: 1 },
        byteLength: image.byteLength,
        checksum: imageChecksum,
        bytesBase64: image.toString("base64"),
      }],
    })}\n`, "utf8");
    const snapshot = await snapshotBytes({
      workspaceId: workspace.id,
      resourceId: created.resource.id,
      revisionId: "moodboard-http-exact",
      kind: "moodboard",
      workspaceRoot: dataDir,
      snapshotRoot: dataDir,
      source: { type: "owned-file", path: "unused", mimeType: "application/json" },
      provenance: {},
      createdAt: Date.now(),
    }, bundle, "application/json");
    const revision = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
      revisionId: snapshot.id,
      parentRevisionId: null,
      manifestPath: snapshot.manifestPath,
      summary: "Frozen references",
      metadata: { mimeType: snapshot.mimeType },
      checksum: snapshot.checksum,
      provenance: snapshot.provenance,
    });
    const viewResponse = await fetch(
      `${base}/api/projects/${project.id}/resources/${created.resource.id}/revisions/${revision.id}`,
    );
    const viewBody = await viewResponse.text();
    assert.equal(viewResponse.status, 200, viewBody);
    const view = JSON.parse(viewBody) as {
      content: { assets: Array<{ url: string; downloadUrl: string }> };
    };
    const asset = view.content.assets[0]!;
    assert.ok(!asset.url.includes("payload.bin"));
    const response = await fetch(`${base}${asset.url}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
    assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox;/);
    const unknown = await fetch(`${base}${asset.url.replace("asset-http", "asset-foreign")}`);
    assert.equal(unknown.status, 404);
  });
});

test("HTML, SVG, and PDF exact payloads keep restrictive content headers", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Resource content headers", mode: "standard" });
    assert.equal((await fetch(`${base}/api/projects/${project.id}/workspace`)).status, 200);

    const addPayload = async (input: {
      id: string;
      mimeType: string;
      bytes: Buffer;
    }): Promise<string> => {
      const workspace = store.workspace.getWorkspace(project.id)!;
      const created = store.workspace.createResourceForProject(project.id, {
        kind: "file",
        title: input.id,
        defaultPinPolicy: "pin-current",
        baseGraphRevision: workspace.graphRevision,
        expectedSnapshotId: workspace.activeSnapshotId,
      });
      const snapshot = await snapshotBytes({
        workspaceId: workspace.id,
        resourceId: created.resource.id,
        revisionId: input.id,
        kind: "file",
        workspaceRoot: dataDir,
        snapshotRoot: dataDir,
        source: { type: "owned-file", path: "unused", mimeType: input.mimeType },
        provenance: { sourceType: "uploaded-file", sourceId: `.refs/${input.id}` },
        createdAt: Date.now(),
      }, input.bytes, input.mimeType);
      const revision = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
        revisionId: snapshot.id,
        parentRevisionId: null,
        manifestPath: snapshot.manifestPath,
        summary: input.id,
        metadata: { mimeType: snapshot.mimeType, byteLength: snapshot.byteSize },
        checksum: snapshot.checksum,
        provenance: snapshot.provenance,
      });
      return `${base}/api/projects/${project.id}/resources/${created.resource.id}/revisions/${revision.id}/payload`;
    };

    const htmlUrl = await addPayload({
      id: "revision-html",
      mimeType: "text/html",
      bytes: Buffer.from("<!doctype html><title>Frozen</title><script>alert(1)</script>", "utf8"),
    });
    const svgUrl = await addPayload({
      id: "revision-svg",
      mimeType: "image/svg+xml",
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>', "utf8"),
    });
    const pdfUrl = await addPayload({
      id: "revision-pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\n% frozen exact fixture\n", "ascii"),
    });

    const html = await fetch(htmlUrl);
    const htmlBody = await html.text();
    assert.equal(html.status, 200, htmlBody);
    assert.equal(html.headers.get("content-type"), "text/html");
    assert.match(html.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.match(html.headers.get("content-security-policy") ?? "", /sandbox.*script-src 'none'.*object-src 'none'/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");

    for (const [url, mime] of [[svgUrl, "image/svg+xml"], [pdfUrl, "application/pdf"]] as const) {
      const response = await fetch(url);
      const responseBody = await response.arrayBuffer();
      assert.equal(response.status, 200, Buffer.from(responseBody).toString("utf8"));
      assert.equal(response.headers.get("content-type"), mime);
      assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
      assert.match(response.headers.get("content-security-policy") ?? "", /sandbox.*script-src 'none'.*frame-ancestors 'self'/);
      assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }

    const forcedDownload = await fetch(`${pdfUrl}?download=1`);
    assert.match(forcedDownload.headers.get("content-disposition") ?? "", /^attachment;/);
    const etag = forcedDownload.headers.get("etag");
    assert.ok(etag);
    const cached = await fetch(pdfUrl, { headers: { "If-None-Match": etag! } });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
  });
});
