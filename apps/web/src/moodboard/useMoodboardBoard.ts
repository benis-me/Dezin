import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo, MoodboardDetail, MoodboardMessage, MoodboardNode, SaveMoodboardNodeInput, Settings } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { MODEL_PROVIDERS } from "../settings/model-provider-registry.ts";
import { inferCapabilities, parseModelEntries } from "../settings/model-provider-ui-utils.tsx";
import { toInput } from "./canvas-utils.ts";
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

export function useMoodboardBoard(boardId: string) {
  const api = useApi();
  const { toast } = useToast();
  const [detail, setDetail] = useState<MoodboardDetail | null>(null);
  const [nodes, setNodes] = useState<MoodboardNode[]>([]);
  const [messages, setMessages] = useState<MoodboardMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [imageModel, setImageModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const pendingSaveInputs = useRef<SaveMoodboardNodeInput[] | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getMoodboard(boardId)
      .then((next) => {
        setDetail(next);
        setNodes(next.nodes);
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

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        const models = imageModelOptions(settings);
        const configuredImageModel = settings.imageModel.trim();
        setImageModels(models);
        setImageModel((current) => (current && models.includes(current) ? current : models.includes(configuredImageModel) ? configuredImageModel : models[0] || ""));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

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
    (point?: { x: number; y: number }) => {
      const node = createImageGeneratorNode(nodes.length, point);
      appendNodes([node]);
      setSelectedIds(node.id ? [node.id] : []);
    },
    [appendNodes, nodes.length],
  );

  const uploadFiles = useCallback(
    async (files: FileList | null, point?: { x: number; y: number }) => {
      if (!files?.length) return;
      setBusy(true);
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
        setBusy(false);
      }
    },
    [api, appendNodes, boardId, nodes.length, toast],
  );

  const generateImage = useCallback(
    async (node: MoodboardNode, prompt: string) => {
      const selectedModel =
        typeof node.data.generatorModel === "string" && node.data.generatorModel.trim() ? node.data.generatorModel.trim() : imageModel;
      setBusy(true);
      setNodes((prev) =>
        prev.map((item) =>
          item.id === node.id
            ? { ...item, data: { ...item.data, generatorPrompt: prompt, generatorModel: selectedModel, generatorStatus: "running" } }
            : item,
        ),
      );
      try {
        const result = await api.generateMoodboardImage(boardId, prompt, {
          generatorId: node.id,
          model: selectedModel || undefined,
          x: node.x + node.width + 24,
          y: node.y,
        });
        setNodes(result.nodes);
        setMessages((cur) => [...cur, ...result.messages]);
      } catch {
        toast("Couldn't generate an image. Check Models settings.", { variant: "error" });
      } finally {
        setBusy(false);
      }
    },
    [api, boardId, imageModel, toast],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      setBusy(true);
      try {
        if (!(await flushPendingNodes())) return;
        const result = await api.postMoodboardMessage(boardId, content, { agentCommand: runAgent || undefined, model: runModel || undefined });
        if (result.nodes) setNodes(result.nodes);
        setMessages((cur) => [...cur, ...result.messages]);
      } catch {
        toast("Couldn't send that message.", { variant: "error" });
      } finally {
        setBusy(false);
      }
    },
    [api, boardId, flushPendingNodes, runAgent, runModel, toast],
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
    messages,
    selectedId,
    selectedIds,
    agents,
    runAgent,
    runModel,
    imageModels,
    imageModel,
    loading,
    busy,
    setSelectedId,
    setSelectedIds,
    setRunAgent,
    setRunModel,
    setImageModel,
    updateNodes,
    addNote,
    addSection,
    addImageGenerator,
    uploadFiles,
    generateImage,
    sendMessage,
    rescanAgents,
  };
}

export function imageModelOptions(settings: Settings): string[] {
  const models = new Set<string>();
  const selectedProvider = MODEL_PROVIDERS.find((provider) => provider.id === settings.aiProviderId);
  const knownCapabilities = new Map<string, Set<string>>();
  for (const provider of MODEL_PROVIDERS) {
    for (const model of provider.models) knownCapabilities.set(model.id, new Set(model.capabilities));
  }

  const configuredImageModel = settings.imageModel.trim();
  const hasLegacyImageEndpoint = Boolean(settings.imageApiBaseUrl.trim() && settings.imageApiKey.trim() && configuredImageModel);
  if (!settings.aiProviderEnabled && !hasLegacyImageEndpoint) return [];

  if (settings.aiProviderEnabled) {
    for (const model of selectedProvider?.models ?? []) {
      if (model.capabilities.includes("Image")) models.add(model.id);
    }
    for (const entry of parseModelEntries(settings.aiProviderModels)) {
      const known = knownCapabilities.get(entry.id);
      const capabilities = entry.capabilities ?? (known ? [...known] : inferCapabilities(entry.id));
      if (capabilities.includes("Image") && !capabilities.includes("Video")) models.add(entry.id);
    }
  }

  if (hasLegacyImageEndpoint) {
    models.add(configuredImageModel);
  } else if (settings.aiProviderEnabled && configuredImageModel) {
    const known = knownCapabilities.get(configuredImageModel);
    const capabilities = known ? [...known] : inferCapabilities(configuredImageModel);
    if (capabilities.includes("Image") && !capabilities.includes("Video")) models.add(configuredImageModel);
  }
  return [...models];
}
