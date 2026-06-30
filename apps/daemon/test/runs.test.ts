import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { Store } from "../../../packages/core/src/index.ts";
import { abortError, FakeRunner } from "../../../packages/agent/src/index.ts";
import type { AgentRunner } from "../../../packages/agent/src/index.ts";
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

function commitAll(dir: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", message], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

async function createProject(base: string, body: object = { name: "P" }): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { id: string };
}

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

test("prototype run folds visual QA findings into score, result, and persisted run", async () => {
  await withRunServer(
    new FakeRunner({ artifacts: [CLEAN], texts: ["done"] }),
    async ({ base, store }) => {
      store.updateSettings({ visualQaEnabled: true });
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
        assert.equal(input.agentCommand, "codex");
        assert.equal(input.model, "gpt-5");
        assert.equal(input.brief, "make a hero");
        assert.match(input.htmlPath, /index\.html$/);
        assert.deepEqual(input.conversationHistory?.map((m) => m.content), [
          "previous user request",
          "previous assistant answer",
          "make a hero",
          "done",
        ]);
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
    assert.match(await v.text(), /Hi there/); // the CLEAN snapshot content

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

test("cancelled runs persist interleaved partial text and tool process items", async () => {
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
    const process = store
      .listMessages(convId)
      .map((m) => {
        try {
          return JSON.parse(m.content) as { process?: { elapsedMs?: number; items?: Array<{ type: string; text?: string; summary?: string }> } };
        } catch {
          return {};
        }
      })
      .find((m) => m.process);
    assert.deepEqual(process?.process?.items, [
      { type: "text", text: "Partial copy before stop." },
      { type: "tool", summary: "Editing hero.tsx" },
    ]);
    assert.equal(typeof process?.process?.elapsedMs, "number");
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
    const runId = events.find((e) => e.type === "run-start")!.runId as string;
    assert.equal(store.getRun(runId)?.status, "cancelled");

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

test("a deck-skill project gets the deck framework in its prompt", async () => {
  const runner = new FakeRunner({ artifacts: [CLEAN] });
  await withRunServer(runner, async ({ base, store }) => {
    const project = store.createProject({ name: "P", skillId: "deck", designSystemId: "modern-minimal" });
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "go" }),
    });
    await res.text();
    assert.match(runner.calls[0]?.systemPrompt ?? "", /Deck framework/);
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

      const diff = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/diff`);
      assert.equal(diff.status, 200);
      const lines = (await diff.json()) as Array<{ t: string; text: string }>;
      assert.ok(lines.some((l) => l.t === "del" && l.text.includes("One")));
      assert.ok(lines.some((l) => l.t === "add" && l.text.includes("Two")));

      const cover = await fetch(`${base}/api/projects/${project.id}/versions/${firstRun.id}/cover`, { method: "POST" });
      assert.equal(cover.status, 200);
      assert.deepEqual(await cover.json(), { captured: true });
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:6202/",
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
      store.updateSettings({ visualQaEnabled: true });
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
      const run = store.getRun(done.runId as string)!;
      assert.equal(run.score, 92);
      assert.equal(run.findings[0]?.id, "visual-fixed-offscreen");
    },
    {
      visualQa: async (input) => {
        assert.equal(input.projectRoot, expectedDir);
        assert.match(input.htmlPath, /index\.html$/);
        assert.equal(input.agentCommand, "codex");
        assert.equal(input.model, "gpt-5");
        assert.deepEqual(input.conversationHistory?.map((m) => m.content), ["make it better", "changed"]);
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

test("the composed prompt includes the active skill body and design-system tokens", async () => {
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
    assert.match(prompt, /Active skill — Frontend design/, "skill section present");
    assert.match(prompt, /Paste its/, "skill body text present");
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

test("an unknown skillId is tolerated — skill omitted, run still succeeds", async () => {
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
    assert.doesNotMatch(runner.calls[0]?.systemPrompt ?? "", /Active skill/, "no skill section");
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
    for (let i = 0; i < 80; i++) {
      if (existsSync(portFile)) {
        base = (JSON.parse(readFileSync(portFile, "utf8")) as { url: string }).url;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(base, "daemon wrote its port file");
    const project = await createProject(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
});
