import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { createApp, createRuntimeSupervisor, type AppDeps } from "../src/index.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";
import {
  standardRunBranchName,
  standardRunWorktreeDir,
  withStandardSourceMutationLock,
} from "../src/standard-run-transaction.ts";

const CLEAN =
  `<style>:root{--accent:#2563eb}</style>\n` +
  `<section data-dezin-id="x"><h1>Hi there</h1><p>Real copy describing the thing.</p></section>`;
const SLOPPY = `<style>.hero{background:#6366f1}</style><h1>🚀 Launch</h1><p>10x faster.</p>`;
const VALID_SOURCE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

interface RunCtx {
  base: string;
  dataDir: string;
  store: Store;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withRunServer(
  runner: AgentRunner | undefined,
  fn: (ctx: RunCtx) => Promise<void>,
  extraDeps: Partial<Omit<AppDeps, "store" | "dataDir" | "runner">> = {},
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = extraDeps.runtimeSupervisor ?? createRuntimeSupervisor({ store, dataDir });
  const server = createApp({ store, dataDir, runner, visualQa: async () => [], ...extraDeps, runtimeSupervisor });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await runtimeSupervisor.shutdown();
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

const VALID_PRODUCT_RESEARCH_REPORT =
  "# Research\n\nFindings from prior product comparisons show that users scan proof, compare alternatives, and need one clear primary action before committing. [product-source]\n";
const VALID_VISUAL_RESEARCH_REPORT =
  "# Visual research\n\nInspected references use restrained contrast, deliberate type hierarchy, and one focused accent to create a calm but distinctive interface. [visual-source]\n";
const VALID_ALPHA_DIRECTION =
  "# Alpha — bold\n\nConcept: Bold direction for alpha, grounded in the product and visual evidence.\n\nStructure: Lead with the primary task, then proof, detail, and one clear next action.\n\nDistinctive move: Use a precise editorial transition and decisive type scale without adding noise.\n";
const VALID_BETA_DIRECTION =
  "# Beta — calm\n\nConcept: Calm direction for beta, grounded in the product and visual evidence.\n\nStructure: Build a measured sequence from context to comparison, confidence, and action.\n\nDistinctive move: Use quiet tonal layers and tightly controlled spacing to make the experience memorable.\n";

function writeValidatedResearchBundle(dir: string): void {
  const researchDir = join(dir, ".research");
  const visualDir = join(researchDir, "visual");
  const directionsDir = join(researchDir, "directions");
  mkdirSync(join(researchDir, "assets"), { recursive: true });
  mkdirSync(join(visualDir, "assets"), { recursive: true });
  mkdirSync(join(directionsDir, "alpha"), { recursive: true });
  mkdirSync(join(directionsDir, "beta"), { recursive: true });
  writeFileSync(join(researchDir, "research.md"), VALID_PRODUCT_RESEARCH_REPORT);
  writeFileSync(join(researchDir, "assets", "product.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(
    join(researchDir, "sources.json"),
    JSON.stringify([
      {
        id: "product-source",
        kind: "inspiration",
        title: "Product source",
        url: "https://example.com/product",
        authority: "primary",
        takeaways: ["Users need comparison evidence before the primary action."],
        assets: ["assets/product.png"],
      },
    ]),
  );
  writeFileSync(join(visualDir, "visual.md"), VALID_VISUAL_RESEARCH_REPORT);
  writeFileSync(join(visualDir, "assets", "visual.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(
    join(visualDir, "sources.json"),
    JSON.stringify([
      {
        id: "visual-source",
        kind: "inspiration",
        title: "Visual source",
        url: "https://example.com/visual",
        reached: true,
        takeaways: ["A restrained palette and deliberate hierarchy keep the surface focused."],
        assets: ["assets/visual.png"],
      },
    ]),
  );
  writeFileSync(join(directionsDir, "alpha", "direction.md"), VALID_ALPHA_DIRECTION);
  writeFileSync(join(directionsDir, "beta", "direction.md"), VALID_BETA_DIRECTION);
}

function initStandardRunProject(dataDir: string, store: Store): { project: ReturnType<Store["createProject"]>; dir: string; head: string } {
  const project = store.createProject({ name: "Std", mode: "standard" });
  const dir = join(dataDir, "projects", project.id);
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "src", "App.jsx"), "source baseline");
  const head = commitAll(dir, "base");
  return { project, dir, head };
}

function initFreshSharinganStandardProject(
  dataDir: string,
  store: Store,
): { project: ReturnType<Store["createProject"]>; dir: string; head: string } {
  const project = store.createProject({ name: "Fresh clone", mode: "standard", sharingan: true, sourceUrl: "http://x.test/" });
  const dir = join(dataDir, "projects", project.id);
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  writeFileSync(join(dir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
  writeFileSync(join(dir, "src", "App.jsx"), `export default function App(){ return <main>source baseline</main> }`);
  return { project, dir, head: commitAll(dir, "base") };
}

function fakeFreshSharinganSession(): SharinganSession {
  let currentUrl = "http://x.test/";
  return {
    currentUrl: () => currentUrl,
    navigate: async (url: string) => {
      currentUrl = url;
      return { status: 200, finalUrl: url };
    },
    readDom: async () => [{ tag: "h1", classes: "", text: "Captured source", box: { x: 0, y: 0, w: 320, h: 48 } }],
    readDomTree: async () => [{ tag: "h1", classes: "", text: "Captured source", box: { x: 0, y: 0, w: 320, h: 48 }, style: {}, children: [] }],
    readRenderMap: async () => ({
      viewport: { width: 1440, height: 900 },
      document: { width: 1440, height: 900 },
      elements: [{ selector: "body", tag: "body", text: "Captured source", box: { x: 0, y: 0, w: 1440, h: 900 }, style: {} }],
    }),
    hasPasswordField: async () => false,
    setViewport: async () => {},
    settle: async () => {},
    screenshot: async () => VALID_SOURCE_PNG,
    styleTokens: async () => ({ colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] }),
    assets: async () => [],
    discoverLinks: async () => [],
    close: async () => {},
  } as unknown as SharinganSession;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SSE_CLOSE_TIMEOUT_MS = 10_000;

async function closedSse(res: Response, label: string): Promise<Array<Record<string, unknown>>> {
  const text = await Promise.race([
    res.text(),
    delay(SSE_CLOSE_TIMEOUT_MS).then(() => {
      throw new Error(`${label} stream did not close`);
    }),
  ]);
  return parseSse(text);
}

function terminalEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === "run-done" || event.type === "run-error" || event.type === "run-cancelled");
}

function writeValidSharinganEvidence(dir: string, sourceUrl = "https://example.com"): void {
  const sharinganDir = join(dir, ".sharingan");
  const screenshotPath = join(sharinganDir, "source-desktop.png");
  const renderMapPath = join(sharinganDir, "source-render-map.json");
  mkdirSync(sharinganDir, { recursive: true });
  writeFileSync(screenshotPath, VALID_SOURCE_PNG);
  writeFileSync(
    renderMapPath,
    JSON.stringify({
      viewport: { width: 1200, height: 800 },
      document: { width: 1200, height: 800 },
      elements: [
        {
          selector: "body",
          tag: "body",
          text: "Captured source",
          box: { x: 0, y: 0, w: 1200, h: 800 },
          style: {},
        },
      ],
    }),
  );
  writeFileSync(
    join(sharinganDir, "pages.json"),
    JSON.stringify({
      sourceUrl,
      pages: [
        {
          url: sourceUrl,
          screenshots: { desktop: ".sharingan/source-desktop.png" },
          renderMap: ".sharingan/source-render-map.json",
        },
      ],
    }),
  );
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
  writeValidSharinganEvidence(dir);
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
    return { ran: true, produced: false, visualProduced: false, complete: false, issues: [] };
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
    assert.equal(done.previewUrl, undefined, "durable run-done events must not persist a viewer URL capability");
    assert.equal(done.bridgeNonce, undefined, "each Prototype viewer must acquire its own bridge nonce");

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

test("Prototype durable preview events never persist viewer capabilities", async () => {
  const runner: AgentRunner = {
    id: "live-prototype-preview",
    async runTurn(input) {
      // Model a real agent writing the artifact while its turn is still live so the
      // preview poller is guaranteed to publish at least one durable invalidation.
      writeFileSync(join(input.projectDir, "index.html"), CLEAN);
      await delay(775);
      return { text: "done", artifactHtml: CLEAN, artifactPath: "index.html" };
    },
  };

  await withRunServer(runner, async ({ base }) => {
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "stream a live preview" }),
    });
    assert.equal(res.status, 200);

    const events = parseSse(await res.text());
    const preview = events.find((event) => event.type === "preview-update");
    assert.ok(preview, "the live artifact write must emit a preview invalidation");
    assert.equal(preview.previewUrl, undefined, "durable preview events must not persist a viewer URL capability");
    assert.equal(preview.bridgeNonce, undefined, "durable preview events must not persist a bridge nonce");

    const done = events.find((event) => event.type === "run-done");
    assert.ok(done);
    assert.equal(done.previewUrl, undefined, "durable terminal events must not persist a viewer URL capability");
    assert.equal(done.bridgeNonce, undefined, "durable terminal events must not persist a bridge nonce");
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
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: true, autoImproveMaxRounds: 3 });
      const project = await createProject(base);
      const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, brief: "make a hero" }) });
      const done = parseSse(await res.text()).find((e) => e.type === "run-done")!;
      // Review infrastructure is part of the acceptance contract: unassessed must not read as a
      // clean pass, even when the artifact's static floor has no findings.
      assert.equal(done.passed, false);
      assert.equal(done.designReviewed, false);
      assert.equal(runner.calls.length, 1, "QA infrastructure failures must not be sent back to the builder as artifact repairs");
      // The persisted result message says so, so the user isn't misled.
      const sys = store
        .listMessages(store.listConversations(project.id)[0]!.id)
        .find((m) => m.role === "system" && /not fully assessed/i.test(m.content));
      assert.ok(sys, "expected the result message to note design review did not run");
    },
    { visualQa: async () => [{ severity: "P2", id: "visual-render-failed", message: "Could not render in headless Chrome.", fix: "Check the preview." }] },
  );
});

test("a malformed critic result is reported as unassessed without claiming the page failed to render", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(
    runner,
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: false });
      const project = await createProject(base);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
      });
      const done = parseSse(await response.text()).find((event) => event.type === "run-done")!;
      const result = store
        .listMessages(store.listConversations(project.id)[0]!.id)
        .find((message) => message.role === "system" && /automated design review/i.test(message.content));

      assert.equal(done.passed, false);
      assert.equal(done.designReviewed, false);
      assert.match(result?.content ?? "", /not fully assessed/i);
      assert.doesNotMatch(result?.content ?? "", /could not render|only the anti-slop checks ran/i);
    },
    {
      visualQa: async () => [
        {
          severity: "P1",
          id: "visual-review-unassessed",
          message: "The visual critic returned malformed JSON twice.",
          fix: "Run the visual review again.",
        },
      ],
    },
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

test("a run with Visual Review disabled reports review status as not run, not approved", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  await withRunServer(runner, async ({ base, store }) => {
    store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
    });
    const done = parseSse(await res.text()).find((event) => event.type === "run-done")!;
    const result = store
      .listMessages(store.listConversations(project.id)[0]!.id)
      .find((message) => message.role === "system" && message.content.includes('"result"'))!;
    const meta = (JSON.parse(result.content) as { result: { meta: Record<string, unknown> } }).result.meta;

    assert.equal(Object.hasOwn(done, "designReviewed"), false);
    assert.equal(Object.hasOwn(meta, "designReviewed"), false);
    assert.match(result.content, /quality gate/);
  });
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
      const run = store.listRuns(project.id)[0];
      assert.ok(run);
      assert.match(
        parsed.visualReview?.screenshotUrl ?? "",
        new RegExp(`/api/projects/${project.id}/runs/${run.id}/evidence/round-0-[a-f0-9]{12}\\.png$`),
      );
      const evidence = await fetch(`${base}${parsed.visualReview?.screenshotUrl}`);
      assert.equal(evidence.status, 200);
      assert.equal(await evidence.text(), "round zero pixels");
      assert.equal(parsed.visualReview?.findings?.[0]?.message, "CTA clips.");
      assert.match(parsed.visualReview?.process?.[1]?.summary ?? "", /codebuddy \/ hunyuan/);
    },
    {
      visualQa: async (input) => {
        const screenshot = join(input.projectRoot!, ".visual-qa", "screenshot.png");
        mkdirSync(join(input.projectRoot!, ".visual-qa"), { recursive: true });
        writeFileSync(screenshot, "round zero pixels");
        return [{ severity: "P2", id: "visual-ai-review-1", message: "CTA clips.", fix: "Allow wrapping." }];
      },
    },
  );
});

