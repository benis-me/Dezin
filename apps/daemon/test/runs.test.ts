import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Store } from "../../../packages/core/src/index.ts";
import { abortError, FakeRunner } from "../../../packages/agent/src/index.ts";
import type { AgentRunner } from "../../../packages/agent/src/index.ts";
import { DesignRegistry } from "../../../packages/design/src/index.ts";
import { createApp, type AppDeps } from "../src/index.ts";

const CLEAN =
  `<style>:root{--accent:#2563eb}</style>\n` +
  `<section data-dezin-id="x"><h1>Hi there</h1><p>Real copy describing the thing.</p></section>`;
const SLOPPY = `<style>.hero{background:#6366f1}</style><h1>🚀 Launch</h1><p>10x faster.</p>`;

interface RunCtx {
  base: string;
  dataDir: string;
  store: Store;
}

async function withRunServer(
  runner: AgentRunner | undefined,
  fn: (ctx: RunCtx) => Promise<void>,
  extraDeps: Partial<Omit<AppDeps, "store" | "dataDir" | "runner">> = {},
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-"));
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir, runner, visualQa: async () => [], ...extraDeps });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((b) => JSON.parse(b.replace(/^data:\s?/, "")) as Record<string, unknown>);
}

function persistedMessageKind(message: { role: string; content: string }): string {
  if (message.role !== "system") return message.role;
  try {
    const parsed = JSON.parse(message.content) as {
      process?: unknown;
      steps?: unknown;
      visualReview?: { round?: unknown };
      result?: unknown;
    };
    if (parsed.process) return "process";
    if (parsed.steps) return "steps";
    if (parsed.visualReview) return `visual-${typeof parsed.visualReview.round === "number" ? parsed.visualReview.round : "unknown"}`;
    if (parsed.result) return "result";
  } catch {
    // Fall through to the generic system kind.
  }
  return "system";
}

function commitAll(dir: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", message], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function closedSse(res: Response, label: string): Promise<Array<Record<string, unknown>>> {
  const text = await Promise.race([
    res.text(),
    delay(2_000).then(() => {
      throw new Error(`${label} stream did not close`);
    }),
  ]);
  return parseSse(text);
}

function terminalEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === "run-done" || event.type === "run-error" || event.type === "run-cancelled");
}

function createSharinganRegionFixture(dataDir: string, store: Store, regions: unknown[]): { project: ReturnType<Store["createProject"]>; dir: string } {
  const project = store.createProject({ name: "Clone", mode: "standard", sharingan: true });
  const dir = join(dataDir, "projects", project.id);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".sharingan"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  writeFileSync(join(dir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
  writeFileSync(join(dir, "src", "App.jsx"), `export default function App(){ return <main>Before</main> }`);
  writeFileSync(join(dir, ".sharingan", "region-plan.json"), JSON.stringify({ version: 1, sourceUrl: "https://example.com", regions }));
  commitAll(dir, "base");
  return { project, dir };
}

async function createProject(base: string, body: object = { name: "P" }, daemonToken = ""): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(daemonToken ? { "x-dezin-daemon-token": daemonToken } : {}) },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { id: string };
}

test("research:false opts out of the Research phase even when it is enabled in Settings", async () => {
  let researchCalls = 0;
  const researchPhase = async () => {
    researchCalls++;
    return { ran: true, produced: false, visualProduced: false };
  };
  await withRunServer(
    new FakeRunner({ artifacts: [CLEAN, CLEAN], texts: ["done", "done"] }),
    async ({ base, store }) => {
      store.updateSettings({ researchEnabled: true });
      const project = await createProject(base);

      // A repair run opts out explicitly — the Research phase must be skipped despite the setting.
      const optOut = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "fix the crash", research: false }),
      });
      await optOut.text();
      assert.equal(researchCalls, 0, "research:false must skip the Research phase");

      // Sanity: with the setting on and no opt-out, the phase runs.
      const normal = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "iterate on it" }),
      });
      await normal.text();
      assert.ok(researchCalls >= 1, "Research must run when enabled and not opted out");
    },
    { researchPhase },
  );
});

test("clean run: streams SSE, persists, serves the artifact back", async () => {
  await withRunServer(new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }), async ({ base, store }) => {
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = parseSse(await res.text());
    const types = events.map((e) => e.type);
    assert.ok(types.includes("run-start"));
    assert.ok(types.includes("turn-start"));
    assert.ok(types.includes("done"));
    const done = events.find((e) => e.type === "run-done")!;
    assert.equal(done.passed, true);
    assert.equal(done.rounds, 0);
    assert.equal(done.score, 100); // a clean artifact scores 100
    assert.equal(done.previewUrl, `/projects/${project.id}/preview/`);

    // artifact served back over /preview/ (with the picker bridge injected)
    const preview = await fetch(`${base}/projects/${project.id}/preview/`);
    assert.equal(preview.status, 200);
    assert.ok((await preview.text()).includes(CLEAN));

    // persisted: one artifact, run succeeded, user+assistant messages plus the result card
    assert.equal(store.listArtifacts(project.id).length, 1);
    const convId = events.find((e) => e.type === "run-start")!.conversationId as string;
    assert.equal(store.listMessages(convId).length, 3);
    const runId = done.runId as string;
    const run = store.getRun(runId)!;
    assert.equal(run.status, "succeeded");
    assert.equal(run.lintPassed, true);
    assert.equal(run.repairRounds, 0);
  });
});

test("run passes BYOK settings to spawned agent turns", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base, store }) => {
    store.updateSettings({
      agentCommand: "claude",
      apiKey: "sk-local",
      apiBaseUrl: "https://api.local.test",
    });
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(runner.calls[0]?.env?.ANTHROPIC_API_KEY, "sk-local");
    assert.equal(runner.calls[0]?.env?.ANTHROPIC_BASE_URL, "https://api.local.test");
  });
});

test("visual QA run emits a start event before visual QA results", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(
    runner,
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, visualQaAgentCommand: "codebuddy", visualQaModel: "hunyuan" });
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
      });
      assert.equal(res.status, 200);

      const events = parseSse(await res.text());
      const startIndex = events.findIndex((event) => event.type === "visual-qa-start");
      const resultIndex = events.findIndex((event) => event.type === "visual-qa");
      assert.ok(startIndex >= 0);
      assert.ok(resultIndex > startIndex);
      assert.equal(events[startIndex]?.agentCommand, "codebuddy");
      assert.equal(events[startIndex]?.model, "hunyuan");
    },
    {
      visualQa: async () => [{ severity: "P2", id: "visual-ai-review-1", message: "CTA clips.", fix: "Allow wrapping." }],
    },
  );
});

test("a run whose critic could not render is NOT reported as a design-reviewed pass", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(
    runner,
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: false });
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "make a hero" }) });
      const done = parseSse(await res.text()).find((e) => e.type === "run-done")!;
      // The floor (anti-slop) still passed, but the ceiling never actually judged — the run must
      // not read as a design-reviewed pass.
      assert.equal(done.passed, true);
      assert.equal(done.designReviewed, false);
      // The persisted result message says so, so the user isn't misled.
      const sys = store
        .listMessages(store.listConversations(project.id)[0]!.id)
        .find((m) => m.role === "system" && /design quality was not assessed/i.test(m.content));
      assert.ok(sys, "expected the result message to note design review did not run");
    },
    { visualQa: async () => [{ severity: "P2", id: "visual-render-failed", message: "Could not render in headless Chrome.", fix: "Check the preview." }] },
  );
});

test("a run whose critic judged the design reports designReviewed=true", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(
    runner,
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: false });
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "make a hero" }) });
      const done = parseSse(await res.text()).find((e) => e.type === "run-done")!;
      assert.equal(done.designReviewed, true);
    },
    { visualQa: async () => [{ severity: "P2", id: "visual-reviewed", message: "Automated design review completed.", fix: "" }] },
  );
});

test("visual QA run persists a visual review transcript record", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(
    runner,
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, visualQaAgentCommand: "codebuddy", visualQaModel: "hunyuan" });
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
      });
      assert.equal(res.status, 200);
      await res.text();

      const conversation = store.listConversations(project.id)[0];
      assert.ok(conversation);
      const visualReviewMessage = store.listMessages(conversation.id).find((message) => {
        if (message.role !== "system") return false;
        try {
          return Boolean((JSON.parse(message.content) as { visualReview?: unknown }).visualReview);
        } catch {
          return false;
        }
      });
      assert.ok(visualReviewMessage);
      const parsed = JSON.parse(visualReviewMessage.content) as {
        visualReview?: {
          status?: string;
          agentCommand?: string;
          model?: string;
          screenshotUrl?: string;
          findings?: Array<{ message?: string }>;
          process?: Array<{ type?: string; summary?: string }>;
        };
      };
      assert.equal(parsed.visualReview?.status, "complete");
      assert.equal(parsed.visualReview?.agentCommand, "codebuddy");
      assert.equal(parsed.visualReview?.model, "hunyuan");
      assert.match(parsed.visualReview?.screenshotUrl ?? "", /\.visual-qa\/screenshot\.png$/);
      assert.equal(parsed.visualReview?.findings?.[0]?.message, "CTA clips.");
      assert.match(parsed.visualReview?.process?.[1]?.summary ?? "", /codebuddy \/ hunyuan/);
    },
    {
      visualQa: async () => [{ severity: "P2", id: "visual-ai-review-1", message: "CTA clips.", fix: "Allow wrapping." }],
    },
  );
});

test("POST /api/runs rejects a concurrent run for the same project variant", async () => {
  let releaseTurn!: () => void;
  const runner: AgentRunner = {
    id: "blocked",
    runTurn: () =>
      new Promise((resolve) => {
        releaseTurn = () => resolve({ text: "done", artifactHtml: CLEAN, artifactPath: "index.html" });
      }),
  };

  await withRunServer(runner, async ({ base, store }) => {
    const project = await createProject(base);
    const first = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "first run" }),
    });
    assert.equal(first.status, 200);

    try {
      const second = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "second run" }),
      });
      assert.equal(second.status, 409);
      assert.match(((await second.json()) as { error?: string }).error ?? "", /run already in progress/i);
      assert.equal(store.listRuns(project.id).length, 1);
    } finally {
      while (!releaseTurn) await delay(5);
      releaseTurn();
      await first.text();
    }
  });
});

test("POST /api/runs closes the TOCTOU window: two racing runs → one starts, one 409s", async () => {
  let releaseTurn: (() => void) | null = null;
  const runner: AgentRunner = {
    id: "blocked",
    runTurn: () =>
      new Promise((resolve) => {
        releaseTurn = () => resolve({ text: "done", artifactHtml: CLEAN, artifactPath: "index.html" });
      }),
  };
  await withRunServer(runner, async ({ base, store }) => {
    const project = await createProject(base);
    const post = () =>
      fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "race" }),
      });
    // Fire both before either's DB row exists. Without the in-memory lock, both could pass the
    // findActiveRun check (the row isn't inserted until createRun, with awaits in between).
    const [a, b] = await Promise.all([post(), post()]);
    assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [200, 409], "exactly one run starts; the other 409s");
    assert.equal(store.listRuns(project.id).length, 1, "only one run row is created");
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    await loser.text().catch(() => {});
    while (!releaseTurn) await delay(5);
    releaseTurn();
    await winner.text();
  });
});

test("exactly-once lifecycle releases the start key when registry lookup throws before createRun", async () => {
  const registry = new DesignRegistry();
  const registryGet = registry.get.bind(registry);
  let failRegistry = true;
  registry.get = (id: string) => {
    if (failRegistry) {
      failRegistry = false;
      throw new Error("registry exploded");
    }
    return registryGet(id);
  };

  await withRunServer(
    new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }),
    async ({ base, store }) => {
      const project = await createProject(base);
      const first = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "first attempt" }),
      });
      assert.equal(first.status, 500);
      assert.match(await first.text(), /registry exploded/);
      assert.equal(store.listRuns(project.id).length, 0, "a pre-record failure creates no Run row");

      const retry = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "immediate retry" }),
      });
      assert.equal(retry.status, 200, "the pre-record start key is released for an immediate retry");
      const events = await closedSse(retry, "registry retry");
      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-done"]);
      assert.equal(store.listRuns(project.id).length, 1);
    },
    { designRegistry: registry },
  );
});

