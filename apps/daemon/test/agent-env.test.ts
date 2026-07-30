import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSpawnEnv } from "../../../packages/agent/src/providers/cli.ts";
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

const CLAUDE_SESSION_ENV = {
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
};

const GEMINI_SESSION_ENV = {
  GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
};

test("buildAgentEnv maps BYOK settings only for Claude", () => {
  assert.deepEqual(buildAgentEnv(SETTINGS, "claude"), {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://api.example.test",
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  });
});

test("buildAgentEnv preserves legacy unclaimed BYOK snapshots without a named-provider field", () => {
  const legacySettings = {
    ...SETTINGS,
    aiProviderId: undefined,
  } as unknown as Settings;

  assert.deepEqual(buildAgentEnv(legacySettings, "claude"), {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://api.example.test",
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  });
});

test("explicit Claude credentials tombstone ambient auth while session auth remains available", () => {
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  process.env.ANTHROPIC_API_KEY = "ambient-api-key";
  process.env.ANTHROPIC_BASE_URL = "https://ambient-anthropic.example.test";
  process.env.ANTHROPIC_AUTH_TOKEN = "ambient-auth-token";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-oauth-token";

  try {
    const explicit = agentSpawnEnv(buildAgentEnv({
      ...SETTINGS,
      agentCommand: "codex",
      aiProviderId: "anthropic",
      aiProviderEnabled: true,
    }, "claude"));
    assert.equal(explicit.ANTHROPIC_API_KEY, "sk-test");
    assert.equal(explicit.ANTHROPIC_BASE_URL, "https://api.example.test");
    assert.equal(explicit.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(explicit.CLAUDE_CODE_OAUTH_TOKEN, undefined);

    const session = agentSpawnEnv(buildAgentEnv({
      ...SETTINGS,
      agentCommand: "codex",
      apiBaseUrl: "",
      apiKey: "",
      apiKeyConfigured: false,
    }, "claude"));
    assert.equal(session.ANTHROPIC_API_KEY, undefined);
    assert.equal(session.ANTHROPIC_BASE_URL, undefined);
    assert.equal(session.ANTHROPIC_AUTH_TOKEN, "ambient-auth-token");
    assert.equal(session.CLAUDE_CODE_OAUTH_TOKEN, "ambient-oauth-token");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("buildAgentEnv keeps Codex on host login instead of borrowing project provider credentials", () => {
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
  assert.deepEqual(buildAgentEnv({
    ...SETTINGS,
    agentCommand: "gemini",
  }, "gemini"), {
    GEMINI_API_KEY: "sk-test",
    GOOGLE_API_KEY: "sk-test",
  });
});

test("buildAgentEnv never relabels an active Azure OpenAI credential for another CLI", () => {
  const azureSettings: Settings = {
    ...SETTINGS,
    agentCommand: "codex",
    aiProviderId: "azure-openai",
    aiProviderEnabled: true,
    apiBaseUrl: "https://azure-openai.example.test",
    apiKey: "azure-openai-key",
    imageApiBaseUrl: "https://azure-openai.example.test",
    imageApiKey: "azure-openai-key",
  };

  assert.deepEqual(buildAgentEnv(azureSettings, "claude"), CLAUDE_SESSION_ENV);
  assert.deepEqual(buildAgentEnv(azureSettings, "gemini"), GEMINI_SESSION_ENV);
});

test("buildAgentEnv uses only an enabled exact provider profile for a different CLI", () => {
  const profiledSettings: Settings = {
    ...SETTINGS,
    agentCommand: "codex",
    aiProviderId: "azure-openai",
    aiProviderEnabled: true,
    apiBaseUrl: "https://azure-openai.example.test",
    apiKey: "azure-openai-key",
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: true,
        baseUrl: "https://anthropic.example.test",
        apiKey: "anthropic-key",
        models: "claude-sonnet-4-6",
        organization: "",
      },
      gemini: {
        enabled: true,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-key",
        models: "gemini-2.5-pro",
        organization: "",
      },
    }),
  };

  assert.deepEqual(buildAgentEnv(profiledSettings, "claude"), {
    ANTHROPIC_API_KEY: "anthropic-key",
    ANTHROPIC_BASE_URL: "https://anthropic.example.test",
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  });
  assert.deepEqual(buildAgentEnv(profiledSettings, "gemini"), {
    GEMINI_API_KEY: "gemini-key",
    GOOGLE_API_KEY: "gemini-key",
  });
});

test("buildAgentEnv never falls back through a disabled exact provider profile", () => {
  const profiledSettings: Settings = {
    ...SETTINGS,
    aiProviderProfiles: JSON.stringify({
      anthropic: {
        enabled: false,
        baseUrl: "https://anthropic.example.test",
        apiKey: "disabled-anthropic-key",
        models: "claude-sonnet-4-6",
        organization: "",
      },
      gemini: {
        enabled: false,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "disabled-gemini-key",
        models: "gemini-2.5-pro",
        organization: "",
      },
    }),
  };

  assert.deepEqual(buildAgentEnv(profiledSettings, "claude"), CLAUDE_SESSION_ENV);
  assert.deepEqual(buildAgentEnv(profiledSettings, "gemini"), GEMINI_SESSION_ENV);
});

test("buildAgentEnv never relabels a generic key across a named or malformed profile envelope", () => {
  for (const aiProviderProfiles of [
    JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://api.openai.example.test/v1",
        apiKey: "openai-profile-key",
        models: "gpt-5",
        organization: "",
      },
    }),
    "{}",
    "{malformed",
  ]) {
    const settings = {
      ...SETTINGS,
      apiBaseUrl: "https://api.openai.example.test/v1",
      apiKey: "generic-external-key",
      aiProviderProfiles,
    };
    assert.deepEqual(buildAgentEnv(settings, "claude"), CLAUDE_SESSION_ENV);
    assert.deepEqual(buildAgentEnv({
      ...settings,
      agentCommand: "gemini",
    }, "gemini"), GEMINI_SESSION_ENV);
  }
});