test("a disabled Prototype visual review cannot persist pixels from the prior enabled run", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN, CLEAN], texts: ["first done", "second done"] });
  let visualQaCalls = 0;
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: false });
      const project = await createProject(base);
      const firstResponse = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "first enabled visual review" }),
      });
      const firstEvents = parseSse(await firstResponse.text());
      const firstRunId = firstEvents.find((event) => event.type === "run-start")!.runId as string;
      assert.equal(existsSync(join(dataDir, "version-evidence", project.id, firstRunId, "visual")), true);

      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const secondResponse = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "second review disabled" }),
      });
      const secondEvents = parseSse(await secondResponse.text());
      const secondStart = secondEvents.find((event) => event.type === "run-start")!;
      const secondRunId = secondStart.runId as string;
      const secondConversationId = secondStart.conversationId as string;

      assert.equal(visualQaCalls, 1, "the disabled run does not invoke visual QA");
      assert.equal(
        existsSync(join(dataDir, "version-evidence", project.id, secondRunId, "visual")),
        false,
        "the disabled run must not copy the previous run's mutable screenshot into immutable evidence",
      );
      assert.equal(JSON.stringify(secondEvents).includes(`/runs/${secondRunId}/evidence/`), false);
      assert.equal(
        store.listMessages(secondConversationId).some((message) => message.role === "system" && message.content.includes('"visualReview"')),
        false,
        "the disabled run must not persist a visual-review record",
      );
    },
    {
      visualQa: async (input) => {
        visualQaCalls += 1;
        mkdirSync(join(input.projectRoot!, ".visual-qa"), { recursive: true });
        writeFileSync(join(input.projectRoot!, ".visual-qa", "screenshot.png"), "pixels from the enabled run");
        return [{ severity: "P2", id: "visual-reviewed", message: "Automated design review completed.", fix: "" }];
      },
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
    return { ran: true, produced: false, visualProduced: false, complete: true, issues: [] };
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

test("incomplete explicit or automatic Research stops before the build runner", async () => {
  for (const mode of ["explicit", "automatic"] as const) {
    const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["must not run"] });
    const researchPhase: NonNullable<AppDeps["researchPhase"]> = async () => ({
      ran: true,
      produced: false,
      visualProduced: true,
      complete: false,
      issues: [
        { area: "product", code: "product-report-missing", message: "Product research report is missing." },
        { area: "directions", code: "directions-count", message: "Research must produce 2–3 meaningful directions; found 0." },
      ],
      error: "product: no report was produced",
    });

    await withRunServer(
      runner,
      async ({ base, store }) => {
        if (mode === "automatic") store.updateSettings({ researchEnabled: true });
        const project = await createProject(base);
        const response = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.id, brief: "research before building", ...(mode === "explicit" ? { research: true } : {}) }),
        });
        const events = await closedSse(response, `${mode} incomplete research`);
        const runId = String(events.find((event) => event.type === "run-start")?.runId ?? "");
        const researchDone = events.find((event) => event.type === "research-done");

        assert.equal(runner.calls.length, 0, `${mode} Research must hard-gate the build runner`);
        assert.equal(researchDone?.complete, false);
        assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-error"]);
        assert.equal(store.getRun(runId)?.status, "failed");
      },
      { researchPhase },
    );
  }
});

test("automatic Research revalidates a partial bundle left on disk instead of skipping to Build", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["must not run"] });
  let researchCalls = 0;
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async () => {
    researchCalls += 1;
    return {
      ran: true,
      produced: false,
      visualProduced: false,
      complete: false,
      issues: [{ area: "visual", code: "visual-report-missing", message: "Visual research report is missing." }],
    };
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ researchEnabled: true });
      const project = await createProject(base);
      const researchDir = join(dataDir, "projects", project.id, ".research");
      mkdirSync(researchDir, { recursive: true });
      writeFileSync(join(researchDir, "research.md"), "# Partial research\n\nThis leftover report exists, but the rest of the evidence bundle is incomplete.");

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "continue after partial research" }),
      });
      const events = await closedSse(response, "automatic partial research retry");

      assert.equal(researchCalls, 1);
      assert.equal(runner.calls.length, 0);
      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-error"]);
    },
    { researchPhase },
  );
});

test("an incomplete on-disk Research bundle cannot be used to build a selected direction", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["must not run"] });
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = await createProject(base);
    const researchDir = join(dataDir, "projects", project.id, ".research");
    mkdirSync(join(researchDir, "directions", "alpha"), { recursive: true });
    writeFileSync(join(researchDir, "research.md"), "# Partial research\n\nThis report exists without its required sources, assets, visual evidence, or complete direction set.");
    writeFileSync(
      join(researchDir, "directions", "alpha", "direction.md"),
      "# Alpha\n\nConcept: incomplete evidence.\n\nStructure: incomplete.\n\nDistinctive move: incomplete.",
    );

    const response = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "build alpha", research: false, directionSlug: "alpha" }),
    });
    const events = await closedSse(response, "incomplete direction build");
    const runId = String(events.find((event) => event.type === "run-start")?.runId ?? "");

    assert.equal(runner.calls.length, 0);
    assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-error"]);
    assert.equal(store.getRun(runId)?.status, "failed");
  });
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

test("prototype visual repair publishes the highest-scoring round with its matching assets", async () => {
  const bestHtml = `${CLEAN}\n<img src="assets/hero.png" alt="Round zero"><p>best visual round</p>`;
  const regressedHtml = `${CLEAN}\n<img src="assets/hero.png" alt="Round one"><p>regressed visual round</p>`;
  const bestPixels = Buffer.concat([VALID_SOURCE_PNG, Buffer.from("best-round-pixels")]);
  const regressedPixels = Buffer.concat([VALID_SOURCE_PNG, Buffer.from("regressed-round-pixels")]);
  const runner = new FakeRunner({ artifacts: [bestHtml, regressedHtml], texts: ["draft", "worse repair"] });
  let projectRoot = "";
  let visualRound = 0;

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: true });
      const project = await createProject(base);
      projectRoot = join(dataDir, "projects", project.id);
      mkdirSync(join(projectRoot, "assets"), { recursive: true });
      writeFileSync(join(projectRoot, "assets", "hero.png"), bestPixels);

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero", maxRounds: 1 }),
      });
      const events = parseSse(await response.text());
      const done = events.find((event) => event.type === "run-done")!;
      const runId = done.runId as string;

      assert.equal(done.rounds, 1, "the regressing repair was still attempted");
      assert.equal(done.score, 92, "the returned quality state belongs to the better initial round");
      assert.match(readFileSync(join(projectRoot, "index.html"), "utf8"), /best visual round/);
      assert.deepEqual(readFileSync(join(projectRoot, "assets", "hero.png")), bestPixels);
      assert.match(readFileSync(join(projectRoot, ".versions", `${runId}.html`), "utf8"), /best visual round/);
      assert.deepEqual(readFileSync(join(projectRoot, ".versions", `${runId}.files`, "assets", "hero.png")), bestPixels);
      assert.equal(
        existsSync(join(projectRoot, ".versions", `${runId}-visual-round-0.html`)),
        false,
        "private repair-round snapshots are removed after publication",
      );

      const persisted = store.getRun(runId)!;
      assert.equal(persisted.score, 92);
      assert.equal(persisted.findings.filter((finding) => finding.reviewStatus !== "resolved")[0]?.id, "visual-round-zero");
      assert.deepEqual(
        store.listMessages(persisted.conversationId).filter((message) => message.role === "assistant").map((message) => message.content),
        ["draft"],
        "the transcript summary belongs to the published candidate, not the rejected repair",
      );
    },
    {
      visualQa: async () => {
        visualRound += 1;
        if (visualRound === 1) {
          // The first round snapshot must already own these bytes before a later repair mutates
          // the shared Prototype root.
          writeFileSync(join(projectRoot, "assets", "hero.png"), regressedPixels);
          return [{ severity: "P1", id: "visual-round-zero", message: "Initial issue.", fix: "Try one repair." }];
        }
        return [
          { severity: "P1", id: "visual-round-one-a", message: "Repair regressed hierarchy.", fix: "Restore the stronger hierarchy." },
          { severity: "P1", id: "visual-round-one-b", message: "Repair regressed spacing.", fix: "Restore the stronger spacing." },
        ];
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
  let captured: { url: string; outPath: string } | null = null;
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
    assert.match(versionHtml, /data-dezin-runtime-probe/);
    assert.match(versionHtml, /sync-scroll/);
    const previewCapabilityResponse = await fetch(
      `${base}/api/projects/${project.id}/versions/${runId}/preview-url`,
    );
    assert.equal(previewCapabilityResponse.status, 200);
    const previewCapability = await previewCapabilityResponse.json() as {
      mode: string;
      url: string;
      bridgeNonce?: string;
    };
    assert.equal(previewCapability.mode, "prototype");
    assert.match(previewCapability.bridgeNonce ?? "", /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(
      previewCapability.url,
      `/api/projects/${project.id}/versions/${runId}#dezin-bridge=${previewCapability.bridgeNonce}`,
    );
    const rawSource = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/source`);
    assert.equal(rawSource.status, 200);
    assert.equal(await rawSource.text(), CLEAN, "Historical Files reads the immutable source without Viewer instrumentation");

    const identicalDiff = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/diff`);
    assert.equal(identicalDiff.status, 200);
    assert.deepEqual(await identicalDiff.json(), [], "Prototype Diff compares raw snapshots, not injected Viewer scripts");
    writeFileSync(join(dataDir, "projects", project.id, "index.html"), "<main>current raw document</main>");
    const changedDiff = (await (await fetch(`${base}/api/projects/${project.id}/versions/${runId}/diff`)).json()) as Array<{ t: string; text: string }>;
    assert.ok(changedDiff.some((line) => line.t === "del" && line.text.includes("Hi there")));
    assert.ok(changedDiff.some((line) => line.t === "add" && line.text.includes("current raw document")));

    const restore = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/restore`, { method: "POST" });
    assert.equal(restore.status, 200);
    const restored = (await restore.json()) as { runId?: string; historyRecorded?: boolean };
    assert.equal(restored.historyRecorded, true);
    assert.ok(restored.runId && restored.runId !== runId);
    assert.equal(store.listRuns(project.id)[0]?.id, restored.runId, "Prototype Restore creates a durable Current version identity");
    assert.equal(readFileSync(join(dataDir, "projects", project.id, ".versions", `${restored.runId}.html`), "utf8"), CLEAN);

    const cover = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/cover`, { method: "POST" });
    assert.equal(cover.status, 200);
    assert.deepEqual(await cover.json(), { captured: true });
    assert.equal(captured?.url, `${base}/api/projects/${project.id}/versions/${runId}`);
    assert.equal(captured?.outPath, join(dataDir, "projects", project.id, ".cover.png"));
    assert.equal(existsSync(join(dataDir, "projects", project.id, ".cover.png")), true);

    const miss = await fetch(`${base}/api/projects/${project.id}/versions/nope`);
    assert.equal(miss.status, 404);
  }, {
    captureCoverUrl: async (url, outPath) => {
      captured = { url, outPath };
      writeFileSync(outPath, "png");
      return true;
    },
  });
});

test("a queued Prototype Restore records the branch that is active inside the project mutation lock", async () => {
  const activationRestored = deferred();
  const allowActivation = deferred();
  await withRunServer(
    undefined,
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Prototype restore identity", mode: "prototype" });
      const main = store.ensureMainVariant(project.id);
      const target = store.createVariant(project.id, "Target");
      store.setActiveVariant(project.id, main.id);
      const root = join(dataDir, "projects", project.id);
      mkdirSync(join(root, ".variants", target.id), { recursive: true });
      mkdirSync(join(root, ".versions"), { recursive: true });
      writeFileSync(join(root, "index.html"), "<main>Active A</main>");
      writeFileSync(join(root, ".variants", target.id, "index.html"), "<main>Active B</main>");
      const conversation = store.createConversation(project.id, "Historical version");
      const sourceRun = store.createRun(project.id, conversation.id, main.id);
      store.updateRun(sourceRun.id, { status: "succeeded", score: 94, lintPassed: true, finishedAt: Date.now() });
      writeFileSync(join(root, ".versions", `${sourceRun.id}.html`), "<main>Historical pixels</main>");

      const activating = fetch(`${base}/api/projects/${project.id}/variants/${target.id}/activate`, { method: "POST" });
      await activationRestored.promise;

      const restoreReadActive = deferred();
      const originalGetActiveVariantId = store.getActiveVariantId.bind(store);
      let observeRestoreRead = true;
      store.getActiveVariantId = ((projectId: string) => {
        const active = originalGetActiveVariantId(projectId);
        if (observeRestoreRead) {
          observeRestoreRead = false;
          restoreReadActive.resolve();
        }
        return active;
      }) as Store["getActiveVariantId"];
      const restoring = fetch(`${base}/api/projects/${project.id}/versions/${sourceRun.id}/restore`, { method: "POST" });
      await restoreReadActive.promise;
      allowActivation.resolve();

      const [activateResponse, restoreResponse] = await Promise.all([activating, restoring]);
      assert.equal(activateResponse.status, 200);
      assert.equal(restoreResponse.status, 200);
      const restored = (await restoreResponse.json()) as { runId: string };
      assert.equal(store.getRun(restored.runId)?.variantId, target.id, "Restore identity follows the branch active when its lock begins");
      assert.equal(store.getActiveVariantId(project.id), target.id);
      assert.match(readFileSync(join(root, "index.html"), "utf8"), /Historical pixels/);
    },
    {
      prototypeVariantRestored: async () => {
        activationRestored.resolve();
        await allowActivation.promise;
      },
    },
  );
});

test("a Prototype Run waits for the same project mutation lock used by Restore", async () => {
  const runnerEntered = deferred();
  const runner: AgentRunner = {
    id: "prototype-lock-probe",
    async runTurn() {
      runnerEntered.resolve();
      return { text: "done", artifactHtml: CLEAN, artifactPath: "index.html" };
    },
  };

  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Prototype Run serialization", mode: "prototype" });
    const root = join(dataDir, "projects", project.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<main>Before restore lock</main>");
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    const heldMutation = withStandardSourceMutationLock(`prototype:${project.id}`, async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    });
    await mutationEntered.promise;

    const runRequest = fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "write after restore" }),
    });
    const whileRestoreOwnsRoot = await Promise.race([
      runnerEntered.promise.then(() => "runner-entered" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    releaseMutation.resolve();
    const response = await runRequest;
    await response.text();
    await heldMutation;

    assert.equal(whileRestoreOwnsRoot, "blocked", "the agent cannot read or write the shared Prototype root during Restore");
    assert.equal(response.status, 200);
    assert.match(readFileSync(join(root, "index.html"), "utf8"), /Hi there/);
  });
});

