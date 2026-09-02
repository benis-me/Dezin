import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "@dezin/core";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { createDesignProject } from "../src/design/design-project-store.ts";
import { getDesignCanvas } from "../src/design/design-storage.ts";
import { importFigmaDesignProject } from "../src/design/figma-import.ts";
import type { FigmaRestClient } from "../src/design/figma-rest-client.ts";

function figmaClient(calls: string[]): FigmaRestClient {
  return {
    async getMetadata() {
      calls.push("metadata");
      return {
        file: { key: "AbC123xyZ", name: "Product System", version: "42", editorType: "figma" },
        mainFileKey: "AbC123xyZ",
      };
    },
    async getFileVersion(input) {
      calls.push(`file:${input.version}`);
      return {
        version: input.version,
        name: "Product System",
        role: "viewer",
        editorType: "figma",
        linkAccess: "view",
        lastModified: "2026-08-11T00:00:00Z",
        document: { id: "0:0", name: "Product System", type: "DOCUMENT", children: [] },
        components: {},
        componentSets: {},
        styles: {},
      };
    },
    async getLocalVariables() {
      calls.push("variables");
      return { kind: "unavailable", status: 403, reason: "Variables require Enterprise access." };
    },
  };
}

async function assertNoSecretOutsideStore(dataDir: string, token: string): Promise<void> {
  for (const entry of await readdir(dataDir, { recursive: true })) {
    const path = join(dataDir, String(entry));
    if (!(await stat(path)).isFile() || path === join(dataDir, "secrets", "figma-pat.json")) continue;
    assert.equal((await readFile(path)).includes(Buffer.from(token)), false, `credential leaked into ${path}`);
  }
}

test("Figma HTTP stores a non-echoed PAT and imports exact artifacts at a Canvas anchor with replay semantics", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-http-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const acquireProjectLease = runtimeSupervisor.acquireOperationLease.bind(runtimeSupervisor);
  const leasedProjectIds: string[] = [];
  runtimeSupervisor.acquireOperationLease = (scope) => {
    leasedProjectIds.push(scope.projectId);
    return acquireProjectLease(scope);
  };
  const calls: string[] = [];
  const server = createApp({ dataDir, store, runtimeSupervisor, figmaClient: figmaClient(calls) });
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const json = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

  const empty = await json("/api/figma/credential");
  assert.equal(empty.status, 200, await empty.clone().text());
  assert.deepEqual(await empty.json(), { configured: false, source: null });

  const invalid = await json("/api/figma/credential", "PUT", {
    token: "figd_private_token_0123456789",
    unexpected: true,
  });
  assert.equal(invalid.status, 400, await invalid.clone().text());

  const token = "figd_private_token_0123456789";
  const stored = await json("/api/figma/credential", "PUT", { token });
  assert.equal(stored.status, 200, await stored.clone().text());
  const storedText = await stored.text();
  assert.equal(storedText.includes(token), false);
  assert.deepEqual(JSON.parse(storedText), { configured: true, source: "local" });

  const project = await createDesignProject(dataDir, { name: "Existing canvas" });
  const input = {
    schemaVersion: 1,
    idempotencyKey: "figma-http-import-1",
    url: "https://www.figma.com/design/AbC123xyZ/Product-System",
    depth: 4,
    anchor: { x: 180, y: -240 },
    rightsAcknowledged: true,
  };
  const importPath = `/api/projects/${project.projectId}/design-canvas/imports/figma`;
  const firstResponse = await json(importPath, "POST", input);
  assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
  const first = await firstResponse.json() as {
    canvas: {
      projectId: string;
      revision: number;
      viewport: unknown;
      nodes: Array<{ name: string; geometry: unknown }>;
    };
    import: {
      reused: boolean;
      manifest: { projectId: string; importId: string; canvasRevision: number };
    };
  };
  assert.deepEqual(Object.keys(first).sort(), ["canvas", "import"]);
  assert.equal(first.import.reused, false);
  assert.equal(first.canvas.projectId, project.projectId);
  assert.equal(first.import.manifest.projectId, project.projectId);
  assert.deepEqual((await getDesignCanvas(dataDir, project.projectId)).nodes.map((node) => node.name), [
    "Design.md", "tokens.json", "components.json", "layout.json",
  ]);
  assert.deepEqual((await getDesignCanvas(dataDir, project.projectId)).nodes.map((node) => node.geometry), [
    { x: 180, y: -240, width: 420, height: 560 },
    { x: 640, y: -240, width: 420, height: 560 },
    { x: 1_100, y: -240, width: 420, height: 560 },
    { x: 1_560, y: -240, width: 420, height: 560 },
  ]);
  assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);
  assert.deepEqual(leasedProjectIds, [project.projectId]);

  await assertNoSecretOutsideStore(dataDir, token);

  const changedCanvasResponse = await json(`/api/projects/${project.projectId}/design-canvas`, "PUT", {
    expectedRevision: first.canvas.revision,
    intents: [{ type: "set-viewport", viewport: { x: 33, y: -44, zoom: 1.25 } }],
  });
  assert.equal(changedCanvasResponse.status, 200, await changedCanvasResponse.clone().text());
  const changedCanvas = await changedCanvasResponse.json() as { revision: number; viewport: unknown };

  const replayResponse = await json(importPath, "POST", input);
  assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
  const replay = await replayResponse.json() as typeof first;
  assert.equal(replay.import.reused, true);
  assert.equal(replay.canvas.projectId, project.projectId);
  assert.equal(replay.canvas.revision, changedCanvas.revision);
  assert.deepEqual(replay.canvas.viewport, changedCanvas.viewport);
  assert.equal(replay.import.manifest.importId, first.import.manifest.importId);
  assert.equal(replay.import.manifest.canvasRevision, first.canvas.revision);
  assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);

  const conflict = await json(importPath, "POST", { ...input, depth: 5 });
  assert.equal(conflict.status, 409, await conflict.clone().text());
  const anchorConflict = await json(importPath, "POST", {
    ...input,
    anchor: { x: input.anchor.x + 1, y: input.anchor.y },
  });
  assert.equal(anchorConflict.status, 409, await anchorConflict.clone().text());
  assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);
  assert.equal(leasedProjectIds.length, 5, "each Canvas operation owns exactly one Project lease");
  assert.deepEqual([...new Set(leasedProjectIds)], [project.projectId]);

  const secretBytes = await readFile(join(dataDir, "secrets", "figma-pat.json"), "utf8");
  assert.equal(secretBytes.includes(token), true);
  const forgotten = await json("/api/figma/credential", "DELETE");
  assert.equal(forgotten.status, 200, await forgotten.clone().text());
  assert.deepEqual(await forgotten.json(), { configured: false, source: null });
});

