import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunner } from "../src/run-handler.ts";
import { ClaudeCodeRunner, GenericCliRunner } from "../../../packages/agent/src/index.ts";
import type { Settings } from "../../../packages/core/src/index.ts";

function settings(over: Partial<Settings>): Settings {
  return {
    agentCommand: "claude",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    defaultDesignSystemId: "modern-minimal",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: "",
    visualQaEnabled: false,
    ...over,
  };
}

test("buildRunner uses the generic runner for non-claude agents", () => {
  const r = buildRunner(settings({ agentCommand: "codex", model: "o3" }));
  assert.ok(r instanceof GenericCliRunner);
  assert.equal(r.command, "codex");
  assert.equal(r.model, "o3");
  assert.ok(r.buildArgs("X").includes("o3"));
});

test("buildRunner uses the Claude runner for claude", () => {
  const r = buildRunner(settings({ agentCommand: "claude", model: "claude-opus-4-8" }));
  assert.ok(r instanceof ClaudeCodeRunner);
  assert.equal(r.command, "claude");
  assert.ok(r.buildArgs("X").includes("claude-opus-4-8"));
});

test("buildRunner falls back to claude with no model", () => {
  const r = buildRunner(settings({ agentCommand: "", model: "" }));
  assert.ok(r instanceof ClaudeCodeRunner);
  assert.equal(r.command, "claude");
  assert.equal(r.model, undefined);
  assert.ok(!r.buildArgs("X").includes("--model"));
});