test("exactly-once lifecycle terminalizes a research throw and accepts an immediate retry", async () => {
  let failResearch = true;
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async () => {
    if (failResearch) {
      failResearch = false;
      throw new Error("research exploded");
    }
    return { ran: true, produced: false, visualProduced: false };
  };

  await withRunServer(
    new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }),
    async ({ base, store }) => {
      const project = await createProject(base);
      const first = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "first attempt", research: true }),
      });
      assert.equal(first.status, 200);
      const failedEvents = await closedSse(first, "research failure");
      assert.deepEqual(terminalEvents(failedEvents).map((event) => event.type), ["run-error"]);
      const failedRunId = failedEvents.find((event) => event.type === "run-start")?.runId as string;
      const failedRun = store.getRun(failedRunId);
      assert.equal(failedRun?.status, "failed");
      assert.equal(typeof failedRun?.finishedAt, "number");

      const retry = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "immediate retry", research: true }),
      });
      assert.equal(retry.status, 200, "a failed durable Run no longer blocks its target");
      const retryEvents = await closedSse(retry, "research retry");
      assert.deepEqual(terminalEvents(retryEvents).map((event) => event.type), ["run-done"]);
    },
    { researchPhase },
  );
});

test("exactly-once lifecycle terminalizes broker creation failure and accepts an immediate retry", async () => {
  await withRunServer(new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }), async ({ base, store }) => {
    const project = await createProject(base);
    const originalSetMaxListeners = EventEmitter.prototype.setMaxListeners;
    let failBrokerCreation = true;
    EventEmitter.prototype.setMaxListeners = function (count: number) {
      if (failBrokerCreation && this.constructor === EventEmitter && count === 64) {
        failBrokerCreation = false;
        throw new Error("broker creation exploded");
      }
      return originalSetMaxListeners.call(this, count);
    };
    let first: Response;
    try {
      first = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "first attempt" }),
      });
      assert.equal(first.status, 200);
      const failedEvents = await closedSse(first, "broker creation failure");
      assert.deepEqual(terminalEvents(failedEvents).map((event) => event.type), ["run-error"]);
      const failedRun = store.listRuns(project.id)[0];
      assert.equal(failedRun?.status, "failed");
      assert.equal(typeof failedRun?.finishedAt, "number");
    } finally {
      EventEmitter.prototype.setMaxListeners = originalSetMaxListeners;
    }

    const retry = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "immediate retry" }),
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(terminalEvents(await closedSse(retry, "broker creation retry")).map((event) => event.type), ["run-done"]);
  });
});

test("exactly-once lifecycle terminalizes broker subscription failure and accepts an immediate retry", async () => {
  await withRunServer(new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }), async ({ base, store }) => {
    const project = await createProject(base);
    const originalOnce = EventEmitter.prototype.once;
    let failBrokerSubscription = true;
    EventEmitter.prototype.once = function (eventName: string | symbol, listener: (...args: unknown[]) => void) {
      if (failBrokerSubscription && this.constructor === EventEmitter && eventName === "done") {
        failBrokerSubscription = false;
        throw new Error("broker subscription exploded");
      }
      return originalOnce.call(this, eventName, listener);
    };
    let first: Response;
    try {
      first = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "first attempt" }),
      });
      assert.equal(first.status, 200);
      const failedEvents = await closedSse(first, "broker subscription failure");
      assert.deepEqual(terminalEvents(failedEvents).map((event) => event.type), ["run-error"]);
      const failedRun = store.listRuns(project.id)[0];
      assert.equal(failedRun?.status, "failed");
      assert.equal(typeof failedRun?.finishedAt, "number");
    } finally {
      EventEmitter.prototype.once = originalOnce;
    }

    const retry = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "immediate retry" }),
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(terminalEvents(await closedSse(retry, "broker subscription retry")).map((event) => event.type), ["run-done"]);
  });
});

test("exactly-once lifecycle terminalizes Standard workspace setup failure and releases the start key", async () => {
  await withRunServer(new FakeRunner({ artifacts: [CLEAN, CLEAN], texts: ["done", "done"] }), async ({ base, store }) => {
    const project = store.createProject({ name: "Std", mode: "standard" });
    store.ensureMainVariant(project.id);
    const branch = store.createVariant(project.id, "Broken branch");
    const post = () =>
      fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, variantId: branch.id, brief: "run on branch" }),
      });

    const first = await post();
    assert.equal(first.status, 200);
    assert.deepEqual(terminalEvents(await closedSse(first, "Standard setup failure")).map((event) => event.type), ["run-error"]);
    const failedRun = store.listRuns(project.id)[0];
    assert.equal(failedRun?.status, "failed");
    assert.equal(typeof failedRun?.finishedAt, "number");

    const retry = await post();
    assert.equal(retry.status, 200, "workspace setup failure releases the start key immediately");
    assert.deepEqual(terminalEvents(await closedSse(retry, "Standard setup retry")).map((event) => event.type), ["run-error"]);
    assert.equal(store.listRuns(project.id).length, 2);
  });
});

test("run injects referenced moodboard context into the agent message", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = await createProject(base);
    const board = store.createMoodboard({ name: "Warm references" });
    const asset = store.createMoodboardAsset(board.id, {
      kind: "image",
      fileName: "lobby.png",
      mimeType: "image/png",
      width: 1200,
      height: 900,
      source: "upload",
    });
    const assetDir = join(dataDir, "moodboards", board.id, "assets");
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(join(assetDir, `${asset.id}.png`), "png");
    store.replaceMoodboardNodes(board.id, [
      {
        type: "note",
        x: 20,
        y: 30,
        width: 260,
        height: 120,
        data: { content: "Warm editorial lighting with quiet hospitality materials", name: "Tone note" },
      },
      {
        type: "image",
        x: 320,
        y: 30,
        width: 320,
        height: 240,
        data: { assetId: asset.id, name: "Lobby reference" },
      },
    ]);
    store.addMoodboardMessage(board.id, "user", "Prefer warm wood, low contrast, and editorial restraint.");

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        brief: "Use this visual direction for the landing page",
        moodboardRefs: [{ id: board.id, name: board.name }],
      }),
    });

    const events = parseSse(await res.text());
    assert.equal(res.status, 200);
    assert.ok(events.some((event) => event.type === "run-done"));
    const message = runner.calls[0]?.message ?? "";
    assert.match(message, /Use this visual direction/);
    assert.match(message, /Referenced Moodboards/);
    assert.match(message, /Warm references/);
    assert.match(message, /Manifest:/);
    assert.match(message, /Read the moodboard files you need/i);
    assert.doesNotMatch(message, /Warm editorial lighting/);
    assert.doesNotMatch(message, new RegExp(`${asset.id}\\.png`));

    const runId = events.find((event) => event.type === "run-start")!.runId as string;
    const manifestPath = join(dataDir, ".runs", runId, "moodboards", "manifest.json");
    assert.match(message, new RegExp(manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const convId = events.find((event) => event.type === "run-start")!.conversationId as string;
    const userMessage = store.listMessages(convId).find((message) => message.role === "user")!;
    assert.match(userMessage.content, /Moodboard references/);
    assert.match(userMessage.content, /Warm references/);
  });
});

test("run writes a readable moodboard snapshot bundle for the agent", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = await createProject(base);
    const board = store.createMoodboard({ name: "Snapshot references" });
    const asset = store.createMoodboardAsset(board.id, {
      kind: "image",
      fileName: "hero-photo.png",
      mimeType: "image/png",
      width: 1600,
      height: 1000,
      source: "upload",
    });
    const assetDir = join(dataDir, "moodboards", board.id, "assets");
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(join(assetDir, `${asset.id}.png`), "png");
    const longNote = `Private board note ${"full context ".repeat(500)}`;
    store.replaceMoodboardNodes(board.id, [
      {
        type: "note",
        x: 10,
        y: 20,
        width: 320,
        height: 140,
        data: { name: "Long note", content: longNote },
      },
      {
        type: "image",
        x: 420,
        y: 20,
        width: 320,
        height: 220,
        data: { assetId: asset.id, name: "Hero photo" },
      },
    ]);
    store.addMoodboardMessage(board.id, "user", "Use the uploaded hero photo as material.");

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        brief: "Use the referenced moodboard when designing",
        moodboardRefs: [{ id: board.id, name: board.name }],
      }),
    });

    const events = parseSse(await res.text());
    assert.equal(res.status, 200);
    const runId = events.find((event) => event.type === "run-start")!.runId as string;
    const bundleRoot = join(dataDir, ".runs", runId, "moodboards");
    const manifestPath = join(bundleRoot, "manifest.json");
    assert.equal(existsSync(manifestPath), true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      boards: Array<{ id: string; files: { nodes: string; assets: string; messages: string; assetFiles: string } }>;
    };
    assert.equal(manifest.boards[0]?.id, board.id);
    const boardFiles = manifest.boards[0]!.files;
    const nodes = JSON.parse(readFileSync(join(bundleRoot, boardFiles.nodes), "utf8")) as Array<{ data?: { content?: string } }>;
    const assets = JSON.parse(readFileSync(join(bundleRoot, boardFiles.assets), "utf8")) as Array<{ id: string; fileName: string }>;
    const messages = JSON.parse(readFileSync(join(bundleRoot, boardFiles.messages), "utf8")) as Array<{ content: string }>;
    const assetFiles = JSON.parse(readFileSync(join(bundleRoot, boardFiles.assetFiles), "utf8")) as Array<{ id: string; path: string; sourcePath: string; snapshotPath: string | null }>;
    assert.equal(nodes[0]?.data?.content, longNote);
    assert.equal(assets[0]?.fileName, "hero-photo.png");
    assert.equal(messages[0]?.content, "Use the uploaded hero photo as material.");
    assert.match(assetFiles[0]?.path ?? "", new RegExp(`${asset.id}\\.png$`));
    assert.match(assetFiles[0]?.path ?? "", new RegExp(`\\.runs/${runId}/moodboards/boards/${board.id}/asset-files/`));
    assert.match(assetFiles[0]?.sourcePath ?? "", new RegExp(`moodboards/${board.id}/assets/${asset.id}\\.png$`));
    assert.equal(assetFiles[0]?.snapshotPath, `boards/${board.id}/asset-files/${asset.id}.png`);
    assert.equal(existsSync(assetFiles[0]!.path), true);

    const message = runner.calls[0]?.message ?? "";
    assert.match(message, new RegExp(manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(message, /read the moodboard files you need/i);
    assert.doesNotMatch(message, /full context full context full context/);
  });
});

test("prototype run folds visual QA findings into score, result, and persisted run", async () => {
  let visualInput: { agentCommand?: string; model?: string; brief?: string; htmlPath?: string; conversationHistory?: Array<{ content: string }> } | undefined;
  await withRunServer(
    new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }),
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: false });
      const project = await createProject(base);
      const conversation = store.createConversation(project.id);
      store.addMessage(conversation.id, "user", "previous user request");
      store.addMessage(conversation.id, "assistant", "previous assistant answer");
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, conversationId: conversation.id, brief: "make a hero", agentCommand: "codex", model: "gpt-5" }),
      });
      const events = parseSse(await res.text());
      const visual = events.find((e) => e.type === "visual-qa")!;
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal(visual.findings && Array.isArray(visual.findings), true);
      assert.equal(done.score, 92);
      assert.equal((done.findings as Array<{ id: string }>)[0]?.id, "visual-horizontal-overflow");
      assert.equal(visualInput?.agentCommand, "codex");
      assert.equal(visualInput?.model, "gpt-5");
      assert.equal(visualInput?.brief, "make a hero");
      assert.match(visualInput?.htmlPath ?? "", /index\.html$/);
      assert.deepEqual(visualInput?.conversationHistory?.map((m) => m.content), [
        "previous user request",
        "previous assistant answer",
        "make a hero",
        "done",
      ]);

      const run = store.getRun(done.runId as string)!;
      assert.equal(run.score, 92);
      assert.equal(run.findings[0]?.message, "Desktop viewport has horizontal overflow.");

      const convId = events.find((e) => e.type === "run-start")!.conversationId as string;
      const result = store
        .listMessages(convId)
        .map((m) => {
          try {
            return JSON.parse(m.content) as { result?: { meta?: { score?: number } } };
          } catch {
            return {};
          }
        })
        .find((m) => m.result);
      assert.equal(result?.result?.meta?.score, 92);
    },
    {
      visualQa: async (input) => {
        visualInput = input;
        return [
          {
            severity: "P1",
            id: "visual-horizontal-overflow",
            message: "Desktop viewport has horizontal overflow.",
            fix: "Constrain the widest element to the viewport.",
          },
        ];
      },
    },
  );
});