test("Figma Canvas import rejects a missing target before credential, network, or receipt side effects", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-http-missing-target-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  let credentialCalls = 0;
  let remoteCalls = 0;
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    figmaClient: {
      async getMetadata() { remoteCalls += 1; throw new Error("must not fetch"); },
      async getFileVersion() { remoteCalls += 1; throw new Error("must not fetch"); },
      async getLocalVariables() { remoteCalls += 1; throw new Error("must not fetch"); },
    },
    figmaCredentialProvider: async () => {
      credentialCalls += 1;
      throw new Error("must not resolve credential");
    },
  });
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const missingProjectId = "00000000-0000-4000-8000-000000000000";
  const response = await fetch(
    `http://127.0.0.1:${port}/api/projects/${missingProjectId}/design-canvas/imports/figma`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "figma-http-missing-target-1",
        url: "https://www.figma.com/design/AbC123xyZ/Product-System",
        anchor: { x: 0, y: 0 },
        rightsAcknowledged: true,
      }),
    },
  );
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(credentialCalls, 0);
  assert.equal(remoteCalls, 0);
  await assert.rejects(stat(join(dataDir, "projects", missingProjectId)), { code: "ENOENT" });
  await assert.rejects(stat(join(dataDir, "figma-import-jobs")), { code: "ENOENT" });
});

