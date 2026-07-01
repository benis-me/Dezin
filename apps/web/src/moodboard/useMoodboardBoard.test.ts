import { expect, test } from "vitest";
import type { Settings } from "../lib/api.ts";
import { imageModelOptions } from "./useMoodboardBoard.ts";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    agentCommand: "codex",
    model: "",
    apiBaseUrl: "",
    apiKey: "",
    defaultDesignSystemId: "clean",
    customInstructions: "",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "",
    aiProviderOrganization: "",
    visualQaEnabled: false,
    ...overrides,
  };
}

test("imageModelOptions hides provider preset image models until the provider is enabled", () => {
  expect(imageModelOptions(settings())).toEqual([]);
});

test("imageModelOptions exposes image models from the enabled provider", () => {
  expect(imageModelOptions(settings({ aiProviderEnabled: true }))).toEqual(["gpt-image-1", "gpt-image-2"]);
});

test("imageModelOptions still honors an explicitly configured legacy image endpoint", () => {
  expect(
    imageModelOptions(
      settings({
        imageApiBaseUrl: "https://images.example/v1",
        imageApiKey: "secret",
        imageModel: "custom-image-model",
      }),
    ),
  ).toEqual(["custom-image-model"]);
});
