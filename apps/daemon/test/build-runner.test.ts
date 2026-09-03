import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentRunner as buildRunner } from "../src/agent-runner.ts";
import { ClaudeCodeRunner, GenericCliRunner } from "@dezin/agent";
import type { Settings } from "@dezin/core";

function settings(over: Partial<Settings>): Settings {
  return {
    agentCommand: "claude",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageModel: "",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: "",
    sharinganAffirmed: false,
    webResources: true,
    qualityLint: true,
    visualReview: false,
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

test("buildRunner supports analysis-only turns without requiring an HTML output", () => {
  const claude = buildRunner(settings({ agentCommand: "codebuddy", model: "claude-opus-4.8" }));
  assert.ok(claude instanceof ClaudeCodeRunner);
  assert.equal(claude.command, "codebuddy");
  assert.equal(claude.enforceArtifactUpdate, false);

  const generic = buildRunner(settings({ agentCommand: "codex", model: "gpt-5-codex" }));
  assert.ok(generic instanceof GenericCliRunner);
  assert.equal(generic.enforceArtifactUpdate, false);
});
