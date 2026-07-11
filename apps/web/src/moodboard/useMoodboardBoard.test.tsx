import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MoodboardConversation, MoodboardMessage, MoodboardNode, SaveMoodboardNodeInput, Settings } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { imageModelOptions, useMoodboardBoard } from "./useMoodboardBoard.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
    videoApiBaseUrl: "",
    videoApiKey: "",
    videoModel: "",
    aiProviderId: "openai",
    aiProviderEnabled: false,
    aiProviderModels: "",
    aiProviderOrganization: "",
    aiProviderProfiles: "",
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

test("imageModelOptions hides provider preset image models until the provider is enabled", () => {
  expect(imageModelOptions(settings())).toEqual([]);
});

test("imageModelOptions exposes image models from the enabled provider", () => {
  expect(imageModelOptions(settings({ aiProviderEnabled: true }))).toEqual(["gpt-image-1", "gpt-image-2"]);
});

test("imageModelOptions ignores enabled providers without an image runtime", () => {
  expect(
    imageModelOptions(
      settings({
        aiProviderId: "anthropic",
        aiProviderEnabled: true,
        aiProviderModels: JSON.stringify({ id: "claude-image-ish", capabilities: ["Image"] }),
      }),
    ),
  ).toEqual([]);
});

test("imageModelOptions uses the active enabled provider profile instead of the last viewed provider models", () => {
  expect(
    imageModelOptions(
      settings({
        aiProviderId: "openai",
        aiProviderEnabled: true,
        aiProviderModels: JSON.stringify({ id: "azure-image-deployment", capabilities: ["Image"] }),
        imageModel: "stale-image-model",
        aiProviderProfiles: JSON.stringify({
          openai: {
            enabled: true,
            baseUrl: "https://api.openai.com/v1",
            models: JSON.stringify({ id: "openai-image-live", capabilities: ["Image"] }),
            organization: "",
          },
          "azure-openai": {
            enabled: false,
            baseUrl: "https://example.openai.azure.com/openai",
            models: JSON.stringify({ id: "azure-image-deployment", capabilities: ["Image"] }),
            organization: "preview",
          },
        }),
      }),
    ),
  ).toEqual(["openai-image-live"]);
});

test("imageModelOptions exposes fal and Vertex image models from enabled provider profiles", () => {
  expect(
    imageModelOptions(
      settings({
        aiProviderId: "fal",
        aiProviderEnabled: true,
        aiProviderProfiles: JSON.stringify({
          fal: {
            enabled: true,
            baseUrl: "https://fal.run",
            apiKey: "fal-key",
            models: JSON.stringify({ id: "fal-ai/flux/dev", capabilities: ["Image"] }),
            organization: "",
          },
        }),
      }),
    ),
  ).toEqual(["fal-ai/flux/dev"]);

  expect(
    imageModelOptions(
      settings({
        aiProviderId: "vertex",
        aiProviderEnabled: true,
        aiProviderProfiles: JSON.stringify({
          vertex: {
            enabled: true,
            baseUrl: "",
            apiKey: "vertex-key",
            models: JSON.stringify({ id: "imagen-4.0-generate-001", capabilities: ["Image"] }),
            organization: "",
          },
        }),
      }),
    ),
  ).toEqual(["imagen-4.0-generate-001"]);
});