test("buildAgentEnv treats a selected disabled provider as an explicit credential namespace", () => {
  const settings: Settings = {
    ...SETTINGS,
    aiProviderId: "openai",
    aiProviderEnabled: false,
  };
  assert.deepEqual(buildAgentEnv(settings, "claude"), CLAUDE_SESSION_ENV);
});

test("hydrateVisualReviewerSettings keeps Codex on host login without borrowing project credentials", () => {
  const frozen = {
    ...SETTINGS,
    agentCommand: "codex",
    model: "gpt-5.4-mini",
    apiKey: "must-not-reach-reviewer",
    visualQaAgentCommand: "codex",
    visualQaModel: "gpt-5.4-mini",
  };
  const quality = hydrateVisualReviewerSettings(frozen, {
    ...frozen,
    apiKey: "rotated-project-key-must-not-reach-reviewer",
  }, {
    command: "codex",
    model: "gpt-5.4-mini",
  });

  assert.equal(quality.visualQaAgentCommand, "codex");
  assert.equal(quality.visualQaModel, "gpt-5.4-mini");
  assert.equal(quality.apiKey, "");
  assert.deepEqual(buildVisualReviewerEnv(quality, "codex"), {});
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
  }), CLAUDE_SESSION_ENV);
});

test("buildVisualReviewerEnv forwards the exact credential pair for a Claude project", () => {
  assert.deepEqual(buildVisualReviewerEnv(SETTINGS), {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://api.example.test",
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
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
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
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
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
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
  assert.throws(
    () => buildVisualReviewerEnv(foreign),
    /credential for the frozen Claude visual reviewer is unavailable/i,
  );
});

test("hydrateVisualReviewerSettings never stages an external provider key in Claude quality settings", () => {
  const frozen: Settings = {
    ...SETTINGS,
    aiProviderId: "azure-openai",
    aiProviderEnabled: true,
    apiBaseUrl: "https://azure-openai.example.test",
    apiKey: "",
    apiKeyConfigured: true,
    visualQaAgentCommand: "claude",
    visualQaModel: "claude-sonnet-4-6",
  };
  const quality = hydrateVisualReviewerSettings(frozen, {
    ...frozen,
    apiKey: "external-provider-key",
  }, {
    command: "claude",
    model: "claude-sonnet-4-6",
  });

  assert.equal(quality.apiKey, "");
  assert.deepEqual(buildVisualReviewerEnv(quality), CLAUDE_SESSION_ENV);
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
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
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
    aiProviderOrganization: "",
  }), CLAUDE_SESSION_ENV);
});