test("a Prototype version serves immutable assets, external CSS, anchors, and runtime evidence", async () => {
  const html = `<!doctype html><html><head><title>Asset version</title><link rel="stylesheet" href="/styles/site.css"><style>.hero{background-image:url('/assets/root.png')}</style></head><body><a href="#section">Jump</a><img data-kind="relative" src="assets/gen-0.png"><img data-kind="root" src="/assets/root.png"><img data-kind="extensionless-relative" src="assets/hero"><img data-kind="extensionless-root" src="/assets/hero"><img data-kind="external" src="https://cdn.example.test/external.png"><img data-kind="protocol-relative" src="//cdn.example.test/protocol.png"><section id="section">Target</section></body></html>`;
  const runner = new FakeRunner({ artifacts: [html] });
  let coverCapture: { url: string; relative: string; root: string; html: string } | null = null;
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Asset version" });
    const assetPath = join(dataDir, "projects", project.id, "assets", "gen-0.png");
    const rootAssetPath = join(dataDir, "projects", project.id, "assets", "root.png");
    mkdirSync(join(assetPath, ".."), { recursive: true });
    writeFileSync(assetPath, Buffer.from("original-run-asset"));
    writeFileSync(rootAssetPath, Buffer.from("original-root-asset"));
    writeFileSync(join(dataDir, "projects", project.id, "assets", "hero"), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("extensionless-history"),
    ]));
    mkdirSync(join(dataDir, "projects", project.id, "styles"), { recursive: true });
    writeFileSync(join(dataDir, "projects", project.id, "styles", "site.css"), `@import '/styles/theme.css';\n.hero{background:url('/assets/root.png')}`);
    writeFileSync(join(dataDir, "projects", project.id, "styles", "theme.css"), ".hero{color:rebeccapurple}");
    writeFileSync(join(dataDir, "projects", project.id, ".env"), "PRIVATE_TOKEN=must-not-be-snapshotted");
    mkdirSync(join(dataDir, "projects", project.id, ".refs"), { recursive: true });
    writeFileSync(join(dataDir, "projects", project.id, ".refs", "private-reference.png"), "private-reference");
    mkdirSync(join(dataDir, "projects", project.id, ".research", "assets"), { recursive: true });
    writeFileSync(join(dataDir, "projects", project.id, ".research", "assets", "private-research.png"), "private-research");
    mkdirSync(join(dataDir, "projects", project.id, "src"), { recursive: true });
    writeFileSync(join(dataDir, "projects", project.id, "src", "credentials.js"), "export const token = 'private-source';");

    await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "use the local image" }),
      })
    ).text();
    const runId = store.listRuns(project.id)[0]!.id;

    // The live Prototype keeps changing after a Run. Historical viewing must not read this byte.
    writeFileSync(assetPath, Buffer.from("mutated-current-asset"));
    writeFileSync(rootAssetPath, Buffer.from("mutated-current-root-asset"));
    writeFileSync(join(dataDir, "projects", project.id, "assets", "hero"), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("extensionless-current"),
    ]));

    const response = await fetch(`${base}/api/projects/${project.id}/versions/${runId}`);
    assert.equal(response.status, 200);
    const versionHtml = await response.text();
    assert.doesNotMatch(versionHtml, /data-dezin-version-base/, "hash navigation is not redirected by a synthetic base element");
    assert.match(versionHtml, /data-dezin-runtime-probe/, "historical runtime failures remain observable by the Viewer");
    assert.match(versionHtml, /href="#section"/);
    const relativeSrc = versionHtml.match(/data-kind="relative" src="([^"]+)"/)?.[1];
    assert.ok(relativeSrc?.startsWith(`/api/projects/${project.id}/versions/${runId}/files/assets/`));
    const resolvedAsset = new URL(relativeSrc!, base);
    const assetResponse = await fetch(resolvedAsset);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get("access-control-allow-origin"), "*", "sandboxed version documents may load allowed fonts and media");
    assert.equal(Buffer.from(await assetResponse.arrayBuffer()).toString(), "original-run-asset");
    const rootSrc = versionHtml.match(/data-kind="root" src="([^"]+)"/)?.[1];
    assert.ok(rootSrc);
    assert.ok(rootSrc.startsWith(`/api/projects/${project.id}/versions/${runId}/files/assets/`), "root-relative render assets are rewritten into the Run snapshot");
    const rootAssetResponse = await fetch(new URL(rootSrc, base));
    assert.equal(Buffer.from(await rootAssetResponse.arrayBuffer()).toString(), "original-root-asset");
    for (const kind of ["extensionless-relative", "extensionless-root"]) {
      const src = versionHtml.match(new RegExp(`data-kind="${kind}" src="([^"]+)"`))?.[1];
      assert.ok(src?.includes(`/versions/${runId}/files/assets/hero`));
      const bytes = Buffer.from(await (await fetch(new URL(src!, base))).arrayBuffer());
      assert.equal(bytes.subarray(8).toString(), "extensionless-history");
    }
    assert.match(versionHtml, /src="https:\/\/cdn\.example\.test\/external\.png"/);
    assert.match(versionHtml, /src="\/\/cdn\.example\.test\/protocol\.png"/);
    assert.match(versionHtml, new RegExp(`background-image:url\\(['"]?/api/projects/${project.id}/versions/${runId}/files/assets/root\\.png`));
    const stylesheetHref = versionHtml.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
    assert.ok(stylesheetHref?.startsWith(`/api/projects/${project.id}/versions/${runId}/files/styles/`));
    const stylesheet = await (await fetch(new URL(stylesheetHref!, base))).text();
    assert.match(stylesheet, new RegExp(`@import ['"]/api/projects/${project.id}/versions/${runId}/files/styles/theme\\.css`));
    assert.match(stylesheet, new RegExp(`url\\(['"]?/api/projects/${project.id}/versions/${runId}/files/assets/root\\.png`));
    const assetDiff = (await (await fetch(`${base}/api/projects/${project.id}/versions/${runId}/diff`)).json()) as Array<{ t: string; text: string }>;
    assert.ok(assetDiff.some((line) => line.t === "del" && line.text.includes("[asset] assets/gen-0.png")));
    assert.ok(assetDiff.some((line) => line.t === "add" && line.text.includes("[asset] assets/gen-0.png")));
    const filesBase = new URL(`/api/projects/${project.id}/versions/${runId}/files/`, base);
    for (const privatePath of [".env", ".refs/private-reference.png", ".research/assets/private-research.png", "src/credentials.js"]) {
      const privateResponse = await fetch(new URL(privatePath, filesBase));
      assert.equal(privateResponse.status, 404, `${privatePath} must never enter the public historical asset surface`);
      assert.equal(
        existsSync(join(dataDir, "projects", project.id, ".versions", `${runId}.files`, privatePath)),
        false,
        `${privatePath} must not be persisted in the historical asset snapshot`,
      );
    }

    const coverResponse = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/cover`, { method: "POST" });
    assert.equal(coverResponse.status, 200);
    assert.deepEqual(await coverResponse.json(), { captured: true });
    assert.equal(coverCapture?.url, `${base}/api/projects/${project.id}/versions/${runId}`);
    assert.equal(coverCapture?.relative, "original-run-asset");
    assert.equal(coverCapture?.root, "original-root-asset");

    const restoreResponse = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/restore`, { method: "POST" });
    const restored = (await restoreResponse.json()) as { runId?: string };
    assert.ok(restored.runId && restored.runId !== runId);
    const liveAsset = await fetch(`${base}/projects/${project.id}/preview/assets/gen-0.png`);
    assert.equal(liveAsset.status, 200);
    assert.equal(Buffer.from(await liveAsset.arrayBuffer()).toString(), "original-run-asset", "Restore immediately reinstates the historical asset bytes in live Preview");
    assert.equal(readFileSync(join(dataDir, "projects", project.id, ".env"), "utf8"), "PRIVATE_TOKEN=must-not-be-snapshotted", "Restore preserves private project sidecars");
    assert.equal(readFileSync(join(dataDir, "projects", project.id, ".refs", "private-reference.png"), "utf8"), "private-reference");
    writeFileSync(
      join(dataDir, "projects", project.id, ".versions", `${runId}.files`, "assets", "gen-0.png"),
      Buffer.from("mutated-source-history"),
    );
    const restoredHtml = await (await fetch(`${base}/api/projects/${project.id}/versions/${restored.runId}`)).text();
    const restoredRelativeSrc = restoredHtml.match(/data-kind="relative" src="([^"]+)"/)?.[1];
    assert.ok(restoredRelativeSrc);
    const restoredAsset = await fetch(new URL(restoredRelativeSrc, base));
    assert.equal(restoredAsset.status, 200);
    assert.equal(Buffer.from(await restoredAsset.arrayBuffer()).toString(), "original-run-asset", "restored history owns an independent asset snapshot");

    const wrongOwner = store.createProject({ name: "Other project" });
    const crossProject = await fetch(`${base}/api/projects/${wrongOwner.id}/versions/${runId}/files/assets/gen-0.png`);
    assert.equal(crossProject.status, 404, "a Run id cannot expose files through another project");

    const traversal = await fetch(`${base}/api/projects/${project.id}/versions/${runId}/files/..%2F${runId}.html`);
    assert.equal(traversal.status, 400, "the historical file route rejects paths outside its Run snapshot");
  }, {
    captureCoverUrl: async (url, outPath) => {
      const historicalHtml = await (await fetch(url)).text();
      const relativeSrc = historicalHtml.match(/data-kind="relative" src="([^"]+)"/)?.[1];
      const rootSrc = historicalHtml.match(/data-kind="root" src="([^"]+)"/)?.[1];
      assert.ok(relativeSrc && rootSrc);
      const relative = Buffer.from(await (await fetch(new URL(relativeSrc, url))).arrayBuffer()).toString();
      const root = Buffer.from(await (await fetch(new URL(rootSrc, url))).arrayBuffer()).toString();
      coverCapture = { url, relative, root, html: historicalHtml };
      writeFileSync(outPath, "cover");
      return true;
    },
  });
});

test("a legacy HTML-only Prototype Restore never substitutes current assets", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Legacy Prototype" });
    const root = join(dataDir, "projects", project.id);
    const conversation = store.createConversation(project.id, "Legacy restore");
    const run = store.createRun(project.id, conversation.id);
    store.updateRun(run.id, { status: "succeeded", score: 100, lintPassed: true, finishedAt: Date.now() });
    mkdirSync(join(root, ".versions"), { recursive: true });
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, ".versions", `${run.id}.html`), '<main><img src="assets/legacy.png"><img src="media/secret.jpg">Historical</main>');
    writeFileSync(join(root, "index.html"), '<main><img src="assets/legacy.png"><img src="media/secret.jpg">Current</main>');
    const outsidePixels = join(dataDir, "outside-current-pixels.png");
    writeFileSync(outsidePixels, "CURRENT ASSET MUST NOT LEAK");
    symlinkSync(outsidePixels, join(root, "assets", "legacy.png"));
    const outsideMedia = join(dataDir, "outside-media");
    mkdirSync(outsideMedia);
    writeFileSync(join(outsideMedia, "secret.jpg"), "DIRECTORY SYMLINK PIXELS");
    symlinkSync(outsideMedia, join(root, "media"));
    writeFileSync(join(root, ".env"), "PRIVATE=preserved");

    const response = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });
    const restored = (await response.json()) as { assetsRestored?: boolean; historyRecorded?: boolean };

    assert.equal(response.status, 200);
    assert.equal(restored.historyRecorded, true);
    assert.equal(restored.assetsRestored, false);
    assert.match(readFileSync(join(root, "index.html"), "utf8"), /Historical/);
    assert.equal(existsSync(join(root, "assets", "legacy.png")), false, "current pixels are removed instead of misattributed to history");
    assert.equal(existsSync(join(root, "media")), false, "current symlink directories cannot leak pixels into a legacy version");
    assert.equal(readFileSync(join(root, ".env"), "utf8"), "PRIVATE=preserved");
    const current = store.listRuns(project.id)[0]!;
    assert.equal(current.status, "succeeded");
    assert.equal(current.score, null, "missing pixels cannot inherit a perfect historical score after reload");
    assert.equal(current.lintPassed, false);
    assert.ok(current.findings.some((finding) => finding.id === "version-assets-unavailable"));
  });
});

test("a Prototype Restore rolls document and assets back when Current metadata cannot commit", async () => {
  const runner = new FakeRunner({ artifacts: ['<main><img src="assets/hero.png">Historical</main>'] });
  await withRunServer(runner, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Prototype atomic restore" });
    const root = join(dataDir, "projects", project.id);
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "hero.png"), "HISTORICAL ASSET");
    await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "snapshot" }),
    })).text();
    const sourceRun = store.listRuns(project.id)[0]!;
    writeFileSync(join(root, "index.html"), '<main><img src="assets/hero.png">Current</main>');
    rmSync(join(root, "assets", "hero.png"));
    const currentPixels = join(dataDir, "current-pixels.png");
    writeFileSync(currentPixels, "CURRENT ASSET");
    symlinkSync(currentPixels, join(root, "assets", "hero.png"));
    const originalUpdateRun = store.updateRun.bind(store);
    store.updateRun = ((id, patch) => {
      if (id !== sourceRun.id) throw new Error("injected Prototype metadata failure");
      return originalUpdateRun(id, patch);
    }) as Store["updateRun"];

    const response = await fetch(`${base}/api/projects/${project.id}/versions/${sourceRun.id}/restore`, { method: "POST" });

    assert.equal(response.status, 409);
    assert.match(await response.text(), /metadata failure/);
    assert.match(readFileSync(join(root, "index.html"), "utf8"), /Current/);
    assert.equal(lstatSync(join(root, "assets", "hero.png")).isSymbolicLink(), true, "rollback restores the exact current symlink");
    assert.equal(readFileSync(join(root, "assets", "hero.png"), "utf8"), "CURRENT ASSET");
    assert.equal(store.listRuns(project.id).filter((run) => run.status === "succeeded").length, 1);
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

test("real cancel wins while Prototype post-agent review is blocked", async () => {
  let enterPostAgent!: () => void;
  let releasePostAgent!: () => void;
  const postAgentEntered = new Promise<void>((resolve) => {
    enterPostAgent = resolve;
  });
  const postAgentRelease = new Promise<void>((resolve) => {
    releasePostAgent = resolve;
  });

  await withRunServer(
    new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }),
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: false });
      const project = store.createProject({ name: "P" });
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "go" }),
      });
      await postAgentEntered;
      const runId = store.listRuns(project.id)[0]!.id;
      let cancelResponse!: Response;
      try {
        cancelResponse = await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
      } finally {
        releasePostAgent();
      }
      assert.deepEqual(await cancelResponse.json(), { cancelled: true });

      const events = await closedSse(response, "Prototype real-cancel race");
      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-cancelled"]);
      assert.equal(events.some((event) => event.type === "run-done"), false);
      assert.equal(store.getRun(runId)?.status, "cancelled");
      assert.equal(typeof store.getRun(runId)?.finishedAt, "number");
    },
    {
      visualQa: async () => {
        enterPostAgent();
        await postAgentRelease;
        return [];
      },
    },
  );
});