test("imageModelOptions keeps legacy active provider profiles enabled through the global flag", () => {
  expect(
    imageModelOptions(
      settings({
        aiProviderId: "openai",
        aiProviderEnabled: true,
        aiProviderProfiles: JSON.stringify({
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: JSON.stringify({ id: "openai-image-live", capabilities: ["Image"] }),
            organization: "",
          },
        }),
      }),
    ),
  ).toEqual(["openai-image-live"]);
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
  await waitFor(() => expect(board.imageModels).toEqual(["gpt-image-1"]));

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

test("useMoodboardBoard restores and persists the selected agent model", async () => {
  let board!: ReturnType<typeof useMoodboardBoard>;
  function Probe() {
    board = useMoodboardBoard("board-1");
    useEffect(() => {}, [board]);
    return null;
  }
  let currentSettings = settings({ agentCommand: "codex", model: "gpt-5" });
  const updateSettings = async (patch: Partial<Settings>) => {
    currentSettings = { ...currentSettings, ...patch };
    return currentSettings;
  };
  const api = makeFakeApi({
    listAgents: async () => [
      { id: "claude", command: "claude", available: true, models: ["sonnet"] },
      { id: "codex", command: "codex", available: true, models: ["gpt-5", "gpt-5.1"] },
    ],
    getSettings: async () => currentSettings,
    updateSettings,
    getMoodboard: async () => ({
      id: "board-1",
      name: "Board",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [],
      assets: [],
      conversations: [],
      messages: [],
    }),
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );

  await waitFor(() => expect(board.loading).toBe(false));
  await waitFor(() => expect(board.runAgent).toBe("codex"));
  expect(board.runModel).toBe("gpt-5");

  await act(async () => {
    board.setRunModel("gpt-5.1");
  });

  await waitFor(() => expect(currentSettings.model).toBe("gpt-5.1"));
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

test("useMoodboardBoard flushes the latest pending nodes on unmount", async () => {
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
    data: { content: "draft" },
    createdAt: 1,
    updatedAt: 1,
  };
  let board!: ReturnType<typeof useMoodboardBoard>;
  function Probe() {
    board = useMoodboardBoard("board-1");
    return null;
  }
  const saveMoodboardNodes = vi.fn(async (_id: string, inputs: SaveMoodboardNodeInput[]) =>
    inputs.map((input) => ({ ...initialNode, ...input, boardId: _id })),
  );
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
    saveMoodboardNodes,
  });
  const view = render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));
  vi.useFakeTimers();

  act(() => {
    board.updateNodes([{ ...initialNode, x: 12 }]);
    board.updateNodes([{ ...initialNode, x: 84 }]);
  });
  view.unmount();
  await act(async () => {
    await Promise.resolve();
  });

  expect(saveMoodboardNodes).toHaveBeenCalledTimes(1);
  expect(saveMoodboardNodes).toHaveBeenCalledWith("board-1", [expect.objectContaining({ id: "note-1", x: 84 })]);
});

test("useMoodboardBoard keeps pending saves isolated when the board id changes", async () => {
  const node = (boardId: string): MoodboardNode => ({
    id: `note-${boardId}`,
    boardId,
    type: "note",
    x: 0,
    y: 0,
    width: 160,
    height: 120,
    rotation: 0,
    zIndex: 0,
    data: { content: boardId },
    createdAt: 1,
    updatedAt: 1,
  });
  let board!: ReturnType<typeof useMoodboardBoard>;
  function Probe({ boardId }: { boardId: string }) {
    board = useMoodboardBoard(boardId);
    return null;
  }
  const saveMoodboardNodes = vi.fn(async (boardId: string, inputs: SaveMoodboardNodeInput[]) =>
    inputs.map((input) => ({ ...node(boardId), ...input, boardId })),
  );
  const api = makeFakeApi({
    getMoodboard: async (boardId: string) => ({
      id: boardId,
      name: boardId,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [node(boardId)],
      assets: [],
      messages: [],
    }),
    saveMoodboardNodes,
  });
  const view = render(
    <ApiProvider client={api}>
      <Probe boardId="board-1" />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.detail?.id).toBe("board-1"));
  vi.useFakeTimers();

  act(() => board.updateNodes([{ ...node("board-1"), x: 11 }]));
  view.rerender(
    <ApiProvider client={api}>
      <Probe boardId="board-2" />
    </ApiProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  act(() => board.updateNodes([{ ...node("board-2"), x: 22 }]));
  await act(async () => {
    vi.advanceTimersByTime(350);
    await Promise.resolve();
  });

  expect(saveMoodboardNodes).toHaveBeenCalledWith("board-1", [expect.objectContaining({ id: "note-board-1", x: 11 })]);
  expect(saveMoodboardNodes).toHaveBeenCalledWith("board-2", [expect.objectContaining({ id: "note-board-2", x: 22 })]);
});

