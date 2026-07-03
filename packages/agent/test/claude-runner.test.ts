import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ClaudeCodeRunner,
  NodeSpawner,
  type ProcessSpawner,
  type SpawnInput,
  type SpawnOutput,
} from "../src/index.ts";

/** A fake spawner that simulates `claude` writing index.html and emitting stream-json. */
class FakeSpawner implements ProcessSpawner {
  last: SpawnInput | null = null;
  private stdout: string;
  private fileContent: string;

  constructor(stdout: string, fileContent: string) {
    this.stdout = stdout;
    this.fileContent = fileContent;
  }

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.last = input;
    await writeFile(join(input.cwd, "index.html"), this.fileContent, "utf8");
    return { stdout: this.stdout, exitCode: 0 };
  }
}

const STREAM = [
  `{"type":"system","subtype":"init","session_id":"s1"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Wrote the hero."}]}}`,
  `{"type":"result","subtype":"success","result":"done","is_error":false}`,
].join("\n");

const ERROR_STREAM = [
  `{"type":"system","subtype":"init","session_id":"s1"}`,
  `{"type":"result","subtype":"error_during_execution","result":"authentication expired","is_error":true}`,
].join("\n");

test("ClaudeCodeRunner assembles args/stdin, runs, and reads back the artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-"));
  const html = `<section data-dezin-id="x"><h1>Hero</h1></section>`;
  const spawner = new FakeSpawner(STREAM, html);
  const runner = new ClaudeCodeRunner({ spawner, command: "claude" });

  const result = await runner.runTurn({
    systemPrompt: "SYSTEM-PROMPT",
    message: "make me a hero",
    projectDir: dir,
  });

  // reads back the written artifact
  assert.equal(result.artifactHtml, html);
  assert.equal(result.artifactPath, "index.html");
  assert.equal(result.text, "Wrote the hero.");
  // the file is actually on disk
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), html);

  // correct command/cwd
  assert.equal(spawner.last?.command, "claude");
  assert.equal(spawner.last?.cwd, dir);
  // flags present
  const args = spawner.last?.args ?? [];
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--permission-mode") && args.includes("bypassPermissions"));
  // system prompt passed via --append-system-prompt
  const i = args.indexOf("--append-system-prompt");
  assert.ok(i >= 0 && args[i + 1] === "SYSTEM-PROMPT");
  // the user message went in as stream-json on stdin
  assert.match(spawner.last?.stdin ?? "", /"type":"user"/);
  assert.match(spawner.last?.stdin ?? "", /make me a hero/);
});

test("ClaudeCodeRunner prepends prior conversation turns to the message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-"));
  const spawner = new FakeSpawner(STREAM, "<section></section>");
  const runner = new ClaudeCodeRunner({ spawner, command: "claude" });

  await runner.runTurn({
    systemPrompt: "SYSTEM-PROMPT",
    message: "now make it bigger",
    projectDir: dir,
    history: [
      { role: "user", content: "make a hero" },
      { role: "assistant", content: "Built a hero." },
    ],
  });

  const stdin = spawner.last?.stdin ?? "";
  assert.match(stdin, /Conversation so far/);
  assert.match(stdin, /make a hero/); // prior user turn
  assert.match(stdin, /Built a hero\./); // prior assistant turn
  assert.match(stdin, /now make it bigger/); // current message still present
});

test("model option adds --model", () => {
  const runner = new ClaudeCodeRunner({ model: "claude-opus-4-8" });
  const args = runner.buildArgs("SYS");
  const i = args.indexOf("--model");
  assert.ok(i >= 0 && args[i + 1] === "claude-opus-4-8");
});

test("NodeSpawner uses the augmented agent environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-"));
  const out = await new NodeSpawner().run({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({path:process.env.PATH, hook:process.env.IMPECCABLE_HOOK_DISABLED, quiet:process.env.IMPECCABLE_HOOK_QUIET}))",
    ],
    cwd: dir,
    stdin: "",
  });
  const env = JSON.parse(out.stdout) as { path: string; hook: string; quiet: string };
  assert.ok(env.path.split(process.platform === "win32" ? ";" : ":").includes(dirname(process.execPath)));
  assert.equal(env.hook, "1");
  assert.equal(env.quiet, "1");
});

test("NodeSpawner passes per-turn extra environment variables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-env-"));
  const out = await new NodeSpawner().run({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.ANTHROPIC_API_KEY || '')"],
    cwd: dir,
    stdin: "",
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  assert.equal(out.stdout, "sk-test");
});

test("NodeSpawner times out a stuck process and escalates termination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-timeout-"));
  const spawner = new NodeSpawner({ timeoutMs: 40, killDelayMs: 10 });

  await assert.rejects(
    () =>
      spawner.run({
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        cwd: dir,
        stdin: "",
      }),
    /timed out after 40ms/i,
  );
});

test("NodeSpawner abort kills a process that ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-abort-"));
  const spawner = new NodeSpawner({ timeoutMs: 1000, killDelayMs: 10 });
  const controller = new AbortController();
  const run = spawner.run({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    cwd: dir,
    stdin: "",
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 20);
  await assert.rejects(run, (error) => error instanceof Error && error.name === "AbortError");
});

test("ClaudeCodeRunner rejects when the CLI exits nonzero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-exit-"));
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, stderr: "authentication expired", exitCode: 1 }),
  };
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    /claude.*exit code 1.*authentication expired/i,
  );
});

test("ClaudeCodeRunner rejects Claude stream-json error results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-is-error-"));
  const spawner = new FakeSpawner(ERROR_STREAM, "<h1>old</h1>");
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    /claude.*error.*authentication expired/i,
  );
});

test("ClaudeCodeRunner rejects when the agent writes no artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-empty-"));
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, exitCode: 0 }),
  };
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    /artifact.*missing/i,
  );
});

test("ClaudeCodeRunner rejects stale artifacts from a successful no-op turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-stale-"));
  await writeFile(join(dir, "index.html"), "<h1>previous</h1>", "utf8");
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, exitCode: 0 }),
  };
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    /artifact.*not updated/i,
  );
});

test("ClaudeCodeRunner can return an unchanged artifact when update enforcement is disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-standard-"));
  const html = "<div id=\"root\"></div><script type=\"module\" src=\"/src/main.jsx\"></script>";
  await writeFile(join(dir, "index.html"), html, "utf8");
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, exitCode: 0 }),
  };
  const runner = new ClaudeCodeRunner({ spawner, enforceArtifactUpdate: false });

  const result = await runner.runTurn({ systemPrompt: "S", message: "update src/App.jsx", projectDir: dir });

  assert.equal(result.artifactHtml, html);
});
