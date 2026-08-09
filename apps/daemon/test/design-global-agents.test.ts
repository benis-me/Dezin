import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { preview, type PreviewServer } from "vite";
import {
  AgentTurnError,
  type AgentRunner,
  type AgentTurnInput,
  type AgentTurnResult,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import {
  DESIGN_EXPORT_CONTENT_SECURITY_POLICY,
  DESIGN_EXPORT_TYPESCRIPT_VERSION,
  DESIGN_EXPORT_VITE_VERSION,
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
  getDesignJobContext,
  getDesignThread,
  initializeDesignProject,
  importDesignCanvasAssetBatch,
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
    devDependencies: { typescript: DESIGN_EXPORT_TYPESCRIPT_VERSION, vite: DESIGN_EXPORT_VITE_VERSION },
  };
  const index = "<!doctype html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Fresh implementation</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>";
  const main = `import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
const selectedNodeId = new URLSearchParams(window.location.search).get("dezin-node");
if (selectedNodeId !== null && selectedNodeId !== "node-page") throw new Error("Unknown Design Node route");
const page = document.createElement("main");
page.className = "page";
page.dataset.dezinExportNodeId = "node-page";
const heading = document.createElement("h1");
heading.textContent = "A considered, engineered implementation";
const control = document.createElement("button");
control.type = "button";
control.textContent = "Toggle local detail";
control.addEventListener("click", () => page.toggleAttribute("data-detail-visible"));
page.append(heading, control);
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
    devDependencies: { typescript: DESIGN_EXPORT_TYPESCRIPT_VERSION, vite: DESIGN_EXPORT_VITE_VERSION },
  };
  const index = "<!doctype html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Matching implementation</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>";
  const main = `import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
const selectedNodeId = new URLSearchParams(window.location.search).get("dezin-node");
if (selectedNodeId !== null && selectedNodeId !== "node-page") throw new Error("Unknown Design Node route");
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

test("Main Agent accepts an ordinary text conversation without creating Canvas work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-conversation-"));
  const projectId = "project-main-conversation";
  let dispatchCalls = 0;
  try {
    await initializeDesignProject(dataDir, projectId);
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "你好",
      runner: runner("conversation", async () => ({
        text: "你好！有什么我可以帮你的？",
        artifactHtml: "",
      })),
      systemPrompt: "Converse normally unless Canvas work is requested.",
      async dispatchNode() {
        dispatchCalls += 1;
        throw new Error("conversation must not dispatch");
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Conversation failed");
    assert.equal(completed.conversationOnly, true);
    assert.equal(dispatchCalls, 0);
    assert.equal((await getDesignCanvas(dataDir, projectId)).revision, 0);
    const messages = (await getDesignThread(dataDir, projectId, { type: "main" })).messages;
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.equal(messages.at(-1)?.content, "你好！有什么我可以帮你的？");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export prompt requires deterministic Node routes and visible identity markers", () => {
  const store = new Store(":memory:");
  try {
    const prompt = buildDesignImplementationExportSystemPrompt({
      settings: store.getSettings(),
      brief: "Reimplement the exact selected Versions.",
    });
    assert.match(prompt, /ordinary \/ route must default to the exact first selected generative Node/i);
    assert.match(prompt, /\/\?dezin-node=<exact Node id>/);
    assert.match(prompt, /exactly one visible element whose data-dezin-export-node-id equals the exact Node id/);
    assert.match(prompt, /compare the ordinary root application with the first frozen Version and every deterministic Node route with its exact Version in Chrome/i);
    assert.match(prompt, /daemon-seeded byte-for-byte at public\/assets\/<assetId>\/<relative path>/i);
    assert.match(prompt, /do not alter or delete the seeded files/i);
    assert.match(prompt, /verify every Write path includes its required \.ts or \.css extension/i);
    assert.match(prompt, /at least one non-empty static src\/\*\*\/\*\.css stylesheet/i);
    assert.match(prompt, /every stylesheet imported through the TypeScript module graph/i);
    assert.match(prompt, /never place CSS in TypeScript strings or create\/inject style or link elements at runtime/i);
    assert.match(prompt, /scope route styles under each Node root/i);
    assert.match(prompt, /element bearing data-dezin-export-node-id is itself the route root/i);
    assert.match(prompt, /&\.board.*\[data-dezin-export-node-id\]\.board/i);
    assert.match(prompt, /never a descendant selector.*\[data-dezin-export-node-id\] \.board/i);
    assert.match(prompt, /Frozen Nodes may disagree in their :root variables and body typography/i);
    assert.match(prompt, /preserve each Version's exact custom-property values, font stack, font size, line height/i);
    assert.match(prompt, /Do not collapse Node-specific root\/body baselines into one shared global token declaration/i);
    assert.match(prompt, /one mistyped path makes the entire Export fail/i);
    assert.match(prompt, /every document\.createElement\/createElementNS tag argument.*static validation can prove safe/i);
    assert.match(prompt, /never define or use generic el\(tag, attrs\), svgEl\(tag, attrs\)/i);
    assert.match(prompt, /every value written to src, srcset, href, poster, action, or formAction must likewise be a literal or a finite same-scope immutable literal set/i);
    assert.match(prompt, /copying a function parameter or object property into a const does not make it proven/i);
    assert.match(prompt, /fresh-code bans also apply inside comments and displayed specimen\/code strings/i);
    assert.match(prompt, /never define generic a\(href, \.\.\.\) or img\(src, \.\.\.\) helpers/i);
    assert.match(prompt, /helper declaration, call arity, return type, and import exactly consistent under strict TypeScript/i);
    assert.match(prompt, /never add a declare module "\*\.css" augmentation inside a \.ts file/i);
    assert.match(prompt, /http:\/\/www\.w3\.org\/2000\/svg.*createElementNS/i);
    assert.match(prompt, new RegExp(`"typescript":"${DESIGN_EXPORT_TYPESCRIPT_VERSION}"`));
    assert.match(prompt, new RegExp(`"vite":"${DESIGN_EXPORT_VITE_VERSION}"`));
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
      runner: runner("main-plan", async () => ({
        text: plan,
        artifactHtml: "",
        executionIdentity: {
          requested: { providerId: "main-plan", model: null },
          observed: {
            providerId: "main-plan",
            model: "runtime-main-model",
            command: "main-plan",
            cliVersion: "1.0.0",
            apiKeySource: null,
            protocol: "claude-stream-json-init-v1",
          },
        },
      })),
      systemPrompt: "Return the exact orchestration JSON envelope.",
      async dispatchNode(dispatch, parentJobId) {
        if (dispatch.nodeId === "node-page") throw new Error("provider unavailable");
        const created = await createDesignJob(dataDir, projectId, {
          kind: "node-generation",
          runnerId: "child-fixture",
          model: "child-fixture-model",
          nodeId: dispatch.nodeId,
          parentJobId,
        });
        childJobs.push(created.job.id);
        return created.job;
      },
    });
    assert.equal(started.job.runnerId, "main-plan");
    assert.equal(started.job.model, null);
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Main Agent did not complete");
    assert.equal(completed.conversationOnly, false);

    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.revision, 2, "one Canvas CAS plus one child Job state transition");
    assert.deepEqual(canvas.nodeOrder, ["node-component", "node-page"]);
    assert.equal(childJobs.length, 1);
    const child = await getDesignJob(dataDir, projectId, childJobs[0]!);
    assert.equal(child.parentJobId, started.job.id);
    assert.equal(child.nodeId, "node-component");
    assert.equal(child.runnerId, "child-fixture");
    assert.equal(child.model, "child-fixture-model");

    const parent = await getDesignJob(dataDir, projectId, started.job.id);
    assert.equal(parent.status, "ready");
    assert.equal(parent.runnerId, started.job.runnerId);
    assert.equal(parent.model, "runtime-main-model");
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

test("Main Agent bounds a large reply plus dispatch failures before durable side effects complete", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-bounded-reply-"));
  const projectId = "project-main-bounded-reply";
  try {
    await initializeDesignProject(dataDir, projectId);
    const plan = JSON.stringify({
      reply: "x".repeat(256 * 1024 - 100),
      canvasIntents: [{ type: "add-node", node: { id: "node-bounded", kind: "page" } }],
      dispatches: [{ nodeId: "node-bounded", message: "Generate it", contextNodeIds: [] }],
    });
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Create one Node and report a bounded dispatch failure.",
      runner: runner("bounded-main-reply", async () => ({ text: plan, artifactHtml: "" })),
      systemPrompt: "Return exact orchestration JSON.",
      async dispatchNode() {
        throw new Error("界".repeat(8_000));
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Main Agent did not complete");
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.id, "node-bounded");
    const thread = await getDesignThread(dataDir, projectId, { type: "main" });
    const reply = thread.messages.at(-1)?.content ?? "";
    assert.ok(Buffer.byteLength(reply, "utf8") <= 256 * 1024);
    assert.match(reply, /Response truncated to fit the durable Agent thread\.$/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Main Agent reserves a complete thread turn before creating a Job or running orchestration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-thread-capacity-"));
  const projectId = "project-main-thread-capacity";
  let runnerCalls = 0;
  let dispatchCalls = 0;
  try {
    await initializeDesignProject(dataDir, projectId);
    await getDesignThread(dataDir, projectId, { type: "main" });
    const threadPath = join(dataDir, "projects", projectId, "design", "agents", "main", "thread.json");
    const thread = JSON.parse(await readFile(threadPath, "utf8"));
    thread.messages = Array.from({ length: 1_999 }, (_, index) => ({
      id: `message-seed-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Seed message ${index}`,
      jobId: null,
      createdAt: index,
    }));
    thread.updatedAt = 1_999;
    await writeFile(threadPath, `${JSON.stringify(thread, null, 2)}\n`);

    await assert.rejects(startDesignMainTurn({
      dataDir,
      projectId,
      message: "This turn cannot fit atomically.",
      runner: runner("capacity-main", async () => {
        runnerCalls += 1;
        return { text: JSON.stringify({ reply: "unused", canvasIntents: [], dispatches: [] }), artifactHtml: "" };
      }),
      systemPrompt: "Return exact JSON.",
      async dispatchNode() {
        dispatchCalls += 1;
        throw new Error("must not dispatch");
      },
    }), /capacity for a complete turn/i);
    assert.equal(runnerCalls, 0);
    assert.equal(dispatchCalls, 0);
    assert.deepEqual(await listDesignJobs(dataDir, projectId), []);
    assert.equal((await getDesignCanvas(dataDir, projectId)).revision, 0);
    assert.equal((await getDesignThread(dataDir, projectId, { type: "main" })).messages.length, 1_999);

    thread.messages.pop();
    await writeFile(threadPath, `${JSON.stringify(thread, null, 2)}\n`);
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "This exact turn fits.",
      runner: runner("capacity-main", async () => {
        runnerCalls += 1;
        return {
          text: JSON.stringify({ reply: "Capacity was reserved before work.", canvasIntents: [], dispatches: [] }),
          artifactHtml: "",
        };
      }),
      systemPrompt: "Return exact JSON.",
      async dispatchNode() {
        dispatchCalls += 1;
        throw new Error("must not dispatch");
      },
    });
    assert.equal((await started.completion).status, "ready");
    assert.equal(runnerCalls, 1);
    assert.equal(dispatchCalls, 0);
    const completedThread = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(completedThread.messages.length, 2_000);
    assert.equal(completedThread.messages.at(-1)?.role, "assistant");
    assert.equal(completedThread.messages.at(-1)?.content, "Capacity was reserved before work.");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed idempotent Main Agent turn retries as one successor and keeps its request binding", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-idempotency-"));
  const projectId = "project-main-idempotency";
  let calls = 0;
  const turnRunner = runner("claude", async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary provider failure");
    return {
      text: JSON.stringify({ reply: "Quick Start recovered.", canvasIntents: [], dispatches: [] }),
      artifactHtml: "",
    };
  });
  const turn = {
    dataDir,
    projectId,
    message: "Create the initial Design Canvas plan.",
    runner: turnRunner,
    systemPrompt: "Return exact JSON.",
    idempotencyKey: "initial-design-canvas",
    dispatchNode: async () => { throw new Error("must not dispatch"); },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const failed = await startDesignMainTurn(turn);
    assert.equal((await failed.completion).status, "failed");

    const retry = await startDesignMainTurn(turn);
    assert.equal(retry.reused, false);
    assert.notEqual(retry.job.id, failed.job.id);
    assert.equal((await retry.completion).status, "ready");
    assert.equal(calls, 2);

    const duplicate = await startDesignMainTurn(turn);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.job.id, retry.job.id);
    assert.equal(calls, 2);

    await assert.rejects(startDesignMainTurn({
      ...turn,
      message: "A different request must not alias the original Quick Start turn.",
    }), /different Design Agent request/i);
    assert.equal(calls, 2);
    const thread = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(thread.messages.length, 4);
    assert.match(thread.messages[1]?.content ?? "", /temporary provider failure/i);
    assert.equal(thread.messages.at(-1)?.content, "Quick Start recovered.");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an idempotent Main Agent plan is terminal-sticky after its atomic Canvas commit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-resume-canvas-"));
  const projectId = "project-main-resume-canvas";
  let runnerCalls = 0;
  let injected = false;
  const plan = JSON.stringify({
    reply: "The Page Node is ready for its scoped Agent.",
    canvasIntents: [{ type: "add-node", node: { id: "node-resumed-page", kind: "page" } }],
    dispatches: [],
  });
  const turn = {
    dataDir,
    projectId,
    message: "Create exactly one Page Node.",
    runner: runner("main-resume-canvas", async () => {
      runnerCalls += 1;
      return { text: plan, artifactHtml: "" };
    }),
    systemPrompt: "Return exact orchestration JSON.",
    idempotencyKey: "resume-canvas-once",
    dispatchNode: async () => { throw new Error("must not dispatch"); },
    executionTestHooks: {
      afterCanvasPlanApplied() {
        if (injected) return;
        injected = true;
        throw new Error("simulated process exit after Canvas commit");
      },
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const first = await startDesignMainTurn(turn);
    assert.equal((await first.completion).status, "failed");
    const committedCanvas = await getDesignCanvas(dataDir, projectId);
    assert.deepEqual(committedCanvas.nodeOrder, ["node-resumed-page"]);
    const project = JSON.parse(await readFile(
      join(dataDir, "projects", projectId, "design", "project.json"),
      "utf8",
    ));
    const receipt = project.turnReceipts["main-agent:main:resume-canvas-once"];
    assert.match(receipt.mainPlanHash, /^[a-f0-9]{64}$/);
    assert.equal(receipt.mainPlanAppliedRevision, committedCanvas.revision);

    const successor = await startDesignMainTurn(turn);
    assert.equal(successor.reused, true);
    assert.equal(successor.job.id, first.job.id);
    const completed = await successor.completion;
    assert.equal(completed.status, "failed");
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.deepEqual(canvas.nodeOrder, ["node-resumed-page"]);
    assert.equal(canvas.nodes.filter((node) => node.id === "node-resumed-page").length, 1);
    assert.equal(runnerCalls, 1, "a committed plan must not start another model turn");
    assert.equal((await listDesignJobs(dataDir, projectId)).filter((job) => job.kind === "main-agent").length, 1);

    const duplicate = await startDesignMainTurn(turn);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.job.id, first.job.id);
    assert.equal(runnerCalls, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an idempotent Main Agent turn never replays a child after its committed plan exits", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-resume-dispatch-"));
  const projectId = "project-main-resume-dispatch";
  let runnerCalls = 0;
  let injected = false;
  const dispatchKeys: string[] = [];
  const plan = JSON.stringify({
    reply: "The Page Node and its scoped generation are underway.",
    canvasIntents: [{ type: "add-node", node: { id: "node-dispatched-once", kind: "page" } }],
    dispatches: [{ nodeId: "node-dispatched-once", message: "Generate the page.", contextNodeIds: [] }],
  });
  const turn = {
    dataDir,
    projectId,
    message: "Create and dispatch exactly one Page Node.",
    runner: runner("main-resume-dispatch", async () => {
      runnerCalls += 1;
      return { text: plan, artifactHtml: "" };
    }),
    systemPrompt: "Return exact orchestration JSON.",
    idempotencyKey: "resume-dispatch-once",
    async dispatchNode(dispatch: { nodeId: string }, parentJobId: string, idempotencyKey?: string | null) {
      assert.ok(idempotencyKey);
      dispatchKeys.push(idempotencyKey);
      return (await createDesignJob(dataDir, projectId, {
        kind: "node-generation",
        runnerId: "child-resume-fixture",
        model: null,
        nodeId: dispatch.nodeId,
        parentJobId,
        idempotencyKey,
        promptHash: sha256("Generate the page."),
      })).job;
    },
    executionTestHooks: {
      afterDispatch() {
        if (injected) return;
        injected = true;
        throw new Error("simulated process exit after child Job commit");
      },
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const first = await startDesignMainTurn(turn);
    assert.equal((await first.completion).status, "failed");
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.activeJobId !== null, true);

    const successor = await startDesignMainTurn(turn);
    const completed = await successor.completion;
    assert.equal(successor.reused, true);
    assert.equal(successor.job.id, first.job.id);
    assert.equal(completed.status, "failed");
    assert.equal(runnerCalls, 1);
    assert.equal(dispatchKeys.length, 1, "the retry must not invoke child dispatch again");
    const jobs = await listDesignJobs(dataDir, projectId);
    const children = jobs.filter((job) => job.kind === "node-generation" && job.nodeId === "node-dispatched-once");
    assert.equal(jobs.filter((job) => job.kind === "main-agent").length, 1);
    assert.equal(children.length, 1, "the durable child dispatch must not be duplicated");
    assert.equal(children[0]?.parentJobId, first.job.id);
    assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodeOrder, ["node-dispatched-once"]);
    assert.match(
      (await getDesignThread(dataDir, projectId, { type: "main" })).messages.at(-1)?.content ?? "",
      /simulated process exit after child Job commit/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("exact Main Agent replay precedes current-context validation after its plan removes that context", async () => {
  for (const terminal of ["ready", "post-commit-failed"] as const) {
    const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-main-context-replay-${terminal}-`));
    const projectId = `project-main-context-replay-${terminal}`;
    let runnerCalls = 0;
    const turn = {
      dataDir,
      projectId,
      message: "Remove the referenced Research Node.",
      runner: runner(`main-context-replay-${terminal}`, async () => {
        runnerCalls += 1;
        return {
          text: JSON.stringify({
            reply: "Removed the Research Node.",
            canvasIntents: [{ type: "remove-node", nodeId: "node-context" }],
            dispatches: [],
          }),
          artifactHtml: "",
        };
      }),
      systemPrompt: "Return exact orchestration JSON.",
      contextNodeIds: ["node-context"],
      idempotencyKey: `context-replay-${terminal}`,
      dispatchNode: async () => { throw new Error("must not dispatch"); },
      ...(terminal === "ready" ? {} : {
        executionTestHooks: {
          afterCanvasPlanApplied() {
            throw new Error("simulated exit after removing the requested context");
          },
        },
      }),
    };
    try {
      await initializeDesignProject(dataDir, projectId);
      await mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: 0,
        intents: [{ type: "add-node", node: { id: "node-context", kind: "research" } }],
      });
      const first = await startDesignMainTurn(turn);
      assert.equal((await first.completion).status, terminal === "ready" ? "ready" : "failed");
      assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodes, []);

      const replay = await startDesignMainTurn(turn);
      assert.equal(replay.reused, true);
      assert.equal(replay.job.id, first.job.id);
      assert.equal((await replay.completion).status, terminal === "ready" ? "ready" : "failed");
      assert.equal(runnerCalls, 1);
      assert.equal((await listDesignJobs(dataDir, projectId)).filter((job) => job.kind === "main-agent").length, 1);

      await assert.rejects(startDesignMainTurn({
        ...turn,
        idempotencyKey: `fresh-missing-context-${terminal}`,
      }), /priority context references unavailable Node node-context/i);
      assert.equal(runnerCalls, 1, "a genuinely new turn must validate context before running the model");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("a failed Main Agent records the runtime identity attested before a provider error", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-provider-error-"));
  const projectId = "project-main-provider-error";
  try {
    await initializeDesignProject(dataDir, projectId);
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Coordinate the canvas using the provider default model.",
      runner: runner("codebuddy", async () => {
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
      }),
      systemPrompt: "Return orchestration JSON only.",
      async dispatchNode() {
        throw new Error("must not dispatch after a provider error");
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /authentication expired/i);
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
        const bytes = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from("context"),
        ]);
        const canvas = await getDesignCanvas(dataDir, projectId);
        await importDesignCanvasAssetBatch(dataDir, projectId, {
          expectedRevision: canvas.revision,
          items: [{
            asset: { name: "context.png", mimeType: "image/png", base64: bytes.toString("base64") },
            binding: { type: "create-node", node: { id: "node-context", kind: "image" } },
          }],
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
      runnerId: "active-node-fixture",
      model: null,
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
      runner: runner("fresh-vite", async (input) => {
        const result = await writeFreshViteProject(input);
        const mainPath = join(input.projectDir, "src", "main.ts");
        await Promise.all([
          rename(
            join(input.projectDir, "src", "styles.css"),
            join(input.projectDir, "src", "main.css"),
          ),
          readFile(mainPath, "utf8").then((main) => writeFile(
            mainPath,
            main.replace('import "./styles.css";', 'import "./main.css";'),
          )),
        ]);
        return {
          ...result,
          executionIdentity: {
            requested: { providerId: "fresh-vite", model: null },
            observed: {
              providerId: "fresh-vite",
              model: "runtime-export-model",
              command: "fresh-vite",
              cliVersion: "1.0.0",
              apiKeySource: null,
              protocol: "claude-stream-json-init-v1",
            },
          },
        };
      }),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });
    assert.equal(started.job.runnerId, "fresh-vite");
    assert.equal(started.job.model, null);
    const frozenContext = await getDesignJobContext(fixture.dataDir, fixture.projectId, started.job.id);
    assert.equal(frozenContext.checksum, started.job.contextHash);
    assert.deepEqual(
      frozenContext.nodes.map((node) => ({
        nodeId: node.id,
        jobId: node.selectedVersionJobId,
        runnerId: node.selectedVersionRunnerId,
        model: node.selectedVersionModel,
      })),
      [{ nodeId: "node-page", jobId: null, runnerId: "fixture", model: null }],
    );
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Implementation Export did not complete");
    assert.equal(completed.exportId, started.exportId);
    assert.equal(completed.runnerId, started.job.runnerId);
    assert.equal(completed.model, "runtime-export-model");

    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId);
    await expectAbsent(join(finalDir, ".context"));
    for (const required of [
      "package.json",
      "index.html",
      "src/main.ts",
      "src/main.css",
      "dist/index.html",
      "dezin-export.json",
    ]) {
      assert.equal((await lstat(join(finalDir, required))).isFile(), true, required);
    }
    const source = await readFile(join(finalDir, "src", "main.ts"), "utf8");
    assert.doesNotMatch(source, /RAW_SNAPSHOT_SENTINEL|iframe|innerHTML|\.context/);
    const publishedIndex = await readFile(join(finalDir, "index.html"), "utf8");
    assert.equal((publishedIndex.match(/http-equiv=["']Content-Security-Policy["']/gi) ?? []).length, 1);
    assert.match(publishedIndex, /connect-src 'none'/);
    assert.match(publishedIndex, /script-src 'self'/);

    const manifestPath = join(finalDir, "dezin-export.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal((await lstat(manifestPath)).mode & 0o777, 0o400);
    assert.equal(manifest.id, started.exportId);
    assert.equal(manifest.projectId, fixture.projectId);
    assert.equal(manifest.jobId, started.job.id);
    assert.equal(manifest.providerId, "fresh-vite");
    assert.equal(manifest.model, "runtime-export-model");
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
      sourceJobId: null,
      sourceProviderId: "fixture",
      sourceModel: null,
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

test("Implementation Export permits inert body comments without treating them as a wrapped preview", async () => {
  const fixture = await generatedProject("dezin-design-export-inert-html-comment-");
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("inert-html-comment", async (input) => {
        const result = await writeFreshViteProject(input);
        const indexPath = join(input.projectDir, "index.html");
        const index = await readFile(indexPath, "utf8");
        const commented = index.replace('<div id="app"></div>', '<!-- TypeScript renders the app; no iframe or srcdoc. --><div id="app"></div>');
        await writeFile(indexPath, commented);
        return { ...result, artifactHtml: commented };
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Inert HTML comment was treated as a wrapped preview");
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export ignores forbidden capability names in inert source comments", async () => {
  const fixture = await generatedProject("dezin-design-export-inert-comments-");
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("inert-comment", async (input) => {
        const result = await writeFreshViteProject(input);
        const mainPath = join(input.projectDir, "src", "main.ts");
        const main = await readFile(mainPath, "utf8");
        await writeFile(mainPath, `// Uses createElement; never innerHTML or DOMParser.\n${main}`);
        return result;
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Inert comment was treated as executable source");
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export accepts canonical SVG namespaces in typed DOM helpers", async () => {
  const fixture = await generatedProject("dezin-design-export-svg-namespace-");
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("svg-namespace", async (input) => {
        const result = await writeFreshViteProject(input);
        const mainPath = join(input.projectDir, "src", "main.ts");
        const main = await readFile(mainPath, "utf8");
        await writeFile(join(input.projectDir, "src", "dom.ts"), `export function svgMark(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 8h12");
  svg.append(path);
  return svg;
}\n`);
        await writeFile(mainPath, main
          .replace('import "./styles.css";', 'import "./styles.css";\nimport { svgMark } from "./dom";')
          .replace("app.append(page);", "app.append(page, svgMark());"));
        return result;
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Canonical SVG namespace was rejected as a remote URL");
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export retries once when the Agent stops after planning without writing index.html", async () => {
  const fixture = await generatedProject("dezin-design-export-plan-only-retry-");
  let calls = 0;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("plan-first", async (input) => {
        calls += 1;
        if (calls === 1) throw new Error("codebuddy artifact not updated: index.html");
        assert.match(input.message, /stopped after planning/i);
        return writeFreshViteProject(input);
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Plan-only retry failed");
    assert.equal(calls, 2);
    assert.ok(completed.activity.some((entry) => /retrying the same staged export once/i.test(entry.text)));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export retries once when the Agent leaves a partial required scaffold", async () => {
  const fixture = await generatedProject("dezin-design-export-partial-scaffold-retry-");
  let calls = 0;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("partial-first", async (input) => {
        calls += 1;
        const result = await writeFreshViteProject(input);
        if (calls === 1) {
          await Promise.all([
            rm(join(input.projectDir, "src", "main.ts")),
            rm(join(input.projectDir, "src", "styles.css")),
          ]);
          return result;
        }
        assert.match(input.message, /partial Implementation Export/i);
        assert.match(input.message, /src\/main\.ts/);
        assert.match(input.message, /src\/\*\*\/\*\.css/);
        assert.match(input.message, /rewrite index\.html/i);
        return result;
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Partial-scaffold retry failed");
    assert.equal(calls, 2);
    assert.ok(completed.activity.some((entry) => /incomplete scaffold.*src\/main\.ts.*retrying/is.test(entry.text)));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export continues one complete staged project after the first bounded turn times out", async () => {
  const fixture = await generatedProject("dezin-design-export-timeout-continuation-");
  let calls = 0;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("timeout-continuation", async (input) => {
        calls += 1;
        if (calls === 1) {
          await writeFreshViteProject(input);
          throw new Error("codebuddy timed out after 3000000ms");
        }
        assert.match(input.message, /prior bounded turn timed out/i);
        const indexPath = join(input.projectDir, "index.html");
        const index = await readFile(indexPath, "utf8");
        assert.match(index, /dezin-validation-repair-required/);
        const repaired = index.replace(/<div id="dezin-validation-repair-required">[^<]*<\/div>/, "");
        await writeFile(indexPath, repaired);
        return { text: "Completed the timed-out staged project", artifactHtml: repaired, artifactPath: "index.html" };
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Timeout continuation failed");
    assert.equal(calls, 2);
    assert.ok(completed.activity.some((entry) => /bounded turn ceiling.*continuing/i.test(entry.text)));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export gives one exact validation diagnostic back for an in-place repair", async () => {
  const fixture = await generatedProject("dezin-design-export-validation-repair-");
  let calls = 0;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("validation-repair", async (input) => {
        calls += 1;
        if (calls === 1) {
          const result = await writeFreshViteProject(input);
          const indexPath = join(input.projectDir, "index.html");
          const index = await readFile(indexPath, "utf8");
          await writeFile(indexPath, index.replace("</head>", '<link rel="stylesheet" href="/src/styles.css"></head>'));
          await writeFile(
            join(input.projectDir, "src", "broken.ts"),
            'const anchor = document.createElement("a");\nanchor.href = unknownExternalState;\n',
          );
          return result;
        }
        assert.match(input.message, /must load styles through the local TypeScript module graph/i);
        assert.match(input.message, /src\/broken\.ts.*assignment to href/is);
        assert.match(input.message, /TypeScript.*unknownExternalState/is);
        await writeFile(join(input.projectDir, "src", "broken.ts"), "export const repaired = true;\n");
        const indexPath = join(input.projectDir, "index.html");
        const index = await readFile(indexPath, "utf8");
        assert.match(index, /dezin-validation-repair-required/);
        const repaired = index
          .replace('<link rel="stylesheet" href="/src/styles.css">', "")
          .replace(/<div id="dezin-validation-repair-required">[^<]*<\/div>/, "");
        await writeFile(indexPath, repaired);
        return { text: "Repaired exact validation diagnostic", artifactHtml: repaired, artifactPath: "index.html" };
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Validation repair failed");
    assert.equal(calls, 2);
    assert.ok(completed.activity.some((entry) => /validation found a repairable issue/i.test(entry.text)));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export requires every stylesheet to be statically reachable from src/main.ts", async () => {
  const fixture = await generatedProject("dezin-design-export-stylesheet-graph-");
  let calls = 0;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("stylesheet-graph", async (input) => {
        calls += 1;
        const mainPath = join(input.projectDir, "src", "main.ts");
        if (calls === 1) {
          const result = await writeFreshViteProject(input);
          const main = await readFile(mainPath, "utf8");
          await writeFile(mainPath, main.replace('import "./styles.css";\n', ""));
          return result;
        }
        assert.match(input.message, /Every src stylesheet must be statically reachable from src\/main\.ts: src\/styles\.css/i);
        const main = await readFile(mainPath, "utf8");
        await writeFile(mainPath, `import "./styles.css";\n${main}`);
        const indexPath = join(input.projectDir, "index.html");
        const index = await readFile(indexPath, "utf8");
        const repaired = index.replace(/<div id="dezin-validation-repair-required">[^<]*<\/div>/, "");
        await writeFile(indexPath, repaired);
        return { text: "Connected the static stylesheet graph", artifactHtml: repaired, artifactPath: "index.html" };
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Unreachable stylesheet repair failed");
    assert.equal(calls, 2);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export never retries an unauthorized path that the confined Agent cannot delete", async () => {
  const fixture = await generatedProject("dezin-design-export-unrepairable-path-");
  let calls = 0;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("unrepairable-path", async (input) => {
        calls += 1;
        const result = await writeFreshViteProject(input);
        await writeFile(join(input.projectDir, "src", "mistyped-source"), "cannot be deleted by the confined Agent\n");
        return result;
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /unauthorized project file/i);
    assert.equal(calls, 1);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export accepts standard extensionless local TypeScript imports under src", async () => {
  const fixture = await generatedProject("dezin-design-export-extensionless-import-");
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("extensionless-import", async (input) => {
        const result = await writeFreshViteProject(input);
        await writeFile(
          join(input.projectDir, "src", "copy.ts"),
          `export const exportHeading = "A considered, engineered implementation";\n`,
        );
        const mainPath = join(input.projectDir, "src", "main.ts");
        const main = await readFile(mainPath, "utf8");
        await writeFile(
          mainPath,
          `import { exportHeading } from "./copy";\n${main.replace('heading.textContent = "A considered, engineered implementation";', "heading.textContent = exportHeading;")}`,
        );
        return result;
      }),
      systemPrompt: "Reimplement the frozen selected Design Canvas Versions.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Extensionless local import failed");
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export daemon-seeds approved frozen PNG Assets into immutable public paths", async () => {
  const fixture = await generatedProject("dezin-design-export-seeded-asset-");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xz6vWQAAAABJRU5ErkJggg==",
    "base64",
  );
  try {
    const asset = await storeDesignAsset(fixture.dataDir, fixture.projectId, {
      name: "context-pixel.png",
      mimeType: "image/png",
      base64: png.toString("base64"),
    });
    const canvas = await importDesignCanvasAssetBatch(fixture.dataDir, fixture.projectId, {
      expectedRevision: fixture.canvasRevision,
      items: [{
        asset: { name: "context-pixel.png", mimeType: "image/png", base64: png.toString("base64") },
        binding: {
          type: "create-node",
          node: { id: "node-context-image", kind: "image", name: "Context pixel" },
        },
      }],
    });
    const publicRelativePath = `public/assets/${asset.id}/${asset.fileName}`;
    const contextRelativePath = `.context/assets/${asset.id}/${asset.fileName}`;
    let runnerObservedSeed = false;
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: canvas.revision,
      runner: runner("seeded-public-asset", async (input) => {
        const contextPath = join(input.projectDir, ...contextRelativePath.split("/"));
        const publicPath = join(input.projectDir, ...publicRelativePath.split("/"));
        const [contextBytes, publicBytes, contextInfo, publicInfo] = await Promise.all([
          readFile(contextPath),
          readFile(publicPath),
          lstat(contextPath),
          lstat(publicPath),
        ]);
        assert.deepEqual(contextBytes, png);
        assert.deepEqual(publicBytes, png);
        assert.equal(publicInfo.mode & 0o777, 0o400);
        assert.equal(publicInfo.nlink, 1);
        assert.equal(contextInfo.dev === publicInfo.dev && contextInfo.ino === publicInfo.ino, false);
        assert.match(input.message, new RegExp(`${contextRelativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> /assets/`));
        runnerObservedSeed = true;
        return writeFreshViteProject(input);
      }),
      systemPrompt: "Reimplement the selected Canvas and preserve daemon-seeded public Assets.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Asset-seeded Export failed");
    assert.equal(runnerObservedSeed, true);
    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId);
    assert.deepEqual(await readFile(join(finalDir, ...publicRelativePath.split("/"))), png);
    const manifest = JSON.parse(await readFile(join(finalDir, "dezin-export.json"), "utf8"));
    assert.equal(
      manifest.outputFiles.find((file: { path: string }) => file.path === publicRelativePath)?.checksum,
      sha256(png),
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export validates and publishes a daemon-owned snapshot, not the Agent-writable tree", async () => {
  const fixture = await generatedProject("dezin-design-export-snapshot-");
  let agentDirectory = "";
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("snapshot-boundary", async (input) => {
        agentDirectory = input.projectDir;
        return writeFreshViteProject(input);
      }),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: async (input) => {
        assert.notEqual(input.stagingDir, agentDirectory);
        await writeFile(
          join(agentDirectory, "src", "main.ts"),
          "window.open('https://example.invalid/post-validation');\n",
        ).catch((error: NodeJS.ErrnoException) => {
          assert.equal(error.code, "ENOENT");
        });
        return successfulVisualGate(input);
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "snapshot-bound Export failed");
    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId);
    const published = await readFile(join(finalDir, "src", "main.ts"), "utf8");
    assert.match(published, /A considered, engineered implementation/);
    assert.doesNotMatch(published, /post-validation|window\.open/);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export rejects dependency versions that differ from its validated toolchain", async () => {
  const fixture = await generatedProject("dezin-design-export-toolchain-pin-");
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("wrong-toolchain", async (input) => {
        const result = await writeFreshViteProject(input);
        const packagePath = join(input.projectDir, "package.json");
        const packageFile = JSON.parse(await readFile(packagePath, "utf8"));
        packageFile.devDependencies = { typescript: "0.0.1", vite: "0.0.1" };
        await writeFile(packagePath, `${JSON.stringify(packageFile, null, 2)}\n`);
        return result;
      }),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });
    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /exact validated TypeScript and Vite versions/i);
    await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export CSP remains active under standard Vite preview", async (t) => {
  const chrome = findDesignExportChrome();
  if (!chrome) {
    t.skip("Chrome is required for the Implementation Export CSP check");
    return;
  }
  const fixture = await generatedProject("dezin-design-export-preview-csp-");
  let server: PreviewServer | undefined;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("preview-csp", writeFreshViteProject),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Implementation Export did not complete");
    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId);
    server = await preview({
      root: finalDir,
      configFile: false,
      logLevel: "silent",
      preview: { host: "127.0.0.1", port: 0 },
    });
    const address = server.httpServer.address() as AddressInfo;
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-background-networking", "--no-first-run"],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
    const policy = await page.$eval(
      'meta[http-equiv="Content-Security-Policy"]',
      (element) => element.getAttribute("content"),
    );
    assert.match(policy ?? "", /connect-src 'none'/);
    await page.click("button");
    assert.equal(await page.$eval("main", (element) => element.hasAttribute("data-detail-visible")), true);
    const violation = await page.evaluate(async () => {
      const scope = globalThis as any;
      const observed = new Promise<string>((resolveViolation) => {
        scope.addEventListener("securitypolicyviolation", (event: any) => resolveViolation(event.blockedURI), { once: true });
      });
      void scope.fetch("https://network.invalid/csp-proof").catch(() => {});
      return Promise.race([
        observed,
        new Promise<string>((resolveTimeout) => scope.setTimeout(() => resolveTimeout("timeout"), 2_000)),
      ]);
    });
    assert.match(violation, /network\.invalid/);
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export rejects a Content Security Policy declared after other head content", async () => {
  const fixture = await generatedProject("dezin-design-export-late-csp-");
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("late-csp", async (input) => {
        const result = await writeFreshViteProject(input);
        const indexPath = join(input.projectDir, "index.html");
        const index = await readFile(indexPath, "utf8");
        await writeFile(
          indexPath,
          index.replace(
            "</head>",
            `<meta http-equiv="Content-Security-Policy" content="${DESIGN_EXPORT_CONTENT_SECURITY_POLICY}"></head>`,
          ),
        );
        return result;
      }),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });
    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /Content Security Policy.*first head content/i);
    await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Implementation Export rejects source Version provenance changed after context freeze", async () => {
  const fixture = await generatedProject("dezin-design-export-provenance-race-");
  let markRunnerStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });
  let releaseRunner!: () => void;
  const runnerReleased = new Promise<void>((resolve) => { releaseRunner = resolve; });
  try {
    const started = await startDesignImplementationExport({
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      canvasRevision: fixture.canvasRevision,
      runner: runner("frozen-provenance", async (input) => {
        markRunnerStarted();
        await runnerReleased;
        return writeFreshViteProject(input);
      }),
      systemPrompt: "Reimplement the selected Canvas as fresh Vite and TypeScript source.",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      visualGate: successfulVisualGate,
    });
    await runnerStarted;

    const manifestPath = join(
      fixture.dataDir,
      "projects",
      fixture.projectId,
      "design",
      "nodes",
      "node-page",
      "versions",
      fixture.versionId,
      "manifest.json",
    );
    const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, `${JSON.stringify({
      ...sourceManifest,
      runnerId: "forged-provider",
      model: "forged-model",
    }, null, 2)}\n`);
    releaseRunner();

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /frozen source Version provenance changed/i);
    await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
  } finally {
    releaseRunner?.();
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
    assert.ok(completed.activity.some((entry) => /Visual gate passed 4 desktop\/mobile comparisons; receipt [a-f0-9]{64}/.test(entry.text)));

    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId);
    const manifest = JSON.parse(await readFile(join(finalDir, "dezin-export.json"), "utf8"));
    assert.equal(manifest.visualValidation.caseCount, 4);
    const receiptBytes = await readFile(join(finalDir, manifest.visualValidation.receiptPath));
    assert.equal(manifest.visualValidation.receiptChecksum, sha256(receiptBytes));
    assert.equal(manifest.outputFiles.find((file: { path: string }) => file.path === manifest.visualValidation.receiptPath)?.checksum, sha256(receiptBytes));
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      contextHash: string;
      jobId: string;
      providerId: string;
      model: string | null;
      rootChecks: Array<{
        nodeId: string;
        versionId: string;
        versionChecksum: string;
        sourceJobId: string | null;
        sourceProviderId: string | null;
        sourceModel: string | null;
        viewport: { name: string };
        metrics: { meanSsim: number };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
      cases: Array<{
        nodeId: string;
        versionId: string;
        versionChecksum: string;
        sourceJobId: string | null;
        sourceProviderId: string | null;
        sourceModel: string | null;
        viewport: { name: string };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
    };
    assert.equal(receipt.contextHash, manifest.inputHash);
    assert.equal(receipt.jobId, started.job.id);
    assert.equal(receipt.providerId, "pixel-matching-vite");
    assert.equal(receipt.model, null);
    assert.deepEqual(receipt.rootChecks.map((entry) => entry.viewport.name), ["desktop", "mobile"]);
    assert.equal(receipt.rootChecks.every((entry) => entry.nodeId === "node-page"
      && entry.versionId === fixture.versionId
      && entry.versionChecksum === fixture.versionChecksum
      && entry.sourceJobId === null
      && entry.sourceProviderId === "fixture"
      && entry.sourceModel === null
      && entry.metrics.meanSsim >= 0.95), true);
    for (const rootCheck of receipt.rootChecks) {
      assert.deepEqual(Object.keys(rootCheck.evidence), ["source", "output", "diff"]);
      for (const evidence of Object.values(rootCheck.evidence)) {
        const bytes = await readFile(join(finalDir, evidence.path));
        assert.equal(bytes.length, evidence.bytes);
        assert.equal(sha256(bytes), evidence.checksum);
      }
    }
    assert.deepEqual(receipt.cases.map((entry) => entry.viewport.name), ["desktop", "mobile"]);
    for (const visualCase of receipt.cases) {
      assert.equal(visualCase.nodeId, "node-page");
      assert.equal(visualCase.versionId, fixture.versionId);
      assert.equal(visualCase.versionChecksum, fixture.versionChecksum);
      assert.equal(visualCase.sourceJobId, null);
      assert.equal(visualCase.sourceProviderId, "fixture");
      assert.equal(visualCase.sourceModel, null);
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
        await writeFile(join(input.projectDir, "src", "legacy.ts"), "document.querySelector('#app')!.innerHTML = '<main>wrapped</main>';\n");
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
    {
      name: "network request hidden from Node validation routes",
      async mutate(input) {
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          `import "./styles.css";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
const nodeId = new URLSearchParams(location.search).get("dezin-node");
const page = document.createElement("main");
page.dataset.dezinExportNodeId = nodeId ?? "node-page";
page.textContent = "Local UI";
app.append(page);
if (nodeId === null) {
  const endpoint = ["ht", "tps:", "//example.invalid/telemetry"].join("");
  void fetch(endpoint, { method: "POST", body: "qa" });
}
`,
        );
      },
      error: /local self-contained UI|network|remote scripts or resources|fresh-code boundary/i,
    },
    {
      name: "package manager hook at the Export root",
      async mutate(input) {
        await writeFile(join(input.projectDir, ".pnpmfile.mjs"), "export default { hooks: {} };\n");
      },
      error: /unauthorized.*file|root allowlist|project structure/i,
    },
    {
      name: "root module imported from src",
      async mutate(input) {
        await writeFile(join(input.projectDir, "escape.ts"), "window.open('https://example.invalid');\n");
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          `import "../escape.ts";\nimport "./styles.css";\ndocument.querySelector("#app")?.setAttribute("data-dezin-export-node-id", "node-page");\n`,
        );
      },
      error: /unauthorized.*file|root allowlist|src.*module|project structure/i,
    },
    {
      name: "active document hidden in public",
      async mutate(input) {
        await mkdir(join(input.projectDir, "public"), { recursive: true });
        await writeFile(join(input.projectDir, "public", "escape.htm"), "<!doctype html><script>location='https://example.invalid'</script>");
      },
      error: /public.*asset|active.*document|unsupported.*asset/i,
    },
    {
      name: "Window recovered from an event receiver",
      async mutate(input) {
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          `import "./styles.css";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
app.dataset.dezinExportNodeId = "node-page";
window.addEventListener("click", (event) => event.view?.open(["ht", "tps:", "//example.invalid"].join("")));
`,
        );
      },
      error: /local self-contained UI|remote|window|navigation/i,
    },
    {
      name: "delayed post-validation replacement",
      async mutate(input) {
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          `import "./styles.css";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
app.dataset.dezinExportNodeId = "node-page";
setTimeout(() => app.replaceChildren(document.createTextNode("wrong later")), 60_000);
`,
        );
      },
      error: /timer|schedule|deterministic|local self-contained UI/i,
    },
    {
      name: "TypeScript semantic error",
      async mutate(input) {
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          `import "./styles.css";
const impossible: string = 42;
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");
app.dataset.dezinExportNodeId = "node-page";
app.textContent = impossible;
`,
        );
      },
      error: /TypeScript|assignable|semantic|typecheck/i,
    },
    {
      name: "TypeScript diagnostic suppression",
      async mutate(input) {
        await writeFile(
          join(input.projectDir, "src", "main.ts"),
          `// @ts-nocheck
import "./styles.css";
const impossible: string = 42;
document.querySelector("#app")?.setAttribute("data-dezin-export-node-id", impossible);
`,
        );
      },
      error: /suppress.*TypeScript|semantic validation/i,
    },
    {
      name: "hard-linked public asset",
      async mutate(input) {
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xz6vWQAAAABJRU5ErkJggg==", "base64");
        await mkdir(join(input.projectDir, "public"), { recursive: true });
        await writeFile(join(input.projectDir, "public", "pixel.png"), png);
        await link(join(input.projectDir, "public", "pixel.png"), join(input.projectDir, "public", "pixel-copy.png"));
      },
      error: /hard.?link|single.?link|immutable snapshot/i,
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
        model: "failed-export-model",
        systemPrompt: "Produce a fresh implementation.",
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        visualGate: successfulVisualGate,
      });
      const completed = await started.completion;
      assert.equal(completed.status, "failed");
      assert.equal(completed.runnerId, "throwing-export");
      assert.equal(completed.model, "failed-export-model");
      assert.match(completed.error ?? "", /deterministic runner failure/);
      await expectAbsent(designExportDirectory(fixture.dataDir, fixture.projectId, started.exportId));
      await expectAbsent(designExportStagingDirectory(fixture.dataDir, fixture.projectId, started.exportId));
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  await t.test("provider error retains the attested runtime identity", async () => {
    const fixture = await generatedProject("dezin-design-export-provider-error-");
    try {
      const started = await startDesignImplementationExport({
        dataDir: fixture.dataDir,
        projectId: fixture.projectId,
        canvasRevision: fixture.canvasRevision,
        runner: runner("codebuddy", async () => {
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
        }),
        systemPrompt: "Produce a fresh implementation.",
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        visualGate: successfulVisualGate,
      });
      const completed = await started.completion;
      assert.equal(completed.status, "failed");
      assert.equal(completed.runnerId, "codebuddy");
      assert.equal(completed.model, "hy3-ioa");
      assert.match(completed.error ?? "", /authentication expired/i);
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
        model: "cancelled-export-model",
        systemPrompt: "Produce a fresh implementation.",
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        visualGate: successfulVisualGate,
      });
      await entered;
      const cancelled = await cancelDesignGlobalJob(fixture.dataDir, fixture.projectId, started.job.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.runnerId, "blocking-export");
      assert.equal(cancelled.model, "cancelled-export-model");
      const completed = await started.completion;
      assert.equal(completed.status, "cancelled");
      assert.equal(completed.runnerId, cancelled.runnerId);
      assert.equal(completed.model, cancelled.model);
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

test("restart recovery removes crash-window Export final, Agent, and validation directories before cancellation", async () => {
  const fixture = await generatedProject("dezin-design-export-recovery-");
  const exportId = "export-crash-window";
  try {
    const created = await createDesignJob(fixture.dataDir, fixture.projectId, {
      kind: "implementation-export",
      runnerId: "recovery-export-fixture",
      model: null,
      expectedCanvasRevision: fixture.canvasRevision,
    });
    await updateDesignJob(fixture.dataDir, fixture.projectId, created.job.id, {
      status: "running",
      exportId,
    });
    const finalDir = designExportDirectory(fixture.dataDir, fixture.projectId, exportId);
    const pendingDir = designExportStagingDirectory(fixture.dataDir, fixture.projectId, exportId);
    const validationDir = join(dirname(dirname(pendingDir)), ".validation", exportId);
    await Promise.all([
      mkdir(finalDir, { recursive: true }),
      mkdir(pendingDir, { recursive: true }),
      mkdir(validationDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(finalDir, "dezin-export.json"), "crash-window final"),
      writeFile(join(pendingDir, "index.html"), "crash-window pending"),
      writeFile(join(validationDir, "index.html"), "crash-window validation"),
    ]);

    const recovered = await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 123_456);
    assert.deepEqual(recovered.map((job) => job.id), [created.job.id]);
    const job = await getDesignJob(fixture.dataDir, fixture.projectId, created.job.id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.cancelRequested, true);
    assert.match(job.error ?? "", /daemon restart/i);
    await expectAbsent(finalDir);
    await expectAbsent(pendingDir);
    await expectAbsent(validationDir);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});
