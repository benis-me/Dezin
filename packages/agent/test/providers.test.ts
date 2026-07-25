import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROVIDERS, getProvider } from "../src/index.ts";

test("the registry resolves providers by id and command (incl. a full path)", () => {
  assert.equal(getProvider("claude")?.id, "claude");
  assert.equal(getProvider("codex")?.id, "codex");
  assert.equal(getProvider("/usr/local/bin/codebuddy")?.id, "codebuddy");
  assert.equal(getProvider("kimi")?.id, "kimi");
  assert.equal(getProvider("trae-cli")?.id, "trae");
  assert.equal(getProvider("pi")?.id, "pi");
  assert.equal(getProvider("hermes")?.id, "hermes");
  assert.equal(getProvider("C:\\Users\\ben\\AppData\\Roaming\\npm\\claude.cmd")?.id, "claude");
  assert.equal(getProvider("C:\\Tools\\codex.exe")?.id, "codex");
  assert.equal(getProvider("aider"), undefined);
  assert.equal(getProvider("nope"), undefined);
});

test("the registry includes the supported agent CLIs and excludes retired ones", () => {
  const ids = AGENT_PROVIDERS.map((p) => p.id);

  assert.deepEqual(ids, [
    "claude",
    "codex",
    "gemini",
    "codebuddy",
    "cursor-agent",
    "copilot",
    "qwen",
    "opencode",
    "kimi",
    "trae",
    "pi",
    "hermes",
  ]);
  assert.ok(!ids.includes("aider"));
});

test("every provider builds a runner + a one-shot invocation that carries the prompt", () => {
  for (const p of AGENT_PROVIDERS) {
    const runner = p.createRunner({ command: p.command });
    assert.ok(runner && typeof runner.runTurn === "function", `${p.id} createRunner returns a runner`);
    const args = p.oneShotArgs("a-model", "THE_PROMPT");
    assert.ok(args.includes("THE_PROMPT"), `${p.id} oneShotArgs carries the prompt`);
  }
});

test("every generic provider forwards its injected spawner to the runner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-provider-spawner-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const provider of AGENT_PROVIDERS.filter((candidate) => candidate.genericConfig)) {
    const projectDir = join(root, provider.id);
    const command = `dezin-injected-${provider.id}-not-installed`;
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "index.html"), `<main>${provider.id}</main>`, "utf8");
    let calls = 0;
    const runner = provider.createRunner({
      command,
      enforceArtifactUpdate: false,
      spawner: {
        async run(input) {
          calls += 1;
          assert.equal(input.command, command);
          assert.equal(input.cwd, projectDir);
          return { stdout: `${provider.id} complete`, stderr: "", exitCode: 0 };
        },
      },
    });

    const result = await runner.runTurn({
      systemPrompt: "Build the exact Artifact.",
      message: "Keep the fixture stable.",
      projectDir,
    });

    assert.equal(calls, 1, `${provider.id} must use the injected spawner`);
    assert.equal(result.artifactHtml, `<main>${provider.id}</main>`);
  }
});

test("the model-listing agents declare a discovery probe", () => {
  assert.ok(getProvider("codex")?.discoverModels, "codex discovers via `codex debug models`");
  assert.ok(getProvider("codebuddy")?.discoverModels, "codebuddy discovers via --help");
  // Claude has no list command — it relies on its seed aliases.
  assert.equal(getProvider("claude")?.discoverModels, undefined);
  assert.deepEqual(getProvider("claude")?.seedModels, ["opus", "sonnet", "haiku"]);
});

test("new generic CLI providers use their documented headless entrypoints", () => {
  assert.deepEqual(getProvider("cursor-agent")?.oneShotArgs("cursor-model", "THE_PROMPT"), [
    "--output-format",
    "text",
    "--model",
    "cursor-model",
    "-p",
    "THE_PROMPT",
  ]);
  assert.deepEqual(getProvider("kimi")?.oneShotArgs("kimi-model", "THE_PROMPT"), [
    "--quiet",
    "--yolo",
    "-m",
    "kimi-model",
    "-p",
    "THE_PROMPT",
  ]);
  assert.deepEqual(getProvider("trae")?.oneShotArgs("trae-model", "THE_PROMPT"), ["run", "THE_PROMPT", "--model", "trae-model"]);
  assert.deepEqual(getProvider("pi")?.oneShotArgs("pi-model", "THE_PROMPT"), ["-p", "THE_PROMPT", "--model", "pi-model"]);
  assert.deepEqual(getProvider("hermes")?.oneShotArgs("hermes-model", "THE_PROMPT"), [
    "--yolo",
    "-m",
    "hermes-model",
    "-z",
    "THE_PROMPT",
  ]);
});
