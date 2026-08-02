import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import type {
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import {
  buildDesignImplementationExportSystemPrompt,
  cancelDesignGlobalJob,
  parseDesignMainPlan,
  startDesignImplementationExport,
  startDesignMainTurn,
} from "../src/design/design-global-agents.ts";
import { findDesignExportChrome } from "../src/design/design-export-visual-gate.ts";
import {
  createDesignJob,
  designExportDirectory,
  designExportStagingDirectory,
  getDesignCanvas,
  getDesignJob,
  getDesignThread,
  initializeDesignProject,
  listDesignJobs,
  mutateDesignCanvas,
  publishDesignVersion,
  recoverInterruptedDesignJobs,
  storeDesignAsset,
  updateDesignJob,
} from "../src/design/design-storage.ts";

const SOURCE_HTML = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{margin:0}.frozen{color:#17202a}</style></head><body><main class=\"frozen\">RAW_SNAPSHOT_SENTINEL_92c676</main></body></html>";

function runner(
  id: string,
  runTurn: (input: AgentTurnInput) => Promise<AgentTurnResult>,
): AgentRunner {
  return { id, runTurn };
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function successfulVisualGate(input: {
  stagingDir: string;
}): Promise<{
  visualValidation: {
    protocol: "dezin-design-export-visual-v1";
    receiptPath: string;
    receiptChecksum: string;
    caseCount: number;
    passed: true;
  };
  receiptChecksum: string;
}> {
  const receiptPath = "validation/visual/receipt.json";
  const evidence = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xz6vWQAAAABJRU5ErkJggg==", "base64");
  const evidenceFiles = ["source.png", "output.png", "diff.png"].map((name) => ({
    path: `validation/visual/node-page/desktop-${name}`,
    checksum: sha256(evidence),
    bytes: evidence.length,
  }));
  const receipt = Buffer.from(`${JSON.stringify({
    protocol: "dezin-design-export-visual-v1",
    cases: [{ nodeId: "node-page", viewport: "desktop", evidence: evidenceFiles }],
    passed: true,
  })}\n`);
  await mkdir(dirname(join(input.stagingDir, receiptPath)), { recursive: true });
  await Promise.all([
    writeFile(join(input.stagingDir, receiptPath), receipt),
    ...evidenceFiles.map(async (file) => {
      const path = join(input.stagingDir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, evidence);
    }),
  ]);
  const receiptChecksum = sha256(receipt);
  return {
    visualValidation: {
      protocol: "dezin-design-export-visual-v1",
      receiptPath,
      receiptChecksum,
      caseCount: 2,
      passed: true,
    },
    receiptChecksum,
  };
}

async function expectAbsent(path: string): Promise<void> {
  await assert.rejects(
    lstat(path),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

async function generatedProject(prefix: string): Promise<{
  dataDir: string;
  projectId: string;
  canvasRevision: number;
  versionId: string;
  versionChecksum: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const projectId = "project-global-agents";
  await initializeDesignProject(dataDir, projectId);
  await mutateDesignCanvas(dataDir, projectId, {
    expectedRevision: 0,
    intents: [{
      type: "add-node",
      node: { id: "node-page", kind: "page", name: "Frozen page" },
    }],
  });
  const published = await publishDesignVersion(dataDir, projectId, {
    nodeId: "node-page",
    html: SOURCE_HTML,
    contextHash: "a".repeat(64),
    canvasRevision: 1,
    expectedHeadVersionId: null,
    jobId: null,
    runnerId: "fixture",
    model: null,
  });
  const canvas = await getDesignCanvas(dataDir, projectId);
  return {
    dataDir,
    projectId,
    canvasRevision: canvas.revision,
    versionId: published.manifest.id,
    versionChecksum: published.manifest.checksum,
  };
}

async function writeFreshViteProject(input: AgentTurnInput): Promise<AgentTurnResult> {
  const packageJson = {
    name: "dezin-fresh-export",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    devDependencies: { typescript: "^6.0.3", vite: "^8.0.16" },
  };
  const index = "<!doctype html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Fresh implementation</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>";
  const main = `import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
const selectedNodeId = new URLSearchParams(window.location.search).get("dezin-node");
if (selectedNodeId !== "node-page") throw new Error("Unknown Design Node route");
const page = document.createElement("main");
page.className = "page";
page.dataset.dezinExportNodeId = "node-page";
const heading = document.createElement("h1");
heading.textContent = "A considered, engineered implementation";
page.append(heading);
app.append(page);
`;
  const styles = `:root { color: #17202a; background: #f4f0e8; font-family: ui-sans-serif, system-ui; }
body { margin: 0; }
.page { min-height: 100vh; display: grid; place-items: center; padding: 3rem; }
h1 { max-width: 12ch; font-size: clamp(2.5rem, 8vw, 7rem); line-height: .9; letter-spacing: -.07em; }
`;
  await mkdir(join(input.projectDir, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(input.projectDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(join(input.projectDir, "index.html"), index),
    writeFile(join(input.projectDir, "src", "main.ts"), main),
    writeFile(join(input.projectDir, "src", "styles.css"), styles),
  ]);
  return { text: "Fresh Vite implementation complete", artifactHtml: index, artifactPath: "index.html" };
}

async function writePixelMatchingViteProject(input: AgentTurnInput): Promise<AgentTurnResult> {
  const packageJson = {
    name: "dezin-pixel-matching-export",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    devDependencies: { typescript: "^6.0.3", vite: "^8.0.16" },
  };
  const index = "<!doctype html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Matching implementation</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>";
  const main = `import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
const selectedNodeId = new URLSearchParams(window.location.search).get("dezin-node");
if (selectedNodeId !== "node-page") throw new Error("Unknown Design Node route");
const page = document.createElement("main");
page.className = "frozen";
page.dataset.dezinExportNodeId = "node-page";
page.textContent = "RAW_SNAPSHOT_SENTINEL_92c676";
app.append(page);
`;
  await mkdir(join(input.projectDir, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(input.projectDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(join(input.projectDir, "index.html"), index),
    writeFile(join(input.projectDir, "src", "main.ts"), main),
    writeFile(join(input.projectDir, "src", "styles.css"), "body{margin:0}.frozen{color:#17202a}\n"),
  ]);
  return { text: "Pixel-matching Vite implementation complete", artifactHtml: index, artifactPath: "index.html" };
}

test("Main Agent accepts only an exact JSON command envelope", () => {
  const valid = JSON.stringify({
    reply: "I will arrange and delegate the requested Nodes.",
    canvasIntents: [{
      type: "add-node",
      node: { id: "node-home", kind: "page", name: "Home" },
    }],
    dispatches: [{
      nodeId: "node-home",
      message: "Generate the Home page.",
      contextNodeIds: [],
    }],
  });
  const parsed = parseDesignMainPlan(valid);
  assert.equal(parsed.canvasIntents.length, 1);
  assert.equal(parsed.dispatches[0]?.nodeId, "node-home");

  assert.throws(() => parseDesignMainPlan(`\`\`\`json\n${valid}\n\`\`\``), /exact JSON/i);
  assert.throws(() => parseDesignMainPlan(JSON.stringify({
    ...JSON.parse(valid),
    markdown: "not allowed",
  })), /unexpected field/i);
  assert.throws(() => parseDesignMainPlan(JSON.stringify({
    reply: "No union-field smuggling",
    canvasIntents: [{
      type: "add-node",
      node: { id: "node-home", kind: "page" },
      patch: { name: "ignored" },
    }],
    dispatches: [],
  })), /unexpected field/i);
  assert.throws(() => parseDesignMainPlan(JSON.stringify({
    reply: "No dispatch extras",
    canvasIntents: [],
    dispatches: [{ nodeId: "node-home", message: "go", contextNodeIds: [], parentJobId: "forged" }],
  })), /unexpected field/i);
});

test("Implementation Export prompt requires deterministic Node routes and visible identity markers", () => {
  const store = new Store(":memory:");
  try {
    const prompt = buildDesignImplementationExportSystemPrompt({
      settings: store.getSettings(),
      brief: "Reimplement the exact selected Versions.",
    });
    assert.match(prompt, /\/\?dezin-node=<exact Node id>/);
    assert.match(prompt, /exactly one visible element whose data-dezin-export-node-id equals the exact Node id/);
    assert.match(prompt, /compare every validation route.*desktop and mobile/i);
  } finally {
    store.close();
  }
});

test("Main Agent atomically applies Canvas commands and exposes best-effort child dispatch failures", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-dispatch-"));
  const projectId = "project-main-dispatch";
  try {
    await initializeDesignProject(dataDir, projectId);
    const plan = JSON.stringify({
      reply: "The two scoped Nodes are now arranged.",
      canvasIntents: [
        { type: "add-node", node: { id: "node-component", kind: "component", name: "Hero" } },
        { type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } },
      ],
      dispatches: [
        { nodeId: "node-component", message: "Generate the Hero component.", contextNodeIds: ["node-page"] },
        { nodeId: "node-page", message: "Generate the Home page.", contextNodeIds: ["node-component"] },
      ],
    });
    const childJobs: string[] = [];
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Create a component and a page, then delegate both.",
      runner: runner("main-plan", async () => ({ text: plan, artifactHtml: "" })),
      systemPrompt: "Return the exact orchestration JSON envelope.",
      async dispatchNode(dispatch, parentJobId) {
        if (dispatch.nodeId === "node-page") throw new Error("provider unavailable");
        const created = await createDesignJob(dataDir, projectId, {
          kind: "node-generation",
          nodeId: dispatch.nodeId,
          parentJobId,
        });
        childJobs.push(created.job.id);
        return created.job;
      },
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Main Agent did not complete");

    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.revision, 2, "one Canvas CAS plus one child Job state transition");
    assert.deepEqual(canvas.nodeOrder, ["node-component", "node-page"]);
    assert.equal(childJobs.length, 1);
    const child = await getDesignJob(dataDir, projectId, childJobs[0]!);
    assert.equal(child.parentJobId, started.job.id);
    assert.equal(child.nodeId, "node-component");

    const parent = await getDesignJob(dataDir, projectId, started.job.id);
    assert.equal(parent.status, "ready");
    assert.ok(parent.activity.some((entry) => /Applied 2 atomic Canvas commands/.test(entry.text)));
    assert.ok(parent.activity.some((entry) => /Scoped Agent dispatch failed.*node-page.*provider unavailable/.test(entry.text)));
    const thread = await getDesignThread(dataDir, projectId, { type: "main" });
    const reply = thread.messages.at(-1);
    assert.equal(reply?.role, "assistant");
    assert.match(reply?.content ?? "", /Dispatched 1 of 2/);
    assert.match(reply?.content ?? "", /Dispatch failures:[\s\S]*node-page: provider unavailable/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed Canvas intent rolls back every command in the Main Agent CAS", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-atomic-"));
  const projectId = "project-main-atomic";
  try {
    await initializeDesignProject(dataDir, projectId);
    const plan = JSON.stringify({
      reply: "This plan must not partially apply.",
      canvasIntents: [
        { type: "add-node", node: { id: "node-must-rollback", kind: "page" } },
        { type: "remove-node", nodeId: "node-does-not-exist" },
      ],
      dispatches: [],
    });
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Try the invalid batch.",
      runner: runner("invalid-main-plan", async () => ({ text: plan, artifactHtml: "" })),
      systemPrompt: "Return exact JSON.",
      dispatchNode: async () => { throw new Error("must not dispatch"); },
    });
    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodes, []);
    assert.equal((await getDesignCanvas(dataDir, projectId)).revision, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Main Agent safely rebases its atomic plan across viewport-only revisions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-viewport-rebase-"));
  const projectId = "project-main-viewport-rebase";
  let releasePlan!: () => void;
  let markPlanning!: () => void;
  const planning = new Promise<void>((resolve) => { markPlanning = resolve; });
  const release = new Promise<void>((resolve) => { releasePlan = resolve; });
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page", name: "Before" } }],
    });
    const plan = JSON.stringify({
      reply: "Renamed the page after the camera movement.",
      canvasIntents: [{ type: "update-node", nodeId: "node-page", patch: { name: "After" } }],
      dispatches: [],
    });
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Rename the page.",
      runner: runner("main-viewport-rebase", async () => {
        markPlanning();
        await release;
        return { text: plan, artifactHtml: "" };
      }),
      systemPrompt: "Return exact JSON.",
      dispatchNode: async () => { throw new Error("must not dispatch"); },
    });
    await planning;
    const beforeViewport = await getDesignCanvas(dataDir, projectId);
    const viewportSaved = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: beforeViewport.revision,
      intents: [{ type: "set-viewport", viewport: { x: 144, y: -72, zoom: 1.35 } }],
    });
    releasePlan();

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Main plan did not rebase");
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.nodes[0]?.name, "After");
    assert.deepEqual(canvas.viewport, viewportSaved.viewport);
    assert.ok(completed.activity.some((entry) => /Rebased Main Agent plan across viewport-only Canvas revisions/.test(entry.text)));
  } finally {
    releasePlan?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Main Agent rejects layout, Version, and Asset authority changes made while it is planning", async (t) => {
  const scenarios: Array<{
    name: string;
    mutate: (dataDir: string, projectId: string) => Promise<void>;
  }> = [
    {
      name: "layout",
      async mutate(dataDir, projectId) {
        const canvas = await getDesignCanvas(dataDir, projectId);
        await mutateDesignCanvas(dataDir, projectId, {
          expectedRevision: canvas.revision,
          intents: [{ type: "update-node", nodeId: "node-page", patch: { geometry: { x: 480 } } }],
        });
      },
    },
    {
      name: "Version head",
      async mutate(dataDir, projectId) {
        const canvas = await getDesignCanvas(dataDir, projectId);
        await publishDesignVersion(dataDir, projectId, {
          nodeId: "node-page",
          html: "<!doctype html><html><head></head><body>new authority</body></html>",
          contextHash: "c".repeat(64),
          canvasRevision: canvas.revision,
          expectedHeadVersionId: null,
          jobId: null,
          runnerId: "fixture",
          model: null,
        });
      },
    },
    {
      name: "Asset binding",
      async mutate(dataDir, projectId) {
        const asset = await storeDesignAsset(dataDir, projectId, {
          name: "context.png",
          mimeType: "image/png",
          base64: Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from("context"),
          ]).toString("base64"),
        });
        const canvas = await getDesignCanvas(dataDir, projectId);
        await mutateDesignCanvas(dataDir, projectId, {
          expectedRevision: canvas.revision,
          intents: [{ type: "add-node", node: { id: "node-context", kind: "image", assetId: asset.id } }],
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-semantic-conflict-"));
      const projectId = `project-main-semantic-${scenario.name.replaceAll(" ", "-").toLowerCase()}`;
      let releasePlan!: () => void;
      let markPlanning!: () => void;
      const planning = new Promise<void>((resolve) => { markPlanning = resolve; });
      const release = new Promise<void>((resolve) => { releasePlan = resolve; });
      try {
        await initializeDesignProject(dataDir, projectId);
        await mutateDesignCanvas(dataDir, projectId, {
          expectedRevision: 0,
          intents: [{ type: "add-node", node: { id: "node-page", kind: "page", name: "Authority" } }],
        });
        const started = await startDesignMainTurn({
          dataDir,
          projectId,
          message: "Plan without overwriting concurrent semantic work.",
          runner: runner(`main-semantic-${scenario.name}`, async () => {
            markPlanning();
            await release;
            return {
              text: JSON.stringify({ reply: "No commands.", canvasIntents: [], dispatches: [] }),
              artifactHtml: "",
            };
          }),
          systemPrompt: "Return exact JSON.",
          dispatchNode: async () => { throw new Error("must not dispatch"); },
        });
        await planning;
        await scenario.mutate(dataDir, projectId);
        releasePlan();
        const completed = await started.completion;
        assert.equal(completed.status, "failed");
        assert.match(completed.error ?? "", /Canvas semantics changed while Main Agent was planning/);
      } finally {
        releasePlan?.();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("Main Agent cannot write design content anywhere in its staged turn", async (t) => {
  const scenarios = [
    { name: "compatibility index", path: "index.html", content: "<!doctype html><body>generated design</body>" },
    { name: "root design file", path: "generated.html", content: "<main>generated design</main>" },
    { name: "extra context file", path: ".context/generated.html", content: "<main>generated design</main>" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-write-"));
      const projectId = "project-main-write";
      try {
        await initializeDesignProject(dataDir, projectId);
        const plan = JSON.stringify({ reply: "No mutation", canvasIntents: [], dispatches: [] });
        const started = await startDesignMainTurn({
          dataDir,
          projectId,
          message: "Do not generate design content.",
          runner: runner(`main-write-${scenario.name}`, async (input) => {
            const path = join(input.projectDir, scenario.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, scenario.content);
            return { text: plan, artifactHtml: scenario.content };
          }),
          systemPrompt: "Orchestrate only.",
          dispatchNode: async () => { throw new Error("must not dispatch"); },
        });
        const completed = await started.completion;
        assert.equal(completed.status, "failed");
        assert.match(completed.error ?? "", /design content|unauthorized|context/i);
        assert.equal((await getDesignCanvas(dataDir, projectId)).revision, 0);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("Implementation Export cannot freeze a last-good Version while its Node is regenerating", async () => {
  const fixture = await generatedProject("dezin-design-export-live-node-");
  try {
    await createDesignJob(fixture.dataDir, fixture.projectId, {
      kind: "node-generation",
      nodeId: "node-page",
      expectedCanvasRevision: fixture.canvasRevision,
    });
    const liveCanvas = await getDesignCanvas(fixture.dataDir, fixture.projectId);
    assert.equal(liveCanvas.nodes[0]?.currentVersionId, fixture.versionId);
    assert.equal(liveCanvas.nodes[0]?.state, "queued");

    await assert.rejects(
      startDesignImplementationExport({
        dataDir: fixture.dataDir,
        projectId: fixture.projectId,
        canvasRevision: liveCanvas.revision,
        runner: runner("must-not-export", writeFreshViteProject),
        systemPrompt: "Produce a fresh implementation.",
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        visualGate: successfulVisualGate,
      }),
      /Wait for Node generation to finish before exporting: Frozen page/,
    );
    assert.equal(
      (await listDesignJobs(fixture.dataDir, fixture.projectId))
        .filter((job) => job.kind === "implementation-export").length,
      0,
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export publishes a fresh built Vite project with a byte-bound immutable manifest", async () => {
  const fixture = await generatedProject("dezin-design-export-ready-");
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("fresh-vite", writeFreshViteProject),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Implementation Export did not complete");
    assert.equal(completed.exportId, started.exportId);

    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId);
    await expectAbsent(join(finalDir, ".context"));
    for (const required of [
      "package.json",
      "index.html",
      "src/main.ts",
      "src/styles.css",
      "dist/index.html",
      "dezin-export.json",
    ]) {
      assert.equal((await lstat(join(finalDir, required))).isFile(), true, required);
    }
    const source = await readFile(join(finalDir, "src", "main.ts"), "utf8");
    assert.doesNotMatch(source, /RAW_SNAPSHOT_SENTINEL|iframe|innerHTML|\.context/);

    const manifestPath = join(finalDir, "dezin-export.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal((await lstat(manifestPath)).mode & 0o777, 0o400);
    assert.equal(manifest.id, started.exportId);
    assert.equal(manifest.projectId, fixture.projectId);
    assert.equal(manifest.canvasRevision, fixture.canvasRevision);
    assert.equal(manifest.visualValidation.protocol, "dezin-design-export-visual-v1");
    assert.equal(manifest.visualValidation.receiptPath, "validation/visual/receipt.json");
    assert.equal(manifest.visualValidation.caseCount, 2);
    assert.equal(manifest.visualValidation.passed, true);
    const receiptBytes = await readFile(join(finalDir, manifest.visualValidation.receiptPath));
    assert.equal(manifest.visualValidation.receiptChecksum, sha256(receiptBytes));
    assert.deepEqual(manifest.nodes, [{
      nodeId: "node-page",
      nodeKind: "page",
      versionId: fixture.versionId,
      checksum: fixture.versionChecksum,
    }]);
    assert.equal(manifest.outputFiles.some((file: { path: string }) => file.path === "dezin-export.json"), false);
    assert.equal(manifest.outputFiles.find((file: { path: string }) => file.path === manifest.visualValidation.receiptPath)?.checksum, manifest.visualValidation.receiptChecksum);
    for (const evidencePath of [
      "validation/visual/node-page/desktop-source.png",
      "validation/visual/node-page/desktop-output.png",
      "validation/visual/node-page/desktop-diff.png",
    ]) assert.ok(manifest.outputFiles.some((file: { path: string }) => file.path === evidencePath), evidencePath);
    const sorted = [...manifest.outputFiles].sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(manifest.outputFiles, sorted);
    assert.equal(manifest.outputHash, sha256(JSON.stringify(sorted)));
    for (const output of manifest.outputFiles as Array<{ path: string; checksum: string; bytes: number }>) {
      const bytes = await readFile(join(finalDir, output.path));
      assert.equal(bytes.byteLength, output.bytes, output.path);
      assert.equal(sha256(bytes), output.checksum, output.path);
    }
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export default pipeline publishes only after a real Chrome visual receipt", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the default Design Export visual pipeline");
    return;
  }
  const fixture = await generatedProject("dezin-design-export-default-visual-");
  const sourceServer = createServer((request, response) => {
    if (request.url === `/api/projects/${fixture.projectId}/design-canvas/nodes/node-page/versions/${fixture.versionId}/preview/`) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(SOURCE_HTML);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("pixel-matching-vite", writePixelMatchingViteProject),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: `http://127.0.0.1:${port}`,
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Default visual export did not complete");
    assert.ok(completed.activity.some((entry) => /Visual gate passed 2 desktop\/mobile comparisons; receipt [a-f0-9]{64}/.test(entry.text)));

    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId);
    const manifest = JSON.parse(await readFile(join(finalDir, "dezin-export.json"), "utf8"));
    const receiptBytes = await readFile(join(finalDir, manifest.visualValidation.receiptPath));
    assert.equal(manifest.visualValidation.receiptChecksum, sha256(receiptBytes));
    assert.equal(manifest.outputFiles.find((file: { path: string }) => file.path === manifest.visualValidation.receiptPath)?.checksum, sha256(receiptBytes));
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      contextHash: string;
      cases: Array<{
        nodeId: string;
        versionId: string;
        versionChecksum: string;
        viewport: { name: string };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
    };
    assert.equal(receipt.contextHash, manifest.inputHash);
    assert.deepEqual(receipt.cases.map((entry) => entry.viewport.name), ["desktop", "mobile"]);
    for (const visualCase of receipt.cases) {
      assert.equal(visualCase.nodeId, "node-page");
      assert.equal(visualCase.versionId, fixture.versionId);
      assert.equal(visualCase.versionChecksum, fixture.versionChecksum);
      for (const evidence of Object.values(visualCase.evidence)) {
        const bytes = await readFile(join(finalDir, evidence.path));
        assert.equal(bytes.length, evidence.bytes);
        assert.equal(sha256(bytes), evidence.checksum);
      }
    }
  } finally {
    sourceServer.closeAllConnections();
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export visual mismatch fails with Node metrics and never publishes", async () => {
  const fixture = await generatedProject("dezin-design-export-visual-failure-");
  const summary = "Visual gate failed for Frozen page (node-page) at mobile 390x844: MAE 0.1420, changed 31.00%, SSIM 0.7100, p05 0.1200";
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("visual-mismatch", writeFreshViteProject),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: async () => { throw new Error(summary); },
    });
    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /Frozen page \(node-page\).*mobile 390x844.*MAE 0\.1420.*SSIM 0\.7100/);
    assert.ok(completed.activity.some((entry) => entry.kind === "status" && entry.text.includes(summary)));
    const thread = await getDesignThread(fixture.dataDir, fixture.projectId, { type: "main" });
    assert.match(thread.messages.at(-1)?.content ?? "", /Implementation export failed.*node-page.*mobile 390x844.*MAE/i);
    await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
    await expectAbsent(designExportStagingDirectory(fixture.dataDir, fixture.projectId, started.exportId));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export cancellation during visual validation disposes the gate and staging", async () => {
  const fixture = await generatedProject("dezin-design-export-visual-cancel-");
  let markGateStarted!: () => void;
  const gateStarted = new Promise<void>((resolve) => { markGateStarted = resolve; });
  let disposed = false;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("visual-cancel", writeFreshViteProject),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: async (input) => {
        markGateStarted();
        try {
          return await new Promise<never>((_resolve, reject) => {
            const fail = () => reject(input.signal.reason ?? new DOMException("aborted", "AbortError"));
            if (input.signal.aborted) fail();
            else input.signal.addEventListener("abort", fail, { once: true });
          });
        } finally {
          disposed = true;
        }
      },
    });
    await gateStarted;
    const cancelled = await cancelDesignGlobalJob(fixture.dataDir, fixture.projectId, started.job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await started.completion).status, "cancelled");
    assert.equal(disposed, true);
    await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
    await expectAbsent(designExportStagingDirectory(fixture.dataDir, fixture.projectId, started.exportId));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export rejects iframe, innerHTML, context coupling, and raw HTML snapshots", async (t) => {
  const scenarios: Array<{
    name: string;
    mutate: (input: AgentTurnInput) => Promise<void>;
    error: RegExp;
  }> = [
    {
      name: "iframe wrapper",
      async mutate(input) {
        await writeFile(
          join(input.projectDir, "index.html"),
          "<!doctype html><html><body><div id=\"app\"></div><iframe src=\"about:blank\"></iframe><script type=\"module\" src=\"/src/main.ts\"></script></body></html>",
        );
      },
      error: /index\.html|wrap a Canvas preview/i,
    },
    {
      name: "iframe created by implementation code",
      async mutate(input) {
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          "const frame = document.createElement('iframe');\nframe.src = '/snapshot.html';\ndocument.querySelector('#app')?.append(frame);\n",
        );
      },
      error: /fresh-code boundary/i,
    },
    {
      name: "innerHTML in a JavaScript side file",
      async mutate(input) {
        await writeFile(join(input.projectDir, "src", "legacy.js"), "document.querySelector('#app').innerHTML = '<main>wrapped</main>';\n");
      },
      error: /fresh-code boundary/i,
    },
    {
      name: "runtime context coupling",
      async mutate(input) {
        await writeFile(join(input.projectDir, "src", "context.ts"), "export const source = '.context/canvas.json';\n");
      },
      error: /fresh-code boundary/i,
    },
    {
      name: "copied immutable HTML snapshot",
      async mutate(input) {
        const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
        const selectedPath = context.nodes[0].selectedVersionPath as string;
        const snapshot = await readFile(join(input.projectDir, selectedPath));
        await mkdir(join(input.projectDir, "public"), { recursive: true });
        await writeFile(join(input.projectDir, "public", "snapshot.html"), snapshot);
      },
      error: /copied an immutable HTML snapshot/i,
    },
    {
      name: "raw snapshot passed to document.write",
      async mutate(input) {
        const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
        const selectedPath = context.nodes[0].selectedVersionPath as string;
        const snapshot = await readFile(join(input.projectDir, selectedPath), "utf8");
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          `document.open();\ndocument.write(${JSON.stringify(snapshot)});\ndocument.close();\n`,
        );
      },
      error: /fresh-code boundary|raw HTML/i,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await generatedProject("dezin-design-export-reject-");
      try {
        const invalid = runner(`invalid-${scenario.name}`, async (input) => {
          const result = await writeFreshViteProject(input);
          await scenario.mutate(input);
          return result;
        });
        const started = await startDesignImplementationExport({
          dataDir: fixture.dataDir,
          projectId: fixture.projectId,
          canvasRevision: fixture.canvasRevision,
          runner: invalid,
          systemPrompt: "Produce a fresh implementation.",
          sourcePreviewOrigin: "http://127.0.0.1:34567",
          visualGate: successfulVisualGate,
        });
        const completed = await started.completion;
        assert.equal(completed.status, "failed");
        assert.match(completed.error ?? "", scenario.error);
        await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
      } finally {
        await rm(fixture.dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("Implementation Export never publishes when its runner fails or is cancelled", async (t) => {
  await t.test("runner failure", async () => {
    const fixture = await generatedProject("dezin-design-export-failure-");
    try {
      const started = await startDesignImplementationExport({
        dataDir: fixture.dataDir,
        projectId: fixture.projectId,
        canvasRevision: fixture.canvasRevision,
        runner: runner("throwing-export", async () => { throw new Error("deterministic runner failure"); }),
        systemPrompt: "Produce a fresh implementation.",
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        visualGate: successfulVisualGate,
      });
      const completed = await started.completion;
      assert.equal(completed.status, "failed");
      assert.match(completed.error ?? "", /deterministic runner failure/);
      await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
      await expectAbsent(designExportStagingDirectory(fixture.dataDir, fixture.projectId, started.exportId));
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  await t.test("cancellation", async () => {
    const fixture = await generatedProject("dezin-design-export-cancel-");
    let markStarted!: () => void;
    const entered = new Promise<void>((resolve) => { markStarted = resolve; });
    try {
      const blocking = runner("blocking-export", async (input) => {
        markStarted();
        return new Promise<AgentTurnResult>((_resolve, reject) => {
          const fail = () => reject(input.signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (input.signal?.aborted) fail();
          else input.signal?.addEventListener("abort", fail, { once: true });
        });
      });
      const started = await startDesignImplementationExport({
        dataDir: fixture.dataDir,
        projectId: fixture.projectId,
        canvasRevision: fixture.canvasRevision,
        runner: blocking,
        systemPrompt: "Produce a fresh implementation.",
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        visualGate: successfulVisualGate,
      });
      await entered;
      const cancelled = await cancelDesignGlobalJob(fixture.dataDir, fixture.projectId, started.job.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal((await started.completion).status, "cancelled");
      await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
      await expectAbsent(designExportStagingDirectory(fixture.dataDir, fixture.projectId, started.exportId));
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });
});

test("Implementation Export start failure leaves a terminal Job instead of an orphan", async () => {
  const fixture = await generatedProject("dezin-design-export-thread-limit-");
  try {
    const thread = await getDesignThread(fixture.dataDir, fixture.projectId, { type: "main" });
    const timestamp = Date.now();
    const fullThread = {
      ...thread,
      messages: Array.from({ length: 2_000 }, (_, index) => ({
        id: `message-filled-${index}`,
        role: "system",
        content: "Thread capacity fixture",
        jobId: null,
        createdAt: timestamp,
      })),
      updatedAt: timestamp,
    };
    await writeFile(
      join(fixture.dataDir, "projects", fixture.projectId, "design", "agents", "main", "thread.json"),
      `${JSON.stringify(fullThread)}\n`,
    );
    await assert.rejects(
      startDesignImplementationExport({
        dataDir: fixture.dataDir,
        projectId: fixture.projectId,
        canvasRevision: fixture.canvasRevision,
        runner: runner("unused-export", writeFreshViteProject),
        systemPrompt: "Produce a fresh implementation.",
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        visualGate: successfulVisualGate,
      }),
      /message limit/i,
    );
    const jobs = (await listDesignJobs(fixture.dataDir, fixture.projectId))
      .filter((job) => job.kind === "implementation-export");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "failed");
    assert.match(jobs[0]?.error ?? "", /persist|thread|message/i);
    assert.ok(jobs[0]?.exportId);
    await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, jobs[0]!.exportId!));
    await expectAbsent(designExportStagingDirectory(fixture.dataDir, fixture.projectId, jobs[0]!.exportId!));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("restart recovery removes crash-window Export final and pending directories before cancellation", async () => {
  const fixture = await generatedProject("dezin-design-export-recovery-");
  const exportId = "export-crash-window";
  try {
    const created = await createDesignJob(fixture.dataDir, fixture.projectId, {
      kind: "implementation-export",
      expectedCanvasRevision: fixture.canvasRevision,
    });
    await updateDesignJob(fixture.dataDir, fixture.projectId, created.job.id, {
      status: "running",
      exportId,
    });
    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, exportId);
    const pendingDir = designExportStagingDirectory(fixture.dataDir, fixture.projectId, exportId);
    await Promise.all([
      mkdir(finalDir, { recursive: true }),
      mkdir(pendingDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(finalDir, "dezin-export.json"), "crash-window final"),
      writeFile(join(pendingDir, "index.html"), "crash-window pending"),
    ]);

    const recovered = await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 123_456);
    assert.deepEqual(recovered.map((job) => job.id), [created.job.id]);
    const job = await getDesignJob(fixture.dataDir, fixture.projectId, created.job.id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.cancelRequested, true);
    assert.match(job.error ?? "", /daemon restart/i);
    await expectAbsent(finalDir);
    await expectAbsent(pendingDir);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});