test("useMoodboardBoard ignores an image generation result after switching boards", async () => {
  const node = (boardId: string): MoodboardNode => ({
    id: `generator-${boardId}`,
    boardId,
    type: "image-generator",
    x: 0,
    y: 0,
    width: 240,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: boardId },
    createdAt: 1,
    updatedAt: 1,
  });
  let board!: ReturnType<typeof useMoodboardBoard>;
  let resolveGeneration!: (value: Awaited<ReturnType<ReturnType<typeof makeFakeApi>["generateMoodboardImage"]>>) => void;
  function Probe({ boardId }: { boardId: string }) {
    board = useMoodboardBoard(boardId);
    return null;
  }
  const api = makeFakeApi({
    getMoodboard: async (boardId: string) => ({
      id: boardId,
      name: boardId,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [node(boardId)],
      assets: [],
      conversations: [],
      messages: [],
    }),
    generateMoodboardImage: async () =>
      new Promise((resolve) => {
        resolveGeneration = resolve;
      }),
  });
  const view = render(
    <ApiProvider client={api}>
      <Probe boardId="board-1" />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.detail?.id).toBe("board-1"));

  let generation!: Promise<void>;
  await act(async () => {
    generation = board.generateImage(node("board-1"), "board one");
  });
  view.rerender(
    <ApiProvider client={api}>
      <Probe boardId="board-2" />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.detail?.id).toBe("board-2"));

  await act(async () => {
    resolveGeneration({
      asset: {
        id: "asset-board-1",
        boardId: "board-1",
        kind: "image",
        fileName: "board-1.png",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        source: "generated",
        createdAt: 2,
        url: "/api/moodboards/board-1/assets/asset-board-1",
      },
      nodes: [{ ...node("board-1"), type: "image", data: { assetId: "asset-board-1" } }],
      messages: [],
    });
    await generation;
  });

  expect(board.detail?.id).toBe("board-2");
  expect(board.nodes).toEqual([expect.objectContaining({ boardId: "board-2", id: "generator-board-2" })]);
  expect(board.assets).toEqual([]);
});

test("useMoodboardBoard never appends a completed upload to a different board", async () => {
  const node = (boardId: string): MoodboardNode => ({
    id: `note-${boardId}`,
    boardId,
    type: "note",
    x: 0,
    y: 0,
    width: 160,
    height: 120,
    rotation: 0,
    zIndex: 0,
    data: { content: boardId },
    createdAt: 1,
    updatedAt: 1,
  });
  let board!: ReturnType<typeof useMoodboardBoard>;
  let resolveUpload!: (asset: Awaited<ReturnType<ReturnType<typeof makeFakeApi>["uploadMoodboardAsset"]>>) => void;
  function Probe({ boardId }: { boardId: string }) {
    board = useMoodboardBoard(boardId);
    return null;
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pending-upload");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    },
  );
  const uploadMoodboardAsset = vi.fn(
    async () =>
      new Promise<Awaited<ReturnType<ReturnType<typeof makeFakeApi>["uploadMoodboardAsset"]>>>((resolve) => {
        resolveUpload = resolve;
      }),
  );
  const saveMoodboardNodes = vi.fn();
  const api = makeFakeApi({
    getMoodboard: async (boardId: string) => ({
      id: boardId,
      name: boardId,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [node(boardId)],
      assets: [],
      conversations: [],
      messages: [],
    }),
    uploadMoodboardAsset,
    saveMoodboardNodes,
  });
  const view = render(
    <ApiProvider client={api}>
      <Probe boardId="board-1" />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.detail?.id).toBe("board-1"));

  let upload!: Promise<void>;
  await act(async () => {
    upload = board.uploadFiles([new File(["image"], "board-1.png", { type: "image/png" })]);
  });
  await waitFor(() => expect(uploadMoodboardAsset).toHaveBeenCalledWith("board-1", expect.any(Object)));
  view.rerender(
    <ApiProvider client={api}>
      <Probe boardId="board-2" />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.detail?.id).toBe("board-2"));
  await act(async () => {
    resolveUpload({
      id: "asset-board-1",
      boardId: "board-1",
      kind: "image",
      fileName: "board-1.png",
      mimeType: "image/png",
      width: null,
      height: null,
      source: "upload",
      createdAt: 2,
      url: "/api/moodboards/board-1/assets/asset-board-1",
    });
    await upload;
  });

  expect(board.nodes).toEqual([expect.objectContaining({ boardId: "board-2", id: "note-board-2" })]);
  expect(saveMoodboardNodes).not.toHaveBeenCalled();
});

