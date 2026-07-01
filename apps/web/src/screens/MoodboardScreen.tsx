import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { AgentInfo, MoodboardDetail, MoodboardMessage, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button, IconButton, Loading } from "../components/ui/index.ts";
import { readPanelPercent, RESIZE_SEPARATOR_CLASS, savePanelFraction, twoPanelLayout } from "../lib/panel-layout.ts";
import { MoodboardAgentPanel } from "../moodboard/MoodboardAgentPanel.tsx";
import { MoodboardCanvas } from "../moodboard/MoodboardCanvas.tsx";

const MOODBOARD_AGENT_PANEL = "agent";
const MOODBOARD_CANVAS_PANEL = "canvas";
const MOODBOARD_AGENT_WIDTH_KEY = "dezin.moodboard.agent.width";

function localId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nodeInput(node: MoodboardNode): SaveMoodboardNodeInput {
  return {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    zIndex: node.zIndex,
    data: node.data,
  };
}

function materialize(boardId: string, inputs: SaveMoodboardNodeInput[], previous: MoodboardNode[]): MoodboardNode[] {
  const now = Date.now();
  const old = new Map(previous.map((node) => [node.id, node]));
  return inputs.map((input, index) => {
    const id = input.id || localId();
    const prev = old.get(id);
    return {
      id,
      boardId,
      type: input.type,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      rotation: input.rotation ?? 0,
      zIndex: input.zIndex ?? index,
      data: input.data ?? {},
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
  });
}

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return dataUrl.split(",")[1] ?? "";
}