test("daemon startup rolls a staged Figma receipt forward before exposing Projects without PAT or network access", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-http-startup-recovery-"));
  const project = await createDesignProject(dataDir, { name: "Startup Figma target" });
  const stagedCalls: string[] = [];
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    projectId: project.projectId,
    input: {
      schemaVersion: 1,
      idempotencyKey: "figma-http-startup-recovery-1",
      url: "https://www.figma.com/design/AbC123xyZ/Product-System",
      anchor: { x: -320, y: 640 },
      rightsAcknowledged: true,
    },
    client: figmaClient(stagedCalls),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    testHooks: {
      simulateProcessCrash: true,
      afterSnapshotRename: () => { throw new Error("daemon restart after snapshot"); },
    },
  }), /daemon restart after snapshot/);

  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  let forbiddenCalls = 0;
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    figmaClient: {
      async getMetadata() { forbiddenCalls += 1; throw new Error("startup must remain offline"); },
      async getFileVersion() { forbiddenCalls += 1; throw new Error("startup must remain offline"); },
      async getLocalVariables() { forbiddenCalls += 1; throw new Error("startup must remain offline"); },
    },
    figmaCredentialProvider: async () => {
      forbiddenCalls += 1;
      throw new Error("startup must not resolve PAT");
    },
  });
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
  assert.equal(response.status, 200, await response.clone().text());
  const projects = await response.json() as Array<{ id: string }>;
  assert.equal(projects.length, 1);
  assert.equal((await getDesignCanvas(dataDir, projects[0]!.id)).nodes.length, 4);
  assert.equal(forbiddenCalls, 0);
  assert.deepEqual(stagedCalls, ["metadata", "file:42", "variables", "metadata"]);
});

test("Figma HTTP rejects token-bearing imports before remote or filesystem side effects", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-http-invalid-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const project = await createDesignProject(dataDir, { name: "Invalid Figma target" });
  const token = "figd_private_token_0123456789";
  let credentialCalls = 0;
  let remoteCalls = 0;
  const client: FigmaRestClient = {
    async getMetadata() { remoteCalls += 1; throw new Error("must not fetch"); },
    async getFileVersion() { remoteCalls += 1; throw new Error("must not fetch"); },
    async getLocalVariables() { remoteCalls += 1; throw new Error("must not fetch"); },
  };
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    figmaClient: client,
    figmaCredentialProvider: async () => {
      credentialCalls += 1;
      return {
        token,
        mode: "personal-access-token",
        source: "environment",
        subject: "pat-0123456789abcdef",
      };
    },
  });
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const importUrl = `http://127.0.0.1:${port}/api/projects/${project.projectId}/design-canvas/imports/figma`;
  const removedHomeRoute = await fetch(`http://127.0.0.1:${port}/api/projects/imports/figma`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "removed-home-route",
      url: "https://www.figma.com/design/AbC123xyZ/Product-System",
      anchor: { x: 0, y: 0 },
      rightsAcknowledged: true,
    }),
  });
  assert.equal(removedHomeRoute.status, 404, await removedHomeRoute.clone().text());
  const response = await fetch(importUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "figma-http-invalid-1",
      url: "https://www.figma.com/design/AbC123xyZ/Product-System",
      anchor: { x: 0, y: 0 },
      rightsAcknowledged: true,
      token,
    }),
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(credentialCalls, 0);
  assert.equal(remoteCalls, 0);

  const projectBodyResponse = await fetch(importUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "figma-http-project-body-1",
      projectId: "other-project",
      url: "https://www.figma.com/design/AbC123xyZ/Product-System",
      anchor: { x: 0, y: 0 },
      rightsAcknowledged: true,
    }),
  });
  assert.equal(projectBodyResponse.status, 400, await projectBodyResponse.clone().text());
  assert.equal(credentialCalls, 0);
  assert.equal(remoteCalls, 0);

  const canaryResponse = await fetch(importUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "figma-http-request-canary-1",
      url: "https://www.figma.com/design/AbC123xyZ/Product-System",
      name: token,
      anchor: { x: 0, y: 0 },
      rightsAcknowledged: true,
    }),
  });
  assert.equal(canaryResponse.status, 400, await canaryResponse.clone().text());
  const responseText = await canaryResponse.text();
  assert.equal(responseText.includes(token), false);
  assert.equal(credentialCalls, 0);
  assert.equal(remoteCalls, 0);
  await assertNoSecretOutsideStore(dataDir, token);
});

test("Figma HTTP never echoes or persists a PAT hidden in hostile upstream labels", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-http-secret-error-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const project = await createDesignProject(dataDir, { name: "Hostile response target" });
  const token = "figd_private_token_0123456789";
  const encoded = Buffer.from(token).toString("base64");
  const client: FigmaRestClient = {
    async getMetadata() { return { file: { version: "42" } }; },
    async getFileVersion() {
      return {
        version: "42",
        name: "Hostile",
        editorType: "figma",
        document: { id: "0:0", name: "Hostile", type: "DOCUMENT", children: [] },
        components: { [token]: 1 },
        componentSets: {},
        styles: {},
      };
    },
    async getLocalVariables() {
      return { kind: "available", body: { meta: { variableCollections: {}, variables: {} } } };
    },
  };
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    figmaClient: client,
    figmaCredentialProvider: async () => ({
      token,
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
  });
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(
    `http://127.0.0.1:${port}/api/projects/${project.projectId}/design-canvas/imports/figma`,
    {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "figma-http-secret-error-1",
      url: "https://www.figma.com/design/AbC123xyZ/Product-System",
      anchor: { x: 0, y: 0 },
      rightsAcknowledged: true,
    }),
    },
  );
  assert.equal(response.status, 502);
  const responseText = await response.text();
  assert.equal(responseText, JSON.stringify({ error: "Figma response could not be normalized safely" }));
  assert.equal(responseText.includes(token), false);
  assert.equal(responseText.includes(encoded), false);
  await assertNoSecretOutsideStore(dataDir, token);
  await assertNoSecretOutsideStore(dataDir, encoded);
});