test("real cancel wins while Standard post-agent preview work is blocked", async () => {
  let enterPostAgent!: () => void;
  let releasePostAgent!: () => void;
  const postAgentEntered = new Promise<void>((resolve) => {
    enterPostAgent = resolve;
  });
  const postAgentRelease = new Promise<void>((resolve) => {
    releasePostAgent = resolve;
  });
  let blockPreviewOnce = true;
  let previewSignal: AbortSignal | undefined;
  let previewAbortObserved = false;
  const runner: AgentRunner = {
    id: "standard-post-agent-cancel",
    async runTurn(input) {
      mkdirSync(join(input.projectDir, "src"), { recursive: true });
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "export default function App(){ return <main>Changed</main> }");
      return { text: "done", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ autoImproveEnabled: false });
      const { project, dir, head } = initStandardRunProject(dataDir, store);

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "change it" }),
      });
      await postAgentEntered;
      const runId = store.listRuns(project.id)[0]!.id;
      let cancelResponse!: Response;
      try {
        cancelResponse = await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
      } finally {
        releasePostAgent();
      }
      assert.deepEqual(await cancelResponse.json(), { cancelled: true });

      const events = await closedSse(response, "Standard real-cancel race");
      assert.ok(previewSignal, "Standard preview preparation receives the active Run AbortSignal");
      assert.equal(previewAbortObserved, true, "cancelling the Run aborts blocked preview preparation");
      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-cancelled"]);
      assert.equal(events.some((event) => event.type === "run-done"), false);
      assert.equal(store.getRun(runId)?.status, "cancelled");
      assert.equal(typeof store.getRun(runId)?.finishedAt, "number");
      assert.match(readFileSync(join(dir, "src", "App.jsx"), "utf8"), /source baseline/);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), head);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
      assert.equal(existsSync(standardRunWorktreeDir(dataDir, project.id, runId)), false);
    },
    {
      ensureDevServer: async (_projectId, _dir, _runtimeKey, signal) => {
        if (blockPreviewOnce) {
          blockPreviewOnce = false;
          previewSignal = signal;
          enterPostAgent();
          if (signal) {
            await new Promise<never>((_resolve, reject) => {
              const onAbort = () => {
                previewAbortObserved = true;
                reject(abortError());
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
          } else {
            await postAgentRelease;
          }
        }
        return { url: "http://127.0.0.1:65530/" };
      },
      captureCoverUrl: async () => true,
    },
  );
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

test("standard Run rejects dirty tracked and untracked input with 409 without creating a Run", async () => {
  await withRunServer(
    {
      id: "should-not-run",
      async runTurn() {
        throw new Error("runner must not start for dirty input");
      },
    },
    async ({ base, dataDir, store }) => {
      const { project, dir, head } = initStandardRunProject(dataDir, store);
      writeFileSync(join(dir, "src", "App.jsx"), "user tracked edit");
      writeFileSync(join(dir, "src", "notes.txt"), "user untracked edit");

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
      });

      assert.equal(response.status, 409);
      assert.match(await response.text(), /uncommitted changes/i);
      assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "user tracked edit");
      assert.equal(readFileSync(join(dir, "src", "notes.txt"), "utf8"), "user untracked edit");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), head);
      assert.equal(store.listRuns(project.id).length, 0);
    },
  );
});

test("failed and aborted Standard Runs discard only their temporary worktree", async () => {
  for (const kind of ["failed", "aborted"] as const) {
    const runner: AgentRunner = {
      id: `standard-${kind}`,
      async runTurn(input) {
        writeFileSync(join(input.projectDir, "src", "App.jsx"), `${kind} partial`);
        writeFileSync(join(input.projectDir, "src", "partial.txt"), "partial");
        if (kind === "aborted") throw abortError();
        throw new Error("agent failed after writing");
      },
    };
    await withRunServer(runner, async ({ base, dataDir, store }) => {
      const { project, dir, head } = initStandardRunProject(dataDir, store);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
      });
      const events = await closedSse(response, `${kind} Standard transaction`);
      const terminal = terminalEvents(events);
      const runId = events.find((event) => event.type === "run-start")!.runId as string;

      assert.deepEqual(terminal.map((event) => event.type), [kind === "aborted" ? "run-cancelled" : "run-error"]);
      assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "source baseline");
      assert.equal(existsSync(join(dir, "src", "partial.txt")), false);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), head);
      assert.equal(existsSync(standardRunWorktreeDir(dataDir, project.id, runId)), false);
      assert.equal(execFileSync("git", ["branch", "--list", standardRunBranchName(runId)], { cwd: dir, encoding: "utf8" }).trim(), "");
    });
  }
});

test("fresh Sharingan capture and agent probe writes stay transactional until a successful Standard Run publishes", async () => {
  let base = "";
  let projectId = "";
  let sourceDir = "";
  let mainTurns = 0;
  let visualReferencePath = "";
  let runProfileDir = "";
  const runner: AgentRunner = {
    id: "fresh-sharingan-transaction-success",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*([a-z0-9_-]+)/i);
      if (regionMatch) {
        const regionId = regionMatch[1]!;
        mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${regionId}.jsx`), `export default function Region(){ return <section>${regionId}</section> }`);
        return { text: `built ${regionId}`, artifactHtml: "", artifactPath: "index.html" };
      }

      mainTurns += 1;
      assert.equal(existsSync(join(input.projectDir, ".sharingan", "pages.json")), true, "fresh capture is available inside the Run transaction");
      assert.equal(existsSync(join(sourceDir, ".sharingan")), false, "persistent source is untouched while the agent is running");
      const probe = readFileSync(join(input.projectDir, ".sharingan", "probe.mjs"), "utf8");
      const runId = probe.match(/const RUN_ID = "([^"]+)";/)?.[1];
      assert.ok(runId, "probe CLI is bound to the active Run");
      assert.match(probe, /"x-dezin-run-id": RUN_ID/);

      const capture = await fetch(`${base}/api/sharingan/${projectId}/capture`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dezin-run-id": runId },
        body: JSON.stringify({ url: "http://x.test/agent-probe" }),
      });
      assert.equal(capture.status, 200, await capture.text());
      assert.equal(existsSync(join(sourceDir, ".sharingan")), false, "agent-triggered capture also stays transactional");

      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>published Sharingan clone</main> }`);
      return { text: "fresh clone complete", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base: serverBase, dataDir, store }) => {
      base = serverBase;
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initFreshSharinganStandardProject(dataDir, store);
      projectId = initialized.project.id;
      sourceDir = initialized.dir;

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, brief: "capture and rebuild the source" }),
      });
      const events = await closedSse(response, "fresh Sharingan transaction success");
      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-done"]);
      assert.ok(mainTurns >= 1);
      assert.equal(existsSync(join(sourceDir, ".sharingan", "pages.json")), true);
      assert.equal(existsSync(join(sourceDir, ".sharingan", "probe.mjs")), true);
      assert.match(visualReferencePath, /run-worktrees/, "visual QA reads the fresh capture from the Run transaction");
      assert.match(readFileSync(join(sourceDir, "src", "App.jsx"), "utf8"), /published Sharingan clone/);
      assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim(), initialized.head);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: sourceDir, encoding: "utf8" }), "");
      assert.ok(runProfileDir, "the Run capture received an isolated profile directory");
      assert.equal(existsSync(runProfileDir), false, "terminal Run cleanup removes its one-use browser profile");
    },
    {
      sharinganOpen: async (_url, options) => {
        runProfileDir = options.userDataDir ?? "";
        mkdirSync(runProfileDir, { recursive: true });
        writeFileSync(join(runProfileDir, "profile-marker"), "run-owned");
        return fakeFreshSharinganSession();
      },
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async (input) => {
        visualReferencePath = input.sharinganReference?.screenshotPath ?? "";
        return [];
      },
    },
  );
});

test("a failed Sharingan entry capture stops before the build runner", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["must not build"] });
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initFreshSharinganStandardProject(dataDir, store);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, brief: "capture the source before building" }),
      });
      const events = await closedSse(response, "failed Sharingan capture gate");

      assert.equal(runner.calls.length, 0);
      assert.ok(events.some((event) => event.type === "run-error" && /source capture/i.test(String(event.message))));
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), initialized.head);
    },
    {
      sharinganOpen: async () => {
        throw new Error("Chrome profile could not be opened");
      },
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("corrupt Sharingan render evidence stops before the build runner", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["must not build"] });
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initFreshSharinganStandardProject(dataDir, store);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, brief: "rebuild only from verified source evidence" }),
      });
      const events = await closedSse(response, "corrupt Sharingan evidence gate");

      assert.equal(runner.calls.length, 0, "the builder cannot run from corrupt source geometry");
      assert.ok(events.some((event) => event.type === "run-error" && /valid entry screenshot and render evidence/i.test(String(event.message))));
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), initialized.head);
    },
    {
      sharinganOpen: async () => {
        const session = fakeFreshSharinganSession();
        session.readRenderMap = async () => ({
          viewport: { width: 1440, height: 900 },
          document: { width: 1440, height: 900 },
          elements: "corrupt",
        }) as never;
        return session;
      },
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan source evidence corrupted during generation blocks publication independently of the critic", async () => {
  const runner: AgentRunner = {
    id: "corrupt-sharingan-evidence-after-build",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "export default function App(){ return <main>candidate clone</main> }");
      const manifest = JSON.parse(readFileSync(join(input.projectDir, ".sharingan", "pages.json"), "utf8")) as {
        sourceUrl: string;
        pages: Array<{ url: string; renderMap: string }>;
      };
      const entry = manifest.pages.find((page) => page.url === manifest.sourceUrl) ?? manifest.pages[0]!;
      writeFileSync(join(input.projectDir, entry.renderMap), "{corrupt-after-build");
      return { text: "candidate complete", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initFreshSharinganStandardProject(dataDir, store);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, brief: "generate without mutating source evidence" }),
      });
      const events = await closedSse(response, "post-build Sharingan evidence gate");

      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-error"]);
      assert.ok(events.some((event) => /fidelity gate blocked publication/i.test(String(event.message))));
      assert.match(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), /source baseline/);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), initialized.head);
    },
    {
      sharinganOpen: async () => fakeFreshSharinganSession(),
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Sharingan publication rejects a fresh manifest downgraded to legacy during generation", async () => {
  const runner: AgentRunner = {
    id: "downgrade-sharingan-evidence-after-build",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "export default function App(){ return <main>candidate clone</main> }");
      const manifestPath = join(input.projectDir, ".sharingan", "pages.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        schemaVersion?: number;
        requestedSourceUrl?: string;
        pages: Array<{ requestedUrl?: string }>;
      };
      delete manifest.schemaVersion;
      delete manifest.requestedSourceUrl;
      for (const page of manifest.pages) delete page.requestedUrl;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      return { text: "candidate complete", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initFreshSharinganStandardProject(dataDir, store);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, brief: "keep the fresh capture contract intact" }),
      });
      const events = await closedSse(response, "downgraded Sharingan evidence gate");

      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-error"]);
      assert.ok(events.some((event) => /fidelity gate blocked publication/i.test(String(event.message))));
      assert.match(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), /source baseline/);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), initialized.head);
    },
    {
      sharinganOpen: async () => fakeFreshSharinganSession(),
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("fresh Sharingan capture is discarded with failed and aborted Standard Run transactions", async () => {
  for (const kind of ["failed", "aborted"] as const) {
    let transactionObserved = false;
    const runner: AgentRunner = {
      id: `fresh-sharingan-transaction-${kind}`,
      async runTurn(input) {
        transactionObserved = true;
        assert.equal(existsSync(join(input.projectDir, ".sharingan", "pages.json")), true);
        assert.equal(existsSync(join(input.projectDir, ".sharingan", "probe.mjs")), true);
        writeFileSync(join(input.projectDir, "src", "App.jsx"), `${kind} partial clone`);
        if (kind === "aborted") throw abortError();
        throw new Error("fresh Sharingan build failed");
      },
    };

    await withRunServer(
      runner,
      async ({ base, dataDir, store }) => {
        store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
        const initialized = initFreshSharinganStandardProject(dataDir, store);
        const response = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: initialized.project.id, brief: "capture then stop" }),
        });
        const events = await closedSse(response, `fresh Sharingan transaction ${kind}`);
        const runId = events.find((event) => event.type === "run-start")!.runId as string;

        assert.equal(transactionObserved, true);
        assert.deepEqual(terminalEvents(events).map((event) => event.type), [kind === "aborted" ? "run-cancelled" : "run-error"]);
        assert.equal(existsSync(join(initialized.dir, ".sharingan")), false);
        assert.match(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), /source baseline/);
        assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), initialized.head);
        assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: initialized.dir, encoding: "utf8" }), "");
        assert.equal(existsSync(standardRunWorktreeDir(dataDir, initialized.project.id, runId)), false);
      },
      {
        sharinganOpen: async () => fakeFreshSharinganSession(),
        ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
        captureCoverUrl: async () => true,
        visualQa: async () => [],
      },
    );
  }
});

