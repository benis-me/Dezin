import { test } from "node:test";
import assert from "node:assert/strict";
import type { Settings } from "../../../packages/core/src/index.ts";
import {
  buildAgentEnv,
  buildVisualReviewerEnv,
  hydrateVisualReviewerSettings,
} from "../src/agent-env.ts";
import { parseProviderProfiles } from "../src/provider-profile-config.ts";

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
  sharinganAffirmed: false,
  researchEnabled: false, researchAgentCommand: "", researchModel: "",  visualQaAgentCommand: "",
  visualQaModel: "",
  autoImproveEnabled: true,
  autoImproveMaxRounds: 8,
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

test("buildAgentEnv includes the daemon token so the agent can call gated endpoints", () => {
  const env = buildAgentEnv(SETTINGS, "claude", "tok-123");
  assert.equal(env.DEZIN_DAEMON_TOKEN, "tok-123");
});

test("buildAgentEnv omits the daemon token when none is supplied", () => {
  const env = buildAgentEnv(SETTINGS, "claude");
  assert.equal(env.DEZIN_DAEMON_TOKEN, undefined);
});

test("buildVisualReviewerEnv never relabels a non-Anthropic project key as a Claude credential", () => {
  assert.deepEqual(buildVisualReviewerEnv({
    ...SETTINGS,
    agentCommand: "codex",
    visualQaAgentCommand: "claude",
    apiKey: "openai-project-key",
    apiBaseUrl: "https://api.openai.example.test",
  }), {});
});

test("buildVisualReviewerEnv forwards the exact credential pair for a Claude project", () => {
  assert.deepEqual(buildVisualReviewerEnv(SETTINGS), {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://api.example.test",
  });
});

test("buildVisualReviewerEnv uses an enabled explicit Anthropic profile for a non-Claude project", () => {
  assert.deepEqual(buildVisualReviewerEnv({
    ...SETTINGS,
    agentCommand: "codex",
    apiKey: "openai-project-key",
    apiBaseUrl: "https://api.openai.example.test",
    aiProviderId: "openai",
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://anthropic-gateway.example.test",
        apiKey: "anthropic-review-key",
        models: "claude-sonnet-4-6",
        organization: "",
      },
    }),
  }), {
    ANTHROPIC_API_KEY: "anthropic-review-key",
    ANTHROPIC_BASE_URL: "https://anthropic-gateway.example.test",
  });
});

test("hydrateVisualReviewerSettings injects only the exact live Anthropic key into frozen reviewer semantics", () => {
  const frozen = {
    ...SETTINGS,
    agentCommand: "codex",
    apiBaseUrl: "https://api.openai.example.test",
    apiKey: "",
    visualQaAgentCommand: "codex",
    visualQaModel: "gpt-5",
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://frozen-anthropic.example.test",
        apiKey: "",
        apiKeyConfigured: true,
        models: "claude-sonnet-4-6",
        organization: "",
      },
      foreign: {
        enabled: true,
        baseUrl: "https://foreign.example.test",
        apiKey: "",
        apiKeyConfigured: true,
        models: "foreign-model",
        organization: "",
      },
    }),
  };
  const live = {
    ...frozen,
    apiKey: "openai-builder-key",
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://frozen-anthropic.example.test",
        apiKey: "anthropic-review-key",
        models: "mutated-live-model",
        organization: "mutated-live-organization",
      },
      foreign: {
        enabled: true,
        baseUrl: "https://foreign.example.test",
        apiKey: "foreign-key",
        models: "foreign-model",
        organization: "",
      },
    }),
  };

  const quality = hydrateVisualReviewerSettings(frozen, live, {
    command: "claude",
    model: "claude-sonnet-4-6",
  });
  const profiles = parseProviderProfiles(quality.aiProviderProfiles);

  assert.equal(quality.visualQaAgentCommand, "claude");
  assert.equal(quality.visualQaModel, "claude-sonnet-4-6");
  assert.equal(quality.apiKey, "");
  assert.equal(profiles.anthropic?.baseUrl, "https://frozen-anthropic.example.test");
  assert.equal(profiles.anthropic?.models, "claude-sonnet-4-6");
  assert.equal(profiles.anthropic?.organization, "");
  assert.equal(profiles.anthropic?.apiKey, "anthropic-review-key");
  assert.equal(profiles.foreign?.apiKey, "");
});

