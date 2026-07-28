import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor, type AppDeps } from "../src/app.ts";
import {
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
} from "../src/resource-revision-payload.ts";
import {
  buildRenderAssembly,
  createRenderAssemblyMaterializer,
} from "../src/render-assembly.ts";
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
    assert.equal(
      (await listPayloadFiles(join(dataDir, "resource-revisions")))
        .some((path) => path.endsWith("materialization-intent.json")),
      false,
    );
  });
});

test("Standard project reference materialization exports meaningful immutable Artifact design content and exact source identity", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const sourceProject = store.createProject({ name: "Source design project", mode: "standard" });
    const sourceFoundation = store.workspace.ensureWorkspaceRecord(sourceProject.id);
    const artifactId = "source-reference-page";
    const trackId = "source-reference-track";
    const componentArtifactId = "source-reference-component";
    const componentTrackId = "source-reference-component-track";
    const graph = store.workspace.applyGraphCommands(sourceProject.id, {
      baseGraphRevision: sourceFoundation.graphRevision,
      expectedSnapshotId: sourceFoundation.activeSnapshotId,
      commands: [
        {
          id: "add-source-reference-page",
          type: "add-node",
          node: {
            id: "source-reference-page-node",
            kind: "page",
            name: "Editorial home",
            artifactId,
            createIdentity: { initialTrackId: trackId },
          },
        },
        {
          id: "add-source-reference-component",
          type: "add-node",
          node: {
            id: "source-reference-component-node",
            kind: "component",
            name: "Editorial feature card",
            artifactId: componentArtifactId,
            createIdentity: { initialTrackId: componentTrackId },
          },
        },
      ],
    });
    const sourceRepository = join(dataDir, "projects", sourceProject.id);
    const artifactRoot = store.workspace.getArtifact(artifactId)!.sourceRoot;
    const componentRoot = store.workspace.getArtifact(componentArtifactId)!.sourceRoot;
    await mkdir(join(sourceRepository, artifactRoot), { recursive: true });
    await writeFile(
      join(sourceRepository, artifactRoot, "index.html"),
      '<link rel="stylesheet" href="../../shared/tokens.css">\n'
        + '<main class="editorial-reference">EXACT_REFERENCE_BODY_CONTENT</main>\n',
      "utf8",
    );
    await writeFile(
      join(sourceRepository, artifactRoot, "styles.css"),
      ".editorial-reference { color: #c2410c; letter-spacing: 0.075em; }\n"
        + "/* EXACT_REFERENCE_CSS_CONTENT */\n",
      "utf8",
    );
    await mkdir(join(sourceRepository, componentRoot), { recursive: true });
    await writeFile(
      join(sourceRepository, componentRoot, "index.js"),
      "export const EXACT_SIBLING_COMPONENT_SOURCE = 'editorial-feature-card';\n",
      "utf8",
    );
    await mkdir(join(sourceRepository, "shared"), { recursive: true });
    await writeFile(
      join(sourceRepository, "shared", "tokens.css"),
      ":root { --exact-reference-accent: #c2410c; }\n/* EXACT_SHARED_SOURCE_CONTENT */\n",
      "utf8",
    );
    execFileSync("git", ["init", "-q"], { cwd: sourceRepository });
    execFileSync("git", ["config", "user.email", "dezin-test@example.invalid"], { cwd: sourceRepository });
    execFileSync("git", ["config", "user.name", "Dezin Test"], { cwd: sourceRepository });
    execFileSync("git", ["add", "--", artifactRoot, componentRoot, "shared"], { cwd: sourceRepository });
    execFileSync("git", ["commit", "-qm", "exact source design"], { cwd: sourceRepository });
    const sourceCommitHash = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepository,
      encoding: "utf8",
    }).trim();
    const sourceTreeHash = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: sourceRepository,
      encoding: "utf8",
    }).trim();
    const componentRevision = store.workspace.createArtifactRevision({
      artifactId: componentArtifactId,
      trackId: componentTrackId,
      parentRevisionId: null,
      sourceCommitHash,
      sourceTreeHash,
      kernelRevisionId: sourceFoundation.activeKernelRevisionId,
      renderSpec: {
        protocol: "dezin.render-spec.v1",
        entry: `${componentRoot}/index.js`,
        frames: [{
          id: "reference-component-default",
          name: "EXACT_SIBLING_COMPONENT_MARKER",
          width: 480,
          height: 320,
          initialState: "default",
          fixture: {
            protocol: "dezin-component-fixture-v1",
            variantKey: "default",
            stateKey: "default",
            props: {},
          },
        }],
      },
      quality: {
        state: "passed",
        score: 96,
        findings: [],
      },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    const componentSnapshot = store.workspace.publishArtifactRevision(componentRevision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: graph.snapshot.id,
    });
    const sourceRevision = store.workspace.createArtifactRevision({
      artifactId,
      trackId,
      parentRevisionId: null,
      sourceCommitHash,
      sourceTreeHash,
      kernelRevisionId: sourceFoundation.activeKernelRevisionId,
      renderSpec: {
        protocol: "dezin.render-spec.v1",
        entry: "artifacts/source-reference-page/index.html",
        frames: [{
          id: "reference-desktop",
          name: "EXACT_EDITORIAL_DESIGN_MARKER",
          width: 1_440,
          height: 900,
          initialState: "default",
        }],
      },
      quality: {
        state: "passed",
        score: 97,
        findings: [{
          severity: "info",
          code: "REFERENCE-DESIGN",
          message: "Meaningful immutable source design evidence",
        }],
      },
      contextPackHash: null,
      dependencies: [{
        instanceId: "source-reference-component-instance",
        componentArtifactId,
        componentRevisionId: componentRevision.id,
        createInstanceIdentity: true,
        sourceLocator: {
          designNodeId: "source-reference-component-instance-node",
          sourcePath: `${artifactRoot}/index.html`,
          selector: ".editorial-reference",
        },
        overrides: {},
        status: "linked",
      }],
      resourcePins: [],
    });
    const sourceSnapshot = store.workspace.publishArtifactRevision(sourceRevision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: componentSnapshot.id,
    });
    const futureGraph = store.workspace.applyGraphCommands(sourceProject.id, {
      baseGraphRevision: sourceSnapshot.graphRevision,
      expectedSnapshotId: sourceSnapshot.id,
      commands: [
        {
          id: "add-future-reference-page",
          type: "add-node",
          node: {
            id: "future-reference-page-node",
            kind: "page",
            name: "Future graph-only page",
            artifactId: "future-reference-page",
            createIdentity: { initialTrackId: "future-reference-page-track" },
          },
        },
        {
          id: "add-future-prototype-edge",
          type: "add-edge",
          edge: {
            id: "future-prototype-edge",
            workspaceId: sourceFoundation.id,
            kind: "prototype",
            sourceNodeId: "source-reference-page-node",
            targetNodeId: "future-reference-page-node",
          },
        },
      ],
    });
    assert.ok(futureGraph.graph.revision > sourceSnapshot.graphRevision);
    const sourceWorkspace = store.workspace.ensureWorkspaceRecord(sourceProject.id);
    const targetProject = store.createProject({ name: "Target design project", mode: "standard" });
    const targetResponse = await fetch(`${base}/api/projects/${targetProject.id}/workspace`);
    const target = await targetResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };

    const response = await fetch(`${base}/api/projects/${targetProject.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "file",
        title: sourceProject.name,
        defaultPinPolicy: "pin-current",
        baseGraphRevision: target.graph.revision,
        expectedSnapshotId: target.activeSnapshot.id,
        source: {
          type: "project-reference",
          sourceProjectId: sourceProject.id,
          sourceWorkspaceId: sourceWorkspace.id,
          sourceSnapshotId: sourceSnapshot.id,
          sourceArtifactId: artifactId,
          sourceArtifactRevisionId: sourceRevision.id,
        },
        reason: "Attach exact Standard Project design reference",
      }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 201, responseText);
    const result = JSON.parse(responseText) as {
      resource: { id: string };
      revision: {
        id: string;
        provenance: Record<string, unknown>;
        metadata: { mimeType: string };
      };
      graph: { revision: number };
      snapshot: { id: string };
    };
    assert.equal(result.revision.metadata.mimeType, "application/json");
    assert.equal(result.revision.provenance.sourceProjectId, sourceProject.id);
    assert.equal(result.revision.provenance.sourceWorkspaceId, sourceWorkspace.id);
    assert.equal(result.revision.provenance.sourceSnapshotId, sourceSnapshot.id);
    assert.equal(result.revision.provenance.sourceArtifactId, artifactId);
    assert.equal(result.revision.provenance.sourceArtifactRevisionId, sourceRevision.id);

    const descriptor = resolveResourceRevisionPayloadDescriptor({
      store,
      dataDir,
      workspaceId: store.workspace.ensureWorkspaceRecord(targetProject.id).id,
      resourceRevisionId: result.revision.id,
      expectedResourceId: result.resource.id,
    });
    const verifiedPath = join(dataDir, "verified-project-reference.json");
    await verifyResourceRevisionPayload(dataDir, descriptor, { destination: verifiedPath });
    const reference = JSON.parse(await readFile(verifiedPath, "utf8")) as {
      protocol: string;
      source: {
        project: { id: string };
        snapshotId: string;
        artifactId: string;
        artifactRevisionId: string;
      };
      design: {
        revision: { renderSpec: { frames: Array<{ name: string }> } };
        assembly: { assemblyHash: string; dependencyLockHash: string };
        graphNode: { id: string } | null;
        adjacentEdges: Array<{ id: string }>;
        adjacentNodes: Array<{ id: string }>;
        files: Array<{
          path: string;
          mimeType: string;
          byteLength: number;
          checksum: string;
          encoding: string;
          content: string;
        }>;
      };
    };
    assert.equal(reference.protocol, "dezin.project-reference-bundle.v1");
    assert.deepEqual(reference.source, {
      project: { id: sourceProject.id, name: sourceProject.name, mode: "standard" },
      workspaceId: sourceWorkspace.id,
      snapshotId: sourceSnapshot.id,
      artifactId,
      artifactRevisionId: sourceRevision.id,
    });
    assert.equal(reference.design.revision.renderSpec.frames[0]?.name, "EXACT_EDITORIAL_DESIGN_MARKER");
    assert.match(reference.design.assembly.assemblyHash, /^[a-f0-9]{64}$/);
    assert.match(reference.design.assembly.dependencyLockHash, /^[a-f0-9]{64}$/);
    assert.equal(reference.design.graphNode?.id, "source-reference-page-node");
    assert.equal(
      reference.design.adjacentEdges.some((edge) => edge.id === "future-prototype-edge"),
      false,
      "historical Project References must not read edges from the current graph",
    );
    assert.equal(
      reference.design.adjacentNodes.some((node) => node.id === "future-reference-page-node"),
      false,
      "historical Project References must not read nodes from the current graph",
    );
    assert.equal(
      reference.design.files.find((file) => file.path === `${artifactRoot}/index.html`)?.content,
      '<link rel="stylesheet" href="../../shared/tokens.css">\n'
        + '<main class="editorial-reference">EXACT_REFERENCE_BODY_CONTENT</main>\n',
    );
    assert.match(
      reference.design.files.find((file) => file.path === `${artifactRoot}/styles.css`)?.content ?? "",
      /EXACT_REFERENCE_CSS_CONTENT/,
    );
    assert.match(
      reference.design.files.find((file) => file.path === "shared/tokens.css")?.content ?? "",
      /EXACT_SHARED_SOURCE_CONTENT/,
    );
    assert.match(
      reference.design.files.find((file) => file.path === `${componentRoot}/index.js`)?.content ?? "",
      /EXACT_SIBLING_COMPONENT_SOURCE/,
    );

    // Installed dependencies are mutable runtime cache and must not perturb the
    // exact source bundle or its payload identity.
    const retainedSourceDir = await realpath(join(
      dataDir,
      "render-assemblies",
      sourceProject.id,
      reference.design.assembly.assemblyHash,
      "source",
    ));
    await mkdir(join(retainedSourceDir, "node_modules", "runtime-only"), { recursive: true });
    await writeFile(
      join(retainedSourceDir, "node_modules", "runtime-only", "cache.js"),
      "MUTABLE_RUNTIME_CACHE_SHOULD_NEVER_ENTER_REFERENCE\n",
      "utf8",
    );
    const reacquiredResponse = await fetch(`${base}/api/projects/${targetProject.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "file",
        title: `${sourceProject.name} reacquired`,
        defaultPinPolicy: "pin-current",
        baseGraphRevision: result.graph.revision,
        expectedSnapshotId: result.snapshot.id,
        source: {
          type: "project-reference",
          sourceProjectId: sourceProject.id,
          sourceWorkspaceId: sourceWorkspace.id,
          sourceSnapshotId: sourceSnapshot.id,
          sourceArtifactId: artifactId,
          sourceArtifactRevisionId: sourceRevision.id,
        },
        reason: "Reacquire the same exact Standard Project design reference",
      }),
    });
    const reacquiredText = await reacquiredResponse.text();
    assert.equal(reacquiredResponse.status, 201, reacquiredText);
    const reacquiredResult = JSON.parse(reacquiredText) as {
      resource: { id: string };
      revision: { id: string };
    };
    const reacquiredDescriptor = resolveResourceRevisionPayloadDescriptor({
      store,
      dataDir,
      workspaceId: store.workspace.ensureWorkspaceRecord(targetProject.id).id,
      resourceRevisionId: reacquiredResult.revision.id,
      expectedResourceId: reacquiredResult.resource.id,
    });
    const reacquiredPath = join(dataDir, "verified-project-reference-reacquired.json");
    await verifyResourceRevisionPayload(dataDir, reacquiredDescriptor, { destination: reacquiredPath });
    assert.deepEqual(await readFile(reacquiredPath), await readFile(verifiedPath));
    assert.doesNotMatch(await readFile(reacquiredPath, "utf8"), /MUTABLE_RUNTIME_CACHE_SHOULD_NEVER_ENTER_REFERENCE/);

    // A fresh materializer instance inventories the retained cache like a daemon
    // restart, still exposing the exact full source and exact Artifact cwd.
    const exactAssembly = buildRenderAssembly(
      store,
      { projectId: sourceProject.id, revisionId: sourceRevision.id },
      { dataDir, shallowSnapshotId: sourceSnapshot.id },
    );
    const restartedMaterializer = createRenderAssemblyMaterializer({
      idleTtlMs: Number.POSITIVE_INFINITY,
    });
    const restartedLease = await restartedMaterializer.acquire({ dataDir }, exactAssembly);
    const exactArtifactDir = restartedLease.artifactDir;
    assert.equal(restartedLease.assemblyRootDir, dirname(restartedLease.sourceDir));
    assert.equal(restartedLease.sourceDir, retainedSourceDir);
    assert.equal(restartedLease.artifactDir, join(retainedSourceDir, artifactRoot));
    assert.match(
      await readFile(join(restartedLease.sourceDir, "shared", "tokens.css"), "utf8"),
      /EXACT_SHARED_SOURCE_CONTENT/,
    );
    await restartedLease.release();

    // Verified-idle entries are ownership metadata only; every new lease must
    // revalidate the full fingerprint and reject local tampering.
    await writeFile(
      join(exactArtifactDir, "index.html"),
      "<main>TAMPERED_RETAINED_ASSEMBLY</main>\n",
      "utf8",
    );
    await assert.rejects(
      restartedMaterializer.acquire({ dataDir }, exactAssembly),
      /cached RenderAssembly source changed after materialization/,
    );
    await restartedMaterializer.dispose();
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
    const request = {
      kind: "file",
      title: "Committed brief",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: ready.activeSnapshot.id,
      source: { type: "uploaded-file", uploadedFileId: ".refs/committed.txt" },
      reason: "Publish before the HTTP reply is lost",
      idempotencyKey: "home-attachment:.refs/committed.txt",
    };

    await assert.rejects(
      handleMaterializeResource(
        jsonRequest(request),
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

    const replay = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const replayText = await replay.text();
    assert.equal(replay.status, 200, replayText);
    const replayBody = JSON.parse(replayText) as {
      resource: { id: string };
      revision: { id: string };
      graph: { nodes: Array<{ kind: string; resourceId?: string }> };
    };
    assert.equal(replayBody.resource.id, resource.id);
    assert.equal(replayBody.revision.id, revision.id);
    assert.equal(
      replayBody.graph.nodes.filter((node) => node.kind === "resource" && node.resourceId === resource.id).length,
      1,
    );
    assert.equal(store.workspace.listResources(project.id).length, 1);
    assert.equal(store.workspace.listResourceRevisions(project.id, resource.id).length, 1);

    const conflict = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, title: "Conflicting title" }),
    });
    assert.equal(conflict.status, 409, await conflict.text());

    const exact = await fetch(
      `${base}/api/projects/${project.id}/resources/${resource.id}/revisions/${revision.id}`,
    );
    const exactBody = await exact.text();
    assert.equal(exact.status, 200, exactBody);
    assert.equal((JSON.parse(exactBody) as { content: { text: string } }).content.text, "committed immutable attachment");
  });
});

