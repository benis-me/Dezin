import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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
    autoFixLiveRuntimeErrors: false,
    sharinganAffirmed: false,
    researchEnabled: false, researchAgentCommand: "", researchModel: "",    visualQaAgentCommand: "",
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

/**
 * Local harness that mirrors how SettingsScreen wires ModelProviderSettings:
 * onLocalPatch merges into local state (no network), onSavePatch is the PUT.
 */
function ProviderSettingsHarness({ onSavePatch, initial }: { onSavePatch: (patch: Partial<Settings>) => void; initial?: Partial<Settings> }) {
  const [current, setCurrent] = useState(settings(initial));
  return (
    <ApiProvider client={makeFakeApi()}>
      <ModelProviderSettings
        settings={current}
        onLocalPatch={(patch) => setCurrent((s) => ({ ...s, ...patch }))}
        onSavePatch={onSavePatch}
      />
    </ApiProvider>
  );
}

test("Base URL field saves on blur, not on every keystroke", () => {
  const onSavePatch = vi.fn();
  render(<ProviderSettingsHarness onSavePatch={onSavePatch} />);

  const baseUrlInput = screen.getByLabelText("Base URL");
  fireEvent.change(baseUrlInput, { target: { value: "h" } });
  fireEvent.change(baseUrlInput, { target: { value: "ht" } });
  fireEvent.change(baseUrlInput, { target: { value: "htt" } });
  fireEvent.change(baseUrlInput, { target: { value: "https://example.com/v1" } });

  expect(onSavePatch).not.toHaveBeenCalled();
  expect(baseUrlInput).toHaveValue("https://example.com/v1");

  fireEvent.blur(baseUrlInput);

  expect(onSavePatch).toHaveBeenCalledTimes(1);
  expect(onSavePatch.mock.calls[0][0]).toMatchObject({ apiBaseUrl: "https://example.com/v1" });
});

test("API key field saves on blur, not on every keystroke, and marks it configured", () => {
  const onSavePatch = vi.fn();
  render(<ProviderSettingsHarness onSavePatch={onSavePatch} />);

  const apiKeyInput = screen.getByLabelText("API Key");
  fireEvent.focus(apiKeyInput);
  fireEvent.change(apiKeyInput, { target: { value: "s" } });
  fireEvent.change(apiKeyInput, { target: { value: "sk" } });
  fireEvent.change(apiKeyInput, { target: { value: "sk-test-123" } });

  expect(onSavePatch).not.toHaveBeenCalled();

  fireEvent.blur(apiKeyInput);

  expect(onSavePatch).toHaveBeenCalledTimes(1);
  expect(onSavePatch.mock.calls[0][0]).toMatchObject({ apiKey: "sk-test-123", apiKeyConfigured: true });
});
