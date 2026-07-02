import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentInfo,
  ImageGenerationParams,
  MoodboardAsset,
  MoodboardConversation,
  MoodboardDetail,
  MoodboardMessage,
  MoodboardNode,
  SaveMoodboardNodeInput,
  Settings,
} from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { SETTINGS_UPDATED_EVENT } from "../lib/settings-events.ts";
import { useToast } from "../components/Toast.tsx";
import { MODEL_PROVIDERS } from "../settings/model-provider-registry.ts";
import { inferCapabilities, parseModelEntries } from "../settings/model-provider-ui-utils.tsx";
import { providerProfile } from "../settings/provider-profiles.ts";
import { generatorModel, referenceAssetIds, toInput } from "./canvas-utils.ts";
import { imageGenerationParamsFromNode } from "./image-generation-params.ts";
import {
  appendInputs,
  createImageGeneratorNode,
  createImageNode,
  createNoteNode,
  createSectionNode,
  fileToBase64,
  imageSize,
  materializeInputs,
} from "./moodboard-board-utils.ts";

function optimisticMoodboardMessage(boardId: string, conversationId: string, content: string): MoodboardMessage {
  return {
    id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    boardId,
    ...(conversationId ? { conversationId } : {}),
    role: "user",
    content,
    createdAt: Date.now(),
  };
}

