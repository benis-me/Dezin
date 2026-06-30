import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ImagePlus, Settings } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { MoodboardDetail, MoodboardMessage, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button, Dialog, IconButton, Input, Loading } from "../components/ui/index.ts";
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [generatePoint, setGeneratePoint] = useState<{ x: number; y: number } | null>(null);
  const [generatePrompt, setGeneratePrompt] = useState("");
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

  const addNote = () => {
    appendNodes([
      {
        id: localId(),
        type: "note",
        x: 80 + nodes.length * 18,
        y: 80 + nodes.length * 18,
        width: 220,
        height: 140,
        zIndex: nodes.length,
        data: { content: "New note" },
      },
    ]);
  };

  const addSection = () => {
    appendNodes([
      {
        id: localId(),
        type: "section",
        x: 40 + nodes.length * 18,
        y: 40 + nodes.length * 18,
        width: 460,
        height: 300,
        zIndex: Math.max(0, nodes.length - 1),
        data: { title: "Section" },
      },
    ]);
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

  const generateImage = async (prompt: string, point?: { x: number; y: number }) => {
    setBusy(true);
    try {
      const result = await api.generateMoodboardImage(boardId, prompt, point);
      setNodes(result.nodes);
      setMessages((cur) => [...cur, ...result.messages]);
      setSaveState("saved");
    } catch {
      toast("Couldn't generate an image. Check Media settings.", { variant: "error" });
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
      <header className="app-drag titlebar-pad-top flex h-[72px] shrink-0 items-end justify-between border-b border-border bg-background px-3 pb-2">
        <div className="app-no-drag flex min-w-0 items-center gap-2">
          <IconButton aria-label="Back to moodboards" onClick={onBack}>
            <ArrowLeft size={16} strokeWidth={1.75} />
          </IconButton>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{detail.name}</div>
            <div className="text-[11px] text-muted-foreground">{saveLabel}</div>
          </div>
        </div>
        <div className="app-no-drag flex items-center gap-1">
          <Button size="sm" variant="ghost" className="gap-2" onClick={() => setGeneratePoint({ x: 120, y: 120 })}>
            <ImagePlus size={14} strokeWidth={1.75} />
            Generate
          </Button>
          <IconButton aria-label="Open Media settings" onClick={() => onOpenSettings("media")}>
            <Settings size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      </header>

      <Group
        id="dezin-moodboard-layout"
        className="min-h-0 flex-1"
        defaultLayout={twoPanelLayout(MOODBOARD_AGENT_PANEL, agentPercent, MOODBOARD_CANVAS_PANEL)}
        onLayoutChanged={(layout) => savePanelFraction(MOODBOARD_AGENT_WIDTH_KEY, layout, MOODBOARD_AGENT_PANEL)}
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
      >
        <Panel id={MOODBOARD_AGENT_PANEL} minSize="280px" maxSize="520px" defaultSize={agentPercent} groupResizeBehavior="preserve-pixel-size">
          <MoodboardAgentPanel messages={messages} nodes={nodes} busy={busy} onSend={sendMessage} onGenerate={(prompt) => generateImage(prompt)} />
        </Panel>
        <Separator aria-label="Resize moodboard agent panel" className={RESIZE_SEPARATOR_CLASS} />
        <Panel id={MOODBOARD_CANVAS_PANEL} minSize="480px">
          <MoodboardCanvas
            nodes={nodes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onNodesChange={updateNodes}
            onAddNote={addNote}
            onAddSection={addSection}
            onUploadFiles={(files) => void uploadFiles(files)}
            onGenerateAt={(x, y) => setGeneratePoint({ x, y })}
          />
        </Panel>
      </Group>

      <Dialog open={generatePoint !== null} onClose={() => setGeneratePoint(null)} label="Generate image" className="max-w-md">
        <form
          className="p-5"
          onSubmit={(e) => {
            e.preventDefault();
            const prompt = generatePrompt.trim();
            const point = generatePoint;
            if (!prompt || !point) return;
            setGeneratePoint(null);
            setGeneratePrompt("");
            void generateImage(prompt, point);
          }}
        >
          <h2 className="text-base font-semibold tracking-tight">Generate image</h2>
          <p className="mt-1 text-sm text-muted-foreground">The image will be placed at the selected canvas position.</p>
          <Input
            aria-label="Image prompt"
            value={generatePrompt}
            autoFocus
            onChange={(e) => setGeneratePrompt(e.target.value)}
            placeholder="A refined material board with brushed steel and soft glass..."
            className="mt-4"
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setGeneratePoint(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={generatePrompt.trim().length === 0 || busy}>
              Generate
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