test("fresh Sharingan capture publishes only to the targeted Standard variant", async () => {
  let rootDir = "";
  let targetDir = "";
  const runner: AgentRunner = {
    id: "fresh-sharingan-target-variant",
    async runTurn(input) {
      assert.equal(existsSync(join(input.projectDir, ".sharingan", "pages.json")), true);
      assert.equal(existsSync(join(rootDir, ".sharingan")), false);
      assert.equal(existsSync(join(targetDir, ".sharingan")), false, "target source remains unchanged until publication");
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>targeted clone</main> }`);
      return { text: "targeted clone complete", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initFreshSharinganStandardProject(dataDir, store);
      rootDir = initialized.dir;
      store.ensureMainVariant(initialized.project.id);
      const target = store.createVariant(initialized.project.id, "Capture target");
      targetDir = join(dataDir, "worktrees", initialized.project.id, target.id);

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, variantId: target.id, brief: "capture into this variant" }),
      });
      const events = await closedSse(response, "fresh Sharingan target variant");

      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-done"]);
      assert.equal(existsSync(join(rootDir, ".sharingan")), false);
      assert.match(readFileSync(join(rootDir, "src", "App.jsx"), "utf8"), /source baseline/);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(), initialized.head);
      assert.equal(existsSync(join(targetDir, ".sharingan", "pages.json")), true);
      assert.match(readFileSync(join(targetDir, "src", "App.jsx"), "utf8"), /targeted clone/);
      assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetDir, encoding: "utf8" }).trim(), initialized.head);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: targetDir, encoding: "utf8" }), "");
    },
    {
      sharinganOpen: async () => fakeFreshSharinganSession(),
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("Standard Run publish conflict preserves the user's concurrent edit and a recovery branch", async () => {
  let sourceDir = "";
  let injectedConflict = false;
  const runner: AgentRunner = {
    id: "standard-publish-conflict",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "agent result");
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      const initialized = initStandardRunProject(dataDir, store);
      sourceDir = initialized.dir;
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, brief: "make it better" }),
      });
      const events = await closedSse(response, "Standard publish conflict");
      const runId = events.find((event) => event.type === "run-start")!.runId as string;

      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-error"]);
      assert.equal(readFileSync(join(sourceDir, "src", "App.jsx"), "utf8"), "concurrent user edit");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim(), initialized.head);
      assert.equal(existsSync(standardRunWorktreeDir(dataDir, initialized.project.id, runId)), false);
      assert.match(execFileSync("git", ["branch", "--list", standardRunBranchName(runId)], { cwd: sourceDir, encoding: "utf8" }), /dezin\/run\//);
    },
    {
      ensureDevServer: async () => {
        if (!injectedConflict) {
          injectedConflict = true;
          writeFileSync(join(sourceDir, "src", "App.jsx"), "concurrent user edit");
        }
        return { url: "http://127.0.0.1:6209/" };
      },
    },
  );
});

test("post-publish metadata and transcript failures cannot downgrade a successful Standard Run", async () => {
  for (const failure of ["update-run", "assistant-message", "result-message"] as const) {
    const runner: AgentRunner = {
      id: `post-publish-${failure}`,
      async runTurn(input) {
        writeFileSync(join(input.projectDir, "src", "App.jsx"), `published despite ${failure}`);
        return { text: `assistant summary for ${failure}`, artifactHtml: "", artifactPath: "index.html" };
      },
    };

    await withRunServer(
      runner,
      async ({ base, dataDir, store }) => {
        store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
        const initialized = initStandardRunProject(dataDir, store);
        let injected = false;
        const published = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim() !== initialized.head;
        const originalUpdateRun = store.updateRun.bind(store);
        const originalAddMessage = store.addMessage.bind(store);
        store.updateRun = ((id, patch) => {
          if (!injected && failure === "update-run" && published()) {
            injected = true;
            throw new Error("injected post-publish updateRun failure");
          }
          return originalUpdateRun(id, patch);
        }) as Store["updateRun"];
        store.addMessage = ((conversationId, role, content) => {
          const isTarget =
            (failure === "assistant-message" && role === "assistant") ||
            (failure === "result-message" && role === "system" && content.includes('"result"'));
          if (!injected && isTarget && published()) {
            injected = true;
            throw new Error(`injected post-publish ${failure} failure`);
          }
          return originalAddMessage(conversationId, role, content);
        }) as Store["addMessage"];

        const response = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: initialized.project.id, brief: `publish through ${failure}` }),
        });
        const events = await closedSse(response, `post-publish ${failure}`);
        const runId = events.find((event) => event.type === "run-start")!.runId as string;

        assert.equal(injected, true, `the ${failure} fault was reached after publication`);
        assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-done"]);
        assert.equal(store.getRun(runId)?.status, "succeeded");
        assert.match(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), new RegExp(failure));
        assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), initialized.head);
        assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: initialized.dir, encoding: "utf8" }), "");
      },
      {
        ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
        captureCoverUrl: async () => true,
        visualQa: async () => [],
      },
    );
  }
});

test("a one-shot succeeded terminalization failure after publication retries success without reapplying the commit", async () => {
  let runnerCalls = 0;
  const runner: AgentRunner = {
    id: "published-terminalize-retry",
    async runTurn(input) {
      runnerCalls += 1;
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "published exactly once");
      return { text: "published", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initStandardRunProject(dataDir, store);
      const baseCommitCount = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim());
      const originalTerminalize = store.terminalizeRun.bind(store);
      let succeededAttempts = 0;
      let succeededTransitions = 0;
      let failedAttempts = 0;
      store.terminalizeRun = ((runId, status, patch) => {
        if (status === "succeeded") {
          succeededAttempts += 1;
        }
        if (status === "failed") failedAttempts += 1;
        const result = originalTerminalize(runId, status, patch);
        if (status === "succeeded" && result.changed) succeededTransitions += 1;
        if (status === "succeeded" && succeededAttempts === 1) {
          throw new Error("injected one-shot post-transition terminalization failure");
        }
        return result;
      }) as Store["terminalizeRun"];

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, brief: "publish once then settle" }),
      });
      const events = await closedSse(response, "published success terminalization retry");
      const runId = events.find((event) => event.type === "run-start")!.runId as string;
      const publishedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim();

      assert.equal(succeededAttempts, 2, "the same succeeded settlement is retried once");
      assert.equal(succeededTransitions, 1, "only one durable succeeded transition is recorded");
      assert.equal(failedAttempts, 0, "published work never enters failed settlement");
      assert.equal(store.getRun(runId)?.status, "succeeded");
      assert.equal(events.filter((event) => event.type === "run-done").length, 1);
      assert.equal(events.some((event) => event.type === "run-error"), false);
      assert.equal(runnerCalls, 1);
      assert.notEqual(publishedHead, initialized.head);
      assert.equal(Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim()), baseCommitCount + 1);
      assert.equal(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), "published exactly once");

      const replay = originalTerminalize(runId, "succeeded", { commitHash: publishedHead });
      assert.equal(replay.changed, false, "retrying the durable success is idempotent");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), publishedHead);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
});

test("a persistent succeeded terminalization failure surfaces an operational event without recording published work as failed", async () => {
  const runner: AgentRunner = {
    id: "published-terminalize-persistent-failure",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "published despite persistent Store failure");
      return { text: "published", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const initialized = initStandardRunProject(dataDir, store);
      const originalTerminalize = store.terminalizeRun.bind(store);
      let succeededAttempts = 0;
      let failedAttempts = 0;
      store.terminalizeRun = ((runId, status, patch) => {
        if (status === "succeeded") {
          succeededAttempts += 1;
          throw new Error("persistent succeeded terminalization failure");
        }
        if (status === "failed") failedAttempts += 1;
        return originalTerminalize(runId, status, patch);
      }) as Store["terminalizeRun"];

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: initialized.project.id, brief: "publish before persistent Store failure" }),
      });
      const events = await closedSse(response, "persistent published-success Store failure");
      const runId = events.find((event) => event.type === "run-start")!.runId as string;

      assert.ok(succeededAttempts >= 2, "success persistence is retried before surfacing the operational error");
      assert.equal(failedAttempts, 0);
      assert.equal(store.getRun(runId)?.status, "running", "an unrepresentable success is never falsified as failed");
      assert.equal(events.filter((event) => event.type === "run-persistence-error").length, 1);
      assert.equal(events.some((event) => event.type === "run-error"), false);
      assert.equal(events.some((event) => event.type === "run-done"), false);
      assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), initialized.head);
      assert.equal(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), "published despite persistent Store failure");
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [],
    },
  );
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
      writeFileSync(join(dir, "src", "first-only.txt"), "belongs to the first version");
      const firstCommit = commitAll(dir, "first");

      execFileSync("git", ["rm", "-q", "src/first-only.txt"], { cwd: dir });
      writeFileSync(join(dir, "src", "App.jsx"), "export default function App(){ return <main>Two</main> }");
      writeFileSync(join(dir, "src", "second-only.txt"), "belongs to the second version");
      const secondCommit = commitAll(dir, "second");

      const conversation = store.createConversation(project.id, "First");
      const mainVariant = store.ensureMainVariant(project.id);
      const archivedVariant = store.createVariant(project.id, "Archived source branch");
      const firstRun = store.createRun(project.id, conversation.id, archivedVariant.id);
      const evidenceName = "round-0-sourceproof.png";
      const evidenceDir = join(dataDir, "version-evidence", project.id, firstRun.id, "visual");
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, evidenceName), "source proof pixels");
      const sourceEvidenceUrl = `/api/projects/${project.id}/runs/${firstRun.id}/evidence/${evidenceName}`;
      store.updateRun(firstRun.id, {
        status: "succeeded",
        commitHash: firstCommit,
        score: 98,
        lintPassed: true,
        findings: [{ severity: "P2", id: "visual-reviewed", message: "reviewed", fix: "", screenshotUrl: sourceEvidenceUrl }],
        finishedAt: Date.now(),
      });
      const secondRun = store.createRun(project.id, conversation.id, mainVariant.id);
      store.updateRun(secondRun.id, { status: "succeeded", commitHash: secondCommit, finishedAt: Date.now() });
      const failedRun = store.createRun(project.id, conversation.id);
      store.updateRun(failedRun.id, { status: "failed", commitHash: firstCommit, finishedAt: Date.now() });

      const rejectedRestore = await fetch(`${base}/api/projects/${project.id}/versions/${failedRun.id}/restore`, { method: "POST" });
      assert.equal(rejectedRestore.status, 409, "failed quality attempts cannot be promoted through the Restore endpoint");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), secondCommit);

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

      writeFileSync(join(devServers[1]!.dir, "src", "App.jsx"), "dirty historical worktree bytes");
      const dirtySameHeadView = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}`, { redirect: "manual" });
      assert.equal(dirtySameHeadView.status, 302);
      assert.equal(
        readFileSync(join(devServers[2]!.dir, "src", "App.jsx"), "utf8"),
        "export default function App(){ return <main>One</main> }",
        "reopening the same historical HEAD discards dirty worktree residue",
      );

      const diff = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/diff`);
      assert.equal(diff.status, 200);
      const lines = (await diff.json()) as Array<{ t: string; text: string }>;
      assert.ok(lines.some((l) => l.t === "del" && l.text.includes("One")));
      assert.ok(lines.some((l) => l.t === "add" && l.text.includes("Two")));

      const cover = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/cover`, { method: "POST" });
      assert.equal(cover.status, 200);
      assert.deepEqual(await cover.json(), { captured: true });
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:6204/",
        outPath: join(dataDir, "projects", project.id, ".cover.png"),
      });

      const restore = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/restore`, { method: "POST" });
      assert.equal(restore.status, 200);
      const restored = (await restore.json()) as { ok: boolean; commitHash?: string; runId?: string };
      assert.equal(restored.ok, true);
      assert.match(restored.commitHash ?? "", /^[0-9a-f]{40}$/);
      assert.match(restored.runId ?? "", /^[0-9a-z-]+$/i);
      const restoredCommit = restored.commitHash!;
      assert.notEqual(restoredCommit, firstCommit, "restore creates a new history-preserving commit");
      assert.notEqual(restoredCommit, secondCommit, "restore does not leave HEAD at the prior current commit");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), restoredCommit);
      assert.equal(execFileSync("git", ["rev-parse", `${restoredCommit}^`], { cwd: dir, encoding: "utf8" }).trim(), secondCommit);
      execFileSync("git", ["diff", "--quiet", firstCommit, restoredCommit, "--", "."], { cwd: dir });
      assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "export default function App(){ return <main>One</main> }");
      assert.equal(readFileSync(join(dir, "src", "first-only.txt"), "utf8"), "belongs to the first version");
      assert.equal(existsSync(join(dir, "src", "second-only.txt")), false, "files absent from the target tree are removed");
      const restoredRun = store.getRun(restored.runId!);
      assert.equal(restoredRun?.status, "succeeded");
      assert.equal(restoredRun?.variantId, mainVariant.id, "cross-branch restore is recorded on the active target branch");
      assert.equal(restoredRun?.commitHash, restoredCommit, "the newest version record names the exact checked-out HEAD");
      assert.equal(store.listRuns(project.id)[0]?.id, restored.runId, "the restored snapshot becomes the durable Current version");
      const restoredEvidenceUrl = restoredRun?.findings[0]?.screenshotUrl ?? "";
      assert.match(restoredEvidenceUrl, new RegExp(`/runs/${restored.runId}/evidence/${evidenceName}$`));

      const repeat = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/restore`, { method: "POST" });
      assert.equal(repeat.status, 200, "restoring an already-current tree is idempotent");
      const repeated = (await repeat.json()) as { commitHash?: string; runId?: string };
      assert.equal(repeated.commitHash, restoredCommit, "an identical restore reuses the current HEAD instead of failing or creating an empty commit");
      assert.ok(repeated.runId && repeated.runId !== restored.runId, "the repeated user action still gets an auditable version identity");

      store.deleteVariant(archivedVariant.id);
      const durableEvidence = await fetch(`${base}${restoredEvidenceUrl}`);
      assert.equal(durableEvidence.status, 200, "restored quality evidence survives deletion of the source branch Run");
      assert.equal(await durableEvidence.text(), "source proof pixels");
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

test("standard version restore rejects tracked and untracked dirty worktrees before changing files", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Dirty restore", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "first version");
    const firstCommit = commitAll(dir, "first");
    writeFileSync(join(dir, "src", "App.jsx"), "second version");
    const secondCommit = commitAll(dir, "second");
    const conversation = store.createConversation(project.id, "Restore");
    const run = store.createRun(project.id, conversation.id);
    store.updateRun(run.id, { status: "succeeded", commitHash: firstCommit, finishedAt: Date.now() });

    writeFileSync(join(dir, "src", "App.jsx"), "user's tracked edit");
    const tracked = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });
    const trackedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const trackedText = readFileSync(join(dir, "src", "App.jsx"), "utf8");

    execFileSync("git", ["reset", "--hard", secondCommit], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "scratch.txt"), "user's untracked note");
    const untracked = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });
    const untrackedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const untrackedApp = readFileSync(join(dir, "src", "App.jsx"), "utf8");

    assert.equal(tracked.status, 409);
    assert.equal(trackedHead, secondCommit);
    assert.equal(trackedText, "user's tracked edit");
    assert.equal(untracked.status, 409);
    assert.equal(untrackedHead, secondCommit);
    assert.equal(untrackedApp, "second version");
    assert.equal(readFileSync(join(dir, "scratch.txt"), "utf8"), "user's untracked note");
  });
});