test("useMoodboardBoard retries a failed unmount flush instead of stranding a timerless save", async () => {
  const initialNode: MoodboardNode = {
    id: "note-retry",
    boardId: "board-retry",
    type: "note",
    x: 0,
    y: 0,
    width: 160,
    height: 120,
    rotation: 0,
    zIndex: 0,
    data: { content: "retry me" },
    createdAt: 1,
    updatedAt: 1,
  };
  let board!: ReturnType<typeof useMoodboardBoard>;
  function Probe() {
    board = useMoodboardBoard("board-retry");
    return null;
  }
  const saveMoodboardNodes = vi
    .fn<ReturnType<typeof makeFakeApi>["saveMoodboardNodes"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (boardId, inputs) => inputs.map((input) => ({ ...initialNode, ...input, boardId })));
  const api = makeFakeApi({
    getMoodboard: async () => ({
      id: "board-retry",
      name: "Retry",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [initialNode],
      assets: [],
      conversations: [],
      messages: [],
    }),
    saveMoodboardNodes,
  });
  const view = render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));
  vi.useFakeTimers();

  act(() => board.updateNodes([{ ...initialNode, x: 91 }]));
  view.unmount();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(saveMoodboardNodes).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(saveMoodboardNodes).toHaveBeenCalledTimes(2);
  expect(saveMoodboardNodes).toHaveBeenLastCalledWith("board-retry", [expect.objectContaining({ id: "note-retry", x: 91 })]);
});

test("useMoodboardBoard sets an image node as the current board cover", async () => {
  const imageNode: MoodboardNode = {
    id: "img1",
    boardId: "board-1",
    type: "image",
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { assetId: "asset-1", url: "/api/moodboards/board-1/assets/asset-1" },
    createdAt: 1,
    updatedAt: 1,
  };
  let patchInput: unknown;
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
      coverUrl: null,
      nodes: [imageNode],
      assets: [],
      messages: [],
    }),
    patchMoodboard: async (_id, patch) => {
      patchInput = patch;
      return {
        id: "board-1",
        name: "Board",
        createdAt: 1,
        updatedAt: 2,
        archivedAt: null,
        coverAssetId: "asset-1",
        coverUrl: "/api/moodboards/board-1/assets/asset-1",
      };
    },
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));

  await act(async () => {
    await board.setCoverImage(imageNode);
  });

  expect(patchInput).toEqual({ coverAssetId: "asset-1" });
  expect(board.detail?.coverAssetId).toBe("asset-1");
  expect(board.detail?.coverUrl).toBe("/api/moodboards/board-1/assets/asset-1");
});

test("sendMessage shows the submitted prompt while the agent is still responding", async () => {
  let resolvePost!: (value: { messages: MoodboardMessage[] }) => void;
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
    postMoodboardMessage: async () =>
      new Promise<{ messages: MoodboardMessage[] }>((resolve) => {
        resolvePost = resolve;
      }),
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));

  let sendPromise!: Promise<void>;
  await act(async () => {
    sendPromise = board.sendMessage("collect warm reference images");
  });

  expect(board.busy).toBe(true);
  expect(board.messages).toEqual([
    expect.objectContaining({
      boardId: "board-1",
      role: "user",
      content: "collect warm reference images",
    }),
  ]);

  await act(async () => {
    resolvePost({
      messages: [
        { id: "server-user", boardId: "board-1", role: "user", content: "collect warm reference images", createdAt: 10 },
        { id: "server-assistant", boardId: "board-1", role: "assistant", content: "Use warmer editorial texture.", createdAt: 11 },
      ],
    });
    await sendPromise;
  });

  expect(board.busy).toBe(false);
  expect(board.messages.map((message) => message.id)).toEqual(["server-user", "server-assistant"]);
});