test("prototype run auto-improves visual QA findings after screenshot review", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN, CLEAN], texts: ["draft", "fixed"] });
  const visualQaCalls: string[] = [];
  await withRunServer(
    runner,
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: true });
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
      });
      const events = parseSse(await res.text());
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal(done.passed, true);
      assert.equal(done.rounds, 1);
      assert.equal(done.score, 100);
      assert.equal(visualQaCalls.length, 2);
      assert.equal(runner.calls[1]?.isRepair, true);
      assert.match(runner.calls[1]?.message ?? "", /visual-ai-review-1/);
      assert.match(runner.calls[1]?.message ?? "", /Allow wrapping inside the viewport/);

      const run = store.getRun(done.runId as string)!;
      assert.equal(run.repairRounds, 1);
      assert.equal(run.lintPassed, true);
      assert.equal(run.findings.length, 1);
      assert.equal(run.findings[0]?.id, "visual-ai-review-1");
      assert.equal(run.findings[0]?.message, "The mobile CTA clips.");
      assert.equal((run.findings[0] as { reviewStatus?: string } | undefined)?.reviewStatus, "resolved");
    },
    {
      visualQa: async () => {
        visualQaCalls.push(`call-${visualQaCalls.length + 1}`);
        return visualQaCalls.length === 1
          ? [
              {
                severity: "P1",
                id: "visual-ai-review-1",
                message: "The mobile CTA clips.",
                fix: "Allow wrapping inside the viewport.",
              },
            ]
          : [];
      },
    },
  );
});

test("sloppy→clean run: closed loop repairs over SSE, serves the fixed artifact", async () => {
  await withRunServer(new FakeRunner({ artifacts: [SLOPPY, CLEAN] }), async ({ base, store }) => {
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
    });
    const events = parseSse(await res.text());
    const types = events.map((e) => e.type);
    assert.ok(types.includes("lint"), "a lint event was streamed");
    // a repair turn ran (round 1, isRepair)
    assert.ok(events.some((e) => e.type === "turn-start" && e.isRepair === true));
    const done = events.find((e) => e.type === "run-done")!;
    assert.equal(done.passed, true);
    assert.equal(done.rounds, 1);

    // the served artifact is the repaired (clean) one, not the sloppy draft
    const preview = await fetch(`${base}/projects/${project.id}/preview/`);
    assert.ok((await preview.text()).includes(CLEAN));

    const runId = done.runId as string;
    assert.equal(store.getRun(runId)?.repairRounds, 1);
    assert.equal(store.getRun(runId)?.lintPassed, true);
  });
});

test("craft references reach the composed prompt (skill's craft sections)", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({ name: "P", skillId: "frontend-design", designSystemId: "modern-minimal" });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    await res.text();
    const prompt = runner.calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /Active craft references/);
    assert.match(prompt, /0\.06em/); // the typography tracking rule reached the agent
  });
});

test("final summary boundary separates persisted process from assistant summary", async () => {
  const runner: AgentRunner = {
    id: "boundary-runner",
    async runTurn(input) {
      input.onActivity?.({ kind: "text", text: "Drafted the pricing layout." });
      input.onActivity?.({ kind: "tool", name: "Write", summary: "Writing App.tsx" });
      input.onActivity?.({
        kind: "text",
        text: "\n<dezin-final-summary>\nDone. Updated the pricing page.\n</dezin-final-summary>",
      });
      return {
        text: "Drafted the pricing layout.\n<dezin-final-summary>\nDone. Updated the pricing page.\n</dezin-final-summary>",
        artifactHtml: CLEAN,
        artifactPath: "index.html",
      };
    },
  };

  await withRunServer(runner, async ({ base, store }) => {
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make a pricing page" }),
    });
    const events = parseSse(await res.text());
    const textActivities = events
      .filter((e) => e.type === "activity")
      .map((e) => (e.activity as { kind?: string; text?: string } | undefined))
      .filter((a): a is { kind: "text"; text: string } => a?.kind === "text");
    assert.deepEqual(textActivities.map((a) => a.text), ["Drafted the pricing layout."]);

    const turnEnd = events.find((e) => e.type === "turn-end")!;
    assert.equal(turnEnd.text, "Done. Updated the pricing page.");
    assert.equal(turnEnd.summaryBoundary, true);

    const convId = events.find((e) => e.type === "run-start")!.conversationId as string;
    const messages = store.listMessages(convId);
    assert.deepEqual(
      messages.map((m) => {
        if (m.role !== "system") return m.role;
        const parsed = JSON.parse(m.content) as Record<string, unknown>;
        if ("process" in parsed) return "process";
        if ("steps" in parsed) return "steps";
        if ("result" in parsed) return "result";
        return "system";
      }),
      ["user", "process", "assistant", "steps", "result"],
    );

    const process = JSON.parse(messages[1]!.content) as { process: { items: unknown[] } };
    assert.deepEqual(process.process.items, [
      { type: "text", text: "Drafted the pricing layout." },
      { type: "tool", summary: "Writing App.tsx" },
    ]);
    assert.equal(messages[2]!.content, "Done. Updated the pricing page.");
  });
});

test("a run snapshots its artifact; versions can be served and restored", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  let captured: { htmlPath: string; outPath: string } | null = null;
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "P" });
    await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "go" }),
      })
    ).text();
    const runs = (await (await fetch(`${base}/api/projects/${project.id}/runs`)).json()) as Array<{ id: string }>;
    const runId = runs[0]!.id;

    const v = await fetch(`${base}/api/projects/${project.id}/versions/${runId}`);
    assert.equal(v.status, 200);
    const versionHtml = await v.text();
    assert.match(versionHtml, /Hi there/); // the CLEAN snapshot content
    assert.match(versionHtml, /data-dezin-bridge/);
    assert.match(versionHtml, /sync-scroll/);

    const restore = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/restore`, { method: "POST" });
    assert.equal(restore.status, 200);

    const cover = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/cover`, { method: "POST" });
    assert.equal(cover.status, 200);
    assert.deepEqual(await cover.json(), { captured: true });
    assert.equal(captured?.htmlPath, join(dataDir, "projects", project.id, ".versions", `${runId}.html`));
    assert.equal(captured?.outPath, join(dataDir, "projects", project.id, ".cover.png"));
    assert.equal(existsSync(join(dataDir, "projects", project.id, ".cover.png")), true);

    const miss = await fetch(`${base}/api/projects/${project.id}/versions/nope`);
    assert.equal(miss.status, 404);
  }, {
    captureCover: async (htmlPath, outPath) => {
      captured = { htmlPath, outPath };
      writeFileSync(outPath, "png");
      return true;
    },
  });
});

test("GET /api/projects/:id/runs lists finished runs with a score", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "go" }),
      })
    ).text();

    const res = await fetch(`${base}/api/projects/${project.id}/runs`);
    assert.equal(res.status, 200);
    const runs = (await res.json()) as Array<Record<string, unknown>>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "succeeded");
    assert.equal(typeof runs[0]!.score, "number");
    assert.equal(runs[0]!.score, 100); // CLEAN artifact

    const miss = await fetch(`${base}/api/projects/nope/runs`);
    assert.equal(miss.status, 404);
  });
});

test("GET /api/projects includes a runStatus for active generations", async () => {
  await withRunServer(undefined, async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const conv = store.createConversation(project.id);
    const run = store.createRun(project.id, conv.id);
    store.updateRun(run.id, { status: "running" });

    const res = await fetch(`${base}/api/projects`);
    assert.equal(res.status, 200);
    const projects = (await res.json()) as Array<{ id: string; runStatus?: string | null }>;
    assert.equal(projects.find((p) => p.id === project.id)?.runStatus, "running");
  });
});

test("cancelled runs persist partial summary before final steps and status", async () => {
  const runner: AgentRunner = {
    id: "partial-stop",
    async runTurn(input) {
      input.onActivity?.({ kind: "text", text: "Partial copy before stop." });
      input.onActivity?.({ kind: "tool", name: "Edit", summary: "Editing hero.tsx" });
      throw abortError();
    },
  };

  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === "activity"));
    assert.ok(events.some((e) => e.type === "run-cancelled"));
    const convId = events.find((e) => e.type === "run-start")!.conversationId as string;
    const messages = store.listMessages(convId);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "system", "assistant", "system", "system"],
    );
    assert.equal(messages[2]?.content, "Partial copy before stop.");
    assert.match(messages[4]?.content ?? "", /Stopped/);

    const process = messages
      .map((m) => {
        try {
          return JSON.parse(m.content) as { process?: { elapsedMs?: number; items?: Array<{ type: string; text?: string; summary?: string }> } };
        } catch {
          return {};
        }
      })
      .find((m) => m.process);
    assert.deepEqual(process?.process?.items, [{ type: "tool", summary: "Editing hero.tsx" }]);
    assert.equal(typeof process?.process?.elapsedMs, "number");

    const steps = JSON.parse(messages[3]!.content) as { steps?: string[] };
    assert.deepEqual(steps.steps, ["Editing hero.tsx"]);
  });
});

test("agent AskUserQuestion markers stream and persist as structured questions", async () => {
  const runner = new FakeRunner({
    artifacts: [CLEAN, CLEAN],
    texts: ["<dezin-ask-user-question>\nWhich pricing tier should be featured?\n</dezin-ask-user-question>", "done"],
  });

  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    const events = parseSse(await res.text());
    const question = events.find((e) => e.type === "ask-user-question");
    assert.equal(question?.question, "Which pricing tier should be featured?");
    const done = events.find((e) => e.type === "run-cancelled");
    assert.equal(done?.reason, "question");
    assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-cancelled"]);
    const runId = events.find((e) => e.type === "run-start")!.runId as string;
    assert.equal(store.getRun(runId)?.status, "cancelled");
    assert.equal(typeof store.getRun(runId)?.finishedAt, "number");

    const convId = events.find((e) => e.type === "run-start")!.conversationId as string;
    const persisted = store
      .listMessages(convId)
      .map((m) => {
        try {
          return JSON.parse(m.content) as { question?: { text?: string } };
        } catch {
          return {};
        }
      })
      .find((m) => m.question);
    assert.equal(persisted?.question?.text, "Which pricing tier should be featured?");

    const answer = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, conversationId: convId, brief: "Use the annual plan." }),
    });
    assert.equal(answer.status, 200);
    assert.equal(runner.calls[1]?.history?.at(-1)?.role, "assistant");
    assert.equal(runner.calls[1]?.history?.at(-1)?.content, "Which pricing tier should be featured?");
  });
});

test("GET /api/projects/:id/runs can list all branch runs", async () => {
  await withRunServer(new FakeRunner({ artifacts: [CLEAN] }), async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const conv = store.createConversation(project.id);
    const main = store.ensureMainVariant(project.id);
    const branch = store.createVariant(project.id, "Exploration");
    store.setActiveVariant(project.id, branch.id);
    const mainRun = store.createRun(project.id, conv.id, main.id);
    store.updateRun(mainRun.id, { status: "succeeded", score: 92, lintPassed: true });
    const branchRun = store.createRun(project.id, conv.id, branch.id);
    store.updateRun(branchRun.id, { status: "succeeded", score: 100, lintPassed: true });

    const activeRes = await fetch(`${base}/api/projects/${project.id}/runs`);
    assert.equal(activeRes.status, 200);
    const activeRuns = (await activeRes.json()) as Array<{ id: string; variantId?: string | null }>;
    assert.deepEqual(
      activeRuns.map((run) => run.id),
      [branchRun.id],
    );
    assert.equal(activeRuns[0]?.variantId, branch.id);

    const allRes = await fetch(`${base}/api/projects/${project.id}/runs?all=1`);
    assert.equal(allRes.status, 200);
    const allRuns = (await allRes.json()) as Array<{ id: string; variantId?: string | null }>;
    assert.deepEqual(
      allRuns.map((run) => run.id),
      [branchRun.id, mainRun.id],
    );
    assert.deepEqual(
      allRuns.map((run) => run.variantId),
      [branch.id, main.id],
    );
  });
});

