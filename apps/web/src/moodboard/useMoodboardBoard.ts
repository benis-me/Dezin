import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo, MoodboardDetail, MoodboardMessage, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<number | null>(null);

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
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  const persistNodes = useCallback(
    (inputs: SaveMoodboardNodeInput[]) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void api
          .saveMoodboardNodes(boardId, inputs)
          .then((saved) => {
            setNodes(saved);
          })
          .catch(() => {
            toast("Couldn't save the board.", { variant: "error" });
          });
      }, 350);
    },
    [api, boardId, toast],
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
      setSelectedId(node.id ?? null);
    },
    [appendNodes, nodes.length],
  );

  const uploadFiles = useCallback(
    async (files: FileList | null) => {
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
          nextNodes.push(createImageNode(asset, nodes.length, index, size));
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
      setBusy(true);
      setNodes((prev) =>
        prev.map((item) =>
          item.id === node.id
            ? { ...item, data: { ...item.data, generatorPrompt: prompt, generatorStatus: "running" } }
            : item,
        ),
      );
      try {
        const result = await api.generateMoodboardImage(boardId, prompt, {
          generatorId: node.id,
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
    [api, boardId, toast],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      setBusy(true);
      try {
        const result = await api.postMoodboardMessage(boardId, content, { agentCommand: runAgent || undefined, model: runModel || undefined });
        setMessages((cur) => [...cur, ...result.messages]);
      } catch {
        toast("Couldn't send that message.", { variant: "error" });
      } finally {
        setBusy(false);
      }
    },
    [api, boardId, runAgent, runModel, toast],
  );

  const rescanAgents = useCallback(async () => {
    const next = await api.rescanAgents();
    setAgents(next);
    const available = next.filter((agent) => agent.available);
    setRunAgent((current) => current || available[0]?.command || "");
  }, [api]);

  return {
    detail,
    nodes,
    messages,
    selectedId,
    agents,
    runAgent,
    runModel,
    loading,
    busy,
    setSelectedId,
    setRunAgent,
    setRunModel,
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
