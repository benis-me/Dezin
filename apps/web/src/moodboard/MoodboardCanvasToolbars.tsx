import { useEffect, useState, type ReactNode } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Copy,
  Hand,
  LayoutGrid,
  Layers,
  Loader2,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { generatorPrompt, generatorStatus, type MoodboardAlignType, type MoodboardCanvasTool } from "./canvas-utils.ts";

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
  onDuplicate,
  onDelete,
}: {
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <div className="pointer-events-auto app-no-drag flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl">
        <ToolButton label="Duplicate" onClick={onDuplicate}>
          <Copy size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Delete" onClick={onDelete}>
          <Trash2 size={14} strokeWidth={1.75} />
        </ToolButton>
      </div>
    </TooltipProvider>
  );
}

export function MultiSelectionToolbar({
  nodes,
  onDuplicate,
  onAlign,
  onArrange,
  onDelete,
}: {
  nodes: MoodboardNode[];
  onDuplicate: () => void;
  onAlign: (type: MoodboardAlignType) => void;
  onArrange: () => void;
  onDelete: () => void;
}) {
  const [alignOpen, setAlignOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={120}>
      <div className="pointer-events-auto app-no-drag flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl">
        <span className="px-2 text-xs font-medium text-muted-foreground">{nodes.length} selected</span>
        <span className="mx-0.5 h-5 w-px bg-border" />
        <ToolButton label="Duplicate selected" onClick={onDuplicate}>
          <Copy size={14} strokeWidth={1.75} />
        </ToolButton>
        <DropdownMenu open={alignOpen} onOpenChange={setAlignOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label="Align selected" onClick={() => setAlignOpen((open) => !open)}>
                  <AlignStartVertical size={14} strokeWidth={1.75} />
                </IconButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent sideOffset={2}>Align selected</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="top" align="center" className="w-44">
            <DropdownMenuItem onClick={() => onAlign("left")}>
              <AlignStartVertical size={14} strokeWidth={1.75} />
              Align left
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAlign("center-v")}>
              <AlignCenterVertical size={14} strokeWidth={1.75} />
              Align center
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAlign("right")}>
              <AlignEndVertical size={14} strokeWidth={1.75} />
              Align right
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAlign("top")}>
              <AlignStartHorizontal size={14} strokeWidth={1.75} />
              Align top
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAlign("center-h")}>
              <AlignCenterHorizontal size={14} strokeWidth={1.75} />
              Align middle
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAlign("bottom")}>
              <AlignEndHorizontal size={14} strokeWidth={1.75} />
              Align bottom
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton label="Arrange selected" onClick={onArrange}>
          <LayoutGrid size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Delete selected" onClick={onDelete}>
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
  models,
  model,
  onModelChange,
  onPromptChange,
  onGenerate,
}: {
  node: MoodboardNode;
  busy: boolean;
  models: string[];
  model: string;
  onModelChange: (model: string) => void;
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
  const modelOptions = models.length ? models : [model].filter(Boolean);

  return (
    <div className="pointer-events-auto app-no-drag w-[min(560px,calc(100vw-3rem))] rounded-xl border border-border bg-card/95 p-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl">
      <div className="rounded-lg border border-input bg-background px-2 pb-2 pt-2">
        <Textarea
          aria-label="Image generator prompt"
          rows={2}
          value={prompt}
          autoFocus
          placeholder="Describe the image material to generate..."
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
          className="min-h-14 resize-none border-0 bg-transparent px-0.5 py-0 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/70 pt-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="label-mono shrink-0 text-muted-foreground">Model</span>
            {modelOptions.length ? (
              <Select value={model || "__default__"} onValueChange={(value) => onModelChange(value === "__default__" ? "" : value)}>
                <SelectTrigger aria-label="Image generation model" size="sm" className="h-7 max-w-52 border-border bg-surface-2 px-2 text-xs shadow-none">
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent side="top" align="start" className="max-h-56">
                  <SelectItem value="__default__">Default</SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="rounded-md bg-surface-2 px-2 py-1 text-xs text-muted-foreground">Default</span>
            )}
          </div>
          <Button size="sm" disabled={busy || prompt.trim().length === 0} onClick={() => void submit()} className="h-7 gap-1.5 px-2.5 text-xs">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <WandSparkles size={13} strokeWidth={1.75} />}
            Generate
          </Button>
        </div>
      </div>
      <p className="mt-1.5 px-0.5 text-[11px] text-muted-foreground">
        {busy ? "Generating..." : status === "done" ? "Last image generated." : "Creates a new image next to this generator node."}
      </p>
    </div>
  );
}