test("a Standard restore isolates its mechanical commit from invalid local signing configuration", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Atomic restore", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "first version");
    const firstCommit = commitAll(dir, "first");
    writeFileSync(join(dir, "src", "App.jsx"), "second version");
    const secondCommit = commitAll(dir, "second");
    const conversation = store.createConversation(project.id, "Restore");
    const run = store.createRun(project.id, conversation.id);
    store.updateRun(run.id, { status: "succeeded", commitHash: firstCommit, finishedAt: Date.now() });

    execFileSync("git", ["config", "commit.gpgSign", "true"], { cwd: dir });
    execFileSync("git", ["config", "user.signingkey", "missing-dezin-test-key"], { cwd: dir });
    const response = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });

    assert.equal(response.status, 200);
    assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), secondCommit);
    assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "first version");
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
  });
});

test("a Standard Restore keeps the originally targeted branch identity when active branch changes mid-flight", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Restore target identity", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "first version");
    const firstCommit = commitAll(dir, "first");
    writeFileSync(join(dir, "src", "App.jsx"), "second version");
    commitAll(dir, "second");
    const conversation = store.createConversation(project.id, "Restore");
    const main = store.ensureMainVariant(project.id);
    const other = store.createVariant(project.id, "Other");
    store.setActiveVariant(project.id, main.id);
    const sourceRun = store.createRun(project.id, conversation.id, main.id);
    store.updateRun(sourceRun.id, {
      status: "succeeded",
      commitHash: firstCommit,
      findings: [{
        severity: "P2",
        id: "visual-reviewed",
        message: "Reviewed",
        fix: "",
        screenshotPath: ".visual-qa/screenshot.png",
        screenshotUrl: `/api/projects/${project.id}/runs/${sourceRun.id}/evidence/visual/round-0.png`,
      }],
      finishedAt: Date.now(),
    });

    const originalFindActiveRun = store.findActiveRun.bind(store);
    let switched = false;
    store.findActiveRun = ((projectId: string, variantId?: string) => {
      const activeRun = originalFindActiveRun(projectId, variantId);
      if (!switched && projectId === project.id) {
        switched = true;
        store.setActiveVariant(project.id, other.id);
      }
      return activeRun;
    }) as Store["findActiveRun"];

    const response = await fetch(`${base}/api/projects/${project.id}/versions/${sourceRun.id}/restore`, { method: "POST" });
    const restored = (await response.json()) as { runId?: string; evidenceCopied?: boolean };

    assert.equal(response.status, 200);
    assert.equal(store.getActiveVariantId(project.id), other.id, "the concurrent UI branch switch still wins");
    assert.equal(store.getRun(restored.runId!)?.variantId, main.id, "Restore history stays attached to the branch whose tree was mutated");
    assert.equal(restored.evidenceCopied, false, "missing source evidence is reported honestly");
    assert.equal(store.getRun(restored.runId!)?.findings[0]?.screenshotUrl, undefined, "a restored identity never points at missing source evidence");
    assert.equal(store.getRun(restored.runId!)?.findings[0]?.screenshotPath, undefined);
  });
});

test("Standard Restore strips non-immutable screenshot references even when an evidence directory copies", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Evidence ownership", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "historical");
    const historical = commitAll(dir, "historical");
    writeFileSync(join(dir, "src", "App.jsx"), "current");
    commitAll(dir, "current");
    const conversation = store.createConversation(project.id, "Evidence");
    const run = store.createRun(project.id, conversation.id);
    store.updateRun(run.id, {
      status: "succeeded",
      commitHash: historical,
      findings: [{
        severity: "P2",
        id: "visual-reviewed",
        message: "Reviewed",
        fix: "",
        screenshotPath: ".visual-qa/screenshot.png",
        screenshotUrl: `/projects/${project.id}/preview/.visual-qa/screenshot.png`,
      }],
      finishedAt: Date.now(),
    });
    const evidence = join(dataDir, "version-evidence", project.id, run.id, "visual");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "proof.png"), "immutable proof bytes");

    const response = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });
    const body = (await response.json()) as { runId?: string; evidenceCopied?: boolean };
    const restoredFinding = store.getRun(body.runId!)?.findings[0];

    assert.equal(response.status, 200);
    assert.equal(body.evidenceCopied, true);
    assert.equal(restoredFinding?.screenshotUrl, undefined);
    assert.equal(restoredFinding?.screenshotPath, undefined);
  });
});

test("a Standard restore bypasses project commit hooks without leaving hook residue", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Hook-safe restore", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "first version");
    const firstCommit = commitAll(dir, "first");
    writeFileSync(join(dir, "src", "App.jsx"), "second version");
    commitAll(dir, "second");
    const conversation = store.createConversation(project.id, "Restore");
    const run = store.createRun(project.id, conversation.id);
    store.updateRun(run.id, { status: "succeeded", commitHash: firstCommit, finishedAt: Date.now() });

    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\ntouch hook-residue.txt\nexit 1\n");
    chmodSync(hook, 0o755);
    const response = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });

    assert.equal(response.status, 200);
    assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "first version");
    assert.equal(existsSync(join(dir, "hook-residue.txt")), false);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
  });
});

test("a Standard restore also isolates post-commit hooks from the restored worktree", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Post-hook-safe restore", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "first version");
    const firstCommit = commitAll(dir, "first");
    writeFileSync(join(dir, "src", "App.jsx"), "second version");
    commitAll(dir, "second");
    const conversation = store.createConversation(project.id, "Restore");
    const run = store.createRun(project.id, conversation.id);
    store.updateRun(run.id, { status: "succeeded", commitHash: firstCommit, finishedAt: Date.now() });

    const hook = join(dir, ".git", "hooks", "post-commit");
    writeFileSync(hook, "#!/bin/sh\ntouch post-hook-residue.txt\n");
    chmodSync(hook, 0o755);
    const response = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });

    assert.equal(response.status, 200);
    assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "first version");
    assert.equal(existsSync(join(dir, "post-hook-residue.txt")), false);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
  });
});

test("a Standard restore does not run checkout hooks while applying the selected tree", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Checkout-hook-safe restore", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "first version");
    const firstCommit = commitAll(dir, "first");
    writeFileSync(join(dir, "src", "App.jsx"), "second version");
    commitAll(dir, "second");
    const conversation = store.createConversation(project.id, "Restore");
    const run = store.createRun(project.id, conversation.id);
    store.updateRun(run.id, { status: "succeeded", commitHash: firstCommit, finishedAt: Date.now() });

    const hook = join(dir, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\ntouch checkout-hook-residue.txt\n");
    chmodSync(hook, 0o755);
    const response = await fetch(`${base}/api/projects/${project.id}/versions/${run.id}/restore`, { method: "POST" });

    assert.equal(response.status, 200);
    assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "first version");
    assert.equal(existsSync(join(dir, "checkout-hook-residue.txt")), false);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
  });
});

test("a Restore metadata failure atomically rolls the Standard tree back", async () => {
  await withRunServer(undefined, async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Restore metadata", mode: "standard" });
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "src", "App.jsx"), "first version");
    const firstCommit = commitAll(dir, "first");
    writeFileSync(join(dir, "src", "App.jsx"), "second version");
    const secondCommit = commitAll(dir, "second");
    const conversation = store.createConversation(project.id, "Restore");
    const sourceRun = store.createRun(project.id, conversation.id);
    store.updateRun(sourceRun.id, { status: "succeeded", commitHash: firstCommit, findings: [], finishedAt: Date.now() });

    const originalUpdateRun = store.updateRun.bind(store);
    store.updateRun = ((id, patch) => {
      if (id !== sourceRun.id) throw new Error("injected restored metadata failure");
      return originalUpdateRun(id, patch);
    }) as Store["updateRun"];

    const response = await fetch(`${base}/api/projects/${project.id}/versions/${sourceRun.id}/restore`, { method: "POST" });
    const result = (await response.json()) as { error?: string };
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const runs = store.listRuns(project.id);

    assert.equal(response.status, 409, "filesystem and Current identity fail as one transaction");
    assert.match(result.error ?? "", /metadata failure/);
    assert.equal(head, secondCommit);
    assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "second version");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
    assert.equal(runs.filter((run) => run.status === "succeeded").length, 1, "partial metadata must not create a fake succeeded Current row");
    assert.ok(runs.some((run) => run.id !== sourceRun.id && run.status === "failed"), "the partial audit row remains explicitly failed");
  });
});

test("standard version preview URL endpoint resolves the dev server URL without iframe redirect", async () => {
  const devServers: Array<{ dir: string; runtimeKey?: string; url: string }> = [];
  const released: string[] = [];
  const bridgeNonce = "v".repeat(43);
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
      assert.deepEqual(await preview.json(), {
        url: `http://127.0.0.1:6201/#dezin-bridge=${bridgeNonce}`,
        mode: "standard",
        leaseId: "version-lease-1",
        bridgeNonce,
        expiresAt: 123_456,
      });
      assert.match(devServers[0]!.dir, new RegExp(`version-worktrees/${project.id}/${run.id}$`));
      assert.equal(devServers[0]!.runtimeKey, `${project.id}:version:${run.id}`);

      const release = await fetch(`${base}/api/preview-leases/version-lease-1`, { method: "DELETE" });
      assert.equal(release.status, 200);
      assert.deepEqual(await release.json(), { released: true });
      assert.deepEqual(released, ["version-lease-1"]);
    },
    {
      ensureDevServer: async (_projectId, dir, runtimeKey) => {
        const baseUrl = `http://127.0.0.1:${6201 + devServers.length}/`;
        const url = `${baseUrl}#dezin-bridge=${bridgeNonce}`;
        devServers.push({ dir, runtimeKey, url });
        return {
          url,
          leaseId: "version-lease-1",
          bridgeNonce,
          expiresAt: 123_456,
          release: async () => {},
        };
      },
      previewLeaseManager: {
        acquire: async () => { throw new Error("not used"); },
        renew: async () => null,
        release: async (leaseId) => {
          released.push(leaseId);
          return true;
        },
        stopScope: async () => {},
        stopAll: async () => {},
        activeCount: () => 0,
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
      const done = events.find((e) => e.type === "run-done")!;
      const invalidPreview = events.find((event) => event.type === "preview-update" && event.mode === "standard");
      assert.equal(invalidPreview?.previewUrl, undefined, "a URL-only adapter must never be handed to the Viewer");
      assert.equal(invalidPreview?.leaseId, undefined);
      assert.ok(events.some((event) => event.type === "activity"
        && String((event.activity as { summary?: string } | undefined)?.summary ?? "").includes("renewable nonce-bound lease")));
      assert.equal(done.mode, "standard");
      assert.equal(done.passed, true);
      assert.equal(store.getRun(done.runId as string)?.status, "succeeded");
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6212/" }),
      captureCoverUrl: async () => true,
    },
  );
});