test("GET /api/projects/:id/runs includes final quality findings", async () => {
  await withRunServer(new FakeRunner({ artifacts: [SLOPPY] }), async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const conv = store.createConversation(project.id);
    const run = store.createRun(project.id, conv.id);
    store.updateRun(run.id, {
      status: "succeeded",
      score: 94,
      lintPassed: true,
      findings: [{ severity: "P2", id: "raw-hex", message: "2 raw hex values outside :root.", fix: "Move colours into tokens." }],
    });

    const res = await fetch(`${base}/api/projects/${project.id}/runs`);
    assert.equal(res.status, 200);
    const runs = (await res.json()) as Array<{ findings?: Array<{ id: string; message: string }> }>;
    assert.equal(runs[0]?.findings?.[0]?.id, "raw-hex");
    assert.equal(runs[0]?.findings?.[0]?.message, "2 raw hex values outside :root.");
  });
});

test("a deck-skill project surfaces the deck playbook in the catalog (scaffold loads on demand)", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({ name: "P", skillId: "deck", designSystemId: "modern-minimal" });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    await res.text();
    const prompt = runner.calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /Slide deck/, "deck skill is catalogued");
    assert.match(prompt, /deck\/SKILL\.md/, "with its on-demand playbook path");
    assert.match(prompt, /pinned for this project/, "the pinned deck skill is flagged");
    assert.doesNotMatch(prompt, /ArrowRight/, "the scaffold is not force-injected — it lives in the playbook");
  });
});

test("settings.customInstructions are injected into the composed prompt", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    store.updateSettings({ customInstructions: "NO EMOJI EVER" });
    const project = store.createProject({ name: "P" });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    await res.text();
    assert.match(runner.calls[0]?.systemPrompt ?? "", /NO EMOJI EVER/);
  });
});

test("settings.defaultDesignSystemId is used when the project pins none", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    store.updateSettings({ defaultDesignSystemId: "editorial" });
    const project = store.createProject({ name: "P" }); // no designSystemId
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    await res.text();
    // editorial's ink-red accent token appears verbatim in the prompt
    assert.match(runner.calls[0]?.systemPrompt ?? "", /--accent:\s*#b3261e/);
  });
});

test("POST /api/runs validation", async () => {
  await withRunServer(new FakeRunner({ artifacts: [CLEAN] }), async ({ base }) => {
    // missing brief
    const noBrief = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "x" }),
    });
    assert.equal(noBrief.status, 400);
    // unknown project
    const noProj = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "nope", brief: "go" }),
    });
    assert.equal(noProj.status, 404);
  });
});

test("POST /api/runs rejects a conversation from another project", async () => {
  await withRunServer(new FakeRunner({ artifacts: [CLEAN] }), async ({ base, store }) => {
    const project = store.createProject({ name: "A" });
    const other = store.createProject({ name: "B" });
    const otherConversation = store.createConversation(other.id);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, conversationId: otherConversation.id, brief: "go" }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /conversation does not belong to project/);
  });
});

test("standard run fails when the agent finishes without changing files", async () => {
  const runner: AgentRunner = {
    id: "noop",
    async runTurn() {
      return { text: "done", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Std", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), "{}");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
    });
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === "run-error"));
    const runId = events.find((e) => e.type === "run-start")!.runId as string;
    assert.equal(store.getRun(runId)?.status, "failed");
  });
});

test("standard version actions use commit snapshots instead of prototype html snapshots", async () => {
  const devServers: Array<{ dir: string; runtimeKey?: string; url: string }> = [];
  let captured: { url: string; outPath: string } | null = null;
  await withRunServer(
    undefined,
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "App.jsx"), "export default function App(){ return <main>One</main> }");
      const firstCommit = commitAll(dir, "first");

      writeFileSync(join(dir, "src", "App.jsx"), "export default function App(){ return <main>Two</main> }");
      const secondCommit = commitAll(dir, "second");

      const conversation = store.createConversation(project.id, "First");
      const firstRun = store.createRun(project.id, conversation.id);
      store.updateRun(firstRun.id, { status: "succeeded", commitHash: firstCommit, finishedAt: Date.now() });
      const secondRun = store.createRun(project.id, conversation.id);
      store.updateRun(secondRun.id, { status: "succeeded", commitHash: secondCommit, finishedAt: Date.now() });

      const view = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}`, { redirect: "manual" });
      assert.equal(view.status, 302);
      assert.equal(view.headers.get("location"), "http://127.0.0.1:6201/");
      assert.match(devServers[0]!.dir, new RegExp(`version-worktrees/${project.id}/${firstRun.id}$`));
      assert.equal(readFileSync(join(devServers[0]!.dir, "src", "App.jsx"), "utf8"), "export default function App(){ return <main>One</main> }");

      execFileSync("git", ["reset", "--hard", secondCommit], { cwd: devServers[0]!.dir, stdio: "ignore" });
      assert.equal(readFileSync(join(devServers[0]!.dir, "src", "App.jsx"), "utf8"), "export default function App(){ return <main>Two</main> }");
      const staleView = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}`, { redirect: "manual" });
      assert.equal(staleView.status, 302);
      assert.equal(readFileSync(join(devServers[1]!.dir, "src", "App.jsx"), "utf8"), "export default function App(){ return <main>One</main> }");

      const diff = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/diff`);
      assert.equal(diff.status, 200);
      const lines = (await diff.json()) as Array<{ t: string; text: string }>;
      assert.ok(lines.some((l) => l.t === "del" && l.text.includes("One")));
      assert.ok(lines.some((l) => l.t === "add" && l.text.includes("Two")));

      const cover = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/cover`, { method: "POST" });
      assert.equal(cover.status, 200);
      assert.deepEqual(await cover.json(), { captured: true });
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:6203/",
        outPath: join(dataDir, "projects", project.id, ".cover.png"),
      });

      const restore = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/restore`, { method: "POST" });
      assert.equal(restore.status, 200);
      assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "export default function App(){ return <main>One</main> }");
    },
    {
      ensureDevServer: async (_projectId, dir, runtimeKey) => {
        const url = `http://127.0.0.1:${6201 + devServers.length}/`;
        devServers.push({ dir, runtimeKey, url });
        return { url };
      },
      captureCoverUrl: async (url, outPath) => {
        captured = { url, outPath };
        return true;
      },
    },
  );
});

test("standard version preview URL endpoint resolves the dev server URL without iframe redirect", async () => {
  const devServers: Array<{ dir: string; runtimeKey?: string; url: string }> = [];
  await withRunServer(
    undefined,
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "App.jsx"), "export default function App(){ return <main>One</main> }");
      const commit = commitAll(dir, "first");

      const conversation = store.createConversation(project.id, "First");
      const run = store.createRun(project.id, conversation.id);
      store.updateRun(run.id, { status: "succeeded", commitHash: commit, finishedAt: Date.now() });

      const preview = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/preview-url`);
      assert.equal(preview.status, 200);
      assert.deepEqual(await preview.json(), { url: "http://127.0.0.1:6201/", mode: "standard" });
      assert.match(devServers[0]!.dir, new RegExp(`version-worktrees/${project.id}/${run.id}$`));
      assert.equal(devServers[0]!.runtimeKey, `${project.id}:version:${run.id}`);
    },
    {
      ensureDevServer: async (_projectId, dir, runtimeKey) => {
        const url = `http://127.0.0.1:${6201 + devServers.length}/`;
        devServers.push({ dir, runtimeKey, url });
        return { url };
      },
    },
  );
});

test("standard run succeeds only after project files change", async () => {
  const runner: AgentRunner = {
    id: "standard-change",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Std", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), "{}");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
    });
    const events = parseSse(await res.text());
    const done = events.find((e) => e.type === "run-done")!;
    assert.equal(done.mode, "standard");
    assert.equal(done.passed, true);
    assert.equal(store.getRun(done.runId as string)?.status, "succeeded");
  });
});

test("standard run streams preview updates from the live dev server before completion", async () => {
  const devServers: Array<{ dir: string; runtimeKey?: string; url: string }> = [];
  const runner: AgentRunner = {
    id: "standard-live-preview",
    async runTurn(input) {
      mkdirSync(join(input.projectDir, "src"), { recursive: true });
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "export default function App(){ return <main>Live</main> }");
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), "{}");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
      });
      const events = parseSse(await res.text());
      const previewIndex = events.findIndex((e) => e.type === "preview-update" && e.mode === "standard");
      const doneIndex = events.findIndex((e) => e.type === "run-done");
      const preview = events[previewIndex]!;
      const done = events[doneIndex]!;
      assert.ok(previewIndex >= 0, "standard run emitted a live preview update");
      assert.ok(doneIndex > previewIndex, "preview update arrived before run-done");
      assert.equal(preview.runId, done.runId);
      assert.equal(preview.previewUrl, "http://127.0.0.1:6207/");
      assert.equal(preview.variantId, store.getActiveVariantId(project.id));
      assert.match(devServers[0]!.runtimeKey ?? "", /:/);
      assert.ok(store.getRun(done.runId as string)?.commitHash, "run persisted a git snapshot before completion");
    },
    {
      ensureDevServer: async (_projectId, dir, runtimeKey) => {
        const url = "http://127.0.0.1:6207/";
        devServers.push({ dir, runtimeKey, url });
        return { url };
      },
      captureCoverUrl: async () => true,
    },
  );
});

