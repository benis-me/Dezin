import { useEffect, useState, type ReactNode } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Brush,
  Check,
  ChevronDown,
  Copy,
  Eraser,
  Hand,
  LayoutGrid,
  Layers,
  Maximize2,
  Minus,
  MousePointer2,
  Presentation,
  Plus,
  Scissors,
  SquareDashedMousePointer,
  StickyNote,
  Trash2,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { generatorPrompt, type MoodboardAlignType, type MoodboardCanvasTool } from "./canvas-utils.ts";

export function ToolButton({
  label,
  active = false,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          aria-label={label}
          onClick={disabled ? undefined : onClick}
          aria-disabled={disabled}
          className={cn(active && "bg-accent text-foreground", disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground")}
        >
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent sideOffset={2}>{label}</TooltipContent>
    </Tooltip>
  );
}

function stopToolbarEvent(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function ToolbarChrome({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-moodboard-toolbar
      className={cn("pointer-events-auto app-no-drag rounded-lg border border-border bg-card/95 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl", className)}
      onPointerDown={stopToolbarEvent}
      onMouseDown={stopToolbarEvent}
    >
      {children}
    </div>
  );
}

function TabHint() {
  return <span className="ml-1 rounded border border-border/80 bg-surface px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">Tab</span>;
}

export function SelectionToolbar({
  node,
  onDuplicate,
  onDelete,
  onImageAction,
  onQuickEdit,
}: {
  node: MoodboardNode;
  onDuplicate: () => void;
  onDelete: () => void;
  onImageAction?: (action: string) => void;
  onQuickEdit?: () => void;
}) {
  const imageLike = node.type === "image";
  return (
    <TooltipProvider delayDuration={120}>
      <ToolbarChrome className="flex items-center gap-1 p-1">
        {imageLike ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="ghost" onClick={onQuickEdit} className="h-7 gap-1.5 px-2 text-xs font-medium">
                  Quick edit
                  <TabHint />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Quick edit</TooltipContent>
            </Tooltip>
            <ToolButton label="Remove background" onClick={() => onImageAction?.("Remove background")}>
              <Eraser size={14} strokeWidth={1.75} />
            </ToolButton>
            <ToolButton label="Edit region" onClick={() => onImageAction?.("Edit region")}>
              <Brush size={14} strokeWidth={1.75} />
            </ToolButton>
            <ToolButton label="Extract layer" onClick={() => onImageAction?.("Extract layer")}>
              <Scissors size={14} strokeWidth={1.75} />
            </ToolButton>
            <span className="mx-0.5 h-5 w-px bg-border" />
          </>
        ) : null}
        <ToolButton label="Duplicate" onClick={onDuplicate}>
          <Copy size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Delete" onClick={onDelete}>
          <Trash2 size={14} strokeWidth={1.75} />
        </ToolButton>
      </ToolbarChrome>
    </TooltipProvider>
  );
}

export function MultiSelectionToolbar({
  nodes,
  onDuplicate,
  onAlign,
  onArrange,
  onDelete,
  onImageAction,
  onQuickEdit,
}: {
  nodes: MoodboardNode[];
  onDuplicate: () => void;
  onAlign: (type: MoodboardAlignType) => void;
  onArrange: () => void;
  onDelete: () => void;
  onImageAction?: (action: string) => void;
  onQuickEdit?: () => void;
}) {
  const [alignOpen, setAlignOpen] = useState(false);
  const imageOnly = nodes.length > 0 && nodes.every((node) => node.type === "image");

  return (
    <TooltipProvider delayDuration={120}>
      <ToolbarChrome className="flex items-center gap-1 p-1">
        <span className="px-2 text-xs font-medium text-muted-foreground">{nodes.length} selected</span>
        <span className="mx-0.5 h-5 w-px bg-border" />
        {imageOnly ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="ghost" onClick={onQuickEdit} className="h-7 gap-1.5 px-2 text-xs font-medium">
                  Quick edit
                  <TabHint />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Quick edit</TooltipContent>
            </Tooltip>
            <ToolButton label="Remove backgrounds" onClick={() => onImageAction?.("Remove backgrounds")}>
              <Eraser size={14} strokeWidth={1.75} />
            </ToolButton>
            <ToolButton label="Edit regions" onClick={() => onImageAction?.("Edit regions")}>
              <Brush size={14} strokeWidth={1.75} />
            </ToolButton>
            <span className="mx-0.5 h-5 w-px bg-border" />
          </>
        ) : null}
        <ToolButton label="Duplicate selected" onClick={onDuplicate}>
          <Copy size={14} strokeWidth={1.75} />
        </ToolButton>
        <Popover open={alignOpen} onOpenChange={setAlignOpen} modal={false}>
          <PopoverTrigger asChild>
            <IconButton aria-label="Align selected" title="Align selected">
              <AlignStartVertical size={14} strokeWidth={1.75} />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className="w-44 p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDown={stopToolbarEvent}
            onMouseDown={stopToolbarEvent}
            onPointerDownOutside={(event) => {
              const target = event.target;
              if (target instanceof Node && document.querySelector("[data-moodboard-toolbar]")?.contains(target)) event.preventDefault();
            }}
          >
            <AlignMenuItem
              icon={<AlignStartVertical size={14} strokeWidth={1.75} />}
              label="Align left"
              onClick={() => {
                onAlign("left");
                setAlignOpen(false);
              }}
            />
            <AlignMenuItem
              icon={<AlignCenterVertical size={14} strokeWidth={1.75} />}
              label="Align center"
              onClick={() => {
                onAlign("center-v");
                setAlignOpen(false);
              }}
            />
            <AlignMenuItem
              icon={<AlignEndVertical size={14} strokeWidth={1.75} />}
              label="Align right"
              onClick={() => {
                onAlign("right");
                setAlignOpen(false);
              }}
            />
            <AlignMenuItem
              icon={<AlignStartHorizontal size={14} strokeWidth={1.75} />}
              label="Align top"
              onClick={() => {
                onAlign("top");
                setAlignOpen(false);
              }}
            />
            <AlignMenuItem
              icon={<AlignCenterHorizontal size={14} strokeWidth={1.75} />}
              label="Align middle"
              onClick={() => {
                onAlign("center-h");
                setAlignOpen(false);
              }}
            />
            <AlignMenuItem
              icon={<AlignEndHorizontal size={14} strokeWidth={1.75} />}
              label="Align bottom"
              onClick={() => {
                onAlign("bottom");
                setAlignOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <ToolButton label="Arrange selected" onClick={onArrange}>
          <LayoutGrid size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Delete selected" onClick={onDelete}>
          <Trash2 size={14} strokeWidth={1.75} />
        </ToolButton>
      </ToolbarChrome>
    </TooltipProvider>
  );
}

function AlignMenuItem({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      onClick={onClick}
    >
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

export function CanvasActionBar({
  tool,
  onToolChange,
  onAddImageGenerator,
}: {
  tool: MoodboardCanvasTool;
  onToolChange: (tool: MoodboardCanvasTool) => void;
  onAddImageGenerator: () => void;
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
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Image generator" onClick={onAddImageGenerator}>
          <WandSparkles size={15} strokeWidth={1.75} />
        </ToolButton>
      </div>
    </TooltipProvider>
  );
}

export function CanvasViewBar({
  layersOpen,
  presentationMode,
  onToggleLayers,
  onTogglePresentation,
}: {
  layersOpen: boolean;
  presentationMode: boolean;
  onToggleLayers: () => void;
  onTogglePresentation: () => void;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <div
        data-moodboard-floating-occluder
        className="app-no-drag absolute bottom-3 left-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      >
        <ToolButton label="Layers" active={layersOpen} onClick={onToggleLayers}>
          <Layers size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Presentation mode" active={presentationMode} onClick={onTogglePresentation}>
          <Presentation size={15} strokeWidth={1.75} />
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
    <div className="pointer-events-auto app-no-drag grid min-h-[146px] w-[min(600px,calc(100vw-3rem))] grid-rows-[1fr_auto] overflow-hidden rounded-xl border border-border bg-card/95 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl">
      <div className="min-h-0 px-2.5 pb-2.5 pt-2">
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
          className="h-full min-h-14 resize-none border-0 bg-transparent px-0.5 py-0 text-sm shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="flex h-10 items-center justify-between gap-2 border-t border-border/70 px-2">
        <ImageModelPicker model={model} options={modelOptions} onModelChange={onModelChange} />
        <Button size="sm" disabled={busy || prompt.trim().length === 0} onClick={() => void submit()} className="h-7 px-2.5 text-xs">
          Generate
        </Button>
      </div>
    </div>
  );
}

export function QuickEditPromptToolbar({
  busy,
  models,
  model,
  onModelChange,
  onGenerate,
}: {
  busy: boolean;
  models: string[];
  model: string;
  onModelChange: (model: string) => void;
  onGenerate: (prompt: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const modelOptions = models.length ? models : [model].filter(Boolean);
  const submit = async () => {
    const next = prompt.trim();
    if (!next || busy) return;
    await onGenerate(next);
    setPrompt("");
  };
  return (
    <div className="pointer-events-auto app-no-drag grid min-h-[138px] w-[min(520px,calc(100vw-3rem))] grid-rows-[1fr_auto] overflow-hidden rounded-xl border border-border bg-card/95 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl">
      <div className="min-h-0 px-2.5 pb-2.5 pt-2">
        <Textarea
          aria-label="Quick edit prompt"
          rows={2}
          value={prompt}
          autoFocus
          placeholder="Describe the variation or edit..."
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
          className="h-full min-h-14 resize-none border-0 bg-transparent px-0.5 py-0 text-sm shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="flex h-10 items-center justify-between gap-2 border-t border-border/70 px-2">
        <ImageModelPicker model={model} options={modelOptions} onModelChange={onModelChange} />
        <Button size="sm" disabled={busy || prompt.trim().length === 0} onClick={() => void submit()} className="h-7 px-2.5 text-xs">
          Generate
        </Button>
      </div>
    </div>
  );
}

function ImageModelPicker({ model, options, onModelChange }: { model: string; options: string[]; onModelChange: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = model || options[0] || "";
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        aria-label="Image generation model"
        className="flex h-7 min-w-0 max-w-[21rem] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
      >
        <span className="label-mono shrink-0 text-muted-foreground">Image</span>
        <span className="truncate font-medium text-foreground">{selected || "Default model"}</span>
        <ChevronDown size={13} strokeWidth={2} className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-2">
        <p className="label-mono px-0.5 pb-1.5">Image model</p>
        {options.length ? (
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-0.5">
            {options.map((option) => {
              const active = option === selected;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    onModelChange(option);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
                    active ? "border-ring bg-surface text-foreground ring-1 ring-ring/30" : "border-border text-muted-foreground hover:bg-surface-2/60 hover:text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">Image generation</span>
                  </span>
                  {active ? <Check size={13} strokeWidth={2.4} className="shrink-0 text-foreground" /> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">No image models configured.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