test("Resource materialization replay fails closed when its committed immutable payload is missing", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Missing replay payload", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    const refsDir = join(dataDir, "projects", project.id, ".refs");
    await mkdir(refsDir, { recursive: true });
    await writeFile(join(refsDir, "missing.txt"), "payload removed after commit", "utf8");
    const request = {
      kind: "file",
      title: "Missing payload",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: ready.activeSnapshot.id,
      source: { type: "uploaded-file", uploadedFileId: ".refs/missing.txt" },
      reason: "Replay must prove the immutable payload still exists",
      idempotencyKey: "home-attachment:.refs/missing.txt",
    };

    const created = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const createdBody = JSON.parse(createdText) as {
      revision: { manifestPath: string };
    };
    await rm(join(dataDir, dirname(createdBody.revision.manifestPath)), {
      recursive: true,
      force: true,
    });

    const replay = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(replay.status, 500, await replay.text());
  });
});

test("Resource materialization replay reports a corrupt durable receipt as server integrity failure", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Corrupt replay receipt", mode: "standard" });
    const readyResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    const refsDir = join(dataDir, "projects", project.id, ".refs");
    await mkdir(refsDir, { recursive: true });
    await writeFile(join(refsDir, "corrupt.txt"), "receipt result must remain immutable", "utf8");
    const request = {
      kind: "file",
      title: "Corrupt receipt",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: ready.activeSnapshot.id,
      source: { type: "uploaded-file", uploadedFileId: ".refs/corrupt.txt" },
      reason: "Replay must reject corrupt durable result JSON",
      idempotencyKey: "home-attachment:.refs/corrupt.txt",
    };

    const created = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(created.status, 201, await created.text());
    store.db.exec("DROP TRIGGER resource_materialization_receipt_update_immutable");
    store.db.prepare(
      "UPDATE resource_materialization_receipts SET result_json = '{}' WHERE idempotency_key = ?",
    ).run(request.idempotencyKey);

    const replay = await fetch(`${base}/api/projects/${project.id}/resources/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(replay.status, 500, await replay.text());
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
