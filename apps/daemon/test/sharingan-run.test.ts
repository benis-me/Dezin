import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import type { AgentRunner, AgentTurnInput } from "../../../packages/agent/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";
import { projectDir } from "../src/serve-static.ts";
import { closeAllSharinganSessions } from "../src/sharingan-handler.ts";
import { sharinganRegionsForSubagents } from "../src/sharingan-region-runner.ts";

test("Sharingan region preparation keeps source order while normalizing duplicate ids", () => {
  const regions = sharinganRegionsForSubagents({
    regions: [
      { id: "Hero Banner", label: "Hero", texts: ["One", "One", "Two"] },
      { id: "Hero Banner", label: "Details", assets: ["/_assets/a.png"] },
    ],
  });

  assert.deepEqual(
    regions.map((region) => ({ id: region.id, label: region.label })),
    [
      { id: "hero-banner", label: "Hero" },
      { id: "hero-banner-2", label: "Details" },
    ],
  );
  assert.deepEqual(regions[0]?.texts, ["One", "Two"]);
});

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((b) => JSON.parse(b.replace(/^data:\s?/, "")) as Record<string, unknown>);
}

/** Records every turn input it receives, and writes a real file into the project
 *  dir + commits nothing itself — run-handler's own gitCommit() picks up the
 *  change — so the standard-mode build loop sees "files changed" and succeeds. */
class RecordingRunner implements AgentRunner {
  readonly id = "recording";
  calls: AgentTurnInput[] = [];
  async runTurn(input: AgentTurnInput) {
    this.calls.push(input);
    const regionId = input.message.match(/Region ID:\s*([a-z0-9_-]+)/i)?.[1];
    if (regionId) {
      mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
      writeFileSync(
        join(input.projectDir, "src", "sharingan-regions", `${regionId}.jsx`),
        `export default function Region(){ return <section>${regionId}</section> }`,
      );
      return { text: `built ${regionId}`, artifactHtml: "", artifactPath: "index.html" };
    }
    writeFileSync(join(input.projectDir, "src", "App.jsx"), "export default function App(){ return <main>Cloned</main> }");
    return { text: "done", artifactHtml: "", artifactPath: "index.html" };
  }
  get lastMessage(): string {
    return this.calls.at(-1)?.message ?? "";
  }
}

test("a sharingan run captures the site, injects the context, and skips research", { skip: !findChrome() && "no Chrome" }, async () => {
  // Local fixture standing in for the site being cloned.
  const fixture = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Acme</title><h1>Acme</h1><p>${"w ".repeat(60)}</p>`);
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const sourceUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;

  const dataDir = mkdtempSync(join(tmpdir(), "dezin-shar-run-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Clone", mode: "standard", sharingan: true, sourceUrl });

  // Manually stand up the standard-project git scaffold (standardProjectSetup only runs from
  // POST /api/projects, not from a project created directly via the store).
  const dir = projectDir(dataDir, project.id);
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  writeFileSync(join(dir, "src", "App.jsx"), "export default function App(){ return <main>Base</main> }");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

  const runner = new RecordingRunner();
  const app = createApp({
    store,
    dataDir,
    runner,
    visualQa: async () => [],
    standardProjectSetup: async () => {},
    ensureDevServer: async () => ({ url: "http://127.0.0.1:1/" }),
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // research intentionally omitted (undefined) — the client does NOT force it off;
      // skipping must come from the server-side `!project.sharingan` gate.
      body: JSON.stringify({ projectId: project.id, brief: sourceUrl }),
    });
    const events = parseSse(await res.text());
    assert.ok(
      events.some((e) => e.type === "run-done"),
      `expected a run-done event, got: ${events.map((e) => e.type).join(", ")}`,
    );

    assert.ok(
      existsSync(join(projectDir(dataDir, project.id), ".sharingan", "pages.json")),
      "the entry capture ran before the build turn",
    );
    assert.match(
      runner.lastMessage,
      /Reproduce from Capture|probe\.mjs/i,
      "the sharingan context block was injected into the agent brief",
    );
    assert.ok(
      !existsSync(join(projectDir(dataDir, project.id), "research")),
      "research was skipped for the sharingan project",
    );
  } finally {
    await closeAllSharinganSessions();
    await new Promise<void>((r) => app.close(() => r()));
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
    store.close();
  }
});
