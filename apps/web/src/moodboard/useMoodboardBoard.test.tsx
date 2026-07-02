import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { MoodboardConversation, MoodboardMessage, MoodboardNode, Settings } from "../lib/api.ts";
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
