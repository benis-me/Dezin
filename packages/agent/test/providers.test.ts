import { test } from "node:test";
import assert from "node:assert/strict";
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

test("the model-listing agents declare a discovery probe", () => {
  assert.ok(getProvider("codex")?.discoverModels, "codex discovers via `codex debug models`");
  assert.ok(getProvider("codebuddy")?.discoverModels, "codebuddy discovers via --help");
  // Claude has no list command — it relies on its seed aliases.
  assert.equal(getProvider("claude")?.discoverModels, undefined);
  assert.deepEqual(getProvider("claude")?.seedModels, ["opus", "sonnet", "haiku"]);
});

test("new generic CLI providers use their documented headless entrypoints", () => {
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
