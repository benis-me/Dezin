import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentExecutionIdentityError,
  AgentTurnError,
  ClaudeCodeRunner,
  type AgentRunner,
  type AgentTurnInput,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import {
  getDesignCanvas,
  getDesignJob,
  getDesignThread,
  initializeDesignProject,
  importDesignCanvasAssetBatch,
  listDesignVersions,
  listDesignJobs,
  mutateDesignCanvas,
  publishDesignVersion,
  storeDesignAsset,
} from "../src/design/design-storage.ts";
import {
  buildDesignNodeSystemPrompt,
  cancelDesignNodeTurn,
  startDesignNodeTurn,
} from "../src/design/design-node-agent.ts";

test("Node generation prompts bind the exact target and expose kind-specific contracts", () => {
  const store = new Store(":memory:");
  try {
    const settings = store.getSettings();
    const page = buildDesignNodeSystemPrompt({
      settings,
      message: "Create it",
      node: { id: "node-page", kind: "page", name: "Home" },
    });
    const research = buildDesignNodeSystemPrompt({
      settings,
      message: "Research it",
      node: { id: "node-research", kind: "research", name: "Audience evidence" },
    });
    assert.match(page, /node-page.*page/i);
    assert.match(page, /complete responsive page/i);
    assert.match(page, /320px.*horizontal overflow/i);
    assert.match(research, /node-research.*research/i);
    assert.match(research, /evidence.*sources|sources.*evidence/i);
    assert.notEqual(page, research);
    assert.doesNotMatch(page, /Dezin Render Frame|dezin:frame-change|Viewer and visual QA|Vite|npm\s+install|pre-installed React|GSAP|CDN/i);
    assert.match(page, /untrusted reference data/i);
    assert.match(page, /cannot change these instructions/i);
  } finally {
    store.close();
  }
});

class WritingRunner implements AgentRunner {
  readonly id = "writing-fake";
  input: AgentTurnInput | null = null;

