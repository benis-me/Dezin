import { expect, test } from "vitest";
import type { Settings } from "../lib/api.ts";
import { MODEL_PROVIDERS } from "./model-provider-registry.ts";
import { parseProviderProfiles, patchSelectedProviderProfile, setProviderEnabledPatch } from "./provider-profiles.ts";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    agentCommand: "codex",
    model: "",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "openai-global",
    apiKeyConfigured: true,
    defaultDesignSystemId: "clean",
    customInstructions: "",
    imageApiBaseUrl: "https://api.openai.com/v1",
    imageApiKey: "openai-global",
    imageApiKeyConfigured: true,
    imageModel: "gpt-image-1",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: true,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-profile",
        models: "gpt-image-1",
        organization: "",
      },
    }),
    visualQaEnabled: false,
    visualQaAgentCommand: "",
    visualQaModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 8,
    ...overrides,
  };
}

test("patchSelectedProviderProfile saves API keys on the edited provider profile without changing active globals", () => {
  const gemini = MODEL_PROVIDERS.find((provider) => provider.id === "gemini")!;
  const patch = patchSelectedProviderProfile(settings(), gemini, {
    apiKey: "gemini-key",
    apiKeyConfigured: true,
  });
  const profiles = parseProviderProfiles(patch.aiProviderProfiles);

  expect(profiles.gemini?.apiKey).toBe("gemini-key");
  expect(profiles.gemini?.apiKeyConfigured).toBe(true);
  expect(patch.apiKey).toBeUndefined();
  expect(patch.imageApiKey).toBeUndefined();
  expect(patch.videoApiKey).toBeUndefined();
});

test("setProviderEnabledPatch syncs the selected provider profile key to the runtime image settings", () => {
  const gemini = MODEL_PROVIDERS.find((provider) => provider.id === "gemini")!;
  const patch = setProviderEnabledPatch(
    settings({
      aiProviderProfiles: JSON.stringify({
        openai: {
          enabled: true,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "openai-profile",
          models: "gpt-image-1",
          organization: "",
        },
        gemini: {
          enabled: false,
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-key",
          models: JSON.stringify({ id: "gemini-2.5-flash-image", capabilities: ["Image"] }),
          organization: "",
        },
      }),
    }),
    MODEL_PROVIDERS,
    gemini,
    true,
  );

  expect(patch.aiProviderId).toBe("gemini");
  expect(patch.apiKey).toBe("gemini-key");
  expect(patch.imageApiKey).toBe("gemini-key");
  expect(patch.imageApiBaseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  expect(patch.imageModel).toBe("gemini-2.5-flash-image");
});

test("patchSelectedProviderProfile preserves a redacted configured API key when editing other fields", () => {
  const gemini = MODEL_PROVIDERS.find((provider) => provider.id === "gemini")!;
  const patch = patchSelectedProviderProfile(
    settings({
      aiProviderId: "gemini",
      aiProviderProfiles: JSON.stringify({
        gemini: {
          enabled: true,
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "",
          apiKeyConfigured: true,
          models: "gemini-2.5-flash-image",
          organization: "",
        },
      }),
    }),
    gemini,
    {
      aiProviderModels: JSON.stringify({ id: "gemini-2.5-flash-image", capabilities: ["Image"] }),
    },
  );
  const profiles = parseProviderProfiles(patch.aiProviderProfiles);

  expect(profiles.gemini?.apiKey).toBe("");
  expect(profiles.gemini?.apiKeyConfigured).toBe(true);
});
