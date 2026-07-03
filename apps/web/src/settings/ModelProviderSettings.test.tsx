import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Settings } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { ModelProviderSettings } from "./ModelProviderSettings.tsx";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    agentCommand: "codex",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    apiKeyConfigured: false,
    defaultDesignSystemId: "clean",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageApiKeyConfigured: false,
    imageModel: "gpt-image-1",
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoApiKeyConfigured: false,
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: true,
    aiProviderModels: "gpt-image-1",
    aiProviderOrganization: "",
    aiProviderProfiles: JSON.stringify({
      openai: {
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        apiKeyConfigured: true,
        models: "gpt-image-1",
        organization: "",
      },
      gemini: {
        enabled: false,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyConfigured: false,
        models: JSON.stringify({ id: "gemini-2.5-flash-image", capabilities: ["Image"] }),
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

test("ModelProviderSettings reads API key state from each provider profile instead of global settings", () => {
  render(
    <ApiProvider client={makeFakeApi()}>
      <ModelProviderSettings settings={settings()} onLocalPatch={vi.fn()} onSavePatch={vi.fn()} />
    </ApiProvider>,
  );

  expect(screen.getByLabelText("API Key")).toHaveValue("configured");

  fireEvent.click(screen.getByLabelText("Gemini disabled").closest("button")!);

  expect(screen.getByLabelText("API Key")).toHaveValue("");
});
