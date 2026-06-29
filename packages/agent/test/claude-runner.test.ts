import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCodeRunner,
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

test("ClaudeCodeRunner assembles args/stdin, runs, and reads back the artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-"));
  const html = `<section data-od-id="x"><h1>Hero</h1></section>`;
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

test("missing artifact file yields empty artifactHtml (agent wrote nothing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-empty-"));
  // spawner that returns stream-json but writes NO file
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, exitCode: 0 }),
  };
  const runner = new ClaudeCodeRunner({ spawner });
  const result = await runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir });
  assert.equal(result.artifactHtml, "");
  assert.equal(result.text, "Wrote the hero.");
});
