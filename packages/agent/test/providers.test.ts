import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PROVIDERS, getProvider } from "../src/index.ts";

test("the registry resolves providers by id and command (incl. a full path)", () => {
  assert.equal(getProvider("claude")?.id, "claude");
  assert.equal(getProvider("codex")?.id, "codex");
  assert.equal(getProvider("/usr/local/bin/codebuddy")?.id, "codebuddy");
  assert.equal(getProvider("nope"), undefined);
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