test("standard run persists deterministic anti-slop findings from source files", async () => {
  const runner: AgentRunner = {
    id: "standard-static-quality",
    async runTurn(input) {
      mkdirSync(join(input.projectDir, "src"), { recursive: true });
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main><h1>Launch</h1><p style={{ color: "rgb(99, 102, 241)" }}>Bad accent</p></main> }`);
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Std", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), "{}");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
    });
    const events = parseSse(await res.text());
    const done = events.find((e) => e.type === "run-done")!;
    assert.equal(done.mode, "standard");
    assert.equal(done.passed, false);
    assert.equal(done.score, 75);
    assert.equal((done.findings as Array<{ id: string }>)[0]?.id, "ai-default-indigo");
    const run = store.getRun(done.runId as string)!;
    assert.equal(run.lintPassed, false);
    assert.equal(run.score, 75);
    assert.equal(run.findings[0]?.id, "ai-default-indigo");
  });
});

test("standard run captures the gallery cover from the dev server URL", async () => {
  let captured: { url: string; outPath: string } | null = null;
  const runner: AgentRunner = {
    id: "standard-cover",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "src-App.jsx"), "export default function App(){ return <main>Cover</main> }");
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
      });
      const events = parseSse(await res.text());
      assert.ok(events.some((e) => e.type === "run-done"));
      for (let i = 0; i < 20 && !captured; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:5999/",
        outPath: join(dataDir, "projects", project.id, ".cover.png"),
      });
    },
    {
      ensureDevServer: async (_projectId, _dir, runtimeKey) => {
        if (typeof runtimeKey !== "string") throw new Error("expected a variant runtime key");
        assert.match(runtimeKey, /:/);
        return { url: "http://127.0.0.1:5999/" };
      },
      captureCoverUrl: async (url, outPath) => {
        captured = { url, outPath };
        return true;
      },
    },
  );
});

test("standard run persists visual QA findings and score when enabled", async () => {
  let expectedDir = "";
  let visualInput: { agentCommand?: string; model?: string; projectRoot?: string; htmlPath?: string; conversationHistory?: Array<{ content: string }> } | undefined;
  const runner: AgentRunner = {
    id: "standard-visual",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "index.html"), "<main><h1>Done</h1></main>");
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({
        visualQaEnabled: true,
        visualQaAgentCommand: "codebuddy",
        visualQaModel: "hunyuan",
        autoImproveEnabled: false,
      });
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      expectedDir = dir;
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), "{}");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better", agentCommand: "codex", model: "gpt-5" }),
      });
      const events = parseSse(await res.text());
      const visual = events.find((e) => e.type === "visual-qa")!;
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal((visual.findings as Array<{ id: string }>)[0]?.id, "visual-fixed-offscreen");
      assert.equal(done.score, 92);
      assert.equal(visualInput?.projectRoot, expectedDir);
      assert.match(visualInput?.htmlPath ?? "", /index\.html$/);
      assert.equal(visualInput?.agentCommand, "codebuddy");
      assert.equal(visualInput?.model, "hunyuan");
      assert.deepEqual(visualInput?.conversationHistory?.map((m) => m.content), ["make it better", "changed"]);
      const run = store.getRun(done.runId as string)!;
      assert.equal(run.score, 92);
      assert.equal(run.findings[0]?.id, "visual-fixed-offscreen");
    },
    {
      visualQa: async (input) => {
        visualInput = input;
        return [
          {
            severity: "P1",
            id: "visual-fixed-offscreen",
            message: "A fixed toolbar is outside the viewport.",
            fix: "Clamp the toolbar inside the viewport.",
          },
        ];
      },
    },
  );
});

test("standard run with a production CLI runner can change src files without touching index.html", async () => {
  let visualQaCalls = 0;
  await withRunServer(
    undefined,
    async ({ base, dataDir, store }) => {
      const root = mkdtempSync(join(tmpdir(), "dezin-standard-cli-"));
      const cliPath = join(root, "standard-agent");
      writeFileSync(
        cliPath,
        `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
fs.mkdirSync(path.join(process.cwd(), "src"), { recursive: true });
fs.writeFileSync(
  path.join(process.cwd(), "src", "App.jsx"),
  "export default function App(){ return <main>Updated by CLI</main> }\\n",
);
console.log("updated src/App.jsx");
`,
        { mode: 0o755 },
      );
      store.updateSettings({ agentCommand: cliPath, visualQaEnabled: true, autoImproveEnabled: false });
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(join(dir, "src"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "index.html"), `<div id="root"></div><script type="module" src="/src/main.jsx"></script>`);
      writeFileSync(join(dir, "src", "main.jsx"), `import App from "./App.jsx";`);
      writeFileSync(join(dir, "src", "App.jsx"), `export default function App(){ return <main>Before</main> }`);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      const beforeIndex = readFileSync(join(dir, "index.html"), "utf8");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "update the React app" }),
      });
      const events = parseSse(await res.text());
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal(done.mode, "standard");
      assert.equal(done.passed, true);
      assert.equal(events.some((e) => e.type === "visual-qa"), true);
      assert.equal(readFileSync(join(dir, "index.html"), "utf8"), beforeIndex);
      assert.match(readFileSync(join(dir, "src", "App.jsx"), "utf8"), /Updated by CLI/);
      const run = store.getRun(done.runId as string)!;
      assert.equal(run.status, "succeeded");
      assert.ok(run.commitHash, "standard run persisted a git snapshot");
      assert.equal(visualQaCalls, 1);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => {
        visualQaCalls += 1;
        return [];
      },
    },
  );
});

test("Sharingan standard run reviews an existing scaffold even when the first agent turn makes no changes and visual QA is globally disabled", async () => {
  const calls: Array<{ message: string; isRepair?: boolean }> = [];
  const runner: AgentRunner = {
    id: "sharingan-existing-scaffold",
    async runTurn(input) {
      calls.push({ message: input.message, isRepair: input.isRepair });
      if (input.isRepair) {
        writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>Fixed from QA</main> }`);
      }
      return { text: input.isRepair ? "fixed from QA" : "scaffold already present", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  const visualQaCalls: string[] = [];
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const project = store.createProject({ name: "Clone", mode: "standard", sharingan: true });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(join(dir, "src"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      writeFileSync(join(dir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(dir, "src", "App.jsx"), `export default function App(){ return <main>SOURCE scaffold</main> }`);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "continue the Sharingan clone" }),
      });
      const events = parseSse(await res.text());
      assert.ok(!events.some((e) => e.type === "run-error"), `unexpected run-error: ${JSON.stringify(events)}`);
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal(done.mode, "standard");
      assert.equal(done.passed, true);
      assert.equal(done.rounds, 1);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.isRepair, false);
      assert.equal(calls[1]?.isRepair, true);
      assert.match(calls[1]?.message ?? "", /visual-ai-review-1/);
      assert.equal(visualQaCalls.length, 2);
      assert.match(readFileSync(join(dir, "src", "App.jsx"), "utf8"), /Fixed from QA/);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => {
        visualQaCalls.push(`call-${visualQaCalls.length + 1}`);
        return visualQaCalls.length === 1
          ? [
              {
                severity: "P1",
                id: "visual-ai-review-1",
                message: "The scaffold is only a SOURCE shell.",
                fix: "Replace the SOURCE shell with the measured final clone.",
              },
            ]
          : [];
      },
    },
  );
});

