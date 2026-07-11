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
import { persistAgentModelDefaults } from "../lib/agent-model-defaults.ts";
import type { ImageActionModelField } from "../lib/image-action-defaults.ts";
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

function mergeAssets(current: MoodboardAsset[], next: MoodboardAsset[]): MoodboardAsset[] {
  if (!next.length) return current;
  const byId = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of next) byId.set(asset.id, asset);
  return [...byId.values()];
}

function imageNodeAssetId(node: MoodboardNode): string {
  return node.type === "image" && typeof node.data.assetId === "string" ? node.data.assetId.trim() : "";
}

interface PendingNodeSave {
  inputs: SaveMoodboardNodeInput[];
  version: number;
  timer: number | null;
  retryCount: number;
}

interface FlushPendingNodesOptions {
  applyResult: boolean;
  notify: boolean;
}

export function useMoodboardBoard(boardId: string) {
  const api = useApi();
  const { toast } = useToast();
  const [detail, setDetail] = useState<MoodboardDetail | null>(null);
  const [nodes, setNodes] = useState<MoodboardNode[]>([]);
  const [assets, setAssets] = useState<MoodboardAsset[]>([]);
  const [conversations, setConversations] = useState<MoodboardConversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<MoodboardMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [agentDefaults, setAgentDefaults] = useState<Pick<Settings, "agentCommand" | "model"> | null>(null);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [imageModel, setImageModel] = useState("");
  const [imageProviderId, setImageProviderId] = useState("");
  const [imageActionModels, setImageActionModels] = useState<Record<ImageActionModelField, string>>({
    removeBackgroundModel: "",
    editRegionModel: "",
    extractLayerModel: "",
  });
  const [loading, setLoading] = useState(true);
  const [agentBusy, setAgentBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const busy = agentBusy || imageBusy;
  const mountedRef = useRef(true);
  const currentBoardIdRef = useRef(boardId);
  const pendingSavesRef = useRef(new Map<string, PendingNodeSave>());
  const inFlightSavesRef = useRef(new Map<string, Promise<boolean>>());
  const saveVersionsRef = useRef(new Map<string, number>());
  currentBoardIdRef.current = boardId;
  const isCurrentBoard = useCallback(
    (targetBoardId: string) => mountedRef.current && currentBoardIdRef.current === targetBoardId,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setDetail(null);
    setNodes([]);
    setAssets([]);
    setConversations([]);
    setConversationId("");
    setMessages([]);
    setSelectedIds([]);
    setAgentBusy(false);
    setImageBusy(false);
    void api
      .getMoodboard(boardId)
      .then((next) => {
        if (!alive) return;
        setDetail(next);
        setNodes(next.nodes);
        setAssets(next.assets ?? []);
        setConversations(next.conversations ?? []);
        setConversationId(next.activeConversationId ?? next.conversations?.[0]?.id ?? "");
        setMessages(next.messages);
      })
      .catch(() => {
        if (alive) toast("Couldn't load the moodboard.", { variant: "error" });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, boardId, toast]);

  useEffect(() => {
    let alive = true;
    void api
      .listAgents()
      .then((next) => {
        if (!alive) return;
        setAgents(next);
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
    setImageActionModels({
      removeBackgroundModel: settings.removeBackgroundModel.trim(),
      editRegionModel: settings.editRegionModel.trim(),
      extractLayerModel: settings.extractLayerModel.trim(),
    });
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
        if (!alive) return;
        setAgentDefaults({ agentCommand: settings.agentCommand, model: settings.model });
        applyImageSettings(settings);
      })
      .catch(() => {
        if (alive) setAgentDefaults({ agentCommand: "", model: "" });
      });
    const onSettingsUpdated = (event: Event) => {
      const settings = (event as CustomEvent<Settings>).detail;
      if (!settings) return;
      setAgentDefaults({ agentCommand: settings.agentCommand, model: settings.model });
      applyImageSettings(settings);
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    return () => {
      alive = false;
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    };
  }, [api, applyImageSettings]);

  useEffect(() => {
    if (agentDefaults === null) return;
    const available = agents.filter((agent) => agent.available);
    if (!available.length) return;
    const useSaved = agentDefaults.agentCommand !== "" && available.some((agent) => agent.command === agentDefaults.agentCommand);
    setRunAgent((current) => current || (useSaved ? agentDefaults.agentCommand : available[0]!.command));
    if (useSaved && agentDefaults.model) setRunModel((current) => current || agentDefaults.model);
  }, [agentDefaults, agents]);

  const flushBoardNodes = useCallback(
    async (targetBoardId: string, options: FlushPendingNodesOptions): Promise<boolean> => {
      const scheduleRetry = (pending: PendingNodeSave): void => {
        if (pending.timer !== null) return;
        const retryCount = pending.retryCount + 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryCount - 1, 5));
        const retry: PendingNodeSave = { ...pending, retryCount, timer: null };
        retry.timer = window.setTimeout(() => {
          retry.timer = null;
          void flushBoardNodes(targetBoardId, { applyResult: true, notify: false });
        }, delay);
        pendingSavesRef.current.set(targetBoardId, retry);
      };
      const inFlight = inFlightSavesRef.current.get(targetBoardId);
      if (inFlight) {
        const succeeded = await inFlight;
        const queued = pendingSavesRef.current.get(targetBoardId);
        if (!queued) return succeeded;
        if (!succeeded) {
          scheduleRetry(queued);
          return false;
        }
        return flushBoardNodes(targetBoardId, options);
      }

      const pending = pendingSavesRef.current.get(targetBoardId);
      if (!pending) return true;
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      pendingSavesRef.current.delete(targetBoardId);

      const save = (async () => {
        try {
          const saved = await api.saveMoodboardNodes(targetBoardId, pending.inputs);
          const isLatest = saveVersionsRef.current.get(targetBoardId) === pending.version && !pendingSavesRef.current.has(targetBoardId);
          if (options.applyResult && mountedRef.current && currentBoardIdRef.current === targetBoardId && isLatest) setNodes(saved);
          return true;
        } catch {
          const queued = pendingSavesRef.current.get(targetBoardId);
          if (!queued || queued.version <= pending.version) scheduleRetry({ ...pending, timer: null });
          else scheduleRetry(queued);
          if (options.notify && mountedRef.current) toast("Couldn't save the board.", { variant: "error" });
          return false;
        } finally {
          inFlightSavesRef.current.delete(targetBoardId);
        }
      })();
      inFlightSavesRef.current.set(targetBoardId, save);
      const succeeded = await save;
      if (!succeeded) return false;
      return pendingSavesRef.current.has(targetBoardId) ? flushBoardNodes(targetBoardId, options) : true;
    },
    [api, toast],
  );

  const flushPendingNodes = useCallback(
    (options: FlushPendingNodesOptions = { applyResult: true, notify: true }): Promise<boolean> => flushBoardNodes(boardId, options),
    [boardId, flushBoardNodes],
  );

  useEffect(
    () => () => {
      void flushBoardNodes(boardId, { applyResult: false, notify: false });
    },
    [boardId, flushBoardNodes],
  );

  const persistNodes = useCallback(
    (inputs: SaveMoodboardNodeInput[]) => {
      const targetBoardId = boardId;
      const previous = pendingSavesRef.current.get(targetBoardId);
      if (previous?.timer !== null && previous?.timer !== undefined) window.clearTimeout(previous.timer);
      const version = (saveVersionsRef.current.get(targetBoardId) ?? 0) + 1;
      saveVersionsRef.current.set(targetBoardId, version);
      const pending: PendingNodeSave = { inputs, version, timer: null, retryCount: 0 };
      pending.timer = window.setTimeout(() => {
        pending.timer = null;
        void flushBoardNodes(targetBoardId, { applyResult: true, notify: true });
      }, 350);
      pendingSavesRef.current.set(targetBoardId, pending);
    },
    [boardId, flushBoardNodes],
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
      return node.id;
    },
    [appendNodes, nodes.length],
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[] | null, point?: { x: number; y: number }) => {
      if (!files?.length) return;
      const targetBoardId = boardId;
      setImageBusy(true);
      try {
        const nextNodes: SaveMoodboardNodeInput[] = [];
        for (const [index, file] of Array.from(files).entries()) {
          if (!file.type.startsWith("image/")) continue;
          const [contentBase64, size] = await Promise.all([fileToBase64(file), imageSize(file)]);
          const asset = await api.uploadMoodboardAsset(targetBoardId, {
            name: file.name,
            contentBase64,
            mimeType: file.type,
            width: size.width,
            height: size.height,
          });
          if (!isCurrentBoard(targetBoardId)) return;
          nextNodes.push(createImageNode(asset, nodes.length, index, size, point));
        }
        if (nextNodes.length && isCurrentBoard(targetBoardId)) appendNodes(nextNodes);
      } catch {
        if (isCurrentBoard(targetBoardId)) toast("Couldn't upload those images.", { variant: "error" });
      } finally {
        if (isCurrentBoard(targetBoardId)) setImageBusy(false);
      }
    },
    [api, appendNodes, boardId, isCurrentBoard, nodes.length, toast],
  );

  const uploadReferenceFiles = useCallback(
    async (files: FileList | File[] | null): Promise<MoodboardAsset[]> => {
      if (!files?.length) return [];
      const targetBoardId = boardId;
      setImageBusy(true);
      try {
        const assets: MoodboardAsset[] = [];
        for (const file of Array.from(files)) {
          if (!file.type.startsWith("image/")) continue;
          const [contentBase64, size] = await Promise.all([fileToBase64(file), imageSize(file)]);
          assets.push(
            await api.uploadMoodboardAsset(targetBoardId, {
              name: file.name,
              contentBase64,
              mimeType: file.type,
              width: size.width,
              height: size.height,
            }),
          );
          if (!isCurrentBoard(targetBoardId)) return [];
        }
        if (assets.length && isCurrentBoard(targetBoardId)) setAssets((current) => mergeAssets(current, assets));
        return assets;
      } catch {
        if (isCurrentBoard(targetBoardId)) toast("Couldn't upload those reference images.", { variant: "error" });
        return [];
      } finally {
        if (isCurrentBoard(targetBoardId)) setImageBusy(false);
      }
    },
    [api, boardId, isCurrentBoard, toast],
  );

  const generateImage = useCallback(
    async (
      node: MoodboardNode,
      prompt: string,
      options: { sourceAssetId?: string; referenceAssetIds?: string[]; params?: ImageGenerationParams } = {},
    ) => {
      const targetBoardId = boardId;
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
        const result = await api.generateMoodboardImage(targetBoardId, prompt, {
          generatorId: node.id,
          model: selectedModel || undefined,
          conversationId: agentConversationId || undefined,
          sourceAssetId: options.sourceAssetId,
          referenceAssetIds: imageReferenceAssetIds,
          params: generationParams,
          x: node.x + node.width + 24,
          y: node.y,
        });
        if (!isCurrentBoard(targetBoardId)) return;
        setNodes(result.nodes);
        setAssets((current) => mergeAssets(current, [result.asset]));
        if (agentConversationId && agentConversationId === conversationId && result.messages.length) {
          setMessages((current) => appendUniqueMessages(current, result.messages));
        }
      } catch {
        if (!isCurrentBoard(targetBoardId)) return;
        setNodes((prev) =>
          prev.map((item) => (item.id === node.id ? { ...item, data: { ...item.data, generatorStatus: "error" } } : item)),
        );
        toast("Couldn't generate an image. Check Models settings.", { variant: "error" });
      } finally {
        if (isCurrentBoard(targetBoardId)) setImageBusy(false);
      }
    },
    [api, boardId, conversationId, imageModel, isCurrentBoard, toast],
  );

  const setCoverImage = useCallback(
    async (node: MoodboardNode) => {
      const targetBoardId = boardId;
      const assetId = imageNodeAssetId(node);
      if (!assetId) {
        toast("That image is missing an asset reference.", { variant: "error" });
        return;
      }
      try {
        const updated = await api.patchMoodboard(targetBoardId, { coverAssetId: assetId });
        if (!isCurrentBoard(targetBoardId)) return;
        setDetail((current) => (current ? { ...current, ...updated } : current));
        toast("Moodboard cover updated.");
      } catch {
        if (isCurrentBoard(targetBoardId)) toast("Couldn't set the cover image.", { variant: "error" });
      }
    },
    [api, boardId, isCurrentBoard, toast],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      const targetBoardId = boardId;
      const activeConversationId = conversationId;
      const optimistic = optimisticMoodboardMessage(targetBoardId, activeConversationId, content);
      setAgentBusy(true);
      setMessages((cur) => [...cur, optimistic]);
      try {
        if (!(await flushPendingNodes({ applyResult: true, notify: true }))) {
          if (isCurrentBoard(targetBoardId)) setMessages((cur) => cur.filter((message) => message.id !== optimistic.id));
          return;
        }
        if (!isCurrentBoard(targetBoardId)) return;
        const result = await api.postMoodboardMessage(targetBoardId, content, {
          agentCommand: runAgent || undefined,
          model: runModel || undefined,
          conversationId: activeConversationId || undefined,
        });
        if (!isCurrentBoard(targetBoardId)) return;
        if (result.nodes) setNodes(result.nodes);
        setMessages((cur) => {
          const withoutOptimistic = cur.filter((message) => message.id !== optimistic.id);
          const serverReturnedUser = result.messages.some((message) => message.role === "user" && message.content === content);
          const replacementMessages = serverReturnedUser ? result.messages : [optimistic, ...result.messages];
          return appendUniqueMessages(withoutOptimistic, replacementMessages);
        });
      } catch {
        if (isCurrentBoard(targetBoardId)) {
          setMessages((cur) => cur.filter((message) => message.id !== optimistic.id));
          toast("Couldn't send that message.", { variant: "error" });
        }
      } finally {
        if (isCurrentBoard(targetBoardId)) setAgentBusy(false);
      }
    },
    [api, boardId, conversationId, flushPendingNodes, isCurrentBoard, runAgent, runModel, toast],
  );

  const switchConversation = useCallback(
    async (nextConversationId: string) => {
      if (!nextConversationId || nextConversationId === conversationId) return;
      const targetBoardId = boardId;
      try {
        const nextMessages = await api.listMoodboardMessages(targetBoardId, nextConversationId);
        if (!isCurrentBoard(targetBoardId)) return;
        setConversationId(nextConversationId);
        setMessages(nextMessages);
      } catch {
        if (isCurrentBoard(targetBoardId)) toast("Couldn't load that conversation.", { variant: "error" });
      }
    },
    [api, boardId, conversationId, isCurrentBoard, toast],
  );

  const createConversation = useCallback(async () => {
    const targetBoardId = boardId;
    try {
      const conversation = await api.createMoodboardConversation(targetBoardId, `Conversation ${conversations.length + 1}`);
      if (!isCurrentBoard(targetBoardId)) return;
      setConversations((current) => [...current, conversation]);
      setConversationId(conversation.id);
      setMessages([]);
    } catch {
      if (isCurrentBoard(targetBoardId)) toast("Couldn't create a conversation.", { variant: "error" });
    }
  }, [api, boardId, conversations.length, isCurrentBoard, toast]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const targetBoardId = boardId;
      try {
        const conversation = await api.renameMoodboardConversation(targetBoardId, id, title);
        if (!isCurrentBoard(targetBoardId)) return;
        setConversations((current) => current.map((item) => (item.id === id ? { ...item, ...conversation } : item)));
      } catch {
        if (isCurrentBoard(targetBoardId)) toast("Couldn't rename that conversation.", { variant: "error" });
      }
    },
    [api, boardId, isCurrentBoard, toast],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      const targetBoardId = boardId;
      try {
        const result = await api.deleteMoodboardConversation(targetBoardId, id);
        if (!isCurrentBoard(targetBoardId)) return;
        setConversations(result.conversations);
        if (id === conversationId) {
          const next = result.conversations[0]?.id ?? "";
          setConversationId(next);
          const nextMessages = next ? await api.listMoodboardMessages(targetBoardId, next) : [];
          if (isCurrentBoard(targetBoardId)) setMessages(nextMessages);
        }
      } catch {
        if (isCurrentBoard(targetBoardId)) toast("Couldn't delete that conversation.", { variant: "error" });
      }
    },
    [api, boardId, conversationId, isCurrentBoard, toast],
  );

  const rescanAgents = useCallback(async () => {
    const next = await api.rescanAgents();
    setAgents(next);
    const available = next.filter((agent) => agent.available);
    setRunAgent((current) => current || available[0]?.command || "");
  }, [api]);

  const saveAgentModelDefaults = useCallback(
    (patch: Pick<Settings, "agentCommand" | "model">) => {
      persistAgentModelDefaults(api, patch, () => toast("Couldn't save settings.", { variant: "error" }));
    },
    [api, toast],
  );

  const setRunAgentDefault = useCallback(
    (command: string) => {
      setRunAgent(command);
      setRunModel("");
      setAgentDefaults({ agentCommand: command, model: "" });
      saveAgentModelDefaults({ agentCommand: command, model: "" });
    },
    [saveAgentModelDefaults],
  );

  const setRunModelDefault = useCallback(
    (model: string) => {
      setRunModel(model);
      if (!runAgent) return;
      setAgentDefaults({ agentCommand: runAgent, model });
      saveAgentModelDefaults({ agentCommand: runAgent, model });
    },
    [runAgent, saveAgentModelDefaults],
  );

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const setSelectedId = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), []);

  return {
    detail,
    nodes,
    assets,
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
    imageActionModels,
    loading,
    agentBusy,
    imageBusy,
    busy,
    setSelectedId,
    setSelectedIds,
    setRunAgent: setRunAgentDefault,
    setRunModel: setRunModelDefault,
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
    setCoverImage,
    flushPendingNodes,
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
