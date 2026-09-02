import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "@dezin/agent";
import { Store } from "@dezin/core";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { createDesignProject } from "../src/design/design-project-store.ts";
import {
  DESIGN_EXPORT_TYPESCRIPT_VERSION,
  DESIGN_EXPORT_VITE_VERSION,
} from "../src/design/design-global-agents.ts";
import {
  createDesignJob,
  getDesignJob,
  mutateDesignCanvas,
  updateDesignJob,
} from "../src/design/design-storage.ts";

async function waitForReadyJob(
  base: string,
  projectId: string,
  jobId: string,
  transport: typeof fetch = fetch,
): Promise<void> {
  let consecutiveTransportFailures = 0;
  let lastStatus = "missing";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await transport(`${base}/api/projects/${projectId}/design-canvas/jobs`);
      consecutiveTransportFailures = 0;
    } catch (error) {
      consecutiveTransportFailures += 1;
      if (consecutiveTransportFailures >= 50) {
        throw new Error(`Job ${jobId} polling lost its loopback transport`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    assert.equal(response.status, 200, `Job ${jobId} polling returned HTTP ${response.status}`);
    const jobs = await response.json() as Array<{
      id: string;
      status: string;
      error: string | null;
    }>;
    const job = jobs.find((candidate) => candidate.id === jobId);
    lastStatus = job?.status ?? "missing";
    if (job?.status === "ready") return;
    if (job && ["failed", "cancelled", "superseded"].includes(job.status)) {
      assert.fail(`Job ${jobId} became ${job.status}: ${job.error ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Job ${jobId} did not become ready within 30 seconds (last status: ${lastStatus})`);
}

test("Job HTTP polling tolerates one transient loopback transport reset", async () => {
  let calls = 0;
  const transport = async (): Promise<Response> => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    return Response.json([{ id: "job-ready", status: "ready", error: null }]);
  };

  await waitForReadyJob("http://unused.invalid", "project", "job-ready", transport as typeof fetch);
  assert.equal(calls, 2);
});

test("current Project HTTP is minimal and retired Design architecture stays unregistered", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-current-http-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const server = createApp({
    store,
    dataDir,
    webDir: join(dataDir, "no-web-build"),
    runtimeSupervisor,
    agentProber: async () => ({ available: false }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  try {
    const rejectedLegacyCreate = await request("/api/projects", "POST", {
      name: "Legacy-shaped project",
      skillId: "frontend-design",
    });
    assert.equal(rejectedLegacyCreate.status, 400);
    assert.match(await rejectedLegacyCreate.text(), /unexpected field: skillId/i);

    const createdResponse = await request("/api/projects", "POST", { name: "Blank canvas" });
    assert.equal(createdResponse.status, 201);
    const project = await createdResponse.json() as Record<string, unknown>;
    assert.equal(project.name, "Blank canvas");
    for (const retiredField of ["skillId", "designSystemId", "mode"]) {
      assert.equal(Object.hasOwn(project, retiredField), false);
    }

    const listed = await (await request("/api/projects")).json() as Array<Record<string, unknown>>;
    assert.deepEqual(listed.map((candidate) => candidate.id), [project.id]);

    const renamed = await request(`/api/projects/${project.id as string}`, "PATCH", { name: "Renamed canvas" });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { name: string }).name, "Renamed canvas");
    const rejectedLegacyPatch = await request(`/api/projects/${project.id as string}`, "PATCH", { mode: "standard" });
    assert.equal(rejectedLegacyPatch.status, 400);

    const id = project.id as string;
    const retiredRoutes: Array<[method: string, path: string, expected?: number]> = [
      ["GET", "/api/skills"],
      ["GET", `/api/projects/${id}/workspace`],
      ["GET", `/api/projects/${id}/workspace/proposals`],
      ["GET", `/api/projects/${id}/workspace/plans`],
      ["GET", `/api/projects/${id}/resources`],
      ["GET", `/api/projects/${id}/artifacts`],
      ["GET", `/api/projects/${id}/preview-targets/resolve`],
      ["GET", `/api/projects/${id}/devserver`],
      ["GET", `/api/projects/${id}/conversations`],
      ["POST", "/api/runs"],
      ["GET", `/api/projects/${id}/research`],
      ["GET", `/api/projects/${id}/variants`],
      ["GET", `/api/projects/${id}/versions/old-run`],
      ["GET", `/api/projects/${id}/refs/old.png`],
      ["GET", `/api/projects/${id}/export`],
      // The generic /api/projects/:id matcher owns this literal path for other
      // methods, so removal is expressed as Method Not Allowed rather than import.
      ["POST", "/api/projects/import", 405],
      ["POST", `/api/projects/${id}/cover/capture`],
      ["GET", `/projects/${id}/preview/index.html`],
    ];
    for (const [method, path, expected = 404] of retiredRoutes) {
      const response = await request(path, method);
      assert.equal(response.status, expected, `${method} ${path} must stay unregistered`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtimeSupervisor.shutdown(Date.now() + 2_000);
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ordinary Design Project identity comes from its filesystem manifest", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-project-authority-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const server = createApp({
    store,
    dataDir,
    webDir: join(dataDir, "no-web-build"),
    runtimeSupervisor,
    agentProber: async () => ({ available: false }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const request = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Filesystem authority" }),
    });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };

    store.deleteProject(project.id);
    assert.equal((await request(`/api/projects/${project.id}`)).status, 200);

    assert.throws(
      () => (store.createProject as (input: unknown) => unknown)({ name: "SQLite ghost" }),
      /Sharingan Projects only/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtimeSupervisor.shutdown(Date.now() + 2_000);
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ordinary Design Project CRUD and title never create or expose a legacy SQLite identity", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-project-crud-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  let titleInput: Record<string, unknown> | null = null;
  const server = createApp({
    store,
    dataDir,
    webDir: join(dataDir, "no-web-build"),
    runtimeSupervisor,
    agentProber: async () => ({ available: false }),
    titleGenerator: async (input) => {
      titleInput = input as unknown as Record<string, unknown>;
      return "Filesystem title";
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  try {
    const created = await request("/api/projects", "POST", { name: "Temporary name" });
    assert.equal(created.status, 201);
    const project = await created.json() as Record<string, unknown>;
    const projectId = project.id as string;
    assert.equal(store.getProject(projectId), null);
    assert.match(
      project.coverUrl as string,
      new RegExp(`^/api/projects/${projectId}/design-canvas/cover\\?v=\\d+$`),
    );
    const cover = await request(project.coverUrl as string);
    assert.equal(cover.status, 200);
    assert.match(cover.headers.get("content-type") ?? "", /^image\/svg\+xml/);
    assert.match(await cover.text(), /Temporary name/);

    const listed = await (await request("/api/projects")).json() as Array<Record<string, unknown>>;
    assert.deepEqual(listed.map((candidate) => candidate.id), [projectId]);
    assert.equal(listed[0]?.coverUrl, project.coverUrl);

    const patched = await request(`/api/projects/${projectId}`, "PATCH", { name: "Renamed", archived: true });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { name: string; archivedAt: number | null }).name, "Renamed");

    const titled = await request(`/api/projects/${projectId}/title`, "POST", {
      brief: "A focused brief",
      agentCommand: "codebuddy",
      model: "hy4-preview-ioa",
    });
    assert.equal(titled.status, 200);
    const titlePayload = await titled.json() as Record<string, unknown>;
    assert.equal(titlePayload.name, "Filesystem title");
    assert.deepEqual(titleInput, {
      projectId,
      brief: "A focused brief",
      currentName: "Renamed",
      agentCommand: "codebuddy",
      model: "hy4-preview-ioa",
    });
    for (const retiredField of ["skillId", "designSystemId", "mode"]) {
      assert.equal(Object.hasOwn(titlePayload, retiredField), false);
    }
    assert.equal(store.getProject(projectId), null);

    assert.equal((await request(`/api/projects/${projectId}`, "DELETE")).status, 204);
    assert.equal((await request(`/api/projects/${projectId}`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtimeSupervisor.shutdown(Date.now() + 2_000);
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("daemon restart recovery discovers filesystem-only Design Projects", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-project-recovery-"));
  const store = new Store(":memory:");
  const project = await createDesignProject(dataDir, { name: "Recover me" });
  await mutateDesignCanvas(dataDir, project.projectId, {
    expectedRevision: 0,
    intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
  });
  const created = await createDesignJob(dataDir, project.projectId, {
    kind: "node-generation",
    runnerId: "http-recovery-fixture",
    model: null,
    nodeId: "node-page",
  });
  await updateDesignJob(dataDir, project.projectId, created.job.id, { status: "running" });
  assert.deepEqual(store.listProjects(), []);

  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const server = createApp({
    store,
    dataDir,
    webDir: join(dataDir, "no-web-build"),
    runtimeSupervisor,
    agentProber: async () => ({ available: false }),
  });
  try {
    let job = await getDesignJob(dataDir, project.projectId, created.job.id);
    for (let attempt = 0; attempt < 100 && job.status !== "cancelled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await getDesignJob(dataDir, project.projectId, created.job.id);
    }
    assert.equal(job.status, "cancelled");
    assert.match(job.error ?? "", /restart|interrupted/i);
  } finally {
    await runtimeSupervisor.shutdown(Date.now() + 2_000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("filesystem-only Design Projects run Main Agent, Node Agent, and Implementation Export", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-project-agents-"));
  const store = new Store(":memory:");
  const runner: AgentRunner = {
    id: "filesystem-authority-runner",
    async runTurn(input) {
      if (input.systemPrompt.includes("Main Agent for one Design Canvas")) {
        const plan = JSON.stringify({ reply: "Canvas reviewed.", canvasIntents: [], dispatches: [] });
        await writeFile(join(input.projectDir, "main-agent-plan.json"), plan);
        return {
          text: plan,
          artifactHtml: "<!doctype html><html><head></head><body>Main Agent orchestration turn</body></html>",
          artifactPath: "index.html",
        };
      }
      if (input.systemPrompt.includes("Reimplement the exact selected Design Canvas Versions")) {
        const packageJson = {
          name: "filesystem-authority-export",
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          devDependencies: { typescript: DESIGN_EXPORT_TYPESCRIPT_VERSION, vite: DESIGN_EXPORT_VITE_VERSION },
        };
        const index = "<!doctype html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Export</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>";
        await mkdir(join(input.projectDir, "src"), { recursive: true });
        await Promise.all([
          writeFile(join(input.projectDir, "package.json"), `${JSON.stringify(packageJson)}\n`),
          writeFile(join(input.projectDir, "index.html"), index),
          writeFile(join(input.projectDir, "src", "main.ts"), "import './styles.css';\nconst app = document.querySelector<HTMLDivElement>('#app');\nif (!app) throw new Error('Missing app');\nconst nodeId = new URLSearchParams(window.location.search).get('dezin-node');\nif (nodeId !== null && nodeId !== 'node-page') throw new Error('Unknown route');\nconst page = document.createElement('main');\npage.dataset.dezinExportNodeId = 'node-page';\npage.textContent = 'Filesystem Node';\napp.append(page);\n"),
          writeFile(join(input.projectDir, "src", "styles.css"), "body { margin: 0; }\n"),
        ]);
        return { text: "Fresh implementation complete", artifactHtml: index, artifactPath: "index.html" };
      }
      const html = "<!doctype html><html><head><title>Filesystem Node</title><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{margin:0}</style></head><body><main>Filesystem Node</main></body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "Node generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const server = createApp({
    store,
    dataDir,
    webDir: join(dataDir, "no-web-build"),
    runtimeSupervisor,
    agentProber: async () => ({ available: false }),
    designRunner: runner,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  try {
    const created = await json("/api/projects", "POST", { name: "No SQLite Agent project" });
    assert.equal(created.status, 201);
    const projectId = ((await created.json()) as { id: string }).id;
    assert.equal(store.getProject(projectId), null);
    store.deleteProject(projectId);

    assert.equal((await json(`/api/projects/${projectId}/design-canvas`, "PUT", {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    })).status, 200);

    const mainResponse = await json(`/api/projects/${projectId}/design-canvas/agent/turns`, "POST", {
      message: "Review the canvas",
    });
    assert.equal(mainResponse.status, 202);
    await waitForReadyJob(base, projectId, ((await mainResponse.json()) as { job: { id: string } }).job.id);

    const nodeResponse = await json(`/api/projects/${projectId}/design-canvas/nodes/node-page/agent/turns`, "POST", {
      message: "Generate this page",
    });
    assert.equal(nodeResponse.status, 202);
    await waitForReadyJob(base, projectId, ((await nodeResponse.json()) as { job: { id: string } }).job.id);

    const canvas = await (await json(`/api/projects/${projectId}/design-canvas`)).json() as { revision: number };
    const exportResponse = await json(`/api/projects/${projectId}/design-canvas/exports`, "POST", {
      canvasRevision: canvas.revision,
    });
    assert.equal(exportResponse.status, 202);
    await waitForReadyJob(base, projectId, ((await exportResponse.json()) as { job: { id: string } }).job.id);
    assert.equal((await json(`/api/projects/${projectId}`)).status, 200);
    assert.deepEqual(store.listProjects(), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtimeSupervisor.shutdown(Date.now() + 2_000);
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