async function imageSize(file: File): Promise<{ width: number | undefined; height: number | undefined }> {
  if (!file.type.startsWith("image/")) return { width: undefined, height: undefined };
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image failed"));
      image.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return { width: undefined, height: undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function MoodboardScreen({
  boardId,
  onBack,
  onOpenSettings,
}: {
  boardId: string;
  onBack: () => void;
  onOpenSettings: (section?: string) => void;
}) {
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
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const saveTimer = useRef<number | null>(null);
  const agentPercent = readPanelPercent(MOODBOARD_AGENT_WIDTH_KEY, 28, 20, 44);

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
      setSaveState("saving");
      saveTimer.current = window.setTimeout(() => {
        void api
          .saveMoodboardNodes(boardId, inputs)
          .then((saved) => {
            setNodes(saved);
            setSaveState("saved");
          })
          .catch(() => {
            setSaveState("error");
            toast("Couldn't save the board.", { variant: "error" });
          });
      }, 350);
    },
    [api, boardId, toast],
  );

  const updateNodes = useCallback(
    (inputs: SaveMoodboardNodeInput[]) => {
      setNodes((prev) => {
        const next = materialize(boardId, inputs, prev);
        persistNodes(next.map(nodeInput));
        return next;
      });
    },
    [boardId, persistNodes],
  );

  const appendNodes = useCallback(
    (newNodes: SaveMoodboardNodeInput[]) => {
      setNodes((prev) => {
        const next = materialize(boardId, [...prev.map(nodeInput), ...newNodes], prev);
        persistNodes(next.map(nodeInput));
        return next;
      });
    },
    [boardId, persistNodes],
  );

  const addNote = (point?: { x: number; y: number }) => {
    appendNodes([
      {
        id: localId(),
        type: "note",
        x: point?.x ?? 80 + nodes.length * 18,
        y: point?.y ?? 80 + nodes.length * 18,
        width: 220,
        height: 140,
        zIndex: nodes.length,
        data: { content: "New note" },
      },
    ]);
  };

  const addSection = (point?: { x: number; y: number }) => {
    appendNodes([
      {
        id: localId(),
        type: "section",
        x: point?.x ?? 40 + nodes.length * 18,
        y: point?.y ?? 40 + nodes.length * 18,
        width: 460,
        height: 300,
        zIndex: Math.max(0, nodes.length - 1),
        data: { title: "Section" },
      },
    ]);
  };

  const addImageGenerator = (point?: { x: number; y: number }) => {
    const id = localId();
    appendNodes([
      {
        id,
        type: "image-generator",
        x: point?.x ?? 120 + nodes.length * 20,
        y: point?.y ?? 120 + nodes.length * 20,
        width: 360,
        height: 240,
        zIndex: Math.max(0, nodes.length),
        data: { generatorPrompt: "", generatorStatus: "ready" },
      },
    ]);
    setSelectedId(id);
  };

  const uploadFiles = async (files: FileList | null) => {
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
        nextNodes.push({
          id: localId(),
          type: "image",
          x: 80 + (nodes.length + index) * 24,
          y: 80 + (nodes.length + index) * 24,
          width: 320,
          height: size.width && size.height ? Math.max(160, Math.round(320 * (size.height / size.width))) : 240,
          zIndex: nodes.length + index,
          data: { assetId: asset.id, url: asset.url, fileName: asset.fileName, source: "upload" },
        });
      }
      if (nextNodes.length) appendNodes(nextNodes);
    } catch {
      toast("Couldn't upload those images.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const generateImage = async (node: MoodboardNode, prompt: string) => {
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
      setSaveState("saved");
    } catch {
      toast("Couldn't generate an image. Check Models settings.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async (content: string) => {
    setBusy(true);
    try {
      const result = await api.postMoodboardMessage(boardId, content);
      setMessages((cur) => [...cur, ...result.messages]);
    } catch {
      toast("Couldn't send that message.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const rescanAgents = async () => {
    const next = await api.rescanAgents();
    setAgents(next);
    const available = next.filter((agent) => agent.available);
    setRunAgent((current) => current || available[0]?.command || "");
  };

  const saveLabel = useMemo(() => {
    if (saveState === "saving") return "Saving...";
    if (saveState === "error") return "Save failed";
    return "Saved";
  }, [saveState]);

  if (loading) return <Loading label="Loading moodboard..." />;
  if (!detail) {
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center">
          <p className="text-sm font-medium">Moodboard not found</p>
          <Button className="mt-3" variant="outline" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <Group
        id="dezin-moodboard-layout"
        className="min-h-0 flex-1"
        defaultLayout={twoPanelLayout(MOODBOARD_AGENT_PANEL, agentPercent, MOODBOARD_CANVAS_PANEL)}
        onLayoutChanged={(layout) => savePanelFraction(MOODBOARD_AGENT_WIDTH_KEY, layout, MOODBOARD_AGENT_PANEL)}
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
      >
        <Panel id={MOODBOARD_AGENT_PANEL} minSize="280px" maxSize="520px" defaultSize={agentPercent} groupResizeBehavior="preserve-pixel-size">
          <MoodboardAgentPanel
            boardName={detail.name}
            status={saveLabel}
            messages={messages}
            busy={busy}
            agents={agents}
            agent={runAgent}
            model={runModel}
            onBack={onBack}
            onAgentChange={(value) => {
              setRunAgent(value);
              setRunModel("");
            }}
            onModelChange={setRunModel}
            onRescanAgents={rescanAgents}
            onSend={sendMessage}
          />
        </Panel>
        <Separator aria-label="Resize moodboard agent panel" className={RESIZE_SEPARATOR_CLASS} />
        <Panel id={MOODBOARD_CANVAS_PANEL} minSize="480px">
          <section aria-label="Moodboard canvas" className="flex h-full min-w-0 flex-col">
            <div className="app-drag flex h-10 shrink-0 items-center justify-end gap-2 border-b border-border px-1">
              <div className="app-no-drag flex items-center gap-1">
                <IconButton aria-label="Open model settings" onClick={() => onOpenSettings("models")}>
                  <Settings size={15} strokeWidth={1.75} />
                </IconButton>
              </div>
            </div>
            <MoodboardCanvas
              nodes={nodes}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onNodesChange={updateNodes}
              onAddNote={addNote}
              onAddSection={addSection}
              onAddImageGenerator={addImageGenerator}
              onUploadFiles={(files) => void uploadFiles(files)}
              onGenerateImage={generateImage}
            />
          </section>
        </Panel>
      </Group>
    </div>
  );
}
