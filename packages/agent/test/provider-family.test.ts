import { test } from "node:test";
import assert from "node:assert/strict";
import { providerFamily } from "../src/providers/index.ts";

test("providerFamily maps provider ids to a model family", () => {
  assert.equal(providerFamily("codex"), "gpt");
  assert.equal(providerFamily("copilot"), "gpt");
  assert.equal(providerFamily("gemini"), "gemini");
  assert.equal(providerFamily("claude"), "claude");
  assert.equal(providerFamily("qwen"), "other");
  assert.equal(providerFamily(undefined), "other");
});

test("providerFamily lets the model name override an agnostic provider", () => {
  assert.equal(providerFamily("cursor-agent", "gpt-4o"), "gpt");
  assert.equal(providerFamily("cursor-agent", "gemini-2.5-pro"), "gemini");
  assert.equal(providerFamily("cursor-agent", "claude-sonnet-5"), "claude");
  assert.equal(providerFamily("opencode", "o3-mini"), "gpt");
});
