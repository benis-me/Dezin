import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Brush,
  Copy,
  Eraser,
  Hand,
  Image as ImageIcon,
  ImagePlus,
  LayoutGrid,
  Layers,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  Paperclip,
  Presentation,
  Plus,
  Scissors,
  SlidersHorizontal,
  SquareDashedMousePointer,
  StickyNote,
  Trash2,
} from "lucide-react";
import type { ImageGenerationParams, MoodboardNode } from "../lib/api.ts";
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
import { generatorPrompt, referenceAssetIds as referenceAssetIdsFromNode, type MoodboardAlignType, type MoodboardCanvasTool } from "./canvas-utils.ts";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_BACKGROUND_OPTIONS,
  IMAGE_FORMAT_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  IMAGE_SIZE_OPTIONS,
  imageGenerationParamsForNode,
  sizeForAspectRatio,
  supportsImageBackground,
  supportsImageModeration,
  supportsImageOutputFormat,
  supportsImageQuality,
  supportsImageSize,
} from "./image-generation-params.ts";
import { ImageModelPicker } from "./ImageModelPicker.tsx";

const ACTIVE_TOOL_BUTTON_CLASS = "!bg-primary !text-primary-foreground hover:!bg-primary hover:!text-primary-foreground";

export function ToolButton({
  label,
  active = false,
  onClick,
  children,
  disabled = false,
  className,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          aria-label={label}
          onClick={disabled ? undefined : onClick}
          aria-disabled={disabled}
          className={cn(className, active && ACTIVE_TOOL_BUTTON_CLASS, disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground")}
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

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files") || (event.dataTransfer?.files?.length ?? 0) > 0;
}

function handleToolbarFileDrag(event: ReactDragEvent<HTMLElement>, onUploadFiles?: (files: FileList) => void): void {
  if (!onUploadFiles || !hasDraggedFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "copy";
}

function handleToolbarFileDrop(event: ReactDragEvent<HTMLElement>, onUploadFiles?: (files: FileList) => void): void {
  if (!onUploadFiles || !hasDraggedFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  onUploadFiles(event.dataTransfer.files);
}

function isToolbarEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-moodboard-toolbar]"));
}

function ReferenceImageControl({
  disabled,
  referenceAssetIds,
  onUploadReferenceFiles,
  onSelectCanvasReference,
}: {
  disabled: boolean;
  referenceAssetIds: string[];
  onUploadReferenceFiles?: (files: FileList) => void;
  onSelectCanvasReference?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const count = referenceAssetIds.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Reference images"
          disabled={disabled}
          className={cn(
            "mb-2 inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground",
            count > 0 && "border-primary/30 bg-primary/5 text-foreground",
          )}
        >
          <ImageIcon size={14} strokeWidth={1.75} />
          <span>参考图</span>
          {count > 0 ? <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] tabular-nums">{count}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-40 rounded-xl p-1.5">
        <input
          ref={inputRef}
          aria-label="Upload reference image"
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files?.length) onUploadReferenceFiles?.(files);
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          disabled={disabled || !onUploadReferenceFiles}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground hover:bg-surface-2 disabled:opacity-45"
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip size={13} strokeWidth={1.75} />
          从本地上传图片
        </button>
        <button
          type="button"
          disabled={disabled || !onSelectCanvasReference}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground hover:bg-surface-2 disabled:opacity-45"
          onClick={onSelectCanvasReference}
        >
          <SquareDashedMousePointer size={13} strokeWidth={1.75} />
          从画布选择
        </button>
      </PopoverContent>
    </Popover>
  );
}

type ImageGenerateOptions = {
  referenceAssetIds: string[];
};

function ToolbarChrome({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-moodboard-toolbar
      className={cn("pointer-events-auto app-no-drag rounded-lg border border-border bg-card/95 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl", className)}
      onPointerDown={stopToolbarEvent}
      onPointerUp={stopToolbarEvent}
      onMouseDown={stopToolbarEvent}
      onMouseUp={stopToolbarEvent}
      onClick={stopToolbarEvent}
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
      <ToolbarChrome className="flex items-center gap-1 p-0.5">
        {imageLike ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="ghost" onClick={onQuickEdit} className="h-8 gap-1.5 px-2 text-xs font-medium">
                  Quick edit
                  <TabHint />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Quick edit</TooltipContent>
            </Tooltip>
            <span className="mx-0.5 h-5 w-px bg-border" />
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
}: {
  nodes: MoodboardNode[];
  onDuplicate: () => void;
  onAlign: (type: MoodboardAlignType) => void;
  onArrange: () => void;
  onDelete: () => void;
  onImageAction?: (action: string) => void;
}) {
  const [alignOpen, setAlignOpen] = useState(false);
  const imageOnly = nodes.length > 0 && nodes.every((node) => node.type === "image");

  return (
    <TooltipProvider delayDuration={120}>
      <ToolbarChrome className="flex items-center gap-1 p-0.5">
        <span className="px-2 text-xs font-medium text-muted-foreground">{nodes.length} selected</span>
        <span className="mx-0.5 h-5 w-px bg-border" />
        {imageOnly ? (
          <>
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
            data-moodboard-toolbar
            side="top"
            align="center"
            className="w-44 p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDown={stopToolbarEvent}
            onPointerUp={stopToolbarEvent}
            onMouseDown={stopToolbarEvent}
            onMouseUp={stopToolbarEvent}
            onClick={stopToolbarEvent}
            onPointerDownOutside={(event) => {
              if (isToolbarEventTarget(event.target)) event.preventDefault();
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
      onPointerDown={stopToolbarEvent}
      onMouseDown={stopToolbarEvent}
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
        className="app-no-drag absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-card/95 p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      >
        <ToolButton label="Select" active={tool === "select"} onClick={() => onToolChange("select")} className="rounded-md">
          <MousePointer2 size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Hand" active={tool === "hand"} onClick={() => onToolChange("hand")} className="rounded-md">
          <Hand size={15} strokeWidth={1.75} />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Add note" active={tool === "note"} onClick={() => onToolChange("note")} className="rounded-md">
          <StickyNote size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Add section" active={tool === "section"} onClick={() => onToolChange("section")} className="rounded-md">
          <SquareDashedMousePointer size={15} strokeWidth={1.75} />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Image generator" onClick={onAddImageGenerator} className="rounded-md">
          <ImagePlus size={15} strokeWidth={1.75} />
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
        className="app-no-drag absolute bottom-3 left-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-card/95 p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      >
        <ToolButton label="Layers" active={layersOpen} onClick={onToggleLayers} className="rounded-md">
          <Layers size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Presentation mode" active={presentationMode} onClick={onTogglePresentation} className="rounded-md">
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
        className="app-no-drag absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-card/95 p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      >
        <ToolButton label="Zoom out" onClick={() => onChangeZoom(zoom * 0.88)} className="rounded-md">
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
        <ToolButton label="Zoom in" onClick={() => onChangeZoom(zoom * 1.14)} className="rounded-md">
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
  imageProviderId = "",
  onModelChange,
  onParamsChange,
  onPromptChange,
  onGenerate,
  onUploadFiles,
  onUploadReferenceFiles,
  onSelectCanvasReference,
}: {
  node: MoodboardNode;
  busy: boolean;
  models: string[];
  model: string;
  imageProviderId?: string;
  onModelChange: (model: string) => void;
  onParamsChange?: (params: ImageGenerationParams) => void;
  onPromptChange: (prompt: string) => void;
  onGenerate: (prompt: string, params: ImageGenerationParams, options: ImageGenerateOptions) => Promise<void>;
  onUploadFiles?: (files: FileList) => void;
  onUploadReferenceFiles?: (files: FileList) => void;
  onSelectCanvasReference?: () => void;
}) {
  const [prompt, setPrompt] = useState(generatorPrompt(node));
  const [params, setParams] = useState(() => imageGenerationParamsForNode(node, imageProviderId));
  const [submitting, setSubmitting] = useState(false);
  const generating = busy || submitting;
  const referenceAssetIds = referenceAssetIdsFromNode(node);

  useEffect(() => {
    setPrompt(generatorPrompt(node));
  }, [node]);

  useEffect(() => {
    setParams(imageGenerationParamsForNode(node, imageProviderId));
  }, [imageProviderId, node]);

  const patchParams = (patch: ImageGenerationParams) => {
    const next = imageGenerationParamsForNode({ ...node, data: { ...node.data, generationParams: { ...params, ...patch } } }, imageProviderId);
    setParams(next);
    onParamsChange?.(next);
  };

  const submit = async () => {
    const next = prompt.trim();
    if (!next || generating) return;
    onPromptChange(next);
    onParamsChange?.(params);
    setSubmitting(true);
    try {
      await onGenerate(next, params, { referenceAssetIds });
    } finally {
      setSubmitting(false);
    }
  };
  const modelOptions = models.length ? models : [model].filter(Boolean);

  return (
    <div
      data-moodboard-toolbar
      className="pointer-events-auto app-no-drag grid min-h-[146px] w-[min(600px,calc(100vw-3rem))] grid-rows-[1fr_auto] overflow-hidden rounded-xl border border-border bg-card/95 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      onPointerDown={stopToolbarEvent}
      onPointerUp={stopToolbarEvent}
      onMouseDown={stopToolbarEvent}
      onMouseUp={stopToolbarEvent}
      onClick={stopToolbarEvent}
      onDragEnter={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDragOver={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDrop={(event) => handleToolbarFileDrop(event, onUploadFiles)}
    >
      <div className="min-h-0 px-2.5 pb-2.5 pt-2">
        <ReferenceImageControl
          disabled={generating}
          referenceAssetIds={referenceAssetIds}
          onUploadReferenceFiles={onUploadReferenceFiles}
          onSelectCanvasReference={onSelectCanvasReference}
        />
        <Textarea
          aria-label="Image generator prompt"
          rows={2}
          value={prompt}
          autoFocus
          disabled={generating}
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
        <div className="min-w-0 flex items-center gap-1.5">
          <ImageModelPicker model={model} options={modelOptions} disabled={generating} onModelChange={onModelChange} />
          <ImageGenerationParamsControl providerId={imageProviderId} params={params} disabled={generating} onChange={patchParams} />
        </div>
        <Button size="sm" disabled={generating || prompt.trim().length === 0} onClick={() => void submit()} className="h-7 px-2.5 text-xs">
          {generating ? <Loader2 size={13} strokeWidth={1.75} className="animate-spin" /> : null}
          {generating ? "Generating" : "Generate"}
        </Button>
      </div>
    </div>
  );
}

function ImageGenerationParamsControl({
  providerId,
  params,
  disabled,
  onChange,
}: {
  providerId: string;
  params: ImageGenerationParams;
  disabled: boolean;
  onChange: (patch: ImageGenerationParams) => void;
}) {
  const summary = `${params.quality ?? "medium"} · ${params.aspectRatio ?? "1:1"} · ${params.count ?? 1}`;
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-label="Image generation parameters"
          className="h-7 max-w-36 gap-1.5 rounded-full bg-surface px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <SlidersHorizontal size={12} strokeWidth={1.75} />
          <span className="truncate">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-moodboard-toolbar
        side="top"
        align="start"
        className="w-[304px] p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerDown={stopToolbarEvent}
        onPointerUp={stopToolbarEvent}
        onMouseDown={stopToolbarEvent}
        onMouseUp={stopToolbarEvent}
        onClick={stopToolbarEvent}
        onPointerDownOutside={(event) => {
          if (isToolbarEventTarget(event.target)) event.preventDefault();
        }}
      >
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-foreground">Image settings</p>
          </div>
          {supportsImageQuality(providerId) ? (
            <ParamGroup label="Quality">
              <div className="grid grid-cols-4 gap-1.5">
                {IMAGE_QUALITY_OPTIONS.map((option) => (
                  <ParamButton
                    key={option.value}
                    active={(params.quality ?? "medium") === option.value}
                    label={option.label}
                    onClick={() => onChange({ quality: option.value })}
                  />
                ))}
              </div>
            </ParamGroup>
          ) : null}
          {supportsImageSize(providerId) ? (
            <ParamGroup label="Size">
              <div className="grid grid-cols-3 gap-1.5">
                {IMAGE_SIZE_OPTIONS.map((option) => (
                  <ParamButton
                    key={option.value}
                    active={(params.size ?? "1024x1024") === option.value}
                    label={option.label}
                    onClick={() => onChange({ size: option.value })}
                  />
                ))}
              </div>
            </ParamGroup>
          ) : null}
          <ParamGroup label="Aspect ratio">
            <div className="grid grid-cols-4 gap-1.5">
              {IMAGE_ASPECT_RATIO_OPTIONS.map((option) => (
                <ParamButton
                  key={option.value}
                  active={(params.aspectRatio ?? "1:1") === option.value}
                  label={option.label}
                  onClick={() => onChange({ aspectRatio: option.value, size: sizeForAspectRatio(option.value) })}
                />
              ))}
            </div>
          </ParamGroup>
          {supportsImageBackground(providerId) ? (
            <ParamGroup label="Background">
              <div className="grid grid-cols-3 gap-1.5">
                {IMAGE_BACKGROUND_OPTIONS.map((option) => (
                  <ParamButton
                    key={option.value}
                    active={(params.background ?? "auto") === option.value}
                    label={option.label}
                    onClick={() => onChange({ background: option.value })}
                  />
                ))}
              </div>
            </ParamGroup>
          ) : null}
          {supportsImageOutputFormat(providerId) ? (
            <ParamGroup label="Output">
              <div className="grid grid-cols-3 gap-1.5">
                {IMAGE_FORMAT_OPTIONS.map((option) => (
                  <ParamButton
                    key={option.value}
                    active={params.outputFormat === option.value}
                    label={option.label}
                    onClick={() => onChange({ outputFormat: option.value })}
                  />
                ))}
              </div>
            </ParamGroup>
          ) : null}
          {supportsImageOutputFormat(providerId) && params.outputFormat && params.outputFormat !== "png" ? (
            <ParamGroup label="Compression">
              <div className="grid grid-cols-3 gap-1.5">
                {[70, 85, 95].map((value) => (
                  <ParamButton
                    key={value}
                    active={(params.outputCompression ?? 85) === value}
                    label={`${value}`}
                    onClick={() => onChange({ outputCompression: value })}
                  />
                ))}
              </div>
            </ParamGroup>
          ) : null}
          {supportsImageModeration(providerId) ? (
            <ParamGroup label="Moderation">
              <div className="grid grid-cols-2 gap-1.5">
                <ParamButton active={(params.moderation ?? "auto") === "auto"} label="Auto" onClick={() => onChange({ moderation: "auto" })} />
                <ParamButton active={params.moderation === "low"} label="Low" onClick={() => onChange({ moderation: "low" })} />
              </div>
            </ParamGroup>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ParamGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function ParamButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "h-8 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-2",
        active && "border-foreground bg-foreground text-background hover:bg-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function QuickEditPromptToolbar({
  busy,
  models,
  model,
  referenceAssetIds = [],
  onModelChange,
  onGenerate,
  onUploadFiles,
  onUploadReferenceFiles,
  onSelectCanvasReference,
}: {
  busy: boolean;
  models: string[];
  model: string;
  referenceAssetIds?: string[];
  onModelChange: (model: string) => void;
  onGenerate: (prompt: string, options: ImageGenerateOptions) => Promise<void>;
  onUploadFiles?: (files: FileList) => void;
  onUploadReferenceFiles?: (files: FileList) => void;
  onSelectCanvasReference?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const generating = busy || submitting;
  const modelOptions = models.length ? models : [model].filter(Boolean);
  const submit = async () => {
    const next = prompt.trim();
    if (!next || generating) return;
    setSubmitting(true);
    try {
      await onGenerate(next, { referenceAssetIds });
      setPrompt("");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      data-moodboard-toolbar
      className="pointer-events-auto app-no-drag grid min-h-[138px] w-[min(520px,calc(100vw-3rem))] grid-rows-[1fr_auto] overflow-hidden rounded-xl border border-border bg-card/95 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      onPointerDown={stopToolbarEvent}
      onPointerUp={stopToolbarEvent}
      onMouseDown={stopToolbarEvent}
      onMouseUp={stopToolbarEvent}
      onClick={stopToolbarEvent}
      onDragEnter={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDragOver={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDrop={(event) => handleToolbarFileDrop(event, onUploadFiles)}
    >
      <div className="min-h-0 px-2.5 pb-2.5 pt-2">
        <ReferenceImageControl
          disabled={generating}
          referenceAssetIds={referenceAssetIds}
          onUploadReferenceFiles={onUploadReferenceFiles}
          onSelectCanvasReference={onSelectCanvasReference}
        />
        <Textarea
          aria-label="Quick edit prompt"
          rows={2}
          value={prompt}
          autoFocus
          disabled={generating}
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
        <ImageModelPicker model={model} options={modelOptions} disabled={generating} onModelChange={onModelChange} />
        <Button size="sm" disabled={generating || prompt.trim().length === 0} onClick={() => void submit()} className="h-7 px-2.5 text-xs">
          {generating ? <Loader2 size={13} strokeWidth={1.75} className="animate-spin" /> : null}
          {generating ? "Generating" : "Generate"}
        </Button>
      </div>
    </div>
  );
}
