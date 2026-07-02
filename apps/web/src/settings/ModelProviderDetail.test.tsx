import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Settings } from "../lib/api.ts";
import { MODEL_PROVIDERS } from "./model-provider-registry.ts";
import { ModelProviderDetail } from "./ModelProviderDetail.tsx";
import { serializeModelEntries } from "./model-provider-ui-utils.tsx";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    agentCommand: "codex",
    model: "",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "",
    defaultDesignSystemId: "clean",
    customInstructions: "",
    imageApiBaseUrl: "https://api.openai.com/v1",
    imageApiKey: "",
    imageModel: "",
    videoApiBaseUrl: "https://api.openai.com/v1",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: serializeModelEntries(MODEL_PROVIDERS[0]!.models),
    aiProviderOrganization: "",
    aiProviderProfiles: "",
    visualQaEnabled: false,
    ...overrides,
  };
}

test("ModelProviderDetail autosaves connection edits without a Save configuration button", () => {
  const onPatchModelSettings = vi.fn();
  const selected = MODEL_PROVIDERS[0]!;
  render(
    <ModelProviderDetail
      selected={selected}
      settings={settings()}
      apiKey=""
      baseUrl={selected.baseUrl}
      modelText={serializeModelEntries(selected.models)}
      status={null}
      onToggleEnabled={() => {}}
      onPatchModelSettings={onPatchModelSettings}
      onTestConnection={() => {}}
      onLoadPresetModels={() => {}}
    />,
  );

  expect(screen.queryByRole("button", { name: "Save configuration" })).toBeNull();

  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
  expect(onPatchModelSettings).toHaveBeenLastCalledWith(
    {
      apiKey: "sk-test",
      apiKeyConfigured: true,
      imageApiKey: "sk-test",
      imageApiKeyConfigured: true,
      videoApiKey: "sk-test",
      videoApiKeyConfigured: true,
    },
    true,
  );
});

test("ModelProviderDetail masks a configured API key, clears on focus, and restores when unchanged", () => {
  const onPatchModelSettings = vi.fn();
  const selected = MODEL_PROVIDERS[0]!;
  render(
    <ModelProviderDetail
      selected={selected}
      settings={settings({ apiKeyConfigured: true, imageApiKeyConfigured: true, videoApiKeyConfigured: true })}
      apiKey=""
      baseUrl={selected.baseUrl}
      modelText={serializeModelEntries(selected.models)}
      status={null}
      onToggleEnabled={() => {}}
      onPatchModelSettings={onPatchModelSettings}
      onTestConnection={() => {}}
      onLoadPresetModels={() => {}}
    />,
  );

  const apiKey = screen.getByLabelText("API Key");
  expect(apiKey).toHaveValue("configured");

  fireEvent.focus(apiKey);
  expect(apiKey).toHaveValue("");

  fireEvent.blur(apiKey);
  expect(apiKey).toHaveValue("configured");
  expect(onPatchModelSettings).not.toHaveBeenCalled();
});

test("ModelProviderDetail saves a replacement API key after clearing the configured mask", () => {
  const onPatchModelSettings = vi.fn();
  const selected = MODEL_PROVIDERS[0]!;
  render(
    <ModelProviderDetail
      selected={selected}
      settings={settings({ apiKeyConfigured: true, imageApiKeyConfigured: true, videoApiKeyConfigured: true })}
      apiKey=""
      baseUrl={selected.baseUrl}
      modelText={serializeModelEntries(selected.models)}
      status={null}
      onToggleEnabled={() => {}}
      onPatchModelSettings={onPatchModelSettings}
      onTestConnection={() => {}}
      onLoadPresetModels={() => {}}
    />,
  );

  const apiKey = screen.getByLabelText("API Key");
  fireEvent.focus(apiKey);
  fireEvent.change(apiKey, { target: { value: "sk-replacement" } });

  expect(onPatchModelSettings).toHaveBeenLastCalledWith(
    {
      apiKey: "sk-replacement",
      apiKeyConfigured: true,
      imageApiKey: "sk-replacement",
      imageApiKeyConfigured: true,
      videoApiKey: "sk-replacement",
      videoApiKeyConfigured: true,
    },
    true,
  );
});