function appendUniqueMessages(current: MoodboardMessage[], next: MoodboardMessage[]): MoodboardMessage[] {
  const seen = new Set(current.map((message) => message.id));
  const merged = [...current];
  for (const message of next) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

export function useMoodboardBoard(boardId: string) {
  const api = useApi();
  const { toast } = useToast();
  const [detail, setDetail] = useState<MoodboardDetail | null>(null);
  const [nodes, setNodes] = useState<MoodboardNode[]>([]);
  const [conversations, setConversations] = useState<MoodboardConversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<MoodboardMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [imageModel, setImageModel] = useState("");
  const [imageProviderId, setImageProviderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [agentBusy, setAgentBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const busy = agentBusy || imageBusy;
  const saveTimer = useRef<number | null>(null);
  const pendingSaveInputs = useRef<SaveMoodboardNodeInput[] | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getMoodboard(boardId)
      .then((next) => {
        setDetail(next);
        setNodes(next.nodes);
        setConversations(next.conversations ?? []);
        setConversationId(next.activeConversationId ?? next.conversations?.[0]?.id ?? "");
        setMessages(next.messages);
      })
      .catch(() => toast("Couldn't load the moodboard.", { variant: "error" }))
      .finally(() => setLoading(false));
  }, [api, boardId, toast]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    let alive = true;
    void api
      .listAgents()
      .then((next) => {
        if (!alive) return;
        setAgents(next);
        const available = next.filter((agent) => agent.available);
        setRunAgent((current) => current || available[0]?.command || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const applyImageSettings = useCallback((settings: Settings) => {
    const models = imageModelOptions(settings);
    const configuredImageModel = settings.imageModel.trim();
    setImageProviderId(settings.aiProviderId.trim());
    setImageModels(models);
    setImageModel((current) =>
      configuredImageModel && models.includes(configuredImageModel)
        ? configuredImageModel
        : current && models.includes(current)
          ? current
          : models[0] || "",
    );
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((settings) => {
        if (alive) applyImageSettings(settings);
      })
      .catch(() => {});
    const onSettingsUpdated = (event: Event) => {
      const settings = (event as CustomEvent<Settings>).detail;
      if (settings) applyImageSettings(settings);
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    return () => {
      alive = false;
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    };
  }, [api, applyImageSettings]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  const flushPendingNodes = useCallback(async (): Promise<boolean> => {
    const inputs = pendingSaveInputs.current;
    if (!inputs) return true;
    pendingSaveInputs.current = null;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      const saved = await api.saveMoodboardNodes(boardId, inputs);
      setNodes(saved);
      return true;
    } catch {
      toast("Couldn't save the board.", { variant: "error" });
      return false;
    }
  }, [api, boardId, toast]);

  const persistNodes = useCallback(
    (inputs: SaveMoodboardNodeInput[]) => {
      pendingSaveInputs.current = inputs;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void flushPendingNodes();
      }, 350);
    },
    [flushPendingNodes],
  );

  const updateNodes = useCallback(
    (inputs: SaveMoodboardNodeInput[]) => {
      setNodes((prev) => {
        const next = materializeInputs(boardId, prev, inputs);
        persistNodes(next.map(toInput));
        return next;
      });
    },
    [boardId, persistNodes],
  );

  const appendNodes = useCallback(
    (newNodes: SaveMoodboardNodeInput[]) => {
      setNodes((prev) => {
        const next = appendInputs(boardId, prev, newNodes);
        persistNodes(next.map(toInput));
        return next;
      });
    },
    [boardId, persistNodes],
  );

  const addNote = useCallback(
    (point?: { x: number; y: number }) => {
      appendNodes([createNoteNode(nodes.length, point)]);
    },
    [appendNodes, nodes.length],
  );

  const addSection = useCallback(
    (point?: { x: number; y: number }) => {
      appendNodes([createSectionNode(nodes.length, point)]);
    },
    [appendNodes, nodes.length],
  );

  const addImageGenerator = useCallback(
    (point?: { x: number; y: number }, data?: Record<string, unknown>) => {
      const node = createImageGeneratorNode(nodes.length, point, data);
      appendNodes([node]);
      setSelectedIds(node.id ? [node.id] : []);
    },
    [appendNodes, nodes.length],
  );

  const uploadFiles = useCallback(
    async (files: FileList | null, point?: { x: number; y: number }) => {
      if (!files?.length) return;
      setImageBusy(true);
      try {
        const nextNodes: SaveMoodboardNodeInput[] = [];
        for (const [index, file] of Array.from(files).entries()) {
          if (!file.type.startsWith("image/")) continue;
          const [contentBase64, size] = await Promise.all([fileToBase64(file), imageSize(file)]);
          const asset = await api.uploadMoodboardAsset(boardId, {
            name: file.name,
            contentBase64,
            mimeType: file.type,
            width: size.width,
            height: size.height,
          });
          nextNodes.push(createImageNode(asset, nodes.length, index, size, point));
        }
        if (nextNodes.length) appendNodes(nextNodes);
      } catch {
        toast("Couldn't upload those images.", { variant: "error" });
      } finally {
        setImageBusy(false);
      }
    },
    [api, appendNodes, boardId, nodes.length, toast],
  );

  const uploadReferenceFiles = useCallback(
    async (files: FileList | null): Promise<MoodboardAsset[]> => {
      if (!files?.length) return [];
      setImageBusy(true);
      try {
        const assets: MoodboardAsset[] = [];
        for (const file of Array.from(files)) {
          if (!file.type.startsWith("image/")) continue;
          const [contentBase64, size] = await Promise.all([fileToBase64(file), imageSize(file)]);
          assets.push(
            await api.uploadMoodboardAsset(boardId, {
              name: file.name,
              contentBase64,
              mimeType: file.type,
              width: size.width,
              height: size.height,
            }),
          );
        }
        return assets;
      } catch {
        toast("Couldn't upload those reference images.", { variant: "error" });
        return [];
      } finally {
        setImageBusy(false);
      }
    },
    [api, boardId, toast],
  );

  const generateImage = useCallback(
    async (
      node: MoodboardNode,
      prompt: string,
      options: { sourceAssetId?: string; referenceAssetIds?: string[]; params?: ImageGenerationParams } = {},
    ) => {
      const selectedModel = generatorModel(node) || imageModel;
      const generationParams = options.params ?? imageGenerationParamsFromNode(node);
      const imageReferenceAssetIds = options.referenceAssetIds ?? referenceAssetIds(node);
      const agentConversationId =
        typeof node.data.agentConversationId === "string" && node.data.agentConversationId.trim()
          ? node.data.agentConversationId.trim()
          : "";
      setImageBusy(true);
      setNodes((prev) =>
        prev.map((item) =>
          item.id === node.id
            ? {
                ...item,
                data: {
                  ...item.data,
                  generatorPrompt: prompt,
                  generatorModel: selectedModel,
                  generatorStatus: "running",
                  generationParams,
                  referenceAssetIds: imageReferenceAssetIds,
                },
              }
            : item,
        ),
      );
      try {
        const result = await api.generateMoodboardImage(boardId, prompt, {
          generatorId: node.id,
          model: selectedModel || undefined,
          conversationId: agentConversationId || undefined,
          sourceAssetId: options.sourceAssetId,
          referenceAssetIds: imageReferenceAssetIds,
          params: generationParams,
          x: node.x + node.width + 24,
          y: node.y,
        });
        setNodes(result.nodes);
        if (agentConversationId && agentConversationId === conversationId && result.messages.length) {
          setMessages((current) => appendUniqueMessages(current, result.messages));
        }
      } catch {
        setNodes((prev) =>
          prev.map((item) => (item.id === node.id ? { ...item, data: { ...item.data, generatorStatus: "error" } } : item)),
        );
        toast("Couldn't generate an image. Check Models settings.", { variant: "error" });
      } finally {
        setImageBusy(false);
      }
    },
    [api, boardId, conversationId, imageModel, toast],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      const activeConversationId = conversationId;
      const optimistic = optimisticMoodboardMessage(boardId, activeConversationId, content);
      setAgentBusy(true);
      setMessages((cur) => [...cur, optimistic]);
      try {
        if (!(await flushPendingNodes())) {
          setMessages((cur) => cur.filter((message) => message.id !== optimistic.id));
          return;
        }
        const result = await api.postMoodboardMessage(boardId, content, {
          agentCommand: runAgent || undefined,
          model: runModel || undefined,
          conversationId: activeConversationId || undefined,
        });
        if (result.nodes) setNodes(result.nodes);
        setMessages((cur) => {
          const withoutOptimistic = cur.filter((message) => message.id !== optimistic.id);
          const serverReturnedUser = result.messages.some((message) => message.role === "user" && message.content === content);
          const replacementMessages = serverReturnedUser ? result.messages : [optimistic, ...result.messages];
          return appendUniqueMessages(withoutOptimistic, replacementMessages);
        });
      } catch {
        setMessages((cur) => cur.filter((message) => message.id !== optimistic.id));
        toast("Couldn't send that message.", { variant: "error" });
      } finally {
        setAgentBusy(false);
      }
    },
    [api, boardId, conversationId, flushPendingNodes, runAgent, runModel, toast],
  );

  const switchConversation = useCallback(
    async (nextConversationId: string) => {
      if (!nextConversationId || nextConversationId === conversationId) return;
      try {
        const nextMessages = await api.listMoodboardMessages(boardId, nextConversationId);
        setConversationId(nextConversationId);
        setMessages(nextMessages);
      } catch {
        toast("Couldn't load that conversation.", { variant: "error" });
      }
    },
    [api, boardId, conversationId, toast],
  );

  const createConversation = useCallback(async () => {
    try {
      const conversation = await api.createMoodboardConversation(boardId, `Conversation ${conversations.length + 1}`);
      setConversations((current) => [...current, conversation]);
      setConversationId(conversation.id);
      setMessages([]);
    } catch {
      toast("Couldn't create a conversation.", { variant: "error" });
    }
  }, [api, boardId, conversations.length, toast]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      try {
        const conversation = await api.renameMoodboardConversation(boardId, id, title);
        setConversations((current) => current.map((item) => (item.id === id ? { ...item, ...conversation } : item)));
      } catch {
        toast("Couldn't rename that conversation.", { variant: "error" });
      }
    },
    [api, boardId, toast],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        const result = await api.deleteMoodboardConversation(boardId, id);
        setConversations(result.conversations);
        if (id === conversationId) {
          const next = result.conversations[0]?.id ?? "";
          setConversationId(next);
          setMessages(next ? await api.listMoodboardMessages(boardId, next) : []);
        }
      } catch {
        toast("Couldn't delete that conversation.", { variant: "error" });
      }
    },
    [api, boardId, conversationId, toast],
  );

  const rescanAgents = useCallback(async () => {
    const next = await api.rescanAgents();
    setAgents(next);
    const available = next.filter((agent) => agent.available);
    setRunAgent((current) => current || available[0]?.command || "");
  }, [api]);

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const setSelectedId = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), []);

  return {
    detail,
    nodes,
    conversations,
    conversationId,
    messages,
    selectedId,
    selectedIds,
    agents,
    runAgent,
    runModel,
    imageModels,
    imageModel,
    imageProviderId,
    loading,
    agentBusy,
    imageBusy,
    busy,
    setSelectedId,
    setSelectedIds,
    setRunAgent,
    setRunModel,
    setImageModel,
    switchConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    updateNodes,
    addNote,
    addSection,
    addImageGenerator,
    uploadFiles,
    uploadReferenceFiles,
    generateImage,
    sendMessage,
    rescanAgents,
  };
}

