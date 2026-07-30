import assert from "node:assert/strict";
import test from "node:test";
import type { Settings } from "../../../packages/core/src/index.ts";
import {
  hydrateWorkspaceMoodboardImageAuthority,
  workspaceMoodboardImageAuthority,
} from "../src/orchestration/moodboard-image-execution-authority.ts";

function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    agentCommand: "claude",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    defaultDesignSystemId: "",
    customInstructions: "",
    imageApiBaseUrl: "https://images.example.test/v1",
    imageApiKey: "global-image-secret",
    imageModel: "image-model-1",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai-compatible",
    aiProviderEnabled: true,
    aiProviderModels: "",
    aiProviderOrganization: "2026-07-30",
    aiProviderProfiles: "",
    visualQaEnabled: true,
    autoFixLiveRuntimeErrors: true,
    sharinganAffirmed: true,
    visualQaAgentCommand: "claude",
    visualQaModel: "",
    researchEnabled: true,
    researchAgentCommand: "codex",
    researchModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 1,
    ...overrides,
  };
}

test("workspaceMoodboardImageAuthority freezes the selected global image route without its secret", () => {
  const settings = settingsFixture();

  const authority = workspaceMoodboardImageAuthority(settings);

  assert.deepEqual(authority, {
    kind: "moodboard-image",
    protocol: "dezin.workspace-moodboard-image-authority.v1",
    providerId: "openai-compatible",
    baseUrl: "https://images.example.test/v1",
    model: "image-model-1",
    apiVersion: "2026-07-30",
    credentialSource: "global-image",
    credentialRequired: true,
  });
  assert.equal(JSON.stringify(authority).includes("global-image-secret"), false);
});

test("provider-profile credential deterministically wins over the global image credential", () => {
  const settings = settingsFixture({
    aiProviderProfiles: JSON.stringify({
      "openai-compatible": {
        enabled: true,
        baseUrl: "https://profile-images.example.test/v1",
        apiKey: "profile-secret",
        models: "",
        organization: "profile-version",
      },
    }),
  });

  const authority = workspaceMoodboardImageAuthority(settings);

  assert.equal(authority.credentialSource, "provider-profile");
  assert.equal(authority.baseUrl, "https://profile-images.example.test/v1");
  assert.equal(authority.apiVersion, "profile-version");
  assert.equal(JSON.stringify(authority).includes("profile-secret"), false);
});

test("authority capture materializes every provider default into explicit immutable runtime semantics", () => {
  const cases = [
    {
      providerId: "azure-openai",
      baseUrl: "https://example-resource.openai.azure.com/",
      expectedBaseUrl: "https://example-resource.openai.azure.com/openai",
      expectedApiVersion: "2025-04-01-preview",
    },
    {
      providerId: "gemini",
      baseUrl: "",
      expectedBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      expectedApiVersion: "",
    },
    {
      providerId: "fal",
      baseUrl: "",
      expectedBaseUrl: "https://fal.run",
      expectedApiVersion: "",
    },
    {
      providerId: "vertex",
      baseUrl: "",
      expectedBaseUrl: "https://aiplatform.googleapis.com/v1/publishers/google",
      expectedApiVersion: "",
    },
  ] as const;

  for (const item of cases) {
    const authority = workspaceMoodboardImageAuthority(settingsFixture({
      aiProviderId: item.providerId,
      imageApiBaseUrl: item.baseUrl,
      aiProviderOrganization: "",
    }));
    assert.equal(authority.baseUrl, item.expectedBaseUrl, item.providerId);
    assert.equal(authority.apiVersion, item.expectedApiVersion, item.providerId);
    assert.ok(authority.baseUrl.length > 0, `${item.providerId} endpoint must be explicit`);
  }
});

test("materialized defaults compare by effective semantics and reject later endpoint drift", () => {
  const implicit = settingsFixture({
    aiProviderId: "gemini",
    imageApiBaseUrl: "",
    aiProviderOrganization: "",
  });
  const frozen = workspaceMoodboardImageAuthority(implicit);

  assert.doesNotThrow(() => hydrateWorkspaceMoodboardImageAuthority(
    settingsFixture({
      aiProviderId: "gemini",
      imageApiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      aiProviderOrganization: "",
    }),
    frozen,
  ));
  assert.throws(
    () => hydrateWorkspaceMoodboardImageAuthority(
      settingsFixture({
        aiProviderId: "gemini",
        imageApiBaseUrl: "https://generativelanguage.googleapis.com/v1",
        aiProviderOrganization: "",
      }),
      frozen,
    ),
    /do not match the frozen Moodboard image provider/,
  );
});

test("authority capture rejects missing credentials and non-canonical credential-bearing URLs", () => {
  assert.throws(
    () => workspaceMoodboardImageAuthority(settingsFixture({ imageApiKey: "" })),
    /requires a configured credential/,
  );
  assert.throws(
    () => workspaceMoodboardImageAuthority(settingsFixture({
      imageApiBaseUrl: "https://user:password@images.example.test/v1?token=secret",
    })),
    /canonical and credential-free/,
  );
});

test("authority capture honors redacted configured flags while hydration still requires the exact secret", () => {
  const profileConfigured = settingsFixture({
    imageApiKey: "",
    aiProviderProfiles: JSON.stringify({
      "openai-compatible": {
        enabled: true,
        baseUrl: "https://profile-images.example.test/v1",
        apiKey: "",
        apiKeyConfigured: true,
        models: "",
        organization: "",
      },
    }),
  });
  const profileAuthority = workspaceMoodboardImageAuthority(profileConfigured);
  assert.equal(profileAuthority.credentialSource, "provider-profile");
  assert.throws(
    () => hydrateWorkspaceMoodboardImageAuthority(profileConfigured, profileAuthority),
    /credential.*unavailable/,
  );

  const globalConfigured = settingsFixture({
    imageApiKey: "",
    imageApiKeyConfigured: true,
  });
  const globalAuthority = workspaceMoodboardImageAuthority(globalConfigured);
  assert.equal(globalAuthority.credentialSource, "global-image");
  assert.throws(
    () => hydrateWorkspaceMoodboardImageAuthority(globalConfigured, globalAuthority),
    /credential.*unavailable/,
  );
});

test("hydration allows secret rotation only inside the frozen credential source", () => {
  const profileSettings = settingsFixture({
    aiProviderProfiles: JSON.stringify({
      "openai-compatible": {
        enabled: true,
        baseUrl: "https://profile-images.example.test/v1",
        apiKey: "profile-secret-a",
        models: "",
        organization: "",
      },
    }),
  });
  const authority = workspaceMoodboardImageAuthority(profileSettings);
  const rotated = settingsFixture({
    imageApiKey: "global-secret-must-not-be-used",
    aiProviderProfiles: JSON.stringify({
      "openai-compatible": {
        enabled: true,
        baseUrl: "https://profile-images.example.test/v1",
        apiKey: "profile-secret-b",
        models: "",
        organization: "",
      },
    }),
  });

  const hydrated = hydrateWorkspaceMoodboardImageAuthority(rotated, authority);

  assert.equal(hydrated.apiKey, "profile-secret-b");
  assert.throws(
    () => hydrateWorkspaceMoodboardImageAuthority(
      settingsFixture({
        imageApiKey: "global-secret",
        aiProviderProfiles: JSON.stringify({
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://profile-images.example.test/v1",
            apiKey: "",
            models: "",
            organization: "",
          },
        }),
      }),
      authority,
    ),
    /do not match the frozen Moodboard image provider/,
  );
});
