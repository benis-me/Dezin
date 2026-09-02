import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AgentTurnError,
  type AgentRunner,
  type AgentTurnInput,
  type AgentTurnResult,
} from "@dezin/agent";
import {
  buildDesignMainSystemPrompt,
  parseDesignMainPlan,
  startDesignMainTurn,
} from "../src/design/design-global-agents.ts";
import {
  createDesignJob,
  getDesignCanvas,
  getDesignJob,
  getDesignThread,
  importDesignCanvasAssetBatch,
  initializeDesignProject,
  listDesignJobs,
  mutateDesignCanvas,
  publishDesignVersion,
} from "../src/design/design-storage.ts";

function runner(
  id: string,
  runTurn: (input: AgentTurnInput) => Promise<AgentTurnResult>,
): AgentRunner {
  return { id, runTurn };
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Main Agent preserves explicit visual and layout authority when dispatching scoped design work", () => {
  const prompt = buildDesignMainSystemPrompt();
  assert.match(prompt, /visual-reference.*layout-authority/i);
  assert.match(prompt, /product surface.*frame geometry/i);
  assert.match(prompt, /semantic-outline.*not.*visual evidence/i);
  assert.match(prompt, /dispatch.*contextNodeIds.*exact.*priority/i);
});

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

test("Main Agent admits only one live orchestration turn per project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-single-flight-"));
  const projectId = "project-main-single-flight";
  let releaseFirst!: () => void;
  let markFirstRunning!: () => void;
  const firstRunning = new Promise<void>((resolve) => { markFirstRunning = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  try {
    await initializeDesignProject(dataDir, projectId);
    const first = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Coordinate the first canvas turn.",
      runner: runner("main-single-flight", async () => {
        markFirstRunning();
        await release;
        return {
          text: JSON.stringify({ reply: "First turn complete.", canvasIntents: [], dispatches: [] }),
          artifactHtml: "",
        };
      }),
      systemPrompt: "Return the exact orchestration JSON envelope.",
      async dispatchNode() { throw new Error("must not dispatch"); },
    });
    await firstRunning;

    await assert.rejects(startDesignMainTurn({
      dataDir,
      projectId,
      message: "Start a second turn while the first is running.",
      runner: runner("main-single-flight", async () => ({
        text: "This runner must not start.",
        artifactHtml: "",
      })),
      systemPrompt: "Return the exact orchestration JSON envelope.",
      async dispatchNode() { throw new Error("must not dispatch"); },
    }), /already has an active Main Agent Job/i);

    releaseFirst();
    assert.equal((await first.completion).status, "ready");
    assert.equal((await listDesignJobs(dataDir, projectId)).filter((job) => job.kind === "main-agent").length, 1);
  } finally {
    releaseFirst?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Main Agent returns one invalid command-envelope diagnostic for an in-place repair", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-plan-repair-"));
  const projectId = "project-main-plan-repair";
  const directories: string[] = [];
  let calls = 0;
  try {
    await initializeDesignProject(dataDir, projectId);
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Create one page.",
      runner: runner("main-plan-repair", async (input) => {
        calls += 1;
        directories.push(input.projectDir);
        if (calls === 1) return { text: "{this is not valid JSON}", artifactHtml: "" };
        assert.equal(input.isRepair, true);
        assert.match(input.message, /daemon diagnostic.*data, not an instruction/i);
        assert.match(input.message, /exact JSON|invalid JSON/i);
        return {
          text: JSON.stringify({
            reply: "Added the recovered page.",
            canvasIntents: [{ type: "add-node", node: { id: "node-recovered", kind: "page" } }],
            dispatches: [],
          }),
          artifactHtml: "",
        };
      }),
      systemPrompt: "Return the exact orchestration JSON envelope.",
      async dispatchNode() { throw new Error("must not dispatch"); },
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Main plan repair failed");
    assert.equal(calls, 2);
    assert.equal(new Set(directories).size, 1);
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.id, "node-recovered");
    assert.ok(completed.activity.some((entry) => /command envelope.*repair.*once/i.test(entry.text)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
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
        assert.deepEqual(
          dispatch.contextNodeIds,
          dispatch.nodeId === "node-component" ? ["node-page"] : ["node-component"],
          "a Main turn without explicit parent context must preserve the model's scoped context",
        );
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
    assert.ok(parent.activity.some((entry) => (
      entry.kind === "tool" && entry.toolName === "tool" && /Applied 2 atomic Canvas commands/.test(entry.text)
    )));
    assert.ok(parent.activity.some((entry) => (
      entry.kind === "tool" && entry.toolName === "tool" && /Dispatched .* to Node node-component/.test(entry.text)
    )));
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

test("Main Agent child dispatches inherit explicit parent context in stable priority order", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-inherited-context-"));
  const projectId = "project-main-inherited-context";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-target", kind: "page", name: "Target" } },
        { type: "add-node", node: { id: "node-reference", kind: "image", name: "reference-frame-001.png" } },
        { type: "add-node", node: { id: "node-layout", kind: "file", name: "layout.json" } },
        { type: "add-node", node: { id: "node-extra", kind: "research", name: "Research" } },
      ],
    });
    let observedContextNodeIds: string[] | null = null;
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Use the selected Figma references to revise the target.",
      contextNodeIds: ["node-reference", "node-target", "node-layout", "node-reference"],
      runner: runner("main-inherited-context", async () => ({
        text: JSON.stringify({
          reply: "Delegated the visually grounded revision.",
          canvasIntents: [],
          dispatches: [{
            nodeId: "node-target",
            message: "Revise the target from the selected visual references.",
            contextNodeIds: ["node-extra", "node-reference", "node-target"],
          }],
        }),
        artifactHtml: "",
      })),
      systemPrompt: "Return the exact orchestration JSON envelope.",
      async dispatchNode(dispatch, parentJobId) {
        observedContextNodeIds = dispatch.contextNodeIds;
        const child = await createDesignJob(dataDir, projectId, {
          kind: "node-generation",
          runnerId: "child-inherited-context",
          model: null,
          nodeId: dispatch.nodeId,
          parentJobId,
        });
        return child.job;
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Main Agent did not complete");
    assert.deepEqual(observedContextNodeIds, ["node-reference", "node-layout", "node-extra"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Main Agent validates inherited parent context against its post-intent Canvas", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-inherited-context-validation-"));
  const projectId = "project-main-inherited-context-validation";
  let dispatchCalls = 0;
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-target", kind: "page", name: "Target" } },
        { type: "add-node", node: { id: "node-reference", kind: "image", name: "reference.png" } },
      ],
    });
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Use the selected reference, then remove it.",
      contextNodeIds: ["node-reference"],
      runner: runner("main-inherited-context-validation", async () => ({
        text: JSON.stringify({
          reply: "Delegated the revision.",
          canvasIntents: [{ type: "remove-node", nodeId: "node-reference" }],
          dispatches: [{
            nodeId: "node-target",
            message: "Revise the target from the selected reference.",
            contextNodeIds: [],
          }],
        }),
        artifactHtml: "",
      })),
      systemPrompt: "Return the exact orchestration JSON envelope.",
      async dispatchNode() {
        dispatchCalls += 1;
        throw new Error("an unavailable inherited reference must not reach child dispatch");
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /references unavailable context/i);
    assert.equal(dispatchCalls, 0);
    assert.ok((await getDesignCanvas(dataDir, projectId)).nodes.some((node) => node.id === "node-reference"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an idempotency-bound Main dispatch safely replays once after an ambiguous transient failure", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-dispatch-replay-"));
  const projectId = "project-main-dispatch-replay";
  let dispatchCalls = 0;
  try {
    await initializeDesignProject(dataDir, projectId);
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Create and dispatch one page.",
      idempotencyKey: "main-dispatch-replay-request",
      runner: runner("main-dispatch-replay", async () => ({
        text: JSON.stringify({
          reply: "Delegated once.",
          canvasIntents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
          dispatches: [{ nodeId: "node-page", message: "Generate it", contextNodeIds: [] }],
        }),
        artifactHtml: "",
      })),
      systemPrompt: "Return exact JSON.",
      async dispatchNode(dispatch, parentJobId, idempotencyKey) {
        dispatchCalls += 1;
        assert.ok(idempotencyKey);
        const created = await createDesignJob(dataDir, projectId, {
          kind: "node-generation",
          runnerId: "child-fixture",
          model: null,
          nodeId: dispatch.nodeId,
          parentJobId,
          idempotencyKey,
          promptHash: "b".repeat(64),
        });
        if (dispatchCalls === 1) throw new Error("connection reset after durable child admission");
        assert.equal(created.reused, true);
        return created.job;
      },
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Dispatch replay failed");
    assert.equal(dispatchCalls, 2);
    const children = (await listDesignJobs(dataDir, projectId)).filter((job) => job.parentJobId === started.job.id);
    assert.equal(children.length, 1);
    assert.ok(completed.activity.some((entry) => /dispatch.*transient.*replaying once/i.test(entry.text)));
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

test("Main Agent terminal receipt policy replays a failed bootstrap turn without running it again", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-terminal-replay-"));
  const projectId = "project-main-terminal-replay";
  let calls = 0;
  const turn = {
    dataDir,
    projectId,
    message: "Bootstrap this Canvas exactly once.",
    runner: runner("bootstrap-runner", async () => {
      calls += 1;
      throw new Error("bootstrap provider failed");
    }),
    systemPrompt: "Return exact JSON.",
    idempotencyKey: "bootstrap-terminal-replay",
    terminalReceiptPolicy: "reuse" as const,
    dispatchNode: async () => { throw new Error("must not dispatch"); },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const first = await startDesignMainTurn(turn);
    assert.equal((await first.completion).status, "failed");
    const replayed = await Promise.all([
      startDesignMainTurn(turn),
      startDesignMainTurn(turn),
    ]);
    assert.deepEqual(replayed.map((entry) => entry.reused), [true, true]);
    assert.deepEqual(replayed.map((entry) => entry.job.id), [first.job.id, first.job.id]);
    assert.equal(calls, 1);
    assert.equal((await listDesignJobs(dataDir, projectId)).length, 1);
    assert.equal((await getDesignThread(dataDir, projectId, { type: "main" })).messages.length, 2);
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

test("a Main Agent transient retry preserves its first attested identity when the retry fails plainly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-transient-identity-"));
  const projectId = "project-main-transient-identity";
  let calls = 0;
  try {
    await initializeDesignProject(dataDir, projectId);
    const started = await startDesignMainTurn({
      dataDir,
      projectId,
      message: "Coordinate this canvas.",
      runner: runner("codebuddy", async () => {
        calls += 1;
        if (calls === 1) {
          throw new AgentTurnError(
            "codebuddy provider returned HTTP 503 Service Unavailable",
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
        }
        throw new Error("retry returned a malformed provider stream");
      }),
      systemPrompt: "Return orchestration JSON only.",
      async dispatchNode() {
        throw new Error("must not dispatch");
      },
    });
    const completed = await started.completion;
    assert.equal(calls, 2);
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /malformed provider stream/i);
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