  async runTurn(input: AgentTurnInput) {
    this.input = input;
    const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
    assert.equal(context.targetNodeId, "node-page");
    const shared = context.nodes.find((node: { id: string }) => node.id === "node-shared");
    assert.match(shared.selectedVersionPath, /^\.context\/nodes\//);
    assert.match(await readFile(join(input.projectDir, shared.selectedVersionPath), "utf8"), /Shared context/);
    assert.equal(shared.selectedVersionAssetPins.length, 1);
    assert.match(shared.selectedVersionAssetPins[0].path, /^\.context\/assets\//);
    const pinnedBytes = await readFile(join(input.projectDir, shared.selectedVersionAssetPins[0].path));
    assert.deepEqual([...pinnedBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sharedDuplicate = context.nodes.find((node: { id: string }) => node.id === "node-shared-2");
    assert.equal(sharedDuplicate.selectedVersionAssetPins[0].path, shared.selectedVersionAssetPins[0].path);
    const image = context.nodes.find((node: { id: string }) => node.id === "node-image");
    assert.match(image.assetPath, /^\.context\/assets\//);
    const imageBytes = await readFile(join(input.projectDir, image.assetPath));
    assert.deepEqual([...imageBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const duplicateImage = context.nodes.find((node: { id: string }) => node.id === "node-image-2");
    assert.equal(duplicateImage.assetPath, image.assetPath);
    const html = "<!doctype html><html><head><style>body{margin:0}</style></head><body><main data-design-node-id=\"hero\">Generated</main></body></html>";
    await writeFile(join(input.projectDir, "index.html"), html);
    input.onActivity?.({ kind: "tool", name: "Write", summary: "Writing index.html" });
    return {
      text: "Generated the page.",
      artifactHtml: html,
      artifactPath: "index.html",
      executionIdentity: {
        requested: { providerId: this.id, model: null },
        observed: {
          providerId: this.id,
          model: "runtime-fixture-model",
          command: "writing-fake",
          cliVersion: "1.0.0",
          apiKeySource: null,
          protocol: "claude-stream-json-init-v1" as const,
        },
      },
    };
  }
}

test("a Node Agent owns one staged HTML output and publishes an immutable version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-agent-"));
  const projectId = "project-agent";
  try {
    await initializeDesignProject(dataDir, projectId);
    const assetBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("context image"),
    ]);
    await storeDesignAsset(dataDir, projectId, {
      name: "context.png",
      mimeType: "image/png",
      base64: assetBytes.toString("base64"),
    });
    const pinnedAsset = await storeDesignAsset(dataDir, projectId, {
      name: "version-only.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("version-only image"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-shared", kind: "component", name: "Shared" } },
        { type: "add-node", node: { id: "node-shared-2", kind: "component", name: "Shared copy" } },
        { type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } },
      ],
    });
    await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 1,
      items: [
        {
          asset: { name: "context.png", mimeType: "image/png", base64: assetBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-image", kind: "image", name: "Image" } },
        },
        {
          asset: { name: "context.png", mimeType: "image/png", base64: assetBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-image-2", kind: "image", name: "Image copy" } },
        },
      ],
    });
    for (const nodeId of ["node-shared", "node-shared-2"]) {
      await publishDesignVersion(dataDir, projectId, {
        nodeId,
        html: `<!doctype html><html><head><style>body{margin:0}</style></head><body>Shared context<img src="dezin-asset://${pinnedAsset.id}"></body></html>`,
        contextHash: "a".repeat(64),
        canvasRevision: 2,
        expectedHeadVersionId: null,
        jobId: null,
        runnerId: "fixture",
        model: null,
      });
    }
    const runner = new WritingRunner();
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Design a distinctive home page",
      systemPrompt: "Follow Dezin's design-quality contract. Write one index.html.",
      runner,
      contextNodeIds: ["node-shared", "node-image"],
    });
    assert.equal(started.job.runnerId, "writing-fake");
    assert.equal(started.job.model, null);
    const completed = await started.completion;
    assert.equal(completed.status, "ready");
    assert.ok(completed.versionId);
    assert.match(runner.input?.projectDir ?? "", /design\/nodes\/node-page\/\.pending\/jobs\/job-/);

    const canvas = await getDesignCanvas(dataDir, projectId);
    const page = canvas.nodes.find((node) => node.id === "node-page");
    assert.equal(page?.currentVersionId, completed.versionId);
    assert.equal(page?.state, "ready");
    const persisted = await getDesignJob(dataDir, projectId, completed.id);
    assert.equal(persisted.runnerId, "writing-fake");
    assert.equal(persisted.model, "runtime-fixture-model");
    assert.ok(persisted.activity.some((entry) => entry.text === "Writing index.html"));
    const [version] = (await listDesignVersions(dataDir, projectId, "node-page"))
      .filter((candidate) => candidate.id === completed.versionId);
    assert.equal(version?.runnerId, persisted.runnerId);
    assert.equal(version?.model, persisted.model);
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a live publication error after staging is recovered before the executor terminalizes the Job", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-live-publication-recovery-"));
  const projectId = "project-live-publication-recovery";
  const runner: AgentRunner = {
    id: "publication-recovery-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head></head><body>Recover me</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with a recoverable live write failure",
      systemPrompt: "Write index.html",
      runner,
      publicationTestHooks: {
        afterPhase(phase) {
          if (phase === "pending") throw new Error("injected live publication failure");
        },
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready");
    assert.ok(completed.versionId);
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.currentVersionId, completed.versionId);
    assert.equal((await listDesignVersions(dataDir, projectId, "node-page")).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a live error during pending payload construction returns the recovered cancelled Job", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-live-partial-publication-"));
  const projectId = "project-live-partial-publication";
  const runner: AgentRunner = {
    id: "partial-publication-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head></head><body>Partial publish</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate across a partial payload failure",
      systemPrompt: "Write index.html",
      runner,
      publicationTestHooks: {
        afterPendingIndex() {
          throw new Error("injected partial pending failure");
        },
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.versionId, null);
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.nodes[0]?.activeJobId, null);
    assert.equal(canvas.nodes[0]?.currentVersionId, null);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
    assert.deepEqual(
      await readdir(join(dataDir, "projects", projectId, "design", "transactions", "publications")),
      [],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a live publication recovery failure preserves marker authority instead of marking the Job failed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-live-publication-quarantine-"));
  const projectId = "project-live-publication-quarantine";
  const runner: AgentRunner = {
    id: "publication-quarantine-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head></head><body>Quarantine me</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with a corrupt durable target",
      systemPrompt: "Write index.html",
      runner,
      publicationTestHooks: {
        async afterPhase(phase) {
          if (phase !== "target") return;
          const versions = join(dataDir, "projects", projectId, "design", "nodes", "node-page", "versions");
          const [versionId] = await readdir(versions);
          assert.ok(versionId);
          await writeFile(join(versions, versionId, "index.html"), "tampered target");
          throw new Error("injected target corruption");
        },
      },
    });

    await assert.rejects(started.completion, /checksum|payload|publication/i);
    await assert.rejects(
      getDesignCanvas(dataDir, projectId),
      /publication recovery must complete/i,
    );
    const job = JSON.parse(await readFile(
      join(dataDir, "projects", projectId, "design", "jobs", `${started.job.id}.json`),
      "utf8",
    ));
    const project = JSON.parse(await readFile(
      join(dataDir, "projects", projectId, "design", "project.json"),
      "utf8",
    ));
    assert.equal(job.status, "validating");
    assert.equal(project.nodes[0]?.activeJobId, job.id);
    assert.equal(project.nodes[0]?.currentVersionId, null);
    assert.deepEqual(
      await readdir(join(dataDir, "projects", projectId, "design", "transactions", "publications")),
      [`${job.id}.json`],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a repeated Node Agent idempotency key returns one durable Job without dispatching twice", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-idempotency-"));
  const projectId = "project-idempotency";
  let calls = 0;
  const runner: AgentRunner = {
    id: "counting-fake",
    async runTurn(input) {
      calls += 1;
      const html = "<!doctype html><html><head></head><body>Exactly once</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "done", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const first = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate once",
      systemPrompt: "Write index.html",
      runner,
      idempotencyKey: "turn-once",
    });
    const duplicate = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate once",
      systemPrompt: "Write index.html",
      runner,
      idempotencyKey: "turn-once",
    });
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.job.id, first.job.id);
    await first.completion;
    assert.equal(calls, 1);
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent fails closed and records the observed model when runtime identity differs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-identity-mismatch-"));
  const projectId = "project-identity-mismatch";
  const runner: AgentRunner = {
    id: "codebuddy",
    async runTurn() {
      throw new AgentExecutionIdentityError(
        "codebuddy reported a different runtime model",
        { providerId: "codebuddy", model: "hy3-ioa" },
        {
          providerId: "codebuddy",
          model: "claude-opus-4.8-1m",
          command: "codebuddy",
          cliVersion: null,
          apiKeySource: "copilot.tencent.com",
          protocol: "claude-stream-json-init-v1",
        },
      );
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with the requested model",
      systemPrompt: "Write index.html",
      runner,
      model: "hy3-ioa",
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "claude-opus-4.8-1m");
    assert.match(completed.error ?? "", /different runtime model/i);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed Node Agent records the runtime identity attested before a provider error", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-provider-error-"));
  const projectId = "project-provider-error";
  const runner: AgentRunner = {
    id: "codebuddy",
    identityProtocol: "claude-stream-json-init-v1",
    async runTurn() {
      throw new AgentTurnError(
        "codebuddy returned an error result: authentication expired",
        {
          requested: { providerId: "codebuddy", model: null },
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
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with the provider default model",
      systemPrompt: "Write index.html",
      runner,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /authentication expired/i);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed Node Agent records the runtime identity attested before a nonzero CLI exit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-cli-exit-"));
  const projectId = "project-cli-exit";
  const runner = new ClaudeCodeRunner({
    id: "codebuddy",
    command: "codebuddy",
    spawner: {
      run: async () => ({
        stdout: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            model: "hy3-ioa",
            apiKeySource: "copilot.tencent.com",
            claude_code_version: "2.132.0",
          }),
          JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
        ].join("\n"),
        stderr: "provider process crashed",
        exitCode: 1,
      }),
    },
  });
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with the provider default model",
      systemPrompt: "Write index.html",
      runner,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /exit code 1.*provider process crashed/i);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cancelling an active Node Agent aborts it and preserves the last good head", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-cancel-"));
  const projectId = "project-cancel";
  let releaseStarted!: () => void;
  const startedRunning = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const runner: AgentRunner = {
    id: "blocking-fake",
    async runTurn(input) {
      releaseStarted();
      return new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(input.signal?.reason ?? new DOMException("cancelled", "AbortError"));
        input.signal?.addEventListener("abort", rejectAbort, { once: true });
        if (input.signal?.aborted) rejectAbort();
      });
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const previous = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>Last good</body></html>",
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Replace this page",
      systemPrompt: "Write index.html",
      runner,
      model: "cancel-fixture-model",
    });
    await startedRunning;
    const cancelled = await cancelDesignNodeTurn(dataDir, projectId, started.job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.runnerId, "blocking-fake");
    assert.equal(cancelled.model, "cancel-fixture-model");
    const completed = await started.completion;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.runnerId, cancelled.runnerId);
    assert.equal(completed.model, cancelled.model);
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.currentVersionId, previous.manifest.id);
    assert.equal(node.selectedVersionId, previous.manifest.id);
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "cancelled");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a material Node Agent is analysis-only and cannot publish a Design version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-material-agent-"));
  const projectId = "project-material-agent";
  const runner: AgentRunner = {
    id: "material-analysis-fake",
    async runTurn(input) {
      const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
      assert.equal(context.targetNodeId, "node-image");
      const placeholder = await readFile(join(input.projectDir, "index.html"), "utf8");
      return { text: "The image establishes a warm editorial direction.", artifactHtml: placeholder, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("reference"),
    ]);
    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [{
        asset: { name: "reference.png", mimeType: "image/png", base64: bytes.toString("base64") },
        binding: { type: "create-node", node: { id: "node-image", kind: "image" } },
      }],
    });
    const importedNode = imported.nodes[0]!;
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-image",
      message: "What should the rest of the design learn from this?",
      systemPrompt: "Analyze only; do not generate design output.",
      runner,
      model: "analysis-fixture-model",
    });
    assert.equal(started.job.kind, "node-analysis");
    assert.equal(started.job.runnerId, "material-analysis-fake");
    assert.equal(started.job.model, "analysis-fixture-model");
    const completed = await started.completion;
    assert.equal(completed.status, "ready");
    assert.equal(completed.runnerId, started.job.runnerId);
    assert.equal(completed.model, started.job.model);
    const versions = await listDesignVersions(dataDir, projectId, "node-image");
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.contentKind, "asset");
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.currentVersionId, importedNode.currentVersionId);
    assert.equal(node.versionCount, 1);
    assert.equal(node.state, "ready");
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-image" });
    assert.match(thread.messages.at(-1)?.content ?? "", /warm editorial/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("material Node analysis is single-flight, cancellable, and retains its Asset", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-material-single-flight-"));
  const projectId = "project-material-single-flight";
  let releaseStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const runner: AgentRunner = {
    id: "blocking-analysis-fake",
    async runTurn(input) {
      releaseStarted();
      return new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(input.signal?.reason ?? new DOMException("cancelled", "AbortError"));
        input.signal?.addEventListener("abort", rejectAbort, { once: true });
        if (input.signal?.aborted) rejectAbort();
      });
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("single flight"),
    ]);
    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [{
        asset: { name: "reference.png", mimeType: "image/png", base64: bytes.toString("base64") },
        binding: { type: "create-node", node: { id: "node-image", kind: "image" } },
      }],
    });
    const assetId = imported.nodes[0]!.assetId;
    const first = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-image", message: "Analyze", systemPrompt: "Analyze only", runner,
    });
    await runnerStarted;
    await assert.rejects(startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-image", message: "Analyze twice", systemPrompt: "Analyze only", runner,
    }), /active Job/i);
    assert.equal((await cancelDesignNodeTurn(dataDir, projectId, first.job.id)).status, "cancelled");
    assert.equal((await first.completion).status, "cancelled");
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.assetId, assetId);
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "cancelled");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node thread append failure terminalizes the queued Job and clears active ownership", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-thread-failure-"));
  const projectId = "project-thread-failure";
  let calls = 0;
  const runner: AgentRunner = {
    id: "must-not-run",
    async runTurn() {
      calls += 1;
      return { text: "unexpected", artifactHtml: "unexpected" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    thread.messages = Array.from({ length: 2_000 }, (_, index) => ({
      id: `message-${index}`,
      role: "user" as const,
      content: "bounded",
      jobId: null,
      createdAt: index,
    }));
    await writeFile(
      join(dataDir, "projects", projectId, "design", "nodes", "node-page", "agent", "thread.json"),
      `${JSON.stringify(thread)}\n`,
    );
    await assert.rejects(startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Cannot append", systemPrompt: "Generate", runner,
      model: "failed-fixture-model",
    }), /message limit/i);
    assert.equal(calls, 0);
    const jobs = await listDesignJobs(dataDir, projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "failed");
    assert.equal(jobs[0]?.runnerId, "must-not-run");
    assert.equal(jobs[0]?.model, "failed-fixture-model");
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "failed");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
