import { test } from "node:test";
import assert from "node:assert/strict";
import type { Settings } from "../../../packages/core/src/index.ts";
import { buildAgentEnv } from "../src/agent-env.ts";

const SETTINGS: Settings = {
  agentCommand: "claude",
  model: "",
  apiBaseUrl: "https://api.example.test",
  apiKey: "sk-test",
  defaultDesignSystemId: "modern-minimal",
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
  aiProviderId: "",
  aiProviderEnabled: false,
  aiProviderModels: "",
  aiProviderOrganization: "org-test",
  aiProviderProfiles: "",
  visualQaEnabled: false,
  autoFixLiveRuntimeErrors: false,
  researchEnabled: false, researchAgentCommand: "", researchModel: "",  visualQaAgentCommand: "",
  visualQaModel: "",
  autoImproveEnabled: true,
  autoImproveMaxRounds: 8,
};

test("buildAgentEnv maps BYOK settings for Anthropic-compatible CLIs", () => {
  assert.deepEqual(buildAgentEnv(SETTINGS, "claude"), {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://api.example.test",
  });
  assert.deepEqual(buildAgentEnv(SETTINGS, "C:\\Tools\\codebuddy.cmd"), {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://api.example.test",
  });
});

test("buildAgentEnv maps BYOK settings for Codex and Gemini CLIs", () => {
  assert.deepEqual(buildAgentEnv(SETTINGS, "codex"), {
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://api.example.test",
    OPENAI_ORG_ID: "org-test",
  });
  assert.deepEqual(buildAgentEnv(SETTINGS, "gemini"), {
    GEMINI_API_KEY: "sk-test",
    GOOGLE_API_KEY: "sk-test",
  });
});

test("buildAgentEnv does not guess env names for unknown CLIs", () => {
  assert.deepEqual(buildAgentEnv(SETTINGS, "custom-agent"), {});
});