test("hydrateVisualReviewerSettings rejects endpoint drift instead of borrowing a different Anthropic credential", () => {
  const frozen = {
    ...SETTINGS,
    agentCommand: "codex",
    apiKey: "",
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://frozen-anthropic.example.test",
        apiKey: "",
        apiKeyConfigured: true,
        models: "claude-sonnet-4-6",
        organization: "",
      },
    }),
  };
  const live = {
    ...frozen,
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://mutated-anthropic.example.test",
        apiKey: "wrong-endpoint-key",
        models: "mutated-model",
        organization: "",
      },
    }),
  };

  const quality = hydrateVisualReviewerSettings(frozen, live, {
    command: "claude",
    model: "claude-sonnet-4-6",
  });

  assert.equal(parseProviderProfiles(quality.aiProviderProfiles).anthropic?.apiKey, "");
  assert.throws(
    () => buildVisualReviewerEnv(quality),
    /credential for the frozen Anthropic visual reviewer is unavailable/i,
  );
});

test("hydrateVisualReviewerSettings binds a generic key only while the project Agent remains exact Claude", () => {
  const frozen = {
    ...SETTINGS,
    apiKey: "",
    apiKeyConfigured: true,
    visualQaAgentCommand: "claude",
    visualQaModel: "claude-sonnet-4-6",
  };
  const sameLiveClaude = {
    ...frozen,
    apiKey: "exact-claude-key",
  };
  const exact = hydrateVisualReviewerSettings(frozen, sameLiveClaude, {
    command: "claude",
    model: "claude-sonnet-4-6",
  });
  assert.deepEqual(buildVisualReviewerEnv(exact), {
    ANTHROPIC_API_KEY: "exact-claude-key",
    ANTHROPIC_BASE_URL: "https://api.example.test",
  });

  const drifted = hydrateVisualReviewerSettings(frozen, {
    ...sameLiveClaude,
    apiBaseUrl: "https://mutated.example.test",
  }, {
    command: "claude",
    model: "claude-sonnet-4-6",
  });
  assert.equal(drifted.apiKey, "");
  assert.throws(
    () => buildVisualReviewerEnv(drifted),
    /credential for the frozen Claude visual reviewer is unavailable/i,
  );

  const foreign = hydrateVisualReviewerSettings({
    ...frozen,
    apiKeyConfigured: undefined,
  }, {
    ...sameLiveClaude,
    agentCommand: "codex",
    apiKey: "openai-key",
  }, {
    command: "claude",
    model: "claude-sonnet-4-6",
  });
  assert.equal(foreign.apiKey, "");
  assert.deepEqual(buildVisualReviewerEnv(foreign), {
    ANTHROPIC_BASE_URL: "https://api.example.test",
  });
});

test("hydrateVisualReviewerSettings supports an exact selected global Anthropic provider without a profile", () => {
  const frozen = {
    ...SETTINGS,
    agentCommand: "codex",
    apiKey: "",
    apiBaseUrl: "https://frozen-anthropic.example.test",
    aiProviderId: "anthropic",
    aiProviderEnabled: true,
    aiProviderProfiles: "",
  };
  const quality = hydrateVisualReviewerSettings(frozen, {
    ...frozen,
    imageApiKey: "selected-anthropic-key",
  }, {
    command: "claude",
    model: null,
  });

  assert.equal(quality.imageApiKey, "");
  assert.equal(quality.apiKey, "selected-anthropic-key");
  assert.deepEqual(buildVisualReviewerEnv(quality), {
    ANTHROPIC_API_KEY: "selected-anthropic-key",
    ANTHROPIC_BASE_URL: "https://frozen-anthropic.example.test",
  });

  const drifted = hydrateVisualReviewerSettings({
    ...frozen,
    apiKeyConfigured: true,
  }, {
    ...frozen,
    apiBaseUrl: "https://mutated-anthropic.example.test",
    imageApiKey: "wrong-endpoint-key",
  }, {
    command: "claude",
    model: null,
  });
  assert.equal(drifted.apiKey, "");
  assert.throws(
    () => buildVisualReviewerEnv(drifted),
    /credential for the frozen Anthropic visual reviewer is unavailable/i,
  );
});

test("buildVisualReviewerEnv preserves local Claude authentication when no BYOK credential was frozen", () => {
  assert.deepEqual(buildVisualReviewerEnv({
    ...SETTINGS,
    apiBaseUrl: "",
    apiKey: "",
    apiKeyConfigured: false,
  }), {});
});
