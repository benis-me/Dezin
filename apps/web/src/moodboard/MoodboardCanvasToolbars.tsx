import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Eye,
  EyeOff,
  Hand,
  Layers,
  Loader2,
  Lock,
  LockOpen,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  SquareDashedMousePointer,
  StickyNote,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import type { MoodboardNode } from "../lib/api.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { generatorPrompt, generatorStatus, isNodeLocked, isNodeVisible, layerLabel, type MoodboardCanvasTool } from "./canvas-utils.ts";

export function ToolButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton aria-label={label} onClick={onClick} className={cn(active && "bg-accent text-foreground")}>
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent sideOffset={2}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SelectionToolbar({
  node,
  onDuplicate,
  onBringToFront,
  onSendToBack,
  onToggleVisible,
  onToggleLocked,
  onDelete,
}: {
  node: MoodboardNode;
  onDuplicate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onToggleVisible: () => void;
  onToggleLocked: () => void;
  onDelete: () => void;
}) {
  const visible = isNodeVisible(node);
  const locked = isNodeLocked(node);

  return (
    <TooltipProvider delayDuration={120}>
      <div className="pointer-events-auto app-no-drag flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl">
        <span className="max-w-40 truncate px-2 text-xs font-medium text-muted-foreground">{layerLabel(node)}</span>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Duplicate" onClick={onDuplicate}>
          <Copy size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Bring to front" onClick={onBringToFront}>
          <ArrowUpToLine size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Send to back" onClick={onSendToBack}>
          <ArrowDownToLine size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label={visible ? "Hide layer" : "Show layer"} onClick={onToggleVisible}>
          {visible ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
        </ToolButton>
        <ToolButton label={locked ? "Unlock layer" : "Lock layer"} onClick={onToggleLocked}>
          {locked ? <LockOpen size={14} strokeWidth={1.75} /> : <Lock size={14} strokeWidth={1.75} />}
        </ToolButton>
        <ToolButton label="Delete" onClick={onDelete}>
          <Trash2 size={14} strokeWidth={1.75} />
        </ToolButton>
      </div>
    </TooltipProvider>
  );
}

export function CanvasActionBar({
  tool,
  layersOpen,
  onToolChange,
  onUpload,
  onAddImageGenerator,
  onToggleLayers,
}: {
  tool: MoodboardCanvasTool;
  layersOpen: boolean;
  onToolChange: (tool: MoodboardCanvasTool) => void;
  onUpload: () => void;
  onAddImageGenerator: () => void;
  onToggleLayers: () => void;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <div
        data-moodboard-floating-occluder
        className="app-no-drag absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      >
        <ToolButton label="Select" active={tool === "select"} onClick={() => onToolChange("select")}>
          <MousePointer2 size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Hand" active={tool === "hand"} onClick={() => onToolChange("hand")}>
          <Hand size={15} strokeWidth={1.75} />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Add note" active={tool === "note"} onClick={() => onToolChange("note")}>
          <StickyNote size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Add section" active={tool === "section"} onClick={() => onToolChange("section")}>
          <SquareDashedMousePointer size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Upload images" onClick={onUpload}>
          <Upload size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Image generator" onClick={onAddImageGenerator}>
          <WandSparkles size={15} strokeWidth={1.75} />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Layers" active={layersOpen} onClick={onToggleLayers}>
          <Layers size={15} strokeWidth={1.75} />
        </ToolButton>
      </div>
    </TooltipProvider>
  );
}

const ZOOM_PRESETS = [0.5, 1, 2];

export function CanvasZoomBar({
  zoom,
  onChangeZoom,
  onFitView,
}: {
  zoom: number;
  onChangeZoom: (zoom: number) => void;
  onFitView: () => void;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <div
        data-moodboard-floating-occluder
        className="app-no-drag absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      >
        <ToolButton label="Zoom out" onClick={() => onChangeZoom(zoom * 0.88)}>
          <Minus size={15} strokeWidth={1.75} />
        </ToolButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="h-8 min-w-12 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            aria-label="Canvas zoom options"
          >
            {Math.round(zoom * 100)}%
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="center" className="w-36">
            <DropdownMenuItem onClick={onFitView}>
              <Maximize2 size={13} strokeWidth={1.75} />
              Fit view
            </DropdownMenuItem>
            {ZOOM_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset} onClick={() => onChangeZoom(preset)}>
                {Math.round(preset * 100)}%
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton label="Zoom in" onClick={() => onChangeZoom(zoom * 1.14)}>
          <Plus size={15} strokeWidth={1.75} />
        </ToolButton>
      </div>
    </TooltipProvider>
  );
}

export function GeneratorPromptToolbar({
  node,
  busy,
  onPromptChange,
  onGenerate,
}: {
  node: MoodboardNode;
  busy: boolean;
  onPromptChange: (prompt: string) => void;
  onGenerate: (prompt: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(generatorPrompt(node));
  const status = generatorStatus(node);

  useEffect(() => {
    setPrompt(generatorPrompt(node));
  }, [node]);

  const submit = async () => {
    const next = prompt.trim();
    if (!next || busy) return;
    onPromptChange(next);
    await onGenerate(next);
  };

  return (
    <div className="pointer-events-auto app-no-drag w-[min(600px,calc(100vw-3rem))] rounded-lg border border-border bg-card/95 p-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl">
      <Textarea
        aria-label="Image generator prompt"
        rows={3}
        value={prompt}
        autoFocus
        placeholder="Describe the image material this generator should create..."
        onChange={(event) => {
          setPrompt(event.target.value);
          onPromptChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        className="min-h-20 resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0"
      />
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
        <span className="label-mono text-muted-foreground">
          {busy ? "Generating" : status === "done" ? "Ready · last image generated" : "Image generator"}
        </span>
        <Button size="sm" disabled={busy || prompt.trim().length === 0} onClick={() => void submit()} className="h-8 gap-2">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} strokeWidth={1.75} />}
          Generate
        </Button>
      </div>
    </div>
  );
}