test("standard run streams preview updates from the live dev server before completion", async () => {
  const devServers: Array<{ dir: string; runtimeKey?: string; url: string }> = [];
  const releasedProducerLeases: string[] = [];
  const bridgeNonce = "r".repeat(43);
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
      assert.equal(preview.previewUrl, undefined, "durable events must not persist a viewer capability");
      assert.equal(preview.leaseId, undefined, "each viewer must acquire its own lease");
      assert.equal(preview.bridgeNonce, undefined, "each viewer must acquire its own bridge nonce");
      assert.equal(preview.expiresAt, undefined, "durable events must not persist an expiry snapshot");
      assert.equal(preview.variantId, store.getActiveVariantId(project.id));
      assert.match(devServers[0]!.runtimeKey ?? "", /:/);
      assert.ok(releasedProducerLeases.includes("run-preview-lease-1"), "the run released its producer lease");
      assert.ok(store.getRun(done.runId as string)?.commitHash, "run persisted a git snapshot before completion");
    },
    {
      ensureDevServer: async (_projectId, dir, runtimeKey) => {
        const url = `http://127.0.0.1:6207/#dezin-bridge=${bridgeNonce}`;
        devServers.push({ dir, runtimeKey, url });
        return {
          url,
          leaseId: "run-preview-lease-1",
          bridgeNonce,
          expiresAt: 123_456,
          release: async () => { releasedProducerLeases.push("run-preview-lease-1"); },
        };
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
      const done = events.find((e) => e.type === "run-done")!;
      assert.equal(done.mode, "standard");
      assert.equal(done.passed, false);
      assert.equal(done.score, 75);
      assert.equal((done.findings as Array<{ id: string }>)[0]?.id, "ai-default-indigo");
      const run = store.getRun(done.runId as string)!;
      assert.equal(run.lintPassed, false);
      assert.equal(run.score, 75);
      assert.equal(run.findings[0]?.id, "ai-default-indigo");
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6213/" }),
      captureCoverUrl: async () => true,
    },
  );
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

test("project deletion cancels and awaits post-success cover capture in Standard and Prototype modes", async () => {
  for (const mode of ["prototype", "standard"] as const) {
    let captureEntered!: () => void;
    const entered = new Promise<void>((resolve) => { captureEntered = resolve; });
    let finishCapture!: () => void;
    const finish = new Promise<void>((resolve) => { finishCapture = resolve; });
    let abortObserved!: () => void;
    const aborted = new Promise<void>((resolve) => { abortObserved = resolve; });
    let sawAbort = false;
    let coverPath = "";
    const runner: AgentRunner = mode === "prototype"
      ? new FakeRunner({ artifacts: [CLEAN] })
      : {
          id: "standard-blocked-cover",
          async runTurn(input) {
            writeFileSync(join(input.projectDir, "src-App.jsx"), "export default function App(){ return <main>Cover</main> }");
            return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
          },
        };
    const blockedCapture = async (_source: string, outPath: string, signal?: AbortSignal): Promise<boolean> => {
      coverPath = outPath;
      signal?.addEventListener("abort", () => {
        sawAbort = true;
        abortObserved();
      }, { once: true });
      captureEntered();
      await finish;
      writeFileSync(outPath, "late cover");
      return true;
    };

    await withRunServer(
      runner,
      async ({ base, dataDir, store }) => {
        const project = store.createProject({ name: `${mode} cover ownership`, mode });
        if (mode === "standard") {
          const dir = join(dataDir, "projects", project.id);
          mkdirSync(dir, { recursive: true });
          execFileSync("git", ["init", "-q"], { cwd: dir });
          writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
          execFileSync("git", ["add", "-A"], { cwd: dir });
          execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });
        }

        const runResponse = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.id, brief: "make it better" }),
        });
        const events = parseSse(await runResponse.text());
        assert.ok(events.some((event) => event.type === "run-done"), `${mode} run succeeds before cover capture`);
        await entered;

        let deletionSettled = false;
        const deleting = fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" }).then((response) => {
          deletionSettled = true;
          return response;
        });
        await Promise.race([aborted, delay(100)]);
        await delay(10);
        assert.equal(sawAbort, true, `${mode} cover receives project cancellation`);
        assert.equal(deletionSettled, false, `${mode} deletion waits for cover settlement`);

        finishCapture();
        const deleted = await deleting;
        assert.equal(deleted.status, 204);
        assert.equal(existsSync(coverPath), false, `${mode} late cover cannot survive project deletion`);
      },
      {
        ensureDevServer: async () => ({ url: "http://127.0.0.1:5998/" }),
        captureCover: blockedCapture,
        captureCoverUrl: blockedCapture,
      },
    );
  }
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
      assert.equal(visualInput?.projectRoot, standardRunWorktreeDir(dataDir, project.id, done.runId as string));
      assert.notEqual(visualInput?.projectRoot, expectedDir, "visual QA reads only the isolated Run worktree");
      assert.match(visualInput?.htmlPath ?? "", /index\.html$/);
      assert.equal(visualInput?.agentCommand, "codebuddy");
      assert.equal(visualInput?.model, "hunyuan");
      assert.deepEqual(visualInput?.conversationHistory?.map((m) => m.content), ["make it better", "changed"]);
      const run = store.getRun(done.runId as string)!;
      assert.equal(run.score, 92);
      assert.equal(run.findings[0]?.id, "visual-fixed-offscreen");
      assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
      assert.equal(existsSync(join(dataDir, "version-evidence", project.id, run.id, "visual")), true);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6214/" }),
      captureCoverUrl: async () => true,
      visualQa: async (input) => {
        visualInput = input;
        mkdirSync(join(input.projectRoot!, ".visual-qa"), { recursive: true });
        writeFileSync(join(input.projectRoot!, ".visual-qa", "screenshot.png"), "fresh Standard review pixels");
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

test("a Standard Run can read uploaded .refs without committing daemon-owned attachments", async () => {
  const runner: AgentRunner = {
    id: "standard-ref-sidecar",
    async runTurn(input) {
      assert.equal(readFileSync(join(input.projectDir, ".refs", "reference.txt"), "utf8"), "reference evidence");
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "built from uploaded reference");
      return { text: "used reference", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project, dir } = initStandardRunProject(dataDir, store);
      const upload = await fetch(`${base}/api/projects/${project.id}/refs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "reference.txt", contentBase64: Buffer.from("reference evidence").toString("base64") }),
      });
      assert.equal(upload.status, 200);

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "Use ./.refs/reference.txt" }),
      });
      const responseText = await response.text();
      assert.equal(response.status, 200, responseText);
      const events = parseSse(responseText);

      assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-done"]);
      assert.equal(readFileSync(join(dir, ".refs", "reference.txt"), "utf8"), "reference evidence");
      assert.equal(execFileSync("git", ["ls-files", "--", ".refs"], { cwd: dir, encoding: "utf8" }).trim(), "");
      assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => false,
    },
  );
});

test("a generated Standard cover remains a clean sidecar for the next Run", async () => {
  let turn = 0;
  const runner: AgentRunner = {
    id: "standard-cover-sidecar",
    async runTurn(input) {
      turn += 1;
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `cover run ${turn}`);
      return { text: `run ${turn}`, artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project, dir } = initStandardRunProject(dataDir, store);
      const first = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "first cover run" }),
      });
      assert.deepEqual(terminalEvents(await closedSse(first, "first cover run")).map((event) => event.type), ["run-done"]);
      for (let i = 0; i < 50 && !existsSync(join(dir, ".cover.png")); i += 1) await delay(10);
      assert.equal(existsSync(join(dir, ".cover.png")), true);

      const second = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "second cover run" }),
      });
      assert.deepEqual(terminalEvents(await closedSse(second, "second cover run")).map((event) => event.type), ["run-done"]);
      assert.equal(turn, 2);
      assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async (_url, outPath) => {
        writeFileSync(outPath, `cover ${turn}`);
        return true;
      },
    },
  );
});

test("legacy tracked Standard runtime sidecars migrate out of Git without losing current references", async () => {
  const runner: AgentRunner = {
    id: "legacy-sidecar-migration",
    async runTurn(input) {
      assert.equal(readFileSync(join(input.projectDir, ".refs", "legacy.txt"), "utf8"), "current reference bytes");
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "built after sidecar migration");
      return { text: "migrated", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const { project, dir } = initStandardRunProject(dataDir, store);
      mkdirSync(join(dir, ".refs"), { recursive: true });
      mkdirSync(join(dir, ".visual-qa"), { recursive: true });
      writeFileSync(join(dir, ".refs", "legacy.txt"), "old reference bytes");
      writeFileSync(join(dir, ".visual-qa", "screenshot.png"), "old review pixels");
      writeFileSync(join(dir, ".cover.png"), "old cover pixels");
      commitAll(dir, "legacy tracked runtime files");
      writeFileSync(join(dir, ".refs", "legacy.txt"), "current reference bytes");
      writeFileSync(join(dir, ".visual-qa", "screenshot.png"), "current review pixels");
      writeFileSync(join(dir, ".cover.png"), "current cover pixels");

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "migrate legacy sidecars" }),
      });
      const responseText = await response.text();
      assert.equal(response.status, 200, responseText);
      assert.deepEqual(terminalEvents(parseSse(responseText)).map((event) => event.type), ["run-done"], responseText);

      assert.equal(execFileSync("git", ["ls-files", "--", ".cover.png", ".visual-qa", ".refs"], { cwd: dir, encoding: "utf8" }).trim(), "");
      assert.equal(readFileSync(join(dir, ".refs", "legacy.txt"), "utf8"), "current reference bytes");
      assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }), "");
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => false,
    },
  );
});

test("a Standard preview failure cannot attach a pre-existing screenshot as current-run evidence", async () => {
  const runner: AgentRunner = {
    id: "standard-preview-failure",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "changed design");
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: true, autoImproveEnabled: false });
      const { project, dir } = initStandardRunProject(dataDir, store);
      mkdirSync(join(dir, ".visual-qa"), { recursive: true });
      writeFileSync(join(dir, ".visual-qa", "screenshot.png"), "pixels from an older visual review");
      commitAll(dir, "seed old screenshot");

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "update the design" }),
      });
      const events = parseSse(await response.text());
      const runId = events.find((event) => event.type === "run-start")!.runId as string;
      const visualEvent = events.find((event) => event.type === "visual-qa")!;
      const findings = visualEvent.findings as Array<{ id?: string; screenshotUrl?: string }>;

      assert.ok(findings.some((finding) => finding.id === "visual-devserver-unavailable"));
      assert.equal(findings.some((finding) => Boolean(finding.screenshotUrl)), false);
      assert.equal(
        existsSync(join(dataDir, "version-evidence", project.id, runId, "visual")),
        false,
        "a preview failure must not promote an older screenshot into this Run's immutable evidence",
      );
      const conversation = store.listConversations(project.id)[0]!;
      const visualRecord = store
        .listMessages(conversation.id)
        .filter((message) => message.role === "system")
        .map((message) => {
          try {
            return JSON.parse(message.content) as { visualReview?: { screenshotUrl?: string } };
          } catch {
            return {};
          }
        })
        .find((message) => message.visualReview);
      assert.ok(visualRecord?.visualReview, "the failed review attempt remains visible in the transcript");
      assert.equal(visualRecord.visualReview.screenshotUrl, undefined);
    },
    {
      visualQa: undefined,
      ensureDevServer: async () => {
        throw new Error("preview intentionally unavailable");
      },
      captureCoverUrl: async () => true,
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
      writeValidSharinganEvidence(dir);
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

test("an unresolved Sharingan fidelity gate preserves a recovery commit without publishing it", async () => {
  let turn = 0;
  const runner: AgentRunner = {
    id: "sharingan-quality-gate",
    async runTurn(input) {
      turn += 1;
      writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>candidate ${turn}</main> }`);
      return { text: `candidate ${turn}`, artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false, autoImproveMaxRounds: 0 });
      const project = store.createProject({ name: "Strict clone", mode: "standard", sharingan: true });
      const dir = join(dataDir, "projects", project.id);
      mkdirSync(join(dir, "src"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      writeFileSync(join(dir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(dir, "src", "App.jsx"), `export default function App(){ return <main>source baseline</main> }`);
      const sourceHead = commitAll(dir, "base");

      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "reconstruct the source exactly" }),
      });
      const events = await closedSse(response, "Sharingan quality gate");
      const runId = String(events.find((event) => event.type === "run-start")?.runId ?? "");
      const run = store.getRun(runId);

      assert.ok(events.some((event) => event.type === "run-error" && /fidelity gate/i.test(String(event.message))));
      assert.equal(events.some((event) => event.type === "run-done"), false);
      assert.equal(run?.status, "failed");
      assert.equal(run?.lintPassed, false);
      assert.match(run?.commitHash ?? "", /^[0-9a-f]{40}$/);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), sourceHead);
      assert.match(readFileSync(join(dir, "src", "App.jsx"), "utf8"), /source baseline/);
      assert.equal(
        execFileSync("git", ["rev-parse", standardRunBranchName(runId)], { cwd: dir, encoding: "utf8" }).trim(),
        run?.commitHash,
      );
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:5999/" }),
      captureCoverUrl: async () => true,
      visualQa: async () => [
        {
          severity: "P1",
          id: "visual-source-screenshot-diff",
          message: "The generated surface still differs materially from the source.",
          fix: "Match the measured source layout and pixels.",
        },
      ],
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
      writeValidSharinganEvidence(dir);
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
      const regionCalls = calls.filter((call) => call.phase === "region");
      const headerCall = regionCalls.find((call) => /Region ID:\s*region-1/.test(call.message));
      const heroCall = regionCalls.find((call) => /Region ID:\s*region-2/.test(call.message));
      const mainCall = calls.find((call) => call.phase === "main");
      assert.equal(headerCall?.historyLength, 0, "region subagents run with isolated context");
      assert.equal(heroCall?.historyLength, 0, "each region subagent gets isolated context");
      assert.match(headerCall?.message ?? "", /Header/);
      assert.match(headerCall?.message ?? "", /textRuns/);
      assert.match(headerCall?.message ?? "", /rgb\(255,255,255\)/);
      assert.match(heroCall?.message ?? "", /Hero/);
      assert.match(heroCall?.message ?? "", /media/);
      assert.match(heroCall?.message ?? "", /\/_assets\/hero\.png/);
      assert.match(mainCall?.message ?? "", /SHARINGAN MAIN INTEGRATION/);
      assert.match(mainCall?.message ?? "", /src\/sharingan-regions\/region-1\.jsx/);
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
  const calls: Array<{ phase: "region" | "main"; id?: string; message: string }> = [];
  const completionOrder: string[] = [];
  const runner: AgentRunner = {
    id: "sharingan-parallel-regions",
    async runTurn(input) {
      const regionMatch = input.message.match(/Region ID:\s*(region-\d+)/);
      if (regionMatch) {
        const id = regionMatch[1]!;
        calls.push({ phase: "region", id, message: input.message });
        activeRegions += 1;
        maxActiveRegions = Math.max(maxActiveRegions, activeRegions);
        await delay(id === "region-1" ? 120 : 10);
        mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
        writeFileSync(join(input.projectDir, "src", "sharingan-regions", `${id}.jsx`), `export default function ${id.replace("-", "_")}(){ return <section>${id}</section>; }\n`);
        activeRegions -= 1;
        completionOrder.push(id);
        return { text: `built ${id}`, artifactHtml: "", artifactPath: "index.html" };
      }
      calls.push({ phase: "main", message: input.message });
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
      assert.deepEqual(completionOrder, ["region-2", "region-1"], "the fixture proves workers completed out of order");
      const manifest = JSON.parse(readFileSync(join(dataDir, "projects", project.id, ".sharingan", "region-build.json"), "utf8")) as { regions: Array<{ id: string }> };
      assert.deepEqual(manifest.regions.map((region) => region.id), ["region-1", "region-2"], "manifest order follows the source plan");
      const mainMessage = calls.find((call) => call.phase === "main")?.message ?? "";
      assert.ok(mainMessage.indexOf("region-1") < mainMessage.indexOf("region-2"), "main integration receives source-plan order");
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
      writeValidSharinganEvidence(dir);

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

test("a second targeted Sharingan Run keeps the variant capture when the root legacy bundle diverges", async () => {
  let expectedBundle = "root-v1";
  let runNumber = 1;
  const runner: AgentRunner = {
    id: "sharingan-variant-bundle-authority",
    async runTurn(input) {
      assert.equal(
        readFileSync(join(input.projectDir, ".sharingan", "bundle-origin.txt"), "utf8"),
        expectedBundle,
        "the selected variant transaction owns its existing capture bundle",
      );
      writeFileSync(
        join(input.projectDir, "src", "App.jsx"),
        `export default function App(){ return <main>targeted Sharingan run ${runNumber}</main> }`,
      );
      return { text: `targeted run ${runNumber}`, artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ visualQaEnabled: false, autoImproveEnabled: false });
      const project = store.createProject({ name: "Variant capture authority", mode: "standard", sharingan: true });
      const rootDir = join(dataDir, "projects", project.id);
      mkdirSync(join(rootDir, "src"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: rootDir });
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      writeFileSync(join(rootDir, "index.html"), `<div id="root"></div><script type="module" src="/src/App.jsx"></script>`);
      writeFileSync(join(rootDir, "src", "App.jsx"), `export default function App(){ return <main>root</main> }`);
      commitAll(rootDir, "base without capture");

      writeValidSharinganEvidence(rootDir, "https://root.example");
      writeFileSync(join(rootDir, ".sharingan", "bundle-origin.txt"), "root-v1");

      store.ensureMainVariant(project.id);
      const variant = store.createVariant(project.id, "Capture-owning variant");
      const first = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, variantId: variant.id, brief: "first targeted clone" }),
      });
      const firstEvents = await closedSse(first, "first targeted Sharingan capture seed");
      assert.deepEqual(terminalEvents(firstEvents).map((event) => event.type), ["run-done"]);

      const variantDir = join(dataDir, "worktrees", project.id, variant.id);
      assert.equal(readFileSync(join(variantDir, ".sharingan", "bundle-origin.txt"), "utf8"), "root-v1");
      writeFileSync(join(rootDir, ".sharingan", "bundle-origin.txt"), "root-v2");
      expectedBundle = "root-v1";
      runNumber = 2;

      const second = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, variantId: variant.id, brief: "second targeted clone" }),
      });
      const secondEvents = await closedSse(second, "second targeted Sharingan capture authority");

      assert.deepEqual(terminalEvents(secondEvents).map((event) => event.type), ["run-done"]);
      assert.equal(readFileSync(join(variantDir, ".sharingan", "bundle-origin.txt"), "utf8"), "root-v1");
      assert.equal(readFileSync(join(rootDir, ".sharingan", "bundle-origin.txt"), "utf8"), "root-v2");
      assert.match(readFileSync(join(variantDir, "src", "App.jsx"), "utf8"), /targeted Sharingan run 2/);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: variantDir, encoding: "utf8" }), "");
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
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6216/" }),
      captureCoverUrl: async () => true,
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
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6219/" }),
      captureCoverUrl: async () => true,
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
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6217/" }),
      captureCoverUrl: async () => true,
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
        ensureDevServer: async () => ({ url: "http://127.0.0.1:6218/" }),
        captureCoverUrl: async () => true,
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

