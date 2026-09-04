import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";
import test from "node:test";
import { Store } from "@dezin/core";
import { AgentTurnError, type AgentRunner } from "@dezin/agent";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import {
  buildDesignMainSystemPrompt,
  DESIGN_EXPORT_TYPESCRIPT_VERSION,
  DESIGN_EXPORT_VITE_VERSION,
  startDesignMainTurn,
} from "../src/design/design-global-agents.ts";
import { trustedDesignPreviewOrigin } from "../src/design/design-http-handler.ts";
import { bootstrapDesignProject } from "../src/design/design-project-bootstrap.ts";
import { ensureDesignProjectAtId } from "../src/design/design-project-store.ts";
import { findDesignExportChrome } from "../src/design/design-export-visual-gate.ts";
import { rewriteDesignHtmlUrlReferences } from "../src/design/design-portable-html.ts";
import {
  getDesignCanvas,
  getDesignJob,
  initializeDesignProject,
  listDesignJobs,
  publishDesignVersion,
} from "../src/design/design-storage.ts";

test("failed Design Jobs expose one idempotent server-authoritative retry route", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-job-retry-"));
  const store = new Store(":memory:");
  store.updateSettings({
    agentCommand: "claude",
    model: "settings-claude-model",
    apiKey: "settings-claude-secret",
  });
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  let calls = 0;
  const messageCalls = new Map<string, number>();
  const designRunner: AgentRunner = {
    id: "codebuddy",
    async runTurn(input) {
      calls += 1;
      const messageCall = (messageCalls.get(input.message) ?? 0) + 1;
      messageCalls.set(input.message, messageCall);
      if (messageCall === 1) {
        throw new AgentTurnError(
          "authentication expired; login required",
          {
            requested: { providerId: "codebuddy", model: "settings-claude-model" },
            observed: {
              providerId: "codebuddy",
              model: "hy3-ioa",
              command: "codebuddy",
              cliVersion: "2.132.0",
              apiKeySource: "copilot.tencent.com",
              protocol: "claude-stream-json-init-v1",
            },
          },
        );
      }
      if (input.message === "Build it") {
        assert.equal(input.env?.ANTHROPIC_API_KEY, "settings-claude-secret", "POST {} must use the current Settings command");
      } else {
        assert.equal(input.message, "Build with explicit provider");
        assert.equal(input.env?.ANTHROPIC_API_KEY, undefined, "an explicit CodeBuddy retry must retain its credential fence");
      }
      const html = "<!doctype html><html><head><title>Retried page</title></head><body><main>Recovered</main></body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "Recovered", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner });
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
  try {
    const projectId = "project-job-retry";
    await initializeDesignProject(dataDir, projectId);
    const root = `/api/projects/${projectId}/design-canvas`;
    const added = await json(root, "PUT", {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    assert.equal(added.status, 200, await added.clone().text());
    const firstResponse = await json(`${root}/nodes/node-page/agent/turns`, "POST", { message: "Build it" });
    assert.equal(firstResponse.status, 202, await firstResponse.clone().text());
    const first = await firstResponse.json() as { job: { id: string } };
    let failed = await getDesignJob(dataDir, projectId, first.job.id);
    for (let attempt = 0; attempt < 200 && failed.status !== "failed"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      failed = await getDesignJob(dataDir, projectId, first.job.id);
    }
    assert.equal(failed.status, "failed");
    assert.equal(failed.runnerId, "codebuddy");
    assert.equal(failed.model, "hy3-ioa");
    assert.equal(calls, 1, "authentication failures must not be retried blindly");

    const retriedResponse = await json(`${root}/jobs/${failed.id}/retry`, "POST", {});
    assert.equal(retriedResponse.status, 202, await retriedResponse.clone().text());
    const retried = await retriedResponse.json() as { retryOfJobId: string; job: { id: string } };
    assert.equal(retried.retryOfJobId, failed.id);
    assert.notEqual(retried.job.id, failed.id);
    const retriedJob = await getDesignJob(dataDir, projectId, retried.job.id);
    assert.equal(retriedJob.model, "settings-claude-model", "a mismatched failed provider cannot donate its model");
    const duplicateResponse = await json(`${root}/jobs/${failed.id}/retry`, "POST", {});
    assert.equal(duplicateResponse.status, 200, await duplicateResponse.clone().text());
    const duplicate = await duplicateResponse.json() as { job: { id: string } };
    assert.equal(duplicate.job.id, retried.job.id);

    let completed = await getDesignJob(dataDir, projectId, retried.job.id);
    for (let attempt = 0; attempt < 200 && completed.status !== "ready"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      completed = await getDesignJob(dataDir, projectId, retried.job.id);
    }
    assert.equal(completed.status, "ready", completed.error ?? "Retry did not complete");
    assert.equal(calls, 2);
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.name, "Retried page");
    // Replaying the Retry after its successor published still returns that successor
    // (the prompt/canvas hash has moved on; the server-derived key has not).
    const lateDuplicate = await json(`${root}/jobs/${failed.id}/retry`, "POST", {});
    assert.equal(lateDuplicate.status, 200, await lateDuplicate.clone().text());
    assert.equal(((await lateDuplicate.json()) as { job: { id: string } }).job.id, retried.job.id);
    const readyRetry = await json(`${root}/jobs/${completed.id}/retry`, "POST", {});
    assert.equal(readyRetry.status, 409);

    const explicitStart = await json(`${root}/nodes/node-page/agent/turns`, "POST", {
      message: "Build with explicit provider",
    });
    assert.equal(explicitStart.status, 202, await explicitStart.clone().text());
    const explicitFirst = await explicitStart.json() as { job: { id: string } };
    let explicitFailed = await getDesignJob(dataDir, projectId, explicitFirst.job.id);
    for (let attempt = 0; attempt < 200 && explicitFailed.status !== "failed"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      explicitFailed = await getDesignJob(dataDir, projectId, explicitFirst.job.id);
    }
    assert.equal(explicitFailed.status, "failed");
    const oversizedOverride = await json(`${root}/jobs/${explicitFailed.id}/retry`, "POST", {
      agentCommand: "x".repeat(513),
    });
    assert.equal(oversizedOverride.status, 400);
    const explicitRetry = await json(`${root}/jobs/${explicitFailed.id}/retry`, "POST", {
      agentCommand: "codebuddy",
    });
    assert.equal(explicitRetry.status, 202, await explicitRetry.clone().text());
    const explicitRetryBody = await explicitRetry.json() as { job: { id: string; model: string | null } };
    assert.equal(explicitRetryBody.job.model, "hy3-ioa", "a compatible explicit provider preserves the attested model");
    let explicitCompleted = await getDesignJob(dataDir, projectId, explicitRetryBody.job.id);
    for (let attempt = 0; attempt < 200 && explicitCompleted.status !== "ready"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      explicitCompleted = await getDesignJob(dataDir, projectId, explicitRetryBody.job.id);
    }
    assert.equal(explicitCompleted.status, "ready", explicitCompleted.error ?? "Explicit retry did not complete");
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

interface AbortGate {
  entered: Promise<void>;
  aborted: Promise<void>;
  release(): void;
}

function abortGateRunner(): { runner: AgentRunner; gate: AbortGate } {
  let enter!: () => void;
  let observeAbort!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const aborted = new Promise<void>((resolve) => { observeAbort = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const runner: AgentRunner = {
    id: "http-design-lifecycle-gate",
    async runTurn(input) {
      const signal = input.signal;
      if (!signal) throw new Error("Lifecycle fixture requires an AbortSignal");
      enter();
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      observeAbort();
      await released;
      throw signal.reason ?? new DOMException("Design execution cancelled", "AbortError");
    },
  };
  return { runner, gate: { entered, aborted, release } };
}

test("Design Export source origin is derived from the accepted socket instead of Host", () => {
  assert.equal(
    trustedDesignPreviewOrigin({ localAddress: "::ffff:127.0.0.1", localPort: 4321 }),
    "http://127.0.0.1:4321",
  );
  assert.equal(
    trustedDesignPreviewOrigin({ localAddress: "::1", localPort: 4321 }),
    "http://[::1]:4321",
  );
  assert.equal(
    trustedDesignPreviewOrigin({ localAddress: "0.0.0.0", localPort: 4321 }),
    "http://127.0.0.1:4321",
  );
  assert.throws(() => trustedDesignPreviewOrigin({ localAddress: undefined, localPort: 4321 }), /socket/i);
});

test("ordinary Project creation initializes an empty Design canvas without scaffolding Vite", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Blank Design" }),
    });
    assert.equal(response.status, 201);
    const project = await response.json() as { id: string };
    assert.equal(store.getProject(project.id), null);
    const root = join(dataDir, "projects", project.id);
    const metadata = JSON.parse(await readFile(join(root, "design", "metadata.json"), "utf8"));
    assert.equal(metadata.projectId, project.id);
    assert.equal(metadata.name, "Blank Design");
    const designProject = JSON.parse(await readFile(join(root, "design", "project.json"), "utf8"));
    assert.equal(designProject.projectId, project.id);
    assert.deepEqual(designProject.nodes, []);
    await assert.rejects(readFile(join(root, "package.json")));
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Home bootstrap HTTP creates once, replays exactly, and rejects key rebinding", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-bootstrap-http-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    designProjectBootstrapPorts: {
      ensureAssetBatch: async () => undefined,
      ensureMainTurn: async () => ({ jobId: "job-bootstrap-http" }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const bootstrap = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/projects/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const input = {
    schemaVersion: 1,
    idempotencyKey: "home-http-0001",
    name: "HTTP bootstrap",
    prompt: "",
    items: [],
  };
  try {
    const firstResponse = await bootstrap(input);
    assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
    const first = await firstResponse.json() as {
      project: { id: string };
      bootstrap: { job: { id: string; projectId: string }; reused: boolean };
    };
    assert.equal(first.project.id, first.bootstrap.job.projectId);
    assert.equal(first.bootstrap.reused, false);
    assert.equal(store.getProject(first.project.id), null);

    const replayResponse = await bootstrap(input);
    assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
    const replay = await replayResponse.json() as typeof first;
    assert.equal(replay.project.id, first.project.id);
    assert.equal(replay.bootstrap.job.id, first.bootstrap.job.id);
    assert.equal(replay.bootstrap.reused, true);

    const conflict = await bootstrap({ ...input, prompt: "Different request" });
    assert.equal(conflict.status, 409, await conflict.clone().text());
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Home bootstrap HTTP rejects malformed nested Asset import records before creating a Project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-bootstrap-invalid-http-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  let assetCalls = 0;
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    designProjectBootstrapPorts: {
      ensureAssetBatch: async () => { assetCalls += 1; },
      ensureMainTurn: async () => ({ jobId: "job-bootstrap-invalid-http" }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const asset = { name: "Source", mimeType: "text/html", base64: Buffer.from("x").toString("base64") };
  const node = { id: "node-source", kind: "document", name: "Source" };
  const malformedItems = [
    [{ asset, binding: { type: "create-node", node }, unexpected: true }],
    [{ asset: { ...asset, sourceVersion: { projectId: "p", nodeId: "n", versionId: "v" } }, binding: { type: "create-node", node } }],
    [{ asset, binding: { type: "create-node", node: { ...node, kind: "unsupported-kind" } } }],
    [{ asset, binding: { type: "create-node", node: { ...node, geometry: { width: null } } } }],
    [{ asset: { name: "Source", mimeType: "text/html", sourceVersion: { projectId: "../escape", nodeId: "n", versionId: "v" } }, binding: { type: "create-node", node } }],
  ];
  try {
    for (const [index, items] of malformedItems.entries()) {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          idempotencyKey: `home-http-invalid-${index}`,
          name: "Invalid bootstrap",
          prompt: "",
          items,
        }),
      });
      assert.equal(response.status, 400, await response.clone().text());
    }
    assert.equal(assetCalls, 0);
    await assert.rejects(readFile(join(dataDir, "design-bootstrap-jobs")));
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("production Home bootstrap atomically imports attachments and reserves one Main turn", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-bootstrap-production-http-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  let runnerCalls = 0;
  const designRunner: AgentRunner = {
    id: "bootstrap-production-runner",
    async runTurn() {
      runnerCalls += 1;
      return { text: "Bootstrap is ready.", artifactHtml: "" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const input = {
    schemaVersion: 1,
    idempotencyKey: "home-production-0001",
    name: "Production bootstrap",
    prompt: "Use the supplied brief",
    items: [{
      asset: { name: "brief.txt", mimeType: "text/plain", base64: Buffer.from("brief").toString("base64") },
      binding: {
        type: "create-node",
        node: { id: "node-brief", kind: "document", name: "Brief" },
      },
    }],
  };
  const bootstrap = () => fetch(`http://127.0.0.1:${port}/api/projects/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  try {
    const firstResponse = await bootstrap();
    assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
    const first = await firstResponse.json() as {
      project: { id: string };
      bootstrap: { job: { id: string; mainJobId: string | null }; reused: boolean };
    };
    assert.ok(first.bootstrap.job.mainJobId);
    const canvas = await getDesignCanvas(dataDir, first.project.id);
    assert.deepEqual(canvas.nodeOrder, ["node-brief"]);
    const mainJob = await getDesignJob(dataDir, first.project.id, first.bootstrap.job.mainJobId!);
    assert.equal(mainJob.kind, "main-agent");

    const replayResponse = await bootstrap();
    assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
    const replay = await replayResponse.json() as typeof first;
    assert.equal(replay.bootstrap.job.id, first.bootstrap.job.id);
    assert.equal(replay.bootstrap.job.mainJobId, first.bootstrap.job.mainJobId);
    assert.equal(replay.bootstrap.reused, true);
    let completedMainJob = await getDesignJob(dataDir, first.project.id, first.bootstrap.job.mainJobId!);
    for (let attempt = 0; attempt < 200 && !["ready", "failed", "cancelled", "superseded"].includes(completedMainJob.status); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      completedMainJob = await getDesignJob(dataDir, first.project.id, first.bootstrap.job.mainJobId!);
    }
    assert.equal(completedMainJob.status, "ready", completedMainJob.error ?? "bootstrap Main turn did not finish");
    assert.equal(completedMainJob.conversationOnly, true);
    assert.equal(runnerCalls, 1);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery never cancels a fresh Main turn resumed from a pre-Main bootstrap phase", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-bootstrap-recovery-main-"));
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-recovery-main-0001",
    name: "Recovered Main bootstrap",
    prompt: "Start after recovery",
    items: [],
  };
  await assert.rejects(
    bootstrapDesignProject({
      dataDir,
      input,
      ports: {
        ensureProject: (project) => ensureDesignProjectAtId(dataDir, project).then(() => undefined),
        ensureAssetBatch: async () => { throw new Error("no assets"); },
        ensureMainTurn: async () => { throw new Error("must crash before Main"); },
      },
      testHooks: {
        simulateProcessCrash: true,
        afterPhase: (phase) => {
          if (phase === "project-created") throw new Error("daemon exited before Main reservation");
        },
      },
    }),
    /daemon exited before Main reservation/,
  );
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  let releaseRunner!: () => void;
  const runnerGate = new Promise<void>((resolve) => { releaseRunner = resolve; });
  const designRunner: AgentRunner = {
    id: "bootstrap-recovery-runner",
    async runTurn() {
      await runnerGate;
      return { text: "Recovered.", artifactHtml: "" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(response.status, 200, await response.clone().text());
    const projects = await response.json() as Array<{ id: string }>;
    assert.equal(projects.length, 1);
    const jobs = await listDesignJobs(dataDir, projects[0]!.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.kind, "main-agent");
    assert.notEqual(jobs[0]!.status, "cancelled");
    assert.notEqual(jobs[0]!.error, "Interrupted by daemon restart");
  } finally {
    releaseRunner();
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery replaces a bootstrap Main orphan created before its phase commit exactly once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-bootstrap-recovery-orphan-"));
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-recovery-orphan-0001",
    name: "Recovered orphan bootstrap",
    prompt: "Resume the durable Main reservation",
    items: [],
  };
  let projectId = "";
  let orphanJobId = "";
  let orphanCompletion: Promise<unknown> | null = null;
  let markOrphanRunning!: () => void;
  let releaseOrphan!: () => void;
  const orphanRunning = new Promise<void>((resolve) => { markOrphanRunning = resolve; });
  const orphanGate = new Promise<void>((resolve) => { releaseOrphan = resolve; });
  const orphanRunner: AgentRunner = {
    id: "bootstrap-restart-runner",
    async runTurn() {
      markOrphanRunning();
      await orphanGate;
      return { text: "The stale process must not complete this turn.", artifactHtml: "" };
    },
  };

  try {
    await assert.rejects(
      bootstrapDesignProject({
        dataDir,
        input,
        ports: {
          ensureProject: async (project) => {
            projectId = project.projectId;
            await ensureDesignProjectAtId(dataDir, project);
          },
          ensureAssetBatch: async () => { throw new Error("no assets"); },
          ensureMainTurn: async (main) => {
            const started = await startDesignMainTurn({
              dataDir,
              projectId: main.projectId,
              message: main.prompt,
              runner: orphanRunner,
              systemPrompt: buildDesignMainSystemPrompt(),
              idempotencyKey: main.idempotencyKey,
              model: null,
              dispatchNode: async () => { throw new Error("orphan fixture must not dispatch"); },
            });
            orphanJobId = started.job.id;
            orphanCompletion = started.completion;
            throw new Error("daemon exited after durable Main creation but before bootstrap phase commit");
          },
        },
        testHooks: { simulateProcessCrash: true },
      }),
      /daemon exited after durable Main creation but before bootstrap phase commit/,
    );
    await orphanRunning;
    assert.ok(projectId);
    assert.ok(orphanJobId);

    const store = new Store(":memory:");
    const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
    let recoveredRunnerCalls = 0;
    const recoveredRunner: AgentRunner = {
      id: "bootstrap-restart-runner",
      async runTurn() {
        recoveredRunnerCalls += 1;
        return { text: "Recovered bootstrap Main turn.", artifactHtml: "" };
      },
    };
    const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: recoveredRunner });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const startup = await fetch(`http://127.0.0.1:${port}/api/projects`);
      assert.equal(startup.status, 200, await startup.clone().text());
      const replayResponse = await fetch(`http://127.0.0.1:${port}/api/projects/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
      const replay = await replayResponse.json() as {
        project: { id: string };
        bootstrap: { job: { mainJobId: string | null }; reused: boolean };
      };
      assert.equal(replay.project.id, projectId);
      assert.equal(replay.bootstrap.reused, true);
      assert.ok(replay.bootstrap.job.mainJobId);
      assert.notEqual(replay.bootstrap.job.mainJobId, orphanJobId);

      const orphan = await getDesignJob(dataDir, projectId, orphanJobId);
      assert.equal(orphan.status, "cancelled");
      assert.equal(orphan.error, "Interrupted by daemon restart");
      let successor = await getDesignJob(dataDir, projectId, replay.bootstrap.job.mainJobId!);
      for (let attempt = 0; attempt < 200 && successor.status !== "ready"; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        successor = await getDesignJob(dataDir, projectId, successor.id);
      }
      assert.equal(successor.status, "ready", successor.error ?? "bootstrap successor did not complete");
      assert.equal(recoveredRunnerCalls, 1);
      assert.equal((await listDesignJobs(dataDir, projectId)).length, 2);
    } finally {
      await runtimeSupervisor.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }

    const restartStore = new Store(":memory:");
    const restartSupervisor = createRuntimeSupervisor({ dataDir, store: restartStore });
    let duplicateRunnerCalls = 0;
    const restartServer = createApp({
      dataDir,
      store: restartStore,
      runtimeSupervisor: restartSupervisor,
      designRunner: {
        id: "bootstrap-duplicate-recovery-runner",
        async runTurn() {
          duplicateRunnerCalls += 1;
          return { text: "Duplicate recovery must not run.", artifactHtml: "" };
        },
      },
    });
    await new Promise<void>((resolve) => restartServer.listen(0, "127.0.0.1", resolve));
    const restartPort = (restartServer.address() as AddressInfo).port;
    try {
      const startup = await fetch(`http://127.0.0.1:${restartPort}/api/projects`);
      assert.equal(startup.status, 200, await startup.clone().text());
      assert.equal((await listDesignJobs(dataDir, projectId)).length, 2);
      assert.equal(duplicateRunnerCalls, 0);
    } finally {
      await restartSupervisor.shutdown();
      await new Promise<void>((resolve) => restartServer.close(() => resolve()));
      restartStore.close();
    }
  } finally {
    releaseOrphan();
    await Promise.resolve(orphanCompletion).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Design HTTP routes wait for startup recovery and fail closed when it cannot complete", async (t) => {
  await t.test("a Canvas mutation cannot overtake startup recovery", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-recovery-gate-"));
    const projectId = "project-recovery-gate";
    await initializeDesignProject(dataDir, projectId);
    const store = new Store(":memory:");
    const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
    let markRecoveryStarted!: () => void;
    let releaseRecovery!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => { markRecoveryStarted = resolve; });
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const server = createApp({
      dataDir,
      store,
      runtimeSupervisor,
      designStartupRecovery: async () => {
        markRecoveryStarted();
        await recoveryGate;
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await recoveryStarted;
      let settled = false;
      const responsePromise = fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/design-canvas`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          intents: [{ type: "add-node", node: { id: "node-after-recovery", kind: "page" } }],
        }),
      }).then((response) => {
        settled = true;
        return response;
      });
      const outcome = await Promise.race([
        responsePromise.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      assert.equal(outcome, "waiting");
      assert.equal(settled, false);
      assert.equal((await getDesignCanvas(dataDir, projectId)).revision, 0);

      releaseRecovery();
      const response = await responsePromise;
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.id, "node-after-recovery");
    } finally {
      releaseRecovery();
      await runtimeSupervisor.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("Home bootstrap cannot overtake startup recovery", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-bootstrap-recovery-gate-"));
    const store = new Store(":memory:");
    const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
    let markRecoveryStarted!: () => void;
    let releaseRecovery!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => { markRecoveryStarted = resolve; });
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const server = createApp({
      dataDir,
      store,
      runtimeSupervisor,
      designStartupRecovery: async () => {
        markRecoveryStarted();
        await recoveryGate;
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await recoveryStarted;
      let settled = false;
      const responsePromise = fetch(`http://127.0.0.1:${port}/api/projects/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          idempotencyKey: "home-recovery-gate",
          name: "Recovered bootstrap",
          prompt: "",
          items: [],
        }),
      }).then((response) => {
        settled = true;
        return response;
      });
      const outcome = await Promise.race([
        responsePromise.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      assert.equal(outcome, "waiting");
      assert.equal(settled, false);

      releaseRecovery();
      const response = await responsePromise;
      assert.equal(response.status, 201, await response.clone().text());
    } finally {
      releaseRecovery();
      await runtimeSupervisor.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("a failed recovery returns 503 without invoking the Design handler", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-recovery-failed-"));
    const projectId = "project-recovery-failed";
    await initializeDesignProject(dataDir, projectId);
    const store = new Store(":memory:");
    const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
    const server = createApp({
      dataDir,
      store,
      runtimeSupervisor,
      designStartupRecovery: async () => { throw new Error("corrupt publication marker"); },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/design-canvas`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          intents: [{ type: "add-node", node: { id: "node-must-not-exist", kind: "page" } }],
        }),
      });
      assert.equal(response.status, 503, await response.clone().text());
      assert.match(await response.text(), /recovery/i);
      assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodes, []);
    } finally {
      await runtimeSupervisor.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("Main Agent request inherits the settings model only when its command stays on the configured provider", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-agent-override-"));
  const store = new Store(":memory:");
  store.updateSettings({ agentCommand: "codebuddy", model: "settings-codebuddy-model" });
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const runner: AgentRunner = {
    id: "http-effective-agent-fixture",
    async runTurn() {
      return {
        text: JSON.stringify({ reply: "No canvas changes.", canvasIntents: [], dispatches: [] }),
        artifactHtml: "",
      };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent override" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const project = await created.json() as { id: string };
    const started = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/design-canvas/agent/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Inspect the canvas.", agentCommand: "claude" }),
    });
    assert.equal(started.status, 202, await started.clone().text());
    const body = await started.json() as { job: { model: string | null } };
    assert.equal(body.job.model, null);

    const sameProviderProjectResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent settings inheritance" }),
    });
    assert.equal(sameProviderProjectResponse.status, 201, await sameProviderProjectResponse.clone().text());
    const sameProviderProject = await sameProviderProjectResponse.json() as { id: string };
    const inherited = await fetch(
      `http://127.0.0.1:${port}/api/projects/${sameProviderProject.id}/design-canvas/agent/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Inspect the canvas.", agentCommand: "codebuddy" }),
      },
    );
    assert.equal(inherited.status, 202, await inherited.clone().text());
    const inheritedBody = await inherited.json() as { job: { model: string | null } };
    assert.equal(inheritedBody.job.model, "settings-codebuddy-model");

    const explicitDefaultProjectResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent explicit provider default" }),
    });
    assert.equal(explicitDefaultProjectResponse.status, 201, await explicitDefaultProjectResponse.clone().text());
    const explicitDefaultProject = await explicitDefaultProjectResponse.json() as { id: string };
    const explicitDefault = await fetch(
      `http://127.0.0.1:${port}/api/projects/${explicitDefaultProject.id}/design-canvas/agent/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Inspect the canvas.", agentCommand: "codebuddy", model: null }),
      },
    );
    assert.equal(explicitDefault.status, 202, await explicitDefault.clone().text());
    const explicitDefaultBody = await explicitDefault.json() as { job: { model: string | null } };
    assert.equal(explicitDefaultBody.job.model, null);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Main Agent request identity is inherited by its child Job and published Version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-main-identity-"));
  const store = new Store(":memory:");
  store.updateSettings({ agentCommand: "codebuddy", model: "settings-main-model" });
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const plan = JSON.stringify({
    reply: "Created and delegated the page.",
    canvasIntents: [{ type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } }],
    dispatches: [{ nodeId: "node-page", message: "Generate Home.", contextNodeIds: [] }],
  });
  const runner: AgentRunner = {
    id: "http-main-child-fixture",
    async runTurn(input) {
      if (input.projectDir.includes("/exports/.pending/main-job-")) {
        return { text: plan, artifactHtml: "" };
      }
      const html = "<!doctype html><html><head><title>Delegated home</title><style>body{margin:0}</style></head><body>Main child generated</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "Published the delegated page.", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
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
  try {
    const created = await json("/api/projects", "POST", { name: "Main identity" });
    assert.equal(created.status, 201, await created.clone().text());
    const project = await created.json() as { id: string };
    const root = `/api/projects/${project.id}/design-canvas`;
    const startedResponse = await json(`${root}/agent/turns`, "POST", {
      message: "Create and delegate a page.",
      agentCommand: "claude",
      model: "request-main-model",
    });
    assert.equal(startedResponse.status, 202, await startedResponse.clone().text());
    const started = await startedResponse.json() as {
      job: { id: string; runnerId: string; model: string | null };
    };
    assert.deepEqual(
      { runnerId: started.job.runnerId, model: started.job.model },
      { runnerId: "http-main-child-fixture", model: "request-main-model" },
    );

    type Job = {
      id: string;
      kind: string;
      status: string;
      parentJobId: string | null;
      runnerId: string;
      model: string | null;
      versionId: string | null;
    };
    const deadline = Date.now() + 2_000;
    let parent: Job | undefined;
    let child: Job | undefined;
    while (Date.now() < deadline) {
      const jobs = await (await json(`${root}/jobs`)).json() as Job[];
      parent = jobs.find((job) => job.id === started.job.id);
      child = jobs.find((job) => job.parentJobId === started.job.id);
      if (parent?.status === "ready" && child?.status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(parent?.status, "ready");
    assert.equal(parent?.kind, "main-agent");
    assert.equal(parent?.runnerId, started.job.runnerId);
    assert.equal(parent?.model, started.job.model);
    assert.equal(child?.kind, "node-generation");
    assert.equal(child?.runnerId, started.job.runnerId);
    assert.equal(child?.model, started.job.model);
    assert.ok(child?.versionId);

    const versions = await (await json(`${root}/nodes/node-page/versions`)).json() as Array<{
      id: string;
      jobId: string | null;
      runnerId: string | null;
      model: string | null;
    }>;
    const version = versions.find((candidate) => candidate.id === child?.versionId);
    assert.equal(version?.jobId, child?.id);
    assert.equal(version?.runnerId, child?.runnerId);
    assert.equal(version?.model, child?.model);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Project deletion aborts and awaits detached Node, Main, and Export executions", async (t) => {
  for (const executionKind of ["node", "main", "export"] as const) {
    await t.test(executionKind, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-delete-${executionKind}-`));
      const store = new Store(":memory:");
      const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
      const { runner, gate } = abortGateRunner();
      const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
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
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        const created = await json("/api/projects", "POST", { name: `${executionKind} deletion` });
        assert.equal(created.status, 201, await created.clone().text());
        const project = await created.json() as { id: string };
        const projectPath = join(dataDir, "projects", project.id);
        const canvasRoot = `/api/projects/${project.id}/design-canvas`;

        if (executionKind !== "main") {
          const added = await json(canvasRoot, "PUT", {
            expectedRevision: 0,
            intents: [{ type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } }],
          });
          assert.equal(added.status, 200, await added.clone().text());
        }
        if (executionKind === "export") {
          await publishDesignVersion(dataDir, project.id, {
            nodeId: "node-page",
            html: "<!doctype html><html><head><style>body{margin:0}</style></head><body><main>Ready</main></body></html>",
            contextHash: "a".repeat(64),
            canvasRevision: 1,
            expectedHeadVersionId: null,
            jobId: null,
            runnerId: "fixture",
            model: null,
          });
        }

        const currentCanvas = await (await json(canvasRoot)).json() as { revision: number };
        const startPath = executionKind === "node"
          ? `${canvasRoot}/nodes/node-page/agent/turns`
          : executionKind === "main"
            ? `${canvasRoot}/agent/turns`
            : `${canvasRoot}/exports`;
        const startBody = executionKind === "export"
          ? { canvasRevision: currentCanvas.revision }
          : { message: `Keep ${executionKind} active` };
        const started = await json(startPath, "POST", startBody);
        assert.equal(started.status, 202, await started.clone().text());
        await gate.entered;

        let deletionSettled = false;
        const deleting = json(`/api/projects/${project.id}`, "DELETE").then((response) => {
          deletionSettled = true;
          return response;
        });
        await gate.aborted;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        assert.equal(deletionSettled, false, "deletion must await the aborted execution's actual settlement");
        assert.equal((await readFile(join(projectPath, "design", "metadata.json"), "utf8")).length > 0, true);

        gate.release();
        let deletionTimer: NodeJS.Timeout | undefined;
        const deleted = await Promise.race([
          deleting,
          new Promise<never>((_resolve, reject) => {
            deletionTimer = setTimeout(() => reject(new Error("Project deletion did not drain")), 2_000);
          }),
        ]).finally(() => clearTimeout(deletionTimer));
        assert.equal(deleted.status, 204, await deleted.clone().text());
        await assert.rejects(readFile(join(projectPath, "design", "metadata.json")), { code: "ENOENT" });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        assert.deepEqual(unhandled, []);
      } finally {
        gate.release();
        process.off("unhandledRejection", onUnhandled);
        await runtimeSupervisor.shutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("Design Export HTTP publishes only after the real desktop and mobile visual gate", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Design Export visual gate");
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-export-visual-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const sourceHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{background:#f6f1e8;color:#17202a;font-family:Arial,sans-serif}*{box-sizing:border-box}
    body{margin:0}.page{min-height:100vh;display:grid;place-items:center;padding:48px}h1{margin:0;max-width:9ch;font-size:clamp(48px,9vw,112px);line-height:.88;letter-spacing:-.07em}
  </style></head><body><main class="page" data-dezin-export-node-id="node-page"><h1>Socket-bound visual export</h1></main></body></html>`;
  const runner: AgentRunner = {
    id: "http-export-visual-fixture",
    async runTurn(input) {
      const packageJson = {
        name: "dezin-http-visual-export",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        devDependencies: { typescript: DESIGN_EXPORT_TYPESCRIPT_VERSION, vite: DESIGN_EXPORT_VITE_VERSION },
      };
      const index = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>";
      const main = `import "./styles.css";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");
const nodeId = new URLSearchParams(window.location.search).get("dezin-node");
if (nodeId !== null && nodeId !== "node-page") throw new Error("Unknown Design Node route");
const page = document.createElement("main");
page.className = "page";
page.dataset.dezinExportNodeId = "node-page";
const heading = document.createElement("h1");
heading.textContent = "Socket-bound visual export";
page.append(heading);
app.append(page);
`;
      const styles = `:root{background:#f6f1e8;color:#17202a;font-family:Arial,sans-serif}*{box-sizing:border-box}
body{margin:0}.page{min-height:100vh;display:grid;place-items:center;padding:48px}h1{margin:0;max-width:9ch;font-size:clamp(48px,9vw,112px);line-height:.88;letter-spacing:-.07em}
`;
      await mkdir(join(input.projectDir, "src"), { recursive: true });
      await Promise.all([
        writeFile(join(input.projectDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
        writeFile(join(input.projectDir, "index.html"), index),
        writeFile(join(input.projectDir, "src", "main.ts"), main),
        writeFile(join(input.projectDir, "src", "styles.css"), styles),
      ]);
      return { text: "Exact fresh implementation", artifactHtml: index, artifactPath: "index.html" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const json = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) => fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const created = await json("/api/projects", "POST", { name: "Real visual export" });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };
    const root = `/api/projects/${project.id}/design-canvas`;
    const added = await json(root, "PUT", {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } }],
    });
    assert.equal(added.status, 200, await added.clone().text());
    await publishDesignVersion(dataDir, project.id, {
      nodeId: "node-page",
      html: sourceHtml,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const canvas = await (await json(root)).json() as { revision: number };
    const startedResponse = await json(`${root}/exports`, "POST", { canvasRevision: canvas.revision }, {
      host: "attacker.invalid:9",
    });
    assert.equal(startedResponse.status, 202, await startedResponse.clone().text());
    const started = await startedResponse.json() as { exportId: string; job: { id: string } };
    // A cold Vite build plus two Chrome viewports takes 15-20s on a shared CI runner.
    const deadline = Date.now() + 60_000;
    let terminal: { status: string; error: string | null; activity: Array<{ kind: string; text: string }> } | undefined;
    while (Date.now() < deadline) {
      const jobs = await (await json(`${root}/jobs`)).json() as Array<{ id: string; status: string; error: string | null; activity: Array<{ kind: string; text: string }> }>;
      terminal = jobs.find((job) => job.id === started.job.id);
      if (terminal && !["queued", "running", "validating"].includes(terminal.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(terminal?.status, "ready", terminal?.error ?? "visual Export did not finish");
    const finalDir = join(dataDir, "projects", project.id, "design", "exports", started.exportId);
    const manifest = JSON.parse(await readFile(join(finalDir, "dezin-export.json"), "utf8"));
    assert.equal(manifest.visualValidation.passed, true);
    assert.equal(manifest.visualValidation.caseCount, 4);
    assert.ok(terminal?.activity.some((entry) => entry.kind === "status" && /Visual gate passed 4.*receipt [a-f0-9]{64}/.test(entry.text)));
    const receiptBytes = await readFile(join(finalDir, manifest.visualValidation.receiptPath));
    assert.equal(createHash("sha256").update(receiptBytes).digest("hex"), manifest.visualValidation.receiptChecksum);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      projectId: string;
      exportId: string;
      canvasRevision: number;
      thresholds: Record<string, number>;
      cases: Array<{
        nodeId: string;
        viewport: { name: string };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
    };
    assert.equal(receipt.projectId, project.id);
    assert.equal(receipt.exportId, started.exportId);
    assert.equal(receipt.canvasRevision, canvas.revision);
    assert.deepEqual(receipt.thresholds, {
      meanAbsoluteError: 0.04,
      changedPixelRatio: 0.12,
      meanSsim: 0.95,
      p05Ssim: 0.6,
      minimumSsim: 0.5,
    });
    assert.deepEqual(receipt.cases.map((entry) => [entry.nodeId, entry.viewport.name]), [
      ["node-page", "desktop"],
      ["node-page", "mobile"],
    ]);
    const outputs = new Map((manifest.outputFiles as Array<{ path: string; checksum: string; bytes: number }>)
      .map((file) => [file.path, file]));
    assert.equal(outputs.get(manifest.visualValidation.receiptPath)?.checksum, manifest.visualValidation.receiptChecksum);
    for (const visualCase of receipt.cases) {
      for (const evidence of Object.values(visualCase.evidence)) {
        const bytes = await readFile(join(finalDir, evidence.path));
        assert.equal(bytes.length, evidence.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.checksum);
        assert.deepEqual(outputs.get(evidence.path), evidence);
      }
    }
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Design Asset batch import commits one Canvas revision and rolls back the whole invalid request", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-import-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({ dataDir, store, runtimeSupervisor });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const json = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  try {
    const created = await json("/api/projects", "POST", { name: "Atomic import" });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };
    const root = `/api/projects/${project.id}/design-canvas`;
    const png = (label: string) => Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(label),
    ]).toString("base64");
    const item = (id: string, name: string, base64: string, x: number) => ({
      asset: { name, mimeType: "image/png", base64 },
      binding: {
        type: "create-node",
        node: { id, kind: "image", name, geometry: { x, y: 24, width: 360, height: 260 } },
      },
    });

    const invalid = await json(`${root}/assets/import`, "POST", {
      expectedRevision: 0,
      items: [
        item("node-one", "one.png", png("one"), 24),
        item("node-bad", "bad.png", "not-canonical-base64", 408),
      ],
    });
    assert.equal(invalid.status, 400, await invalid.clone().text());
    const afterFailure = await (await json(root)).json() as { revision: number; nodes: unknown[] };
    assert.equal(afterFailure.revision, 0);
    assert.deepEqual(afterFailure.nodes, []);
    assert.deepEqual(await (await json(`${root}/assets`)).json(), []);

    const imported = await json(`${root}/assets/import`, "POST", {
      expectedRevision: 0,
      items: [
        item("node-one", "one.png", png("one"), 24),
        item("node-two", "two.png", png("two"), 408),
      ],
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    const canvas = await imported.json() as {
      revision: number;
      undoDepth: number;
      nodeOrder: string[];
      nodes: Array<{
        id: string;
        assetId: string | null;
        state: string;
        currentVersionId: string | null;
        selectedVersionId: string | null;
        versionCount: number;
      }>;
    };
    assert.equal(canvas.revision, 1);
    assert.equal(canvas.undoDepth, 1);
    assert.deepEqual(canvas.nodeOrder, ["node-one", "node-two"]);
    assert.ok(canvas.nodes.every((node) => node.assetId !== null && node.state === "ready"));
    assert.ok(canvas.nodes.every((node) => (
      node.currentVersionId !== null
      && node.selectedVersionId === node.currentVersionId
      && node.versionCount === 1
    )));
    const assets = await (await json(`${root}/assets`)).json() as Array<{ id: string }>;
    assert.equal(assets.length, 2);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Design Canvas HTTP supports CAS, exact preview pins, safe Asset delivery, and Node Agent Jobs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-slice-"));
  const store = new Store(":memory:");
  store.updateSettings({ agentCommand: "codebuddy", model: "hy3-ioa" });
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const runner: AgentRunner = {
    id: "http-writing-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head><style>body{margin:0}</style></head><body>HTTP generated</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      input.onActivity?.({ kind: "tool", name: "Write", summary: "Writing index.html" });
      return { text: "Published through HTTP.", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const json = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  try {
    const createdResponse = await json("/api/projects", "POST", { name: "HTTP canvas" });
    assert.equal(createdResponse.status, 201);
    const project = await createdResponse.json() as { id: string };
    const root = `/api/projects/${project.id}/design-canvas`;
    const initial = await (await json(root)).json() as { revision: number };
    assert.equal(initial.revision, 0);

    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("rangeable-image"),
    ]);
    const importedResponse = await json(`${root}/assets/import`, "POST", {
      expectedRevision: 0,
      items: [{
        asset: {
          name: "hero.png",
          mimeType: "image/png",
          base64: imageBytes.toString("base64"),
        },
        binding: {
          type: "create-node",
          node: { id: "node-image", kind: "image", name: "Hero" },
        },
      }],
    });
    assert.equal(importedResponse.status, 200, await importedResponse.clone().text());
    const imported = await importedResponse.json() as {
      revision: number;
      nodes: Array<{ id: string; assetId: string | null; currentVersionId: string | null }>;
    };
    const imageNode = imported.nodes.find((node) => node.id === "node-image");
    assert.ok(imageNode?.assetId);
    assert.ok(imageNode.currentVersionId);
    const assets = await (await json(`${root}/assets`)).json() as Array<{
      id: string;
      checksum: string;
      fileName: string;
    }>;
    const asset = assets.find((candidate) => candidate.id === imageNode.assetId);
    assert.ok(asset);
    const mutatedResponse = await json(root, "PUT", {
      expectedRevision: imported.revision,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    assert.equal(mutatedResponse.status, 200);
    assert.equal((await json(root, "PUT", { expectedRevision: 0, intents: [{ type: "set-viewport", viewport: { x: 0, y: 0, zoom: 1 } }] })).status, 409);
    assert.equal((await json(`${root}/agent/turns`, "POST", { message: "Arrange", unexpected: true })).status, 400);
    assert.equal((await json(`${root}/agent/turns`, "POST", {
      message: "Reject a terminal-corrupted model id",
      agentCommand: "claude",
      model: "claude-opus-5[1m]",
    })).status, 400);
    assert.equal((await json(`${root}/exports`, "POST", { canvasRevision: 1 })).status, 409);
    assert.equal((await json(`${root}/nodes/node-page/agent/turns`, "POST", { prompt: "retired alias" })).status, 400);

    const ranged = await fetch(`${base}${root}/assets/${asset.id}/content`, { headers: { range: "bytes=2-7" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("accept-ranges"), "bytes");
    assert.equal(ranged.headers.get("content-range"), `bytes 2-7/${imageBytes.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), imageBytes.subarray(2, 8));
    const headed = await fetch(`${base}${root}/assets/${asset.id}/content`, { method: "HEAD", headers: { range: "bytes=0-3" } });
    assert.equal(headed.status, 206);
    assert.equal(headed.headers.get("content-length"), "4");
    assert.equal((await headed.arrayBuffer()).byteLength, 0);

    const materialVersions = await (await json(`${root}/nodes/node-image/versions`)).json() as Array<{
      id: string;
      contentKind: string;
      assetId: string | null;
      checksum: string;
    }>;
    assert.deepEqual(materialVersions.map((version) => ({
      id: version.id,
      contentKind: version.contentKind,
      assetId: version.assetId,
    })), [{
      id: imageNode.currentVersionId,
      contentKind: "asset",
      assetId: asset.id,
    }]);
    assert.equal(materialVersions[0]?.checksum, asset.checksum);
    const materialPreview = await fetch(
      `${base}${root}/nodes/node-image/versions/${imageNode.currentVersionId}/preview/`,
    );
    assert.equal(materialPreview.status, 200, await materialPreview.clone().text());
    assert.equal(materialPreview.headers.get("content-type"), "image/png");
    assert.equal(materialPreview.headers.get("x-content-type-options"), "nosniff");
    // Opaque-origin preview sandboxes may read these public, immutable bytes in canvas/WebGL.
    assert.equal(materialPreview.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(Buffer.from(await materialPreview.arrayBuffer()), imageBytes);
    const materialEmbeddedPreview = await fetch(
      `${base}${root}/nodes/node-image/versions/${imageNode.currentVersionId}/preview/embed`,
    );
    assert.equal(materialEmbeddedPreview.status, 415, await materialEmbeddedPreview.clone().text());

    const revisedImageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("rangeable-image-v2"),
    ]);
    const beforeAppend = await (await json(root)).json() as { revision: number };
    const appendedResponse = await json(`${root}/assets/import`, "POST", {
      expectedRevision: beforeAppend.revision,
      items: [{
        asset: {
          name: "hero-v2.png",
          mimeType: "image/png",
          base64: revisedImageBytes.toString("base64"),
        },
        binding: { type: "append-version", nodeId: "node-image" },
      }],
    });
    assert.equal(appendedResponse.status, 200, await appendedResponse.clone().text());
    const appendedCanvas = await appendedResponse.json() as {
      nodes: Array<{
        id: string;
        assetId: string | null;
        currentVersionId: string | null;
        selectedVersionId: string | null;
        versionCount: number;
      }>;
    };
    const appendedNode = appendedCanvas.nodes.find((node) => node.id === "node-image");
    assert.ok(appendedNode?.currentVersionId);
    assert.notEqual(appendedNode.currentVersionId, imageNode.currentVersionId);
    assert.equal(appendedNode.selectedVersionId, appendedNode.currentVersionId);
    assert.equal(appendedNode.versionCount, 2);
    assert.notEqual(appendedNode.assetId, asset.id);
    const revisedPreview = await fetch(
      `${base}${root}/nodes/node-image/versions/${appendedNode.currentVersionId}/preview/`,
    );
    assert.equal(revisedPreview.status, 200, await revisedPreview.clone().text());
    assert.deepEqual(Buffer.from(await revisedPreview.arrayBuffer()), revisedImageBytes);
    const originalPreviewAgain = await fetch(
      `${base}${root}/nodes/node-image/versions/${imageNode.currentVersionId}/preview/`,
    );
    assert.deepEqual(Buffer.from(await originalPreviewAgain.arrayBuffer()), imageBytes);

    const beforePublish = await (await json(root)).json() as { revision: number };
    const published = await publishDesignVersion(dataDir, project.id, {
      nodeId: "node-page",
      html: `<!doctype html><html><head><style>body{margin:0}</style></head><body><img src="dezin-asset://${asset.id}"></body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: beforePublish.revision,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const preview = await fetch(`${base}${root}/nodes/node-page/versions/${published.manifest.id}/preview/`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("etag"), `"sha256-${published.manifest.checksum}"`);
    const csp = preview.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "sandbox allow-scripts"]) {
      assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(csp, /navigate-to/);
    assert.doesNotMatch(csp, /allow-top-navigation/);
    // Web fonts ride on the Settings toggle: Fontsource on jsDelivr is admitted by default and nothing else.
    assert.match(csp, /style-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net\/fontsource\//);
    assert.match(csp, /font-src 'self' data: blob: https:\/\/cdn\.jsdelivr\.net\/fontsource\//);
    store.updateSettings({ webResources: false });
    const offlineCsp = (await fetch(`${base}${root}/nodes/node-page/versions/${published.manifest.id}/preview/`)).headers.get("content-security-policy") ?? "";
    assert.doesNotMatch(offlineCsp, /jsdelivr/);
    store.updateSettings({ webResources: true });
    const previewHtml = await preview.text();
    assert.equal(
      createHash("sha256").update(Buffer.from(previewHtml, "utf8")).digest("hex"),
      published.manifest.checksum,
    );
    assert.doesNotMatch(previewHtml, /data-dezin-embedded-preview-bridge/);

    const embeddedPreviewUrl = `${base}${root}/nodes/node-page/versions/${published.manifest.id}/preview/embed`;
    const embeddedPreview = await fetch(embeddedPreviewUrl);
    assert.equal(embeddedPreview.status, 200, await embeddedPreview.clone().text());
    const embeddedBytes = Buffer.from(await embeddedPreview.arrayBuffer());
    const embeddedHtml = embeddedBytes.toString("utf8");
    const embeddedChecksum = createHash("sha256").update(embeddedBytes).digest("hex");
    const embeddedEtag = `"sha256-${embeddedChecksum}"`;
    assert.equal(embeddedPreview.headers.get("etag"), embeddedEtag);
    assert.notEqual(embeddedEtag, `"sha256-${published.manifest.checksum}"`);
    assert.equal(embeddedPreview.headers.get("content-length"), String(embeddedBytes.length));
    assert.equal(embeddedPreview.headers.get("cache-control"), "private, no-cache");
    const embeddedCsp = embeddedPreview.headers.get("content-security-policy") ?? "";
    assert.match(embeddedCsp, /worker-src 'none'/);
    assert.doesNotMatch(embeddedCsp, /navigate-to/);
    assert.doesNotMatch(embeddedCsp, /allow-top-navigation/);
    assert.notEqual(embeddedCsp, csp);
    assert.match(embeddedHtml, /data-dezin-embedded-preview-bridge/);
    assert.match(embeddedHtml, /addEventListener\("contextmenu"/);
    assert.match(embeddedHtml, /event\.isTrusted/);
    assert.match(embeddedHtml, /const apply=Reflect\.apply/);
    assert.match(embeddedHtml, /Event\.prototype\.preventDefault/);
    assert.match(embeddedHtml, /Event\.prototype\.stopImmediatePropagation/);
    assert.match(embeddedHtml, /MessagePort\.prototype\.postMessage/);
    assert.match(embeddedHtml, /MessagePort\.prototype\.start/);
    assert.match(embeddedHtml, /apply\(prevent,event,\[\]\)/);
    assert.match(embeddedHtml, /apply\(stop,event,\[\]\)/);
    assert.match(embeddedHtml, /apply\(portPost,channel\.port1/);
    assert.doesNotMatch(embeddedHtml, /parent\.postMessage\(/);
    assert.match(embeddedHtml, /type:"embedded-preview-context-menu-ready"/);
    assert.match(embeddedHtml, /type:"embedded-preview-context-menu"/);
    assert.match(embeddedHtml, /describe\(target,event\.clientX,event\.clientY\)/);
    assert.match(embeddedHtml, /type:"embedded-preview-layout"/);
    assert.match(embeddedHtml, /type:"embedded-preview-escape"/);
    assert.match(embeddedHtml, /data\.type==="annotate-mode"/);
    const bridgeBody = /<script data-dezin-embedded-preview-bridge>([\s\S]*?)<\/script>/.exec(embeddedHtml)?.[1];
    assert.ok(bridgeBody);
    assert.doesNotThrow(() => new Function(bridgeBody));
    assert.ok(
      embeddedHtml.indexOf("data-dezin-embedded-preview-bridge") < embeddedHtml.indexOf("<html>"),
      "the capture bridge must run before generated document scripts and handlers",
    );
    assert.ok(
      embeddedHtml.indexOf('addEventListener("contextmenu"') < embeddedHtml.indexOf("apply(parentPost,parent"),
      "the trusted context-menu listener must exist before the child transfers its private port",
    );

    const embeddedHead = await fetch(embeddedPreviewUrl, { method: "HEAD" });
    assert.equal(embeddedHead.status, 200);
    assert.equal(embeddedHead.headers.get("etag"), embeddedEtag);
    assert.equal(embeddedHead.headers.get("content-length"), String(embeddedBytes.length));
    assert.equal((await embeddedHead.arrayBuffer()).byteLength, 0);
    const embeddedNotModified = await fetch(embeddedPreviewUrl, {
      headers: { "if-none-match": embeddedEtag },
    });
    assert.equal(embeddedNotModified.status, 304);
    assert.equal(embeddedNotModified.headers.get("etag"), embeddedEtag);
    assert.equal(embeddedNotModified.headers.get("content-length"), null);

    const exactPreviewAgain = await fetch(
      `${base}${root}/nodes/node-page/versions/${published.manifest.id}/preview/`,
    );
    assert.equal(exactPreviewAgain.headers.get("etag"), `"sha256-${published.manifest.checksum}"`);
    assert.equal(await exactPreviewAgain.text(), previewHtml);

    const portablePreviewUrl = `${base}${root}/nodes/node-page/versions/${published.manifest.id}/preview/download`;
    const portablePreview = await fetch(portablePreviewUrl);
    assert.equal(portablePreview.status, 200, await portablePreview.clone().text());
    assert.equal(portablePreview.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(portablePreview.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.match(portablePreview.headers.get("cache-control") ?? "", /no-store/);
    const portableHtml = await portablePreview.text();
    assert.match(portableHtml, new RegExp(`data:image/png;base64,${imageBytes.toString("base64")}`));
    assert.doesNotMatch(portableHtml, /dezin-asset:|\/api\/projects\/[^"']+\/design-canvas\/assets\//i);

    const portableHead = await fetch(portablePreviewUrl, { method: "HEAD" });
    assert.equal(portableHead.status, 200);
    assert.equal(portableHead.headers.get("content-length"), String(Buffer.byteLength(portableHtml, "utf8")));
    assert.equal((await portableHead.arrayBuffer()).byteLength, 0);

    // The built-directory export ships index.html plus the pinned asset as files.
    const exportBundle = await fetch(`${base}${root}/nodes/node-page/versions/${published.manifest.id}/preview/export`);
    assert.equal(exportBundle.status, 200, await exportBundle.clone().text());
    assert.equal(exportBundle.headers.get("content-type"), "application/zip");
    assert.match(exportBundle.headers.get("content-disposition") ?? "", /^attachment;.*\.zip/);
    const zip = Buffer.from(await exportBundle.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const entries: Array<{ path: string; data: Buffer }> = [];
    for (let offset = 0; offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50;) {
      const compressedSize = zip.readUInt32LE(offset + 18);
      const nameLength = zip.readUInt16LE(offset + 26);
      const extraLength = zip.readUInt16LE(offset + 28);
      const dataStart = offset + 30 + nameLength + extraLength;
      entries.push({
        path: zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"),
        data: inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)),
      });
      offset = dataStart + compressedSize;
    }
    assert.deepEqual(entries.map((entry) => entry.path), ["index.html", `assets/${asset.id}/${asset.fileName}`]);
    assert.match(entries[0]!.data.toString("utf8"), new RegExp(`assets/${asset.id}/${asset.fileName}`));
    assert.doesNotMatch(entries[0]!.data.toString("utf8"), /dezin-asset:|\/api\/projects\//i);
    assert.deepEqual(entries[1]!.data, imageBytes);

    let pinnedPath: string | undefined;
    rewriteDesignHtmlUrlReferences({
      html: previewHtml,
      rewriteUrl(url) {
        if (url.startsWith(`/api/projects/${project.id}/design-canvas/assets/`)) {
          const checksum = new URL(url, "http://dezin.local").searchParams.get("checksum");
          if (checksum !== null && /^[a-f0-9]{64}$/.test(checksum)) pinnedPath = url;
        }
        return url;
      },
    });
    assert.ok(pinnedPath);
    const pinned = await fetch(`${base}${pinnedPath}`);
    assert.equal(pinned.status, 200, await pinned.clone().text());
    assert.deepEqual(Buffer.from(await pinned.arrayBuffer()), imageBytes);
    const wrongPin = await fetch(`${base}${pinnedPath.replace(asset.checksum, "0".repeat(64))}`);
    assert.equal(wrongPin.status, 403);

    const htmlAssetResponse = await json(`${root}/assets`, "POST", {
      name: "unsafe'()\n.html",
      mimeType: "text/html",
      base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
    });
    assert.equal(htmlAssetResponse.status, 400);
    const safeHtmlAssetResponse = await json(`${root}/assets`, "POST", {
      name: "reference's (exact).html",
      mimeType: "text/html",
      base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
    });
    assert.equal(safeHtmlAssetResponse.status, 201);
    const safeHtmlAsset = await safeHtmlAssetResponse.json() as { id: string };
    const activeContent = await fetch(`${base}${root}/assets/${safeHtmlAsset.id}/content`);
    assert.match(activeContent.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.match(activeContent.headers.get("content-disposition") ?? "", /%27|%28|%29/);
    assert.match(activeContent.headers.get("content-security-policy") ?? "", /default-src 'none'/);

    const turn = await json(`${root}/nodes/node-page/agent/turns`, "POST", {
      message: "Generate from HTTP",
      context: { nodeIds: ["node-image"] },
      idempotencyKey: "http-node-turn",
    });
    assert.equal(turn.status, 202);
    const turnBody = await turn.json() as { job: { id: string; runnerId: string; model: string | null } };
    assert.equal(turnBody.job.runnerId, "http-writing-fake");
    assert.equal(turnBody.job.model, "hy3-ioa");
    const deadline = Date.now() + 2_000;
    let terminal: {
      status: string;
      runnerId: string;
      model: string | null;
      activity: Array<{ kind: string; text: string; toolName?: string }>;
    } | undefined;
    while (Date.now() < deadline) {
      const jobs = await (await json(`${root}/jobs`)).json() as Array<{
        id: string;
        status: string;
        runnerId: string;
        model: string | null;
        activity: Array<{ kind: string; text: string; toolName?: string }>;
      }>;
      terminal = jobs.find((job) => job.id === turnBody.job.id);
      if (terminal && !["queued", "running", "validating"].includes(terminal.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(terminal?.status, "ready");
    assert.equal(terminal?.runnerId, turnBody.job.runnerId);
    assert.equal(terminal?.model, turnBody.job.model);
    assert.ok(terminal?.activity.some((entry) => (
      entry.kind === "tool" && entry.text === "Writing index.html" && entry.toolName === "write"
    )));
    const versions = await (await json(`${root}/nodes/node-page/versions`)).json() as Array<{
      jobId: string | null;
      runnerId: string | null;
      model: string | null;
    }>;
    const generated = versions.find((version) => version.jobId === turnBody.job.id);
    assert.equal(generated?.runnerId, turnBody.job.runnerId);
    assert.equal(generated?.model, turnBody.job.model);
    const thread = await (await json(`${root}/nodes/node-page/agent/thread`)).json() as { messages: Array<{ role: string }> };
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);

    const overrideTurn = await json(`${root}/nodes/node-page/agent/turns`, "POST", {
      message: "Generate with the request model",
      agentCommand: "claude",
      model: "request-model",
      idempotencyKey: "http-node-turn-override",
    });
    assert.equal(overrideTurn.status, 202);
    const overrideBody = await overrideTurn.json() as {
      job: { id: string; runnerId: string; model: string | null };
    };
    assert.equal(overrideBody.job.runnerId, "http-writing-fake");
    assert.equal(overrideBody.job.model, "request-model");
    const overrideDeadline = Date.now() + 2_000;
    let overrideTerminal: { status: string; runnerId: string; model: string | null } | undefined;
    while (Date.now() < overrideDeadline) {
      const jobs = await (await json(`${root}/jobs`)).json() as Array<{
        id: string;
        status: string;
        runnerId: string;
        model: string | null;
      }>;
      overrideTerminal = jobs.find((job) => job.id === overrideBody.job.id);
      if (overrideTerminal && !["queued", "running", "validating"].includes(overrideTerminal.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(overrideTerminal?.status, "ready");
    assert.equal(overrideTerminal?.runnerId, overrideBody.job.runnerId);
    assert.equal(overrideTerminal?.model, overrideBody.job.model);
    const overrideVersions = await (await json(`${root}/nodes/node-page/versions`)).json() as Array<{
      jobId: string | null;
      runnerId: string | null;
      model: string | null;
    }>;
    const overrideVersion = overrideVersions.find((version) => version.jobId === overrideBody.job.id);
    assert.equal(overrideVersion?.runnerId, overrideBody.job.runnerId);
    assert.equal(overrideVersion?.model, overrideBody.job.model);

    assert.equal((await json(`${root}/nodes/node-page/agent/turns`, "POST", { message: "ok", unknown: true })).status, 400);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