test("Sharingan standard run delegates source regions to isolated subagents before main integration", async () => {
  const calls: Array<{ phase: "region" | "main"; message: string; historyLength: number }> = [];
  const runner: AgentRunner = {
    id: "sharingan-region-subagents",
    async runTurn(input) {
      mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) {
        const id = regionMatch[1]!;
        calls.push({ phase: "region", message: input.message, historyLength: input.history?.length ?? 0 });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${id}.jsx`), `export default function ${id.replace("-", "_")}(){ return <section>${id}</section>; }\n`);
        return { text: `built ${id}`, artifactHtml: "", artifactPath: "index.html" };
      }
      calls.push({ phase: "main", message: input.message, historyLength: input.history?.length ?? 0 });
      writeFileSync(
        join(input.projectDir, "src", "App.jsx"),
        `import Region1 from "./sharingan-regions/region-1.jsx";\nimport Region2 from "./sharingan-regions/region-2.jsx";\nexport default function App(){ return <main><Region1/><Region2/></main>; }\n`,
      );
      return { text: "integrated regions", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const project = store.createProject({ name: "Clone", mode: "standard", sharingan: true });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, ".sharingan"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      writeFileSync(join(dir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(dir, "src", "App.jsx"), `export default function App(){ return <main>Before</main> }`);
      writeFileSync(
        join(dir, ".sharingan", "region-plan.json"),
        JSON.stringify({
          version: 1,
          sourceUrl: "https://example.com",
          regions: [
            {
              id: "region-1",
              label: "Header",
              bbox: { x: 0, y: 0, w: 1200, h: 80 },
              texts: ["Home"],
              assets: [],
              textRuns: [{ text: "Home", box: { x: 20, y: 24, w: 64, h: 20 }, fontSize: "14px", color: "rgb(255,255,255)" }],
              styleTokens: { colors: ["rgb(255,255,255)"], fontSizes: ["14px"] },
            },
            {
              id: "region-2",
              label: "Hero",
              bbox: { x: 0, y: 100, w: 1200, h: 500 },
              texts: ["Create"],
              assets: ["/_assets/hero.png"],
              media: [{ src: "/_assets/hero.png", box: { x: 80, y: 140, w: 320, h: 180 }, objectFit: "cover" }],
            },
          ],
        }),
      );
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.ok(!events.some((e) => e.type === "run-error"), `unexpected run-error: ${JSON.stringify(events)}`);
      assert.deepEqual(calls.map((c) => c.phase), ["region", "region", "main"]);
      assert.equal(calls[0]?.historyLength, 0, "region subagents run with isolated context");
      assert.equal(calls[1]?.historyLength, 0, "each region subagent gets isolated context");
      assert.match(calls[0]?.message ?? "", /Header/);
      assert.match(calls[0]?.message ?? "", /textRuns/);
      assert.match(calls[0]?.message ?? "", /rgb\(255,255,255\)/);
      assert.match(calls[1]?.message ?? "", /Hero/);
      assert.match(calls[1]?.message ?? "", /media/);
      assert.match(calls[1]?.message ?? "", /\/_assets\/hero\.png/);
      assert.match(calls[2]?.message ?? "", /SHARINGAN MAIN INTEGRATION/);
      assert.match(calls[2]?.message ?? "", /src\/sharingan-regions\/region-1\.jsx/);
      assert.equal(events.filter((e) => e.type === "sharingan-region-start").length, 2);
      assert.equal(events.filter((e) => e.type === "sharingan-region-done").length, 2);
      assert.match(readFileSync(join(dir, "src", "App.jsx"), "utf8"), /Region1/);
      assert.equal(existsSync(join(dir, ".sharingan", "region-build.json")), true);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan region subagents run in parallel and the main agent waits for all outputs", async () => {
  let activeRegions = 0;
  let maxActiveRegions = 0;
  const calls: Array<{ phase: "region" | "main"; id?: string }> = [];
  const runner: AgentRunner = {
    id: "sharingan-parallel-regions",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) {
        const id = regionMatch[1]!;
        calls.push({ phase: "region", id });
        activeRegions += 1;
        maxActiveRegions = Math.max(maxActiveRegions, activeRegions);
        await delay(80);
        mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${id}.jsx`), `export default function ${id.replace("-", "_")}(){ return <section>${id}</section>; }\n`);
        activeRegions -= 1;
        return { text: `built ${id}`, artifactHtml: "", artifactPath: "index.html" };
      }
      calls.push({ phase: "main" });
      assert.equal(activeRegions, 0, "main integration starts only after region agents finish");
      writeFileSync(
        join(input.projectDir, "src", "App.jsx"),
        `import Region1 from "./sharingan-regions/region-1.jsx";\nimport Region2 from "./sharingan-regions/region-2.jsx";\nexport default function App(){ return <main><Region1/><Region2/></main>; }\n`,
      );
      return { text: "integrated regions", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project } = createSharinganRegionFixture(dataDir, store, [
        { id: "region-1", label: "Header", bbox: { x: 0, y: 0, w: 1200, h: 80 }, texts: ["Home"], assets: [] },
        { id: "region-2", label: "Hero", bbox: { x: 0, y: 100, w: 1200, h: 500 }, texts: ["Create"], assets: [] },
      ]);

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.ok(!events.some((e) => e.type === "run-error"), `unexpected run-error: ${JSON.stringify(events)}`);
      assert.equal(maxActiveRegions, 2, "region subagents should overlap instead of running serially");
      assert.deepEqual(calls.map((c) => c.phase).sort(), ["main", "region", "region"].sort());
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan region subagents validate outputs and retry missing files before main integration", async () => {
  const attempts = new Map<string, number>();
  let mainCalls = 0;
  const runner: AgentRunner = {
    id: "sharingan-region-validation-retry",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) {
        const id = regionMatch[1]!;
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (id === "region-2" && attempt === 1) return { text: "forgot to write the file", artifactHtml: "", artifactPath: "index.html" };
        mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${id}.jsx`), `export default function ${id.replace("-", "_")}(){ return <section>${id}</section>; }\n`);
        return { text: `built ${id} on attempt ${attempt}`, artifactHtml: "", artifactPath: "index.html" };
      }
      mainCalls += 1;
      writeFileSync(
        join(input.projectDir, "src", "App.jsx"),
        `import Region1 from "./sharingan-regions/region-1.jsx";\nimport Region2 from "./sharingan-regions/region-2.jsx";\nexport default function App(){ return <main><Region1/><Region2/></main>; }\n`,
      );
      return { text: "integrated regions", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project, dir } = createSharinganRegionFixture(dataDir, store, [
        { id: "region-1", label: "Header", bbox: { x: 0, y: 0, w: 1200, h: 80 }, texts: ["Home"], assets: [] },
        { id: "region-2", label: "Hero", bbox: { x: 0, y: 100, w: 1200, h: 500 }, texts: ["Create"], assets: [] },
      ]);

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.ok(!events.some((e) => e.type === "run-error"), `unexpected run-error: ${JSON.stringify(events)}`);
      assert.equal(attempts.get("region-2"), 2, "missing region output is retried before integration");
      assert.equal(mainCalls, 1, "main integrates once after validated region outputs");
      assert.equal(events.filter((e) => e.type === "sharingan-region-retry").length, 1);
      const manifest = JSON.parse(readFileSync(join(dir, ".sharingan", "region-build.json"), "utf8"));
      assert.equal(manifest.regions.find((region: { id?: string; attempts?: number }) => region.id === "region-2")?.attempts, 2);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan region subagent failures block main integration after bounded retries", async () => {
  let mainCalls = 0;
  const runner: AgentRunner = {
    id: "sharingan-region-failure",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) return { text: "did not produce a component", artifactHtml: "", artifactPath: "index.html" };
      mainCalls += 1;
      return { text: "should not integrate", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project } = createSharinganRegionFixture(dataDir, store, [
        { id: "region-1", label: "Header", bbox: { x: 0, y: 0, w: 1200, h: 80 }, texts: ["Home"], assets: [] },
      ]);

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.equal(mainCalls, 0, "main integration must not run with a failed region");
      assert.equal(events.filter((e) => e.type === "sharingan-region-failed").length, 1);
      assert.ok(events.some((e) => e.type === "run-error" && String(e.message).includes("Sharingan region subagents failed")), `expected region run-error: ${JSON.stringify(events)}`);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan region validation ignores stale region files copied from the project root", async () => {
  let mainCalls = 0;
  const runner: AgentRunner = {
    id: "sharingan-stale-region-validation",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) return { text: "no new region output", artifactHtml: "", artifactPath: "index.html" };
      mainCalls += 1;
      return { text: "should not integrate", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project, dir } = createSharinganRegionFixture(dataDir, store, [{ id: "region-1", label: "Header", bbox: { x: 0, y: 0, w: 1200, h: 80 }, texts: ["Home"], assets: [] }]);
      mkdirSync(join(dir, "src", "sharingan-regions"), { recursive: true });
      writeFileSync(join(dir, "src", "sharingan-regions", "region-1.jsx"), `export default function stale_region(){ return <section>stale</section>; }\n`);
      commitAll(dir, "stale region output");

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.equal(mainCalls, 0, "main integration must not use a stale region component copied into the sandbox");
      assert.equal(events.filter((e) => e.type === "sharingan-region-failed").length, 1);
      assert.ok(events.some((e) => e.type === "run-error" && String(e.message).includes("Sharingan region subagents failed")), `expected stale output to fail validation: ${JSON.stringify(events)}`);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan region outputs do not mask a no-op main integration turn", async () => {
  const runner: AgentRunner = {
    id: "sharingan-main-noop-after-regions",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) {
        const id = regionMatch[1]!;
        mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${id}.jsx`), `export default function ${id.replace("-", "_")}(){ return <section>${id}</section>; }\n`);
        return { text: `built ${id}`, artifactHtml: "", artifactPath: "index.html" };
      }
      return { text: "main integration skipped", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project } = createSharinganRegionFixture(dataDir, store, [{ id: "region-1", label: "Header", bbox: { x: 0, y: 0, w: 1200, h: 80 }, texts: ["Home"], assets: [] }]);

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.ok(events.some((e) => e.type === "sharingan-region-done"), "region subagent should finish first");
      assert.ok(events.some((e) => e.type === "run-error" && String(e.message).includes("without changing project files")), `expected main no-op failure: ${JSON.stringify(events)}`);
      assert.ok(!events.some((e) => e.type === "run-done"), "main no-op must not be accepted just because regions changed files");
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan main integration no-op is retried once before visual QA", async () => {
  let mainCalls = 0;
  const runner: AgentRunner = {
    id: "sharingan-main-noop-retry",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) {
        const id = regionMatch[1]!;
        mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${id}.jsx`), `export default function ${id.replace("-", "_")}(){ return <section>${id}</section>; }\n`);
        return { text: `built ${id}`, artifactHtml: "", artifactPath: "index.html" };
      }
      mainCalls += 1;
      if (mainCalls === 1) return { text: "main integration skipped", artifactHtml: "", artifactPath: "index.html" };
      assert.match(input.message, /SHARINGAN MAIN INTEGRATION RETRY/);
      writeFileSync(
        join(input.projectDir, "src", "App.jsx"),
        `import Region1 from "./sharingan-regions/region-1.jsx";\nexport default function App(){ return <main><Region1 /></main>; }\n`,
      );
      return { text: "integrated after retry", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project, dir } = createSharinganRegionFixture(dataDir, store, [{ id: "region-1", label: "Header", bbox: { x: 0, y: 0, w: 1200, h: 80 }, texts: ["Home"], assets: [] }]);

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.ok(!events.some((e) => e.type === "run-error"), `unexpected run-error: ${JSON.stringify(events)}`);
      assert.equal(mainCalls, 2, "main integration should get one automatic retry");
      assert.ok(events.some((e) => e.type === "turn-start" && e.round === 1 && e.isRepair === true));
      assert.ok(events.some((e) => e.type === "run-done"));
      assert.match(readFileSync(join(dir, "src", "App.jsx"), "utf8"), /Region1/);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan variant runs sync the root capture bundle before region subagents", async () => {
  let regionCalls = 0;
  const runner: AgentRunner = {
    id: "sharingan-variant-capture-sync",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) {
        regionCalls += 1;
        assert.equal(existsSync(join(input.projectDir, "public", "_assets", "hero.png")), true, "variant workspace receives captured assets");
        const id = regionMatch[1]!;
        mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${id}.jsx`), `export default function ${id.replace("-", "_")}(){ return <section>${id}</section>; }\n`);
        return { text: `built ${id}`, artifactHtml: "", artifactPath: "index.html" };
      }
      writeFileSync(
        join(input.projectDir, "src", "App.jsx"),
        `import Region1 from "./sharingan-regions/region-1.jsx";\nexport default function App(){ return <main><Region1 /></main>; }\n`,
      );
      return { text: "integrated variant regions", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const project = store.createProject({ name: "Clone", mode: "standard", sharingan: true });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(join(dir, "src"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      writeFileSync(join(dir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(dir, "src", "App.jsx"), `export default function App(){ return <main>Before</main> }`);
      commitAll(dir, "base without capture");

      mkdirSync(join(dir, ".sharingan"), { recursive: true });
      mkdirSync(join(dir, ".sharingan", "region-work", "stale"), { recursive: true });
      mkdirSync(join(dir, "public", "_assets"), { recursive: true });
      writeFileSync(join(dir, ".sharingan", "region-work", "stale", "old.txt"), "old");
      writeFileSync(join(dir, ".sharingan", "region-build.json"), JSON.stringify({ version: 1, regions: [{ id: "stale" }], failures: [] }));
      writeFileSync(join(dir, "public", "_assets", "hero.png"), "PNGDATA");
      writeFileSync(
        join(dir, ".sharingan", "region-plan.json"),
        JSON.stringify({ version: 1, sourceUrl: "https://example.com", regions: [{ id: "region-1", label: "Header", bbox: { x: 0, y: 0, w: 1200, h: 80 }, texts: ["Home"], assets: ["/_assets/hero.png"] }] }),
      );

      store.ensureMainVariant(project.id);
      const variant = store.createVariant(project.id, "Variant");
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, variantId: variant.id, brief: "rebuild the Sharingan page" }),
      });
      const events = parseSse(await res.text());
      assert.ok(!events.some((e) => e.type === "run-error"), `unexpected run-error: ${JSON.stringify(events)}`);
      assert.equal(regionCalls, 1, "variant run should still delegate captured source regions");
      assert.ok(events.some((e) => e.type === "sharingan-region-done"));
      const variantDir = join(dataDir, "worktrees", project.id, variant.id);
      assert.equal(existsSync(join(variantDir, ".sharingan", "region-plan.json")), true);
      assert.equal(existsSync(join(variantDir, ".sharingan", "region-build.json")), true);
      assert.equal(existsSync(join(variantDir, ".sharingan", "region-work", "stale")), false);
      assert.equal(existsSync(join(variantDir, "public", "_assets", "hero.png")), true);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("standard run auto-improves visual QA findings without a manual button", async () => {
  let turn = 0;
  const calls: Array<{ message: string; isRepair?: boolean }> = [];
  const runner: AgentRunner = {
    id: "standard-auto-improve",
    async runTurn(input) {
      turn += 1;
      calls.push({ message: input.message, isRepair: input.isRepair });
      mkdirSync(join(input.projectDir, "src"), { recursive: true });
      writeFileSync(join(input.projectDir, "index.html"), `<div id="root"></div>`);
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>${turn === 1 ? "Draft" : "Fixed"}</main> }`);
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: turn === 1 ? "draft complete" : "fixed complete", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  const visualQaCalls: string[] = [];
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: true });
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), "{}");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
      });
      const events = parseSse(await res.text());
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal(done.mode, "standard");
      assert.equal(done.passed, true);
      assert.equal(done.rounds, 1);
      assert.equal(done.score, 100);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.isRepair, true);
      assert.match(calls[1]?.message ?? "", /visual-ai-review-1/);
      assert.match(calls[1]?.message ?? "", /Allow wrapping inside the viewport/);
      assert.equal(visualQaCalls.length, 2);
      const run = store.getRun(done.runId as string)!;
      assert.equal(run.repairRounds, 1);
      assert.equal(run.lintPassed, true);
      assert.equal(run.findings.length, 1);
      assert.equal(run.findings[0]?.id, "visual-ai-review-1");
      assert.equal((run.findings[0] as { reviewStatus?: string } | undefined)?.reviewStatus, "resolved");
    },
    {
      visualQa: async () => {
        visualQaCalls.push(`call-${visualQaCalls.length + 1}`);
        return visualQaCalls.length === 1
          ? [
              {
                severity: "P1",
                id: "visual-ai-review-1",
                message: "The mobile CTA clips.",
                fix: "Allow wrapping inside the viewport.",
              },
            ]
          : [];
      },
    },
  );
});

test("standard auto-improve creates a version before repairing a visual defect", async () => {
  let turn = 0;
  const calls: Array<{ message: string; isRepair?: boolean }> = [];
  const runner: AgentRunner = {
    id: "standard-p2-versioned-auto-improve",
    async runTurn(input) {
      turn += 1;
      calls.push({ message: input.message, isRepair: input.isRepair });
      mkdirSync(join(input.projectDir, "src"), { recursive: true });
      writeFileSync(join(input.projectDir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>${turn === 1 ? "Draft" : "Fixed"}</main> }`);
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: turn === 1 ? "draft complete" : "fixed complete", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  const visualQaCalls: string[] = [];
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: true });
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), "{}");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
      });
      const events = parseSse(await res.text());
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal(done.mode, "standard");
      assert.equal(done.passed, true);
      assert.equal(done.rounds, 1);
      assert.equal(done.score, 100);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.isRepair, true);
      assert.match(calls[1]?.message ?? "", /visual-copy-wrap/);
      assert.match(calls[1]?.message ?? "", /Let the heading wrap/);
      assert.equal(visualQaCalls.length, 2);

      const versionRuns = store.listRuns(project.id).filter((run) => run.commitHash);
      assert.equal(versionRuns.length, 2);
      const finalRun = store.getRun(done.runId as string)!;
      assert.equal(versionRuns[0]?.id, finalRun.id, "the completed run remains the newest version");
      const snapshot = versionRuns.find((run) => run.id !== finalRun.id)!;
      assert.equal(snapshot.status, "succeeded");
      assert.equal(snapshot.repairRounds, 0);
      assert.equal(snapshot.score, 92);
      assert.equal(snapshot.findings[0]?.id, "visual-copy-wrap");
      assert.equal((snapshot.findings[0] as { reviewStatus?: string } | undefined)?.reviewStatus, "active");
      assert.notEqual(snapshot.commitHash, finalRun.commitHash);

      assert.equal(finalRun.repairRounds, 1);
      assert.equal(finalRun.lintPassed, true);
      assert.equal(finalRun.score, 100);
      assert.equal(finalRun.findings[0]?.id, "visual-copy-wrap");
      assert.equal((finalRun.findings[0] as { reviewStatus?: string } | undefined)?.reviewStatus, "resolved");
    },
    {
      visualQa: async () => {
        visualQaCalls.push(`call-${visualQaCalls.length + 1}`);
        return visualQaCalls.length === 1
          ? [
              {
                severity: "P1",
                id: "visual-copy-wrap",
                message: "The heading clips on mobile.",
                fix: "Let the heading wrap inside the viewport.",
              },
            ]
          : [];
      },
    },
  );
});

