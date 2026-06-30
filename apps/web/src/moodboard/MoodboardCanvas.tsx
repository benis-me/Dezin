import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Hand, ImagePlus, MousePointer2, Plus, SquareDashedMousePointer, StickyNote, Upload } from "lucide-react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { Button, IconButton, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";

type Tool = "select" | "pan";

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

interface DragState {
  kind: "pan" | "node";
  id?: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

function nodeText(node: MoodboardNode): string {
  const content = node.data.content;
  return typeof content === "string" ? content : "";
}

function nodeTitle(node: MoodboardNode): string {
  const title = node.data.title;
  return typeof title === "string" ? title : node.type === "section" ? "Section" : "Note";
}

function assetUrl(node: MoodboardNode): string {
  const url = node.data.url;
  return typeof url === "string" ? url : "";
}

function promptText(node: MoodboardNode): string {
  const prompt = node.data.prompt;
  return typeof prompt === "string" ? prompt : "";
}

export function MoodboardCanvas({
  nodes,
  selectedId,
  onSelect,
  onNodesChange,
  onAddNote,
  onAddSection,
  onUploadFiles,
  onGenerateAt,
}: {
  nodes: MoodboardNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNodesChange: (nodes: SaveMoodboardNodeInput[]) => void;
  onAddNote: () => void;
  onAddSection: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onGenerateAt: (x: number, y: number) => void;
}) {
  const [tool, setTool] = useState<Tool>("select");
  const [viewport, setViewport] = useState<Viewport>({ x: 220, y: 120, scale: 1 });
  const drag = useRef<DragState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = useCallback(
    (next: MoodboardNode[]) =>
      onNodesChange(
        next.map((n) => ({
          id: n.id,
          type: n.type,
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
          rotation: n.rotation,
          zIndex: n.zIndex,
          data: n.data,
        })),
      ),
    [onNodesChange],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<MoodboardNode>) => {
      const next = nodes.map((node) => (node.id === id ? { ...node, ...patch } : node));
      save(next);
    },
    [nodes, save],
  );

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      const nextScale = Math.min(2.5, Math.max(0.25, viewport.scale * (event.deltaY > 0 ? 0.92 : 1.08)));
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const wx = (mx - viewport.x) / viewport.scale;
      const wy = (my - viewport.y) / viewport.scale;
      setViewport({ x: mx - wx * nextScale, y: my - wy * nextScale, scale: nextScale });
    } else {
      setViewport((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    }
  };

  const onBlankPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    onSelect(null);
    drag.current = { kind: "pan", startX: event.clientX, startY: event.clientY, originX: viewport.x, originY: viewport.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setViewport((v) => ({ ...v, x: d.originX + event.clientX - d.startX, y: d.originY + event.clientY - d.startY }));
      return;
    }
    if (d.id) {
      updateNode(d.id, {
        x: d.originX + (event.clientX - d.startX) / viewport.scale,
        y: d.originY + (event.clientY - d.startY) / viewport.scale,
      });
    }
  };

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer may already be released */
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="relative h-full min-w-0 bg-background">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          onUploadFiles(e.target.files);
          e.currentTarget.value = "";
        }}
      />

      <TooltipProvider delayDuration={120}>
        <div className="app-no-drag absolute left-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-pop">
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton aria-label="Select" className={cn(tool === "select" && "bg-accent text-foreground")} onClick={() => setTool("select")}>
                <MousePointer2 size={15} strokeWidth={1.75} />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent sideOffset={2}>Select</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton aria-label="Pan" className={cn(tool === "pan" && "bg-accent text-foreground")} onClick={() => setTool("pan")}>
                <Hand size={15} strokeWidth={1.75} />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent sideOffset={2}>Pan</TooltipContent>
          </Tooltip>
          <span className="mx-1 h-5 w-px bg-border" />
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton aria-label="Add note" onClick={onAddNote}>
                <StickyNote size={15} strokeWidth={1.75} />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent sideOffset={2}>Add note</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton aria-label="Add section" onClick={onAddSection}>
                <SquareDashedMousePointer size={15} strokeWidth={1.75} />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent sideOffset={2}>Add section</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton aria-label="Upload images" onClick={() => inputRef.current?.click()}>
                <Upload size={15} strokeWidth={1.75} />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent sideOffset={2}>Upload images</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>

      <div
        className={cn("dz-canvas h-full w-full overflow-hidden", tool === "pan" ? "cursor-grab active:cursor-grabbing" : "cursor-default")}
        onWheel={onWheel}
        onPointerDown={onBlankPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onGenerateAt((event.clientX - rect.left - viewport.x) / viewport.scale, (event.clientY - rect.top - viewport.y) / viewport.scale);
        }}
      >
        <div
          className="absolute left-0 top-0"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: "0 0" }}
        >
          {nodes.map((node) => {
            const selectedNode = selectedId === node.id;
            return (
              <div
                key={node.id}
                className={cn(
                  "absolute overflow-hidden rounded-lg border bg-card text-card-foreground transition-[border-color,box-shadow]",
                  node.type === "section" ? "bg-background/35" : "bg-card",
                  selectedNode ? "border-primary ring-2 ring-ring/25" : "border-border hover:border-border-strong",
                )}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  zIndex: node.zIndex,
                  transform: `rotate(${node.rotation}deg)`,
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (event.button !== 0 || tool === "pan") return;
                  onSelect(node.id);
                  drag.current = { kind: "node", id: node.id, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
              >
                {node.type === "image" ? (
                  <div className="h-full w-full bg-surface-2">
                    {assetUrl(node) ? <img src={assetUrl(node)} alt={promptText(node) || "Moodboard image"} className="h-full w-full object-cover" draggable={false} /> : null}
                    {promptText(node) ? (
                      <div className="absolute inset-x-0 bottom-0 bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
                        <span className="line-clamp-2">{promptText(node)}</span>
                      </div>
                    ) : null}
                  </div>
                ) : node.type === "section" ? (
                  <div className="flex h-full flex-col">
                    <div className="border-b border-border bg-background/70 px-2 py-1.5 text-xs font-medium">{nodeTitle(node)}</div>
                    <div className="flex-1" />
                  </div>
                ) : node.type === "video" ? (
                  <div className="grid h-full place-items-center bg-surface-2 text-xs text-muted-foreground">Video placeholder</div>
                ) : (
                  <div className="flex h-full flex-col bg-[color-mix(in_oklch,var(--surface)_88%,var(--background))]">
                    <div className="h-6 shrink-0 border-b border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">Note</div>
                    <textarea
                      value={nodeText(node)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) => updateNode(node.id, { data: { ...node.data, content: event.target.value } })}
                      className="dz-selectable min-h-0 flex-1 resize-none bg-transparent p-3 text-sm leading-relaxed outline-none"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="pointer-events-auto flex flex-col items-center gap-3 text-center">
              <span className="grid size-14 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
                <ImagePlus size={24} strokeWidth={1.5} />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">Start collecting direction</p>
                <p className="mt-1 text-xs text-muted-foreground">Upload images, add notes, or double-click the canvas to generate.</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
                <Plus size={14} strokeWidth={1.75} />
                Add images
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="absolute bottom-3 right-3 rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow-pop">
        {Math.round(viewport.scale * 100)}%
        {selected ? <span className="ml-2 text-foreground">{selected.type}</span> : null}
      </div>
    </div>
  );
}
