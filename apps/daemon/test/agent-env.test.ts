import assert from "node:assert/strict";
import { test } from "node:test";

import type { Settings } from "@dezin/core";
import { buildAgentEnv } from "../src/agent-env.ts";

const SETTINGS: Settings = {
  agentCommand: "claude",
  model: "",
  apiBaseUrl: "https://api.example.test",
  apiKey: "sk-test",
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
  sharinganAffirmed: false,
};

test("buildAgentEnv maps BYOK settings only for Claude", () => {
  assert.deepEqual(buildAgentEnv(SETTINGS, "claude"), {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://api.example.test",
  });
});

test("buildAgentEnv tombstones every provider credential for host-authenticated CodeBuddy", () => {
  const env = buildAgentEnv(SETTINGS, "C:\\Tools\\codebuddy.cmd", "daemon-token");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEBUDDY_API_KEY",
    "CODEBUDDY_AUTH_TOKEN",
    "CODEBUDDY_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
  ]) {
    assert.equal(Object.hasOwn(env, key), true, key);
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.DEZIN_DAEMON_TOKEN, "daemon-token");
});

test("buildAgentEnv keeps Codex on host login instead of borrowing provider credentials", () => {
  const env = buildAgentEnv(SETTINGS, "codex");
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
  ]) {
    assert.equal(Object.hasOwn(env, key), true, key);
    assert.equal(env[key], undefined, key);
  }
});

test("buildAgentEnv maps BYOK settings for the Gemini CLI", () => {
  assert.deepEqual(buildAgentEnv(SETTINGS, "gemini"), {
    GEMINI_API_KEY: "sk-test",
    GOOGLE_API_KEY: "sk-test",
  });
});

test("buildAgentEnv does not guess env names for unknown CLIs", () => {
  assert.deepEqual(buildAgentEnv(SETTINGS, "custom-agent"), {});
});

test("buildAgentEnv includes the daemon token only when supplied", () => {
  assert.equal(buildAgentEnv(SETTINGS, "claude", "tok-123").DEZIN_DAEMON_TOKEN, "tok-123");
  assert.equal(buildAgentEnv(SETTINGS, "claude").DEZIN_DAEMON_TOKEN, undefined);
});