test("standard auto-improve persists each turn summary before its visual review", async () => {
  let turn = 0;
  const runner: AgentRunner = {
    id: "standard-round-transcript-persistence",
    async runTurn(input) {
      turn += 1;
      mkdirSync(join(input.projectDir, "src"), { recursive: true });
      writeFileSync(join(input.projectDir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>Round ${turn}</main> }`);
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: turn === 1 ? "round zero summary" : "round one summary", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  let visualQaCalls = 0;
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: true });
      const project = store.createProject({ name: "Std", mode: "standard" });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), "{}");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
      });
      const events = parseSse(await res.text());
      const done = events.find((e) => e.type === "run-done")!;
      const conversationId = events.find((e) => e.type === "run-start")?.conversationId as string;
      assert.equal(done.rounds, 1);

      const persisted = store.listMessages(conversationId);
      assert.deepEqual(persisted.map(persistedMessageKind), ["user", "assistant", "visual-0", "assistant", "visual-1", "result"]);
      assert.equal(persisted[1]?.content, "round zero summary");
      assert.equal(persisted[3]?.content, "round one summary");
    },
    {
      visualQa: async () => {
        visualQaCalls += 1;
        return visualQaCalls === 1
          ? [
              {
                severity: "P1",
                id: "visual-spacing",
                message: "Spacing needs polish.",
                fix: "Tighten the vertical rhythm.",
              },
            ]
          : [];
      },
    },
  );
});

test("standard auto-improve persists process elapsed time per turn", async () => {
  let turn = 0;
  let now = 10_000;
  const realNow = Date.now;
  Date.now = () => now;
  const runner: AgentRunner = {
    id: "standard-round-process-elapsed",
    async runTurn(input) {
      turn += 1;
      input.onActivity?.({ kind: "tool", name: turn === 1 ? "Write" : "Edit", summary: turn === 1 ? "Drafting App.jsx" : "Fixing App.jsx" });
      now += turn === 1 ? 60_000 : 5_000;
      mkdirSync(join(input.projectDir, "src"), { recursive: true });
      writeFileSync(join(input.projectDir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>Round ${turn}</main> }`);
      writeFileSync(join(input.projectDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      return { text: turn === 1 ? "round zero summary" : "round one summary", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  let visualQaCalls = 0;
  try {
    await withRunServer(
      runner,
      async ({ base, dataDir, store }) => {
        store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: true });
        const project = store.createProject({ name: "Std", mode: "standard" });
        const dir = join(dataDir, "projects", project.id);
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: dir });
        writeFileSync(join(dir, "package.json"), "{}");
        execFileSync("git", ["add", "-A"], { cwd: dir });
        execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

        const res = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
        });
        const events = parseSse(await res.text());
        const done = events.find((e) => e.type === "run-done")!;
        const conversationId = events.find((e) => e.type === "run-start")?.conversationId as string;
        assert.equal(done.rounds, 1);

        const processElapsed = store
          .listMessages(conversationId)
          .flatMap((message): number[] => {
            if (message.role !== "system") return [];
            try {
              const parsed = JSON.parse(message.content) as { process?: { elapsedMs?: unknown } };
              return typeof parsed.process?.elapsedMs === "number" ? [parsed.process.elapsedMs] : [];
            } catch {
              return [];
            }
          });
        assert.equal(processElapsed.length, 2);
        assert.ok(processElapsed[0]! >= 60_000);
        assert.ok(processElapsed[1]! < processElapsed[0]!);
      },
      {
        visualQa: async () => {
          visualQaCalls += 1;
          return visualQaCalls === 1
            ? [
                {
                  severity: "P1",
                  id: "visual-spacing",
                  message: "Spacing needs polish.",
                  fix: "Tighten the vertical rhythm.",
                },
              ]
            : [];
        },
      },
    );
  } finally {
    Date.now = realNow;
  }
});

test("the composed prompt exposes the skill catalog for on-demand loading, not a force-injected body", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({
      name: "P",
      skillId: "frontend-design",
      designSystemId: "modern-minimal",
    });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
    });
    await res.text(); // drain the SSE stream

    const prompt = runner.calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /Available skills/, "skill catalog present");
    assert.match(prompt, /`frontend-design`/, "the skill is catalogued");
    assert.match(prompt, /pinned for this project/, "an explicit skillId is flagged as pinned, not forced");
    assert.match(prompt, /frontend-design\/SKILL\.md/, "on-demand playbook path present");
    assert.doesNotMatch(prompt, /general skill for a single polished page/, "the body is NOT injected — the agent reads it on demand");
    assert.match(prompt, /AUTHORITATIVE/, "design-system declared authoritative");
    assert.match(prompt, /--accent: #2563eb/, "verbatim design-system token present");
  });
});

test("motion skills add animation library routing to the composed prompt", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({
      name: "Animation",
      skillId: "motion-landing",
    });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make an animated launch page" }),
    });
    await res.text();

    const prompt = runner.calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /Implementation library routing/);
    assert.match(prompt, /Motion for React/);
    assert.match(prompt, /GSAP/);
    assert.match(prompt, /Remotion/);
  });
});

test("an unknown skillId is tolerated — the catalog is still offered, run still succeeds", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({ name: "P", skillId: "does-not-exist" });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === "run-done"), "run completed");
    const prompt = runner.calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /Available skills/, "the catalog is always offered for on-demand loading");
    assert.doesNotMatch(prompt, /pinned for this project/, "an unknown skillId pins nothing");
  });
});

test("daemon start honors per-run agentCommand/model instead of a fixed startup runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-start-agent-"));
  const binDir = join(root, "bin");
  const dataDir = join(root, "data");
  const portFile = join(root, "daemon.json");
  const callsFile = join(root, "calls.jsonl");
  const clean = CLEAN.replace(/`/g, "\\`");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "codex"),
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({cmd:"codex", args:process.argv.slice(2)}) + "\\n");
const args = process.argv.slice(2);
if (!args.includes("exec")) {
  console.log("codex 1.0.0");
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), "index.html"), \`${clean}\`);
console.log("codex done");
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "fake-claude"),
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({cmd:"fake-claude", args:process.argv.slice(2)}) + "\\n");
const args = process.argv.slice(2);
if (!args.includes("-p")) {
  console.log("fake-claude 1.0.0");
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), "index.html"), \`${clean}\`);
console.log(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"claude done"}]}}));
`,
    { mode: 0o755 },
  );

  const child = spawn("node", ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "src/start.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEZIN_DATA_DIR: dataDir,
      DEZIN_PORTFILE: portFile,
      DEZIN_AGENT_CMD: "fake-claude",
    },
    stdio: "ignore",
  });
  try {
    let base = "";
    let daemonToken = "";
    for (let i = 0; i < 80; i++) {
      if (existsSync(portFile)) {
        const info = JSON.parse(readFileSync(portFile, "utf8")) as { url: string; token: string };
        base = info.url;
        daemonToken = info.token;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(base, "daemon wrote its port file");
    assert.ok(daemonToken, "daemon wrote its token");
    const project = await createProject(base, { name: "P" }, daemonToken);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dezin-daemon-token": daemonToken },
      body: JSON.stringify({ projectId: project.id, brief: "go", agentCommand: "codex", model: "gpt-5" }),
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === "run-done"), "run completed");

    const calls = readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { cmd: string; args: string[] });
    const runCall = calls.find((c) => c.cmd === "codex" && c.args.includes("exec"));
    assert.ok(runCall, `expected the run to use codex, got ${JSON.stringify(calls)}`);
    assert.ok(runCall.args.includes("gpt-5"), "selected model reaches the chosen runner");
  } finally {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
});

test("daemon start rejects a second instance for the same data dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-start-lock-"));
  const dataDir = join(root, "data");
  const firstPortFile = join(root, "daemon-1.json");
  const secondPortFile = join(root, "daemon-2.json");
  const commonEnv = {
    ...process.env,
    DEZIN_DATA_DIR: dataDir,
  };
  const first = spawn("node", ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "src/start.ts"], {
    cwd: process.cwd(),
    env: { ...commonEnv, DEZIN_PORTFILE: firstPortFile },
    stdio: "ignore",
  });

  try {
    let started = false;
    for (let i = 0; i < 80; i++) {
      if (existsSync(firstPortFile)) {
        started = true;
        break;
      }
      await delay(50);
    }
    assert.ok(started, "first daemon wrote its port file");

    let stderr = "";
    const second = spawn("node", ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "src/start.ts"], {
      cwd: process.cwd(),
      env: { ...commonEnv, DEZIN_PORTFILE: secondPortFile },
      stdio: ["ignore", "ignore", "pipe"],
    });
    second.stderr?.setEncoding("utf8");
    second.stderr?.on("data", (data: string) => (stderr += data));
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));

    assert.notEqual(code, 0);
    assert.match(stderr, /already using/);
    assert.equal(existsSync(secondPortFile), false);
  } finally {
    await new Promise<void>((resolve) => {
      if (first.exitCode !== null || first.signalCode !== null) return resolve();
      first.once("exit", () => resolve());
      first.kill("SIGTERM");
    });
  }
});

test("research-enabled run writes research/ and grounds the build in the report", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async (input) => {
    mkdirSync(join(input.dir, ".research"), { recursive: true });
    writeFileSync(join(input.dir, ".research", "research.md"), "# Research\n\nKey finding: real users skim.");
    return { ran: true, produced: true, visualProduced: false };
  };
  await withRunServer(
    runner,
    async ({ base }) => {
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero", research: true }),
      });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      const types = events.map((e) => e.type);
      assert.ok(types.includes("research-start"));
      assert.ok(types.includes("research-done"));
      assert.ok(types.includes("run-done"));
      const done = events.find((e) => e.type === "research-done")!;
      assert.equal(done.produced, true);
      assert.equal(done.report, true, "research-done carries a disk summary (report present)");
      // the build turn's brief was grounded in the research report
      assert.ok(runner.calls.length >= 1);
      assert.match(runner.calls[0]!.message, /Key finding: real users skim/);
      assert.match(runner.calls[0]!.message, /research report/i);
    },
    { researchPhase },
  );
});

test("research phase uses the configured research Agent/model override", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  let researchInput: { agentCommand?: string; model?: string } | undefined;
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async (input) => {
    researchInput = { agentCommand: input.agentCommand, model: input.model };
    mkdirSync(join(input.dir, ".research"), { recursive: true });
    writeFileSync(join(input.dir, ".research", "research.md"), "# Research\n\nx");
    return { ran: true, produced: true, visualProduced: false };
  };
  await withRunServer(
    runner,
    async ({ base, store }) => {
      store.updateSettings({ researchAgentCommand: "codebuddy", researchModel: "hunyuan" });
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero", research: true, agentCommand: "codex", model: "gpt-5" }),
      });
      assert.equal(res.status, 200);
      await res.text();
      // Research must use its own configured Agent/model, NOT the run's — so a vision-capable
      // agent can be chosen for research independently of the build agent.
      assert.equal(researchInput?.agentCommand, "codebuddy", "research uses the research Agent override");
      assert.equal(researchInput?.model, "hunyuan", "research uses the research model override");
    },
    { researchPhase },
  );
});

test("a follow-up turn does not re-run Research on an already-researched project", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  let researchCalls = 0;
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async () => {
    researchCalls++;
    return { ran: false, produced: true, visualProduced: false };
  };
  await withRunServer(
    runner,
    async ({ base, store, dataDir }) => {
      store.updateSettings({ researchEnabled: true });
      const project = await createProject(base);
      // Simulate a project ALREADY researched on a prior run: report + 2 candidate directions on
      // disk. A follow-up turn (no directionSlug, no explicit research:true) must NOT re-enter
      // research — doing so flashes "Researching", re-surfaces the old direction gate, and cancels
      // the run.
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(join(dir, ".research", "directions", "a"), { recursive: true });
      mkdirSync(join(dir, ".research", "directions", "b"), { recursive: true });
      writeFileSync(join(dir, ".research", "research.md"), "# Research\n\nprior");
      writeFileSync(join(dir, ".research", "directions", "a", "direction.md"), "# Direction A");
      writeFileSync(join(dir, ".research", "directions", "b", "direction.md"), "# Direction B");
      writeFileSync(join(dir, ".research", "chosen"), "a\n"); // the user picked direction "a" earlier

      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make the hero bigger" }),
      });
      assert.equal(res.status, 200);
      const types = parseSse(await res.text()).map((e) => e.type);

      assert.equal(researchCalls, 0, "a follow-up must not re-run the Research phase");
      assert.ok(!types.includes("research-start"), "must not flash Researching on a follow-up");
      assert.ok(!types.includes("direction-gate"), "must not re-surface the old direction gate");
      assert.ok(!types.includes("run-cancelled"), "must not cancel the follow-up run");
      assert.ok(types.includes("run-done"), "the follow-up build completes normally");

      // …but the follow-up build must stay GROUNDED: the research report + the previously-chosen
      // direction are re-wired into the brief WITHOUT re-running research.
      assert.match(runner.calls[0]!.message, /## Research report/, "follow-up brief carries the research report");
      assert.match(runner.calls[0]!.message, /prior/, "…including the report body");
      assert.match(runner.calls[0]!.message, /Chosen direction/, "…and the previously-chosen direction spec");
    },
    { researchPhase },
  );
});