export function imageModelOptions(settings: Settings): string[] {
  const models = new Set<string>();
  const activeProvider = MODEL_PROVIDERS.find((provider) => provider.id === settings.aiProviderId);
  const knownCapabilities = new Map<string, Set<string>>();
  for (const provider of MODEL_PROVIDERS) {
    for (const model of provider.models) knownCapabilities.set(model.id, new Set(model.capabilities));
  }

  const configuredImageModel = settings.imageModel.trim();
  const hasLegacyImageEndpoint = Boolean(
    settings.imageApiBaseUrl.trim() && (settings.imageApiKey.trim() || settings.imageApiKeyConfigured) && configuredImageModel,
  );

  if (activeProvider?.imageRuntime) {
    const profile = providerProfile(settings, activeProvider);
    if (profile.enabled) {
      for (const entry of parseModelEntries(profile.models)) {
        const known = knownCapabilities.get(entry.id);
        const capabilities = entry.capabilities ?? (known ? [...known] : inferCapabilities(entry.id));
        if (capabilities.includes("Image") && !capabilities.includes("Video")) models.add(entry.id);
      }
    }
  }

  if (models.size === 0 && hasLegacyImageEndpoint) {
    const known = knownCapabilities.get(configuredImageModel);
    const capabilities = known ? [...known] : inferCapabilities(configuredImageModel);
    if (capabilities.includes("Image") && !capabilities.includes("Video")) models.add(configuredImageModel);
  }

  return [...models];
}
