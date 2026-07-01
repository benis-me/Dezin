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
  expect(onPatchModelSettings).toHaveBeenLastCalledWith({ apiKey: "sk-test", imageApiKey: "sk-test", videoApiKey: "sk-test" }, true);
});