test("generateImage keeps canvas generation out of the agent loading state and conversation", async () => {
  let resolveGenerate!: (value: Awaited<ReturnType<ReturnType<typeof makeFakeApi>["generateMoodboardImage"]>>) => void;
  const generator: MoodboardNode = {
    id: "gen-1",
    boardId: "board-1",
    type: "image-generator",
    x: 10,
    y: 20,
    width: 240,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light" },
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
      nodes: [generator],
      assets: [],
      messages: [],
    }),
    generateMoodboardImage: async () =>
      new Promise((resolve) => {
        resolveGenerate = resolve;
      }),
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));

  let generatePromise!: Promise<void>;
  await act(async () => {
    generatePromise = board.generateImage(generator, "soft light");
  });

  expect(board.agentBusy).toBe(false);
  expect(board.imageBusy).toBe(true);
  expect(board.busy).toBe(true);
  expect(board.messages).toEqual([]);

  await act(async () => {
    resolveGenerate({
      asset: {
        id: "asset-1",
        boardId: "board-1",
        kind: "image",
        fileName: "generated.png",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        source: "generated",
        createdAt: 2,
        url: "/api/moodboards/board-1/assets/asset-1",
      },
      nodes: [{ ...generator, data: { ...generator.data, generatorStatus: "done", resultAssetId: "asset-1" }, updatedAt: 3 }],
      messages: [
        { id: "agent-status", boardId: "board-1", conversationId: "conversation-1", role: "assistant", content: "Generated an image.", createdAt: 4 },
      ],
    });
    await generatePromise;
  });

  expect(board.agentBusy).toBe(false);
  expect(board.imageBusy).toBe(false);
  expect(board.messages).toEqual([]);
});

test("generateImage sends generation parameters to the daemon", async () => {
  let capturedOptions: Parameters<ReturnType<typeof makeFakeApi>["generateMoodboardImage"]>[2] | undefined;
  const generator: MoodboardNode = {
    id: "gen-params",
    boardId: "board-1",
    type: "image-generator",
    x: 10,
    y: 20,
    width: 240,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generatorModel: "gpt-image-2" },
    createdAt: 1,
    updatedAt: 1,
  };
  let board!: ReturnType<typeof useMoodboardBoard>;
  function Probe() {
    board = useMoodboardBoard("board-1");
    useEffect(() => {}, [board]);
    return null;
  }
  const params = { quality: "high" as const, aspectRatio: "16:9" as const, size: "1536x1024" as const, count: 1 };
  const api = makeFakeApi({
    getMoodboard: async () => ({
      id: "board-1",
      name: "Board",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      coverAssetId: null,
      nodes: [generator],
      assets: [],
      messages: [],
    }),
    getSettings: async () =>
      settings({
        aiProviderId: "openai",
        aiProviderEnabled: true,
        aiProviderModels: JSON.stringify({ id: "gpt-image-2", capabilities: ["Image"] }),
        imageModel: "gpt-image-2",
      }),
    generateMoodboardImage: async (_id, _prompt, options) => {
      capturedOptions = options;
      return {
        asset: {
          id: "asset-1",
          boardId: "board-1",
          kind: "image",
          fileName: "generated.png",
          mimeType: "image/png",
          width: 1536,
          height: 1024,
          source: "generated",
          createdAt: 2,
          url: "/api/moodboards/board-1/assets/asset-1",
        },
        nodes: [{ ...generator, type: "image", data: { assetId: "asset-1", prompt: "soft light", model: "gpt-image-2", generationParams: params }, updatedAt: 3 }],
        messages: [],
      };
    },
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));

  await act(async () => {
    await board.generateImage(generator, "soft light", { params });
  });

  expect(capturedOptions).toEqual(
    expect.objectContaining({
      model: "gpt-image-2",
      params,
    }),
  );
  expect(board.nodes[0]?.data).toEqual(expect.objectContaining({ generationParams: params }));
});

test("generateImage sends reference asset ids to the daemon", async () => {
  let capturedOptions: Parameters<ReturnType<typeof makeFakeApi>["generateMoodboardImage"]>[2] | undefined;
  const generator: MoodboardNode = {
    id: "gen-ref",
    boardId: "board-1",
    type: "image-generator",
    x: 10,
    y: 20,
    width: 240,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", referenceAssetIds: ["ref-1"] },
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
      nodes: [generator],
      assets: [],
      messages: [],
    }),
    generateMoodboardImage: async (_id, _prompt, options) => {
      capturedOptions = options;
      return {
        asset: {
          id: "asset-1",
          boardId: "board-1",
          kind: "image",
          fileName: "generated.png",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          source: "generated",
          createdAt: 2,
          url: "/api/moodboards/board-1/assets/asset-1",
        },
        nodes: [
          {
            ...generator,
            type: "image",
            data: { assetId: "asset-1", prompt: "soft light", model: "gpt-image-1", referenceAssetIds: ["ref-1"] },
            updatedAt: 3,
          },
        ],
        messages: [],
      };
    },
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));

  await act(async () => {
    await board.generateImage(generator, "soft light");
  });

  expect(capturedOptions).toEqual(expect.objectContaining({ referenceAssetIds: ["ref-1"] }));
  expect(board.nodes[0]?.data).toEqual(expect.objectContaining({ referenceAssetIds: ["ref-1"] }));
});

