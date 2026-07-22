import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor, type AppDeps } from "../src/app.ts";
import {
  handleCreateResourceRevision,
  handleMaterializeResource,
} from "../src/workspace-handler.ts";

function jsonRequest(body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
  request.headers = { "content-type": "application/json" };
  return request;
}

function responseThatLosesCommittedReply(): ServerResponse {
  return {
    writeHead: () => {
      throw new Error("injected response send failure");
    },
  } as unknown as ServerResponse;
}

async function withServer(run: (input: {
  base: string;
  dataDir: string;
  store: Store;
}) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-resource-materialization-http-"));
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

async function listPayloadFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    const files: string[] = [];
    for (const entry of entries) {
      const status = await lstat(join(root, entry));
      if (!status.isDirectory()) files.push(entry);
    }
    return files.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("one Resource materialization request publishes an exact first Revision without exposing an empty Resource", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Atomic Agent attachment", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    const refsDir = join(dataDir, "projects", project.id, ".refs");
    await mkdir(refsDir, { recursive: true });
    await writeFile(join(refsDir, "brief.txt"), "immutable attachment bytes", "utf8");

    const response = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "file",
        title: "Product brief",
        defaultPinPolicy: "pin-current",
        baseGraphRevision: ready.graph.revision,
        expectedSnapshotId: ready.activeSnapshot.id,
        source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt" },
        reason: "Attached to scoped Agent Context",
      }),
    });
    const bodyText = await response.text();
    assert.equal(response.status, 201, bodyText);
    const body = JSON.parse(bodyText) as {
      resource: { id: string; headRevisionId: string | null };
      node: { kind: string; resourceId: string };
      revision: { id: string; resourceId: string; parentRevisionId: string | null; checksum: string };
      graph: { revision: number; nodes: Array<{ kind: string; resourceId?: string }> };
      snapshot: { id: string; resourceRevisions: Record<string, string | null> };
    };

    assert.equal(body.node.kind, "resource");
    assert.equal(body.node.resourceId, body.resource.id);
    assert.equal(body.revision.resourceId, body.resource.id);
    assert.equal(body.revision.parentRevisionId, null);
    assert.match(body.revision.checksum, /^[a-f0-9]{64}$/);
    assert.equal(body.resource.headRevisionId, body.revision.id);
    assert.equal(body.snapshot.resourceRevisions[body.resource.id], body.revision.id);
    assert.equal(body.graph.revision, ready.graph.revision + 1);
    assert.equal(
      body.graph.nodes.filter((node) => node.kind === "resource" && node.resourceId === body.resource.id).length,
      1,
    );
    assert.deepEqual(store.workspace.listResources(project.id).map(({ id }) => id), [body.resource.id]);
    assert.deepEqual(
      store.workspace.listResourceRevisions(project.id, body.resource.id).map(({ id }) => id),
      [body.revision.id],
    );
  });
});

test("Resource materialization removes frozen bytes when the atomic database publication fails", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Atomic attachment rollback", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    const beforeWorkspace = store.workspace.getWorkspace(project.id)!;
    const beforeGraph = store.workspace.getGraph(project.id);
    const beforeSnapshots = store.workspace.listSnapshots(project.id);
    const refsDir = join(dataDir, "projects", project.id, ".refs");
    await mkdir(refsDir, { recursive: true });
    await writeFile(join(refsDir, "rollback.txt"), "bytes that must be removed", "utf8");

    const original = store.workspace.createPublishedResourceForProject;
    store.workspace.createPublishedResourceForProject = (() => {
      throw new Error("injected atomic publication failure");
    }) as typeof original;
    let response: Response;
    try {
      response = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "file",
          title: "Rollback brief",
          defaultPinPolicy: "pin-current",
          baseGraphRevision: ready.graph.revision,
          expectedSnapshotId: ready.activeSnapshot.id,
          source: { type: "uploaded-file", uploadedFileId: ".refs/rollback.txt" },
          reason: "Attached to scoped Agent Context",
        }),
      });
    } finally {
      store.workspace.createPublishedResourceForProject = original;
    }

    assert.equal(response.status, 500);
    assert.deepEqual(store.workspace.listResources(project.id), []);
    assert.deepEqual(store.workspace.getWorkspace(project.id), beforeWorkspace);
    assert.deepEqual(store.workspace.getGraph(project.id), beforeGraph);
    assert.deepEqual(store.workspace.listSnapshots(project.id), beforeSnapshots);
    assert.deepEqual(await listPayloadFiles(join(dataDir, "resource-revisions")), []);
  });
});

test("Resource materialization keeps its committed immutable payload when the response cannot be sent", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Committed attachment response loss", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    const refsDir = join(dataDir, "projects", project.id, ".refs");
    await mkdir(refsDir, { recursive: true });
    await writeFile(join(refsDir, "committed.txt"), "committed immutable attachment", "utf8");

    await assert.rejects(
      handleMaterializeResource(
        jsonRequest({
          kind: "file",
          title: "Committed brief",
          defaultPinPolicy: "pin-current",
          baseGraphRevision: ready.graph.revision,
          expectedSnapshotId: ready.activeSnapshot.id,
          source: { type: "uploaded-file", uploadedFileId: ".refs/committed.txt" },
          reason: "Publish before the HTTP reply is lost",
        }),
        responseThatLosesCommittedReply(),
        { id: project.id },
        { store, dataDir } as AppDeps,
      ),
      /injected response send failure/,
    );

    const [resource] = store.workspace.listResources(project.id);
    assert.ok(resource);
    const [revision] = store.workspace.listResourceRevisions(project.id, resource.id);
    assert.ok(revision);
    assert.equal(resource.headRevisionId, revision.id);
    const exact = await fetch(
      `${base}/api/projects/${project.id}/resources/${resource.id}/revisions/${revision.id}`,
    );
    const exactBody = await exact.text();
    assert.equal(exact.status, 200, exactBody);
    assert.equal((JSON.parse(exactBody) as { content: { text: string } }).content.text, "committed immutable attachment");
  });
});

test("Resource Revision creation keeps its committed immutable payload when the response cannot be sent", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Committed Revision response loss", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    const created = store.workspace.createResourceForProject(project.id, {
      kind: "file",
      title: "Revision target",
      defaultPinPolicy: "manual",
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: ready.activeSnapshot.id,
    });
    const refsDir = join(dataDir, "projects", project.id, ".refs");
    await mkdir(refsDir, { recursive: true });
    await writeFile(join(refsDir, "candidate.txt"), "committed immutable candidate", "utf8");

    await assert.rejects(
      handleCreateResourceRevision(
        jsonRequest({
          expectedHeadRevisionId: null,
          source: { type: "uploaded-file", uploadedFileId: ".refs/candidate.txt" },
        }),
        responseThatLosesCommittedReply(),
        { id: project.id, resourceId: created.resource.id },
        { store, dataDir } as AppDeps,
      ),
      /injected response send failure/,
    );

    const [revision] = store.workspace.listResourceRevisions(project.id, created.resource.id);
    assert.ok(revision);
    const exact = await fetch(
      `${base}/api/projects/${project.id}/resources/${created.resource.id}/revisions/${revision.id}`,
    );
    const exactBody = await exact.text();
    assert.equal(exact.status, 200, exactBody);
    assert.equal((JSON.parse(exactBody) as { content: { text: string } }).content.text, "committed immutable candidate");
  });
});