test("daemon start removes Prototype snapshot crash residue without touching completed or legacy versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-start-version-cleanup-"));
  const dataDir = join(root, "data");
  const portFile = join(root, "daemon.json");
  const versionsDir = join(dataDir, "projects", "project-cleanup", ".versions");
  mkdirSync(join(versionsDir, "orphan-run.files"), { recursive: true });
  mkdirSync(join(versionsDir, "valid-run.files"), { recursive: true });
  writeFileSync(join(versionsDir, "valid-run.html"), "<main>valid</main>");
  writeFileSync(join(versionsDir, "legacy-run.html"), "<main>legacy</main>");
  mkdirSync(join(versionsDir, "run-visual-round-0.files"), { recursive: true });
  writeFileSync(join(versionsDir, "run-visual-round-0.html"), "<main>private</main>");
  writeFileSync(join(versionsDir, ".run-crash.html.tmp"), "<main>staged</main>");

  const child = spawn("node", ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "src/start.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DEZIN_DATA_DIR: dataDir, DEZIN_PORTFILE: portFile },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 80 && !existsSync(portFile); i++) await delay(50);
    assert.equal(existsSync(portFile), true, "daemon wrote its port file");
    assert.equal(existsSync(join(versionsDir, "orphan-run.files")), false);
    assert.equal(existsSync(join(versionsDir, "run-visual-round-0.files")), false);
    assert.equal(existsSync(join(versionsDir, "run-visual-round-0.html")), false);
    assert.equal(existsSync(join(versionsDir, ".run-crash.html.tmp")), false);
    assert.equal(existsSync(join(versionsDir, "valid-run.files")), true);
    assert.equal(readFileSync(join(versionsDir, "valid-run.html"), "utf8"), "<main>valid</main>");
    assert.equal(readFileSync(join(versionsDir, "legacy-run.html"), "utf8"), "<main>legacy</main>");
  } finally {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
    rmSync(root, { recursive: true, force: true });
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
    return { ran: true, produced: true, visualProduced: false, complete: true, issues: [] };
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
    return { ran: true, produced: true, visualProduced: false, complete: true, issues: [] };
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
    return { ran: false, produced: true, visualProduced: false, complete: true, issues: [] };
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
      writeValidatedResearchBundle(dir);
      writeFileSync(join(dir, ".research", "chosen"), "alpha\n"); // the user picked direction "alpha" earlier

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
    return { ran: true, produced: true, visualProduced: true, complete: true, issues: [] };
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

test("research activity is clamped, incrementally bounded, and force-flushed before failure", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["unused"] });
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async (input) => {
    for (let index = 0; index < 260; index++) {
      input.onActivity?.({ kind: "note", text: `${index}:${"界".repeat(5_000)}`, track: index % 2 ? "visual" : "product" });
    }
    throw new Error("research fixture failed");
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      const project = await createProject(base);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "research heavily", research: true }),
      });
      assert.equal(response.status, 200);
      const events = parseSse(await response.text());
      const runId = String(events.find((event) => event.type === "run-start")?.runId ?? "");
      assert.ok(runId);
      assert.ok(events.some((event) => event.type === "run-error"));
      const live = events.filter((event) => event.type === "research-activity");
      assert.equal(live.length, 260);
      assert.ok(live.every((event) => Buffer.byteLength(String(event.text ?? ""), "utf8") <= 8 * 1024));

      const journal = readFileSync(join(dataDir, ".runs", runId, "research-activity.jsonl"), "utf8");
      assert.ok(Buffer.byteLength(journal, "utf8") <= 2 * 1024 * 1024);
      assert.equal(journal.split('"type":"research-activity-truncated"').length - 1, 1);
      const journalEvents = journal.trim().split("\n").map((line) => JSON.parse(line) as {
        type?: string;
        seq?: number;
        droppedEvents?: number;
        droppedBytes?: number;
        droppedThroughSeq?: number;
      });
      const marker = journalEvents.find((event) => event.type === "research-activity-truncated");
      assert.ok(marker && marker.droppedEvents! > 0 && marker.droppedBytes! > 0 && marker.droppedThroughSeq! > 0);
      const retainedActivities = journalEvents.filter((event) => typeof event.seq === "number" && !event.type);
      assert.equal(retainedActivities.at(-1)?.seq, 260, "the bounded journal retains the newest activity");

      const conversation = store.listConversations(project.id)[0]!;
      const runningCard = store.listMessages(conversation.id).find((message) => {
        try {
          return (JSON.parse(message.content) as { research?: { status?: string } }).research?.status === "running";
        } catch {
          return false;
        }
      });
      assert.ok(runningCard, "the pending 250ms snapshot is force-flushed before run-error");
      assert.ok(Buffer.byteLength(runningCard!.content, "utf8") <= 300 * 1024);
      const parsed = JSON.parse(runningCard!.content) as { research: { activities: unknown[] } };
      assert.ok(parsed.research.activities.length <= 200);
    },
    { researchPhase },
  );
});

test("runs without the research flag skip the research phase", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["done"] });
  let called = false;
  const researchPhase: NonNullable<AppDeps["researchPhase"]> = async () => {
    called = true;
    return { ran: true, produced: false, visualProduced: false, complete: false, issues: [] };
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
  writeValidatedResearchBundle(input.dir);
  return { ran: true, produced: true, visualProduced: false, complete: true, issues: [] };
};

test("Standard chosen direction is durably checkpointed before failure, abort, question, or no-op and retry reuses it", async () => {
  for (const exit of ["failure", "abort", "question", "noop"] as const) {
    let retrying = false;
    let researchCalls = 0;
    const runner: AgentRunner = {
      id: `direction-checkpoint-${exit}`,
      async runTurn(input) {
        if (retrying) {
          assert.match(input.message, /Chosen direction/);
          assert.match(input.message, /# Alpha — bold/);
          assert.match(input.message, /Concept: Bold direction for alpha, grounded in the product and visual evidence\./);
          writeFileSync(join(input.projectDir, "src", "App.jsx"), `export default function App(){ return <main>retry ${exit} with alpha</main> }`);
          return { text: "retry built the chosen direction", artifactHtml: "", artifactPath: "index.html" };
        }
        if (exit === "failure") throw new Error("agent failed after direction choice");
        if (exit === "abort") throw abortError();
        if (exit === "question") {
          return {
            text: "<dezin-ask-user-question>\nWhich CTA label should I use?\n</dezin-ask-user-question>",
            artifactHtml: "",
            artifactPath: "index.html",
          };
        }
        return { text: "no project changes", artifactHtml: "", artifactPath: "index.html" };
      },
    };

    await withRunServer(
      runner,
      async ({ base, dataDir, store }) => {
        store.updateSettings({ researchEnabled: true, visualQaEnabled: false, autoImproveEnabled: false });
        const initialized = initStandardRunProject(dataDir, store);
        writeValidatedResearchBundle(initialized.dir);
        const researchHead = commitAll(initialized.dir, "published research directions");

        const first = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: initialized.project.id, brief: "build selected direction", directionSlug: "alpha" }),
        });
        const firstEvents = await closedSse(first, `direction checkpoint ${exit}`);
        const firstRunId = firstEvents.find((event) => event.type === "run-start")!.runId as string;
        const expectedTerminal = exit === "abort" || exit === "question" ? "run-cancelled" : "run-error";

        assert.deepEqual(terminalEvents(firstEvents).map((event) => event.type), [expectedTerminal]);
        assert.equal(researchCalls, 0, "choosing a published direction never re-runs research");
        assert.equal(existsSync(join(initialized.dir, ".research", "chosen")), true, "the choice is published before the build turn");
        assert.equal(readFileSync(join(initialized.dir, ".research", "chosen"), "utf8").trim(), "alpha");
        assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: initialized.dir, encoding: "utf8" }).trim(), researchHead);
        assert.match(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), /source baseline/);
        assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: initialized.dir, encoding: "utf8" }), "");
        assert.equal(existsSync(standardRunWorktreeDir(dataDir, initialized.project.id, firstRunId)), false);

        retrying = true;
        const retry = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: initialized.project.id, brief: "retry the selected direction" }),
        });
        const retryEvents = await closedSse(retry, `direction checkpoint retry ${exit}`);

        assert.deepEqual(terminalEvents(retryEvents).map((event) => event.type), ["run-done"]);
        assert.equal(researchCalls, 0, "retry reuses the durable direction without research");
        assert.equal(readFileSync(join(initialized.dir, ".research", "chosen"), "utf8").trim(), "alpha");
        assert.match(readFileSync(join(initialized.dir, "src", "App.jsx"), "utf8"), new RegExp(`retry ${exit} with alpha`));
        assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: initialized.dir, encoding: "utf8" }), "");
      },
      {
        researchPhase: async (input) => {
          researchCalls += 1;
          return researchWithDirections(input);
        },
        ensureDevServer: async () => ({ url: "http://127.0.0.1:6221/" }),
        captureCoverUrl: async () => true,
        visualQa: async () => [],
      },
    );
  }
});

test("Standard direction gate publishes research from its transaction before disposing it", async () => {
  let researchCalls = 0;
  const runner: AgentRunner = {
    id: "standard-direction-build",
    async runTurn(input) {
      writeFileSync(join(input.projectDir, "src", "App.jsx"), "chosen direction build");
      return { text: "built", artifactHtml: "", artifactPath: "index.html" };
    },
  };
  await withRunServer(
    runner,
    async ({ base, dataDir, store }) => {
      store.updateSettings({ researchEnabled: true });
      const { project, dir, head } = initStandardRunProject(dataDir, store);
      const first = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, brief: "make a hero" }),
      });
      const firstEvents = parseSse(await first.text());
      const firstRunId = firstEvents.find((event) => event.type === "run-start")!.runId as string;
      const conversationId = firstEvents.find((event) => event.type === "run-start")!.conversationId as string;

      assert.ok(firstEvents.some((event) => event.type === "direction-gate"));
      assert.equal(readFileSync(join(dir, ".research", "research.md"), "utf8"), VALID_PRODUCT_RESEARCH_REPORT);
      assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), head);
      assert.equal(existsSync(standardRunWorktreeDir(dataDir, project.id, firstRunId)), false);
      assert.equal(execFileSync("git", ["branch", "--list", standardRunBranchName(firstRunId)], { cwd: dir, encoding: "utf8" }).trim(), "");

      const second = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, conversationId, brief: "make a hero", directionSlug: "alpha" }),
      });
      assert.ok(parseSse(await second.text()).some((event) => event.type === "run-done"));
      assert.equal(researchCalls, 1, "the chosen-direction build reuses the published research");
      assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "chosen direction build");
    },
    {
      researchPhase: async (input) => {
        researchCalls += 1;
        return researchWithDirections(input);
      },
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6220/" }),
      captureCoverUrl: async () => true,
    },
  );
});

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
      assert.match(runner.calls[0]!.message, /# Alpha — bold/);
      assert.match(runner.calls[0]!.message, /Concept: Bold direction for alpha, grounded in the product and visual evidence\./);
      assert.doesNotMatch(runner.calls[0]!.message, /Calm concept for beta/);
      // The pick is persisted so the Research views can show it (survives reload).
      const research = (await (await fetch(`${base}/api/projects/${project.id}/research`)).json()) as { chosenSlug?: string };
      assert.equal(research.chosenSlug, "alpha");
    },
    { researchPhase: researchWithDirections },
  );
});

test("unsafe or missing directionSlug cannot bypass the gate or write the chosen checkpoint", async () => {
  for (const directionSlug of ["../alpha", "missing-direction"]) {
    const runner = new FakeRunner({ artifacts: [CLEAN], texts: ["must not build"] });
    await withRunServer(
      runner,
      async ({ base, dataDir, store }) => {
        const project = await createProject(base);
        const response = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.id, brief: "make a hero", research: true, directionSlug }),
        });
        const events = await closedSse(response, `invalid direction ${directionSlug}`);
        const runId = String(events.find((event) => event.type === "run-start")?.runId ?? "");
        const chosen = join(dataDir, "projects", project.id, ".research", "chosen");

        assert.equal(runner.calls.length, 0);
        assert.deepEqual(terminalEvents(events).map((event) => event.type), ["run-error"]);
        assert.equal(store.getRun(runId)?.status, "failed");
        assert.equal(existsSync(chosen), false, "invalid direction must never be checkpointed");
      },
      { researchPhase: researchWithDirections },
    );
  }
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
