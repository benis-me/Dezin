import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericCliRunner, GENERIC_AGENTS, type ProcessSpawner, type SpawnInput } from "../src/index.ts";

test("each known agent builds a sane invocation with model + prompt", () => {
  for (const [cmd, config] of Object.entries(GENERIC_AGENTS)) {
    const args = config.buildArgs("some-model", "PROMPT");
    assert.ok(args.includes("PROMPT"), `${cmd} should pass the prompt`);
    assert.ok(args.includes("some-model"), `${cmd} should pass the model`);
  }
});

test("codex invocation runs exec headlessly", () => {
  const runner = new GenericCliRunner({ command: "codex", config: GENERIC_AGENTS.codex! });
  const args = runner.buildArgs("the prompt");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args.at(-1), "the prompt");
});

test("runTurn spawns the agent and reads the artifact it wrote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dezin-generic-"));
  await writeFile(join(dir, "index.html"), "<h1>built by codex</h1>", "utf8");

  let captured: SpawnInput | null = null;
  const fakeSpawner: ProcessSpawner = {
    async run(input) {
      captured = input;
      return { stdout: "line a\nline b\napplied 1 edit\n", exitCode: 0 };
    },
  };

  const runner = new GenericCliRunner({ command: "codex", model: "gpt-5-codex", config: GENERIC_AGENTS.codex!, spawner: fakeSpawner });
  const result = await runner.runTurn({ systemPrompt: "SYS", message: "make a hero", projectDir: dir });

  assert.equal(result.artifactHtml, "<h1>built by codex</h1>");
  assert.ok(result.text.includes("applied 1 edit"));
  assert.equal(captured!.cwd, dir);
  // The combined prompt carries both the system prompt and the task message.
  assert.ok(captured!.args.some((a) => a.includes("SYS") && a.includes("make a hero")));
});