test("Figma HTTP waits for startup recovery, enforces daemon auth, and propagates request cancellation", { timeout: 5_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-http-lifecycle-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const project = await createDesignProject(dataDir, { name: "Lifecycle Figma target" });
  let releaseRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  let metadataCalls = 0;
  let requestAborted = false;
  let markMetadataStarted!: () => void;
  const metadataStarted = new Promise<void>((resolve) => { markMetadataStarted = resolve; });
  const client: FigmaRestClient = {
    async getMetadata(input) {
      metadataCalls += 1;
      markMetadataStarted();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          requestAborted = true;
          reject(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
      });
      throw new Error("unreachable");
    },
    async getFileVersion() { throw new Error("must not reach file fetch"); },
    async getLocalVariables() { throw new Error("must not reach variables fetch"); },
  };
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    designStartupRecovery: () => recovery,
    security: { token: "daemon-secret" },
    figmaClient: client,
    figmaCredentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "environment",
      subject: "pat-0123456789abcdef",
    }),
  });
  t.after(async () => {
    releaseRecovery();
    await runtimeSupervisor.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/api/projects/${project.projectId}/design-canvas/imports/figma`;
  const body = JSON.stringify({
    schemaVersion: 1,
    idempotencyKey: "figma-http-lifecycle-1",
    url: "https://www.figma.com/design/AbC123xyZ/Product-System",
    anchor: { x: 0, y: 0 },
    rightsAcknowledged: true,
  });

  const unauthorized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(unauthorized.status, 401, await unauthorized.clone().text());

  const controller = new AbortController();
  const pending = fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dezin-daemon-token": "daemon-secret" },
    body,
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(metadataCalls, 0, "the import route must wait for Design startup recovery");
  releaseRecovery();
  await Promise.race([
    metadataStarted,
    pending.then(async (response) => {
      throw new Error(`import returned before metadata: ${response.status} ${await response.text()}`);
    }),
  ]);
  assert.equal(metadataCalls, 1);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  for (let attempt = 0; attempt < 200 && !requestAborted; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(requestAborted, true);
});

test("Figma HTTP keeps the Project lease through response projection before concurrent DELETE completes", { timeout: 10_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-http-delete-race-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const project = await createDesignProject(dataDir, { name: "Delete-race Figma target" });
  let releaseProjection!: () => void;
  const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
  let markProjectionEntered!: (projectId: string) => void;
  const projectionEntered = new Promise<string>((resolve) => { markProjectionEntered = resolve; });
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    figmaClient: figmaClient([]),
    figmaCredentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "environment",
      subject: "pat-0123456789abcdef",
    }),
    beforeFigmaProjectResponse: async (projectId) => {
      markProjectionEntered(projectId);
      await projectionGate;
    },
  });
  t.after(async () => {
    releaseProjection();
    await runtimeSupervisor.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const importing = fetch(`${base}/api/projects/${project.projectId}/design-canvas/imports/figma`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "figma-http-delete-race-1",
      url: "https://www.figma.com/design/AbC123xyZ/Product-System",
      anchor: { x: 0, y: 0 },
      rightsAcknowledged: true,
    }),
  });
  const projectId = await Promise.race([
    projectionEntered,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("response projection hook was not reached")), 5_000)),
  ]);
  let deletionSettled = false;
  const deleting = fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" }).then((response) => {
    deletionSettled = true;
    return response;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(deletionSettled, false, "DELETE must wait while the import response is projected");
  releaseProjection();
  const importResponse = await importing;
  assert.equal(importResponse.status, 201, await importResponse.clone().text());
  const deleteResponse = await deleting;
  assert.equal(deleteResponse.status, 204, await deleteResponse.clone().text());
});