test("generateImage notifies the active agent conversation for agent-created generators", async () => {
  let capturedConversationId = "";
  const generator: MoodboardNode = {
    id: "gen-1",
    boardId: "board-1",
    type: "image-generator",
    x: 10,
    y: 20,
    width: 240,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { agentConversationId: "conversation-1", generatorPrompt: "soft light" },
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
      nodes: [generator],
      assets: [],
      conversations: [{ id: "conversation-1", boardId: "board-1", title: "Conversation 1", createdAt: 1, turns: 1 }],
      activeConversationId: "conversation-1",
      messages: [{ id: "a0", boardId: "board-1", conversationId: "conversation-1", role: "assistant", content: "Ready", createdAt: 1 }],
    }),
    generateMoodboardImage: async (_id, _prompt, options) => {
      capturedConversationId = options?.conversationId ?? "";
      return {
        asset: {
          id: "asset-1",
          boardId: "board-1",
          kind: "image",
          fileName: "generated.png",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          source: "generated",
          createdAt: 2,
          url: "/api/moodboards/board-1/assets/asset-1",
        },
        nodes: [{ ...generator, data: { ...generator.data, generatorStatus: "done", resultAssetId: "asset-1" }, updatedAt: 3 }],
        messages: [
          { id: "agent-status", boardId: "board-1", conversationId: "conversation-1", role: "assistant", content: "Generated an image.", createdAt: 4 },
        ],
      };
    },
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));

  await act(async () => {
    await board.generateImage(generator, "soft light");
  });

  expect(capturedConversationId).toBe("conversation-1");
  expect(board.agentBusy).toBe(false);
  expect(board.imageBusy).toBe(false);
  expect(board.messages.map((message) => message.content)).toEqual(["Ready", "Generated an image."]);
});

test("useMoodboardBoard switches moodboard conversations independently", async () => {
  const conversations: MoodboardConversation[] = [
    { id: "conversation-1", boardId: "board-1", title: "Conversation 1", createdAt: 1, turns: 1 },
    { id: "conversation-2", boardId: "board-1", title: "Alternate direction", createdAt: 2, turns: 0 },
  ];
  let postedConversationId = "";
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
      conversations,
      activeConversationId: "conversation-1",
      messages: [{ id: "u1", boardId: "board-1", conversationId: "conversation-1", role: "user", content: "First", createdAt: 1 }],
    }),
    listMoodboardMessages: async (_id, conversationId) =>
      conversationId === "conversation-2"
        ? [{ id: "u2", boardId: "board-1", conversationId: "conversation-2", role: "user", content: "Second", createdAt: 2 }]
        : [{ id: "u1", boardId: "board-1", conversationId: "conversation-1", role: "user", content: "First", createdAt: 1 }],
    postMoodboardMessage: async (_id, content, options) => {
      postedConversationId = options?.conversationId ?? "";
      return {
        messages: [
          { id: "u3", boardId: "board-1", conversationId: postedConversationId, role: "user", content, createdAt: 3 },
          { id: "a3", boardId: "board-1", conversationId: postedConversationId, role: "assistant", content: "Done", createdAt: 4 },
        ],
      };
    },
  });

  render(
    <ApiProvider client={api}>
      <Probe />
    </ApiProvider>,
  );
  await waitFor(() => expect(board.loading).toBe(false));
  expect(board.conversationId).toBe("conversation-1");
  expect(board.messages.map((message) => message.content)).toEqual(["First"]);

  await act(async () => {
    await board.switchConversation("conversation-2");
  });
  expect(board.conversationId).toBe("conversation-2");
  expect(board.messages.map((message) => message.content)).toEqual(["Second"]);

  await act(async () => {
    await board.sendMessage("Continue");
  });
  expect(postedConversationId).toBe("conversation-2");
});
