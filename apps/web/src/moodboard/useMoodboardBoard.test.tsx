import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { MoodboardNode, Settings } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { imageModelOptions, useMoodboardBoard } from "./useMoodboardBoard.ts";

afterEach(() => cleanup());

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
    aiProviderProfiles: "",
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

test("useMoodboardBoard refreshes image model choices when settings change elsewhere", async () => {
  let board!: ReturnType<typeof useMoodboardBoard>;
  function Probe() {
    board = useMoodboardBoard("board-1");
    useEffect(() => {}, [board]);
    return null;
  }
  const api = makeFakeApi({
    getMoodboard: async () => ({
      id: "board-1",
      name: "Board",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [],
      assets: [],
      messages: [],
    }),
    getSettings: async () =>
      settings({
        aiProviderEnabled: true,
        aiProviderModels: JSON.stringify({ id: "gpt-image-1", capabilities: ["Image"] }),
      }),
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.imageModels).toEqual(["gpt-image-1", "gpt-image-2"]));

  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("dezin:settings-updated", {
        detail: settings({
          aiProviderEnabled: true,
          aiProviderId: "azure-openai",
          imageModel: "azure-image-deployment",
          aiProviderModels: JSON.stringify({ id: "azure-image-deployment", capabilities: ["Image"] }),
        }),
      }),
    );
  });

  await waitFor(() => expect(board.imageModels).toContain("azure-image-deployment"));
  expect(board.imageModel).toBe("azure-image-deployment");
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

test("sendMessage flushes pending node saves before posting to the agent", async () => {
  const calls: string[] = [];
  const initialNode: MoodboardNode = {
    id: "note-1",
    boardId: "board-1",
    type: "note",
    x: 0,
    y: 0,
    width: 160,
    height: 120,
    rotation: 0,
    zIndex: 0,
    data: { content: "old" },
    createdAt: 1,
    updatedAt: 1,
  };
  let board!: ReturnType<typeof useMoodboardBoard>;
  function Probe() {
    board = useMoodboardBoard("board-1");
    useEffect(() => {}, [board]);
    return null;
  }
  const api = makeFakeApi({
    getMoodboard: async () => ({
      id: "board-1",
      name: "Board",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [initialNode],
      assets: [],
      messages: [],
    }),
    saveMoodboardNodes: async (_id, inputs) => {
      calls.push(`save:${inputs[0]?.x}`);
      return inputs.map((input) => ({ ...initialNode, ...input, id: input.id ?? "note-1", boardId: "board-1", updatedAt: 2 }));
    },
    postMoodboardMessage: async () => {
      calls.push("post");
      return { messages: [] };
    },
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));

  await act(async () => {
    board.updateNodes([{ ...initialNode, x: 42 }]);
  });
  await act(async () => {
    await board.sendMessage("inspect the current board");
  });

  expect(calls).toEqual(["save:42", "post"]);
});
