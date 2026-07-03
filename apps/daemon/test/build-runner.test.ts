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
    visualQaAgentCommand: "",
    visualQaModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 8,
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

test("buildRunner can disable artifact update enforcement for standard projects", () => {
  const claude = buildRunner(
    settings({ agentCommand: "codebuddy", model: "claude-opus-4.8" }),
    {},
    { enforceArtifactUpdate: false },
  );
  assert.ok(claude instanceof ClaudeCodeRunner);
  assert.equal(claude.command, "codebuddy");
  assert.equal(claude.enforceArtifactUpdate, false);

  const generic = buildRunner(
    settings({ agentCommand: "codex", model: "gpt-5-codex" }),
    {},
    { enforceArtifactUpdate: false },
  );
  assert.ok(generic instanceof GenericCliRunner);
  assert.equal(generic.enforceArtifactUpdate, false);
});