test("dual-track research: SSE research-activity carries track, and visual assets sync into a moodboard", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async (input) => {
    // Product track.
    mkdirSync(join(input.dir, ".research"), { recursive: true });
    writeFileSync(join(input.dir, ".research", "research.md"), "# Research\n\nKey finding: real users skim.");
    // Visual track — enough for syncVisualResearchMoodboard to have something to fold in.
    const visualAssets = join(input.dir, ".research", "visual", "assets");
    mkdirSync(visualAssets, { recursive: true });
    writeFileSync(join(input.dir, ".research", "visual", "visual.md"), "# Visual research\n\nMono, bold type.");
    writeFileSync(join(visualAssets, "a.png"), "PNGDATA");
    writeFileSync(
      join(input.dir, ".research", "visual", "sources.json"),
      JSON.stringify([{ id: "v1", platform: "dribbble", url: "https://dribbble.com/shots/1", assets: ["assets/a.png"] }]),
    );
    // Emit one activity per track so the SSE assertion below can check both tags arrive.
    input.onActivity?.({ kind: "note", text: "product note", track: "product" });
    input.onActivity?.({ kind: "note", text: "visual note", track: "visual" });
    return { ran: true, produced: true, visualProduced: true };
  };
  await withRunServer(
    runner,
    async ({ base, store }) => {
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero", research: true }),
      });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.ok(events.some((e) => e.type === "research-done" && e.produced === true));

      // The SSE research-activity event threads the track through to the client.
      const activity = events.filter((e) => e.type === "research-activity");
      assert.ok(activity.some((e) => e.track === "product" && e.text === "product note"));
      assert.ok(activity.some((e) => e.track === "visual" && e.text === "visual note"));

      // The visual moodboard was synced (best-effort, after the phase resolved) — a board
      // named "Visual research" now holds an image node for the visual-track asset.
      const boards = store.listMoodboards();
      const board = boards.find((b) => b.name === "Visual research");
      assert.ok(board, "expected the visual-research moodboard to have been created");
      const nodes = store.listMoodboardNodes(board!.id);
      assert.equal(nodes.filter((n) => n.type === "image").length, 1);

      // The visual section is now visible via the research endpoint too.
      const research = (await (await fetch(`${base}/api/projects/${project.id}/research`)).json()) as {
        visual?: { exists: boolean; boardId?: string };
      };
      assert.equal(research.visual?.exists, true);
      assert.equal(research.visual?.boardId, board!.id);
    },
    { researchPhase },
  );
});

test("runs without the research flag skip the research phase", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  let called = false;
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async () => {
    called = true;
    return { ran: true, produced: false, visualProduced: false };
  };
  await withRunServer(
    runner,
    async ({ base }) => {
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(called, false);
      assert.doesNotMatch(runner.calls[0]!.message, /research report/i);
    },
    { researchPhase },
  );
});

const researchWithDirections: NonNullable<AppDeps["researchPhase"]> = async (input) => {
  const dirs = join(input.dir, ".research", "directions");
  mkdirSync(join(dirs, "alpha"), { recursive: true });
  mkdirSync(join(dirs, "beta"), { recursive: true });
  writeFileSync(join(input.dir, ".research", "research.md"), "# Research\n\nFindings.");
  writeFileSync(join(dirs, "alpha", "direction.md"), "# Alpha — bold\n\nBold concept for alpha.");
  writeFileSync(join(dirs, "beta", "direction.md"), "# Beta — calm\n\nCalm concept for beta.");
  return { ran: true, produced: true, visualProduced: false };
};

test("research with 2+ directions fires the direction gate and stops before build", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(
    runner,
    async ({ base, store }) => {
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero", research: true }),
      });
      const events = parseSse(await res.text());
      const gate = events.find((e) => e.type === "direction-gate");
      assert.ok(gate, "expected a direction-gate event");
      assert.equal((gate!.directions as unknown[]).length, 2);
      assert.equal(events.find((e) => e.type === "run-cancelled")!.reason, "direction");
      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-cancelled"]);
      const runId = events.find((event) => event.type === "run-start")!.runId as string;
      assert.equal(store.getRun(runId)?.status, "cancelled");
      assert.equal(typeof store.getRun(runId)?.finishedAt, "number");
      assert.equal(runner.calls.length, 0); // build never ran

      const retry = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          conversationId: events.find((event) => event.type === "run-start")!.conversationId,
          brief: "make a hero",
          research: true,
          directionSlug: "alpha",
        }),
      });
      assert.equal(retry.status, 200, "direction-gate settlement releases the target for an immediate retry");
      assert.deepEqual(terminalEvents(await closedSse(retry, "direction retry")).map((event) => event.type), ["run-done"]);
    },
    { researchPhase: researchWithDirections },
  );
});

test("a run with directionSlug skips the gate and builds the chosen direction", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(
    runner,
    async ({ base }) => {
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero", research: true, directionSlug: "alpha" }),
      });
      const events = parseSse(await res.text());
      assert.ok(!events.some((e) => e.type === "direction-gate"), "gate should be skipped");
      assert.ok(events.some((e) => e.type === "run-done"));
      assert.ok(runner.calls.length >= 1);
      assert.match(runner.calls[0]!.message, /Chosen direction/);
      assert.match(runner.calls[0]!.message, /Bold concept for alpha/);
      assert.doesNotMatch(runner.calls[0]!.message, /Calm concept for beta/);
      // The pick is persisted so the Research views can show it (survives reload).
      const research = (await (await fetch(`${base}/api/projects/${project.id}/research`)).json()) as { chosenSlug?: string };
      assert.equal(research.chosenSlug, "alpha");
    },
    { researchPhase: researchWithDirections },
  );
});

test("picking a direction does not re-run research or duplicate the user/research message on reload", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  let researchCalls = 0;
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async (input) => {
    researchCalls += 1;
    return researchWithDirections(input);
  };
  await withRunServer(
    runner,
    async ({ base, store }) => {
      const project = await createProject(base);
      store.updateSettings({ researchEnabled: true });
      // Run 1: research → direction gate (cancels before build).
      await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "make a hero" }) })).text();
      const convId = store.listConversations(project.id)[0]!.id;
      // Run 2: pick a direction, SAME conversation → build (no `research` flag, mirroring the client).
      await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "make a hero", directionSlug: "alpha", conversationId: convId }) })).text();

      const messages = store.listMessages(convId);
      const userMessages = messages.filter((m) => m.role === "user");
      const researchMessages = messages.filter((m) => {
        if (m.role !== "system") return false;
        try {
          return !!(JSON.parse(m.content) as { research?: unknown }).research;
        } catch {
          return false;
        }
      });
      assert.equal(researchCalls, 1, "research must not re-run when building a pre-chosen direction");
      assert.equal(userMessages.length, 1, "the brief is ONE user message — the pick must not duplicate it");
      assert.equal(researchMessages.length, 1, "ONE research summary message — the pick must not duplicate it");
      assert.ok(runner.calls.length >= 1, "the chosen direction still builds");
    },
    { researchPhase },
  );
});

test("a run records its model, agent, and agent-selected skill for attribution", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "a pricing page with three tiers", agentCommand: "codebuddy", model: "hy3-preview-agent-ioa" }),
    });
    const runId = parseSse(await res.text()).find((e) => e.type === "run-start")!.runId as string;
    const run = store.getRun(runId)!;
    assert.equal(run.agentCommand, "codebuddy");
    assert.equal(run.model, "hy3-preview-agent-ioa");
    assert.equal(run.skillId, "pricing-page");
  });
});

test("the run feedback endpoint records and clears a verdict", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
    });
    const runId = parseSse(await res.text()).find((e) => e.type === "run-start")!.runId as string;

    const up = await fetch(`${base}/api/runs/${runId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "up", gap: "layout" }),
    });
    assert.equal(up.status, 200);
    assert.deepEqual(store.getRun(runId)!.feedback, { verdict: "up", gap: "layout" });

    await fetch(`${base}/api/runs/${runId}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: true }) });
    assert.equal(store.getRun(runId)!.feedback, null);

    const bad = await fetch(`${base}/api/runs/${runId}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict: "maybe" }) });
    assert.equal(bad.status, 400);
  });
});

test("a build references the user's previously-kept (upvoted) designs", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN, CLEAN], texts: ["done", "done"] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = await createProject(base);
    const res1 = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "v1" }) });
    const run1 = parseSse(await res1.text()).find((e) => e.type === "run-start")!.runId as string;
    store.setRunFeedback(run1, { verdict: "up" });

    const res2 = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "v2" }) });
    await res2.text();

    const lastCall = runner.calls[runner.calls.length - 1]!;
    assert.match(lastCall.message, new RegExp(`\\.versions/${run1}\\.html`));
    assert.match(lastCall.message, /KEPT these earlier designs/);
  });
});

test("a build references kept designs of the same kind from other projects (cross-project exemplars)", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN, CLEAN], texts: ["done", "done"] });
  await withRunServer(runner, async ({ base, store }) => {
    const projA = store.createProject({ name: "A", skillId: "landing", mode: "prototype" });
    const projB = store.createProject({ name: "B", skillId: "landing", mode: "prototype" });

    const resA = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: projA.id, brief: "landing A" }) });
    const runA = parseSse(await resA.text()).find((e) => e.type === "run-start")!.runId as string;
    store.setRunFeedback(runA, { verdict: "up" });

    const resB = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: projB.id, brief: "landing B" }) });
    await resB.text();

    const lastCall = runner.calls[runner.calls.length - 1]!;
    assert.match(lastCall.message, /kept designs of this kind before/);
    assert.match(lastCall.message, /--accent:#2563eb/);
  });
});

test("an approved distilled preference is injected into the next build's system prompt (learning loop closes)", async () => {
  // Closes the preference leg of the learning loop end-to-end: feedback → distilled preference
  // → (user approves →) settings.customInstructions → the NEXT build's system prompt. The
  // suggestion + exemplar legs are covered above; this proves the approved preference actually
  // reaches the agent that generates the design.
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = await createProject(base);
    // The user approved a distilled preference — the endpoint writes it into customInstructions.
    const preference = "Prefer generous whitespace with exactly one restrained accent color";
    store.updateSettings({ customInstructions: preference });

    const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "make a hero" }) });
    await res.text();

    const lastCall = runner.calls[runner.calls.length - 1]!;
    assert.match(lastCall.systemPrompt, /generous whitespace with exactly one restrained accent color/);
  });
});

test("the preference suggestion endpoint reflects over feedback (injected agent)", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  let gotSignals = 0;
  const preferenceSuggester: NonNullable<AppDeps["preferenceSuggester"]> = async (input) => {
    gotSignals = input.signals.length;
    return "- Prefer restrained accent use\n- Generous whitespace";
  };
  await withRunServer(
    runner,
    async ({ base, store }) => {
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "make a hero" }) });
      const runId = parseSse(await res.text()).find((e) => e.type === "run-start")!.runId as string;
      store.setRunFeedback(runId, { verdict: "up", gap: "layout" });

      const sugg = await fetch(`${base}/api/preferences/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(sugg.status, 200);
      const body = (await sugg.json()) as { suggestion: string; signals: number };
      assert.equal(body.signals, 1);
      assert.match(body.suggestion, /restrained accent/);
      assert.equal(gotSignals, 1);
    },
    { preferenceSuggester },
  );
});

test("the preference suggestion endpoint returns empty when there is no feedback", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base }) => {
    await createProject(base);
    const sugg = await fetch(`${base}/api/preferences/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = (await sugg.json()) as { suggestion: string; signals: number };
    assert.equal(body.signals, 0);
    assert.equal(body.suggestion, "");
  });
});
