import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
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
  SendHorizontal,
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

export type ReferenceImageItem = {
  assetId: string;
  url?: string;
  name?: string;
};

function referenceImagesFromNode(node: MoodboardNode): ReferenceImageItem[] {
  const value = node.data.referenceAssets;
  if (!Array.isArray(value)) return [];
  const items: ReferenceImageItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const assetId = typeof record.assetId === "string" && record.assetId.trim() ? record.assetId.trim() : "";
    if (!assetId) continue;
    items.push({
      assetId,
      url: typeof record.url === "string" ? record.url : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
    });
  }
  return items;
}

function orderedReferenceImages(referenceAssetIds: string[], referenceImages: ReferenceImageItem[] = []): ReferenceImageItem[] {
  const byId = new Map(referenceImages.map((item) => [item.assetId, item]));
  return referenceAssetIds.map((assetId) => byId.get(assetId) ?? { assetId });
}

function referenceImageName(item: ReferenceImageItem): string {
  return item.name?.trim() || item.assetId;
}

function moveId(ids: string[], sourceId: string, targetId: string): string[] {
  if (sourceId === targetId) return ids;
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return ids;
  const next = ids.slice();
  const [removed] = next.splice(sourceIndex, 1);
  if (!removed) return ids;
  next.splice(targetIndex, 0, removed);
  return next;
}

function assetIdsKey(assetIds: string[]): string {
  return assetIds.join("\u0000");
}

function moveTextControlCaretToEnd(element: HTMLInputElement | HTMLTextAreaElement): void {
  const end = element.value.length;
  element.setSelectionRange(end, end);
}

function usePromptAutofocus<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) return;
    const frame = window.requestAnimationFrame(() => {
      const element = ref.current;
      element?.focus({ preventScroll: true });
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        moveTextControlCaretToEnd(element);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [enabled]);
  return ref;
}

function ReferenceImageControl({
  disabled,
  referenceAssetIds,
  referenceImages = [],
  referencePickActive = false,
  onReferenceAssetIdsChange,
  onUploadReferenceFiles,
  onSelectCanvasReference,
}: {
  disabled: boolean;
  referenceAssetIds: string[];
  referenceImages?: ReferenceImageItem[];
  referencePickActive?: boolean;
  onReferenceAssetIdsChange?: (assetIds: string[]) => void;
  onUploadReferenceFiles?: (files: FileList) => void;
  onSelectCanvasReference?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [visibleAssetIds, setVisibleAssetIds] = useState(referenceAssetIds);
  const referenceAssetIdsKey = assetIdsKey(referenceAssetIds);

  useEffect(() => {
    setVisibleAssetIds(referenceAssetIds);
  }, [referenceAssetIdsKey]);

  const items = orderedReferenceImages(visibleAssetIds, referenceImages);
  const openUpload = () => inputRef.current?.click();
  const changeOrder = (assetIds: string[]) => {
    setVisibleAssetIds(assetIds);
    onReferenceAssetIdsChange?.(assetIds);
  };
  const handleDragEnd = (event: DragEndEvent) => {
    if (disabled || event.canceled) return;
    const sourceId = String(event.operation.source?.id ?? "");
    const targetId = String(event.operation.target?.id ?? "");
    if (!sourceId || !targetId || sourceId === targetId) return;
    changeOrder(moveId(visibleAssetIds, sourceId, targetId));
  };
  const moveBefore = (assetId: string) => {
    const index = visibleAssetIds.indexOf(assetId);
    if (index <= 0) return;
    const next = visibleAssetIds.slice();
    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
    changeOrder(next);
  };
  const moveAfter = (assetId: string) => {
    const index = visibleAssetIds.indexOf(assetId);
    if (index < 0 || index >= visibleAssetIds.length - 1) return;
    const next = visibleAssetIds.slice();
    [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
    changeOrder(next);
  };
  const remove = (assetId: string) => changeOrder(visibleAssetIds.filter((id) => id !== assetId));

  return (
    <div aria-label="Reference images" className="mb-2 flex min-h-12 items-center gap-1.5 overflow-x-auto pb-0.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Add reference image"
            disabled={disabled}
            className={cn(
              "grid h-12 aspect-square shrink-0 place-items-center rounded-lg border border-dashed border-border bg-surface text-muted-foreground transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45",
              referencePickActive && "border-primary/70 bg-primary/5 text-primary",
            )}
          >
            <Plus size={18} strokeWidth={1.75} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-moodboard-toolbar
          align="start"
          side="top"
          sideOffset={8}
          className="w-44 p-1"
          onContextMenu={stopToolbarEvent}
          onPointerDown={stopToolbarEvent}
          onPointerUp={stopToolbarEvent}
          onMouseDown={stopToolbarEvent}
          onMouseUp={stopToolbarEvent}
          onClick={stopToolbarEvent}
        >
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
            onClick={openUpload}
          >
            <Paperclip size={13} strokeWidth={1.75} />
            从本地上传图片
          </button>
          <button
            type="button"
            disabled={disabled || !onSelectCanvasReference}
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground hover:bg-surface-2 disabled:opacity-45",
              referencePickActive && "bg-primary/10 text-primary",
            )}
            onClick={onSelectCanvasReference}
          >
            <SquareDashedMousePointer size={13} strokeWidth={1.75} />
            从画布选择
          </button>
        </PopoverContent>
      </Popover>
      {items.length ? (
        <DragDropProvider onDragEnd={handleDragEnd}>
          <div className="flex items-center gap-1.5">
            {items.map((item, index) => (
              <ReferenceImageThumb
                key={item.assetId}
                item={item}
                index={index}
                count={items.length}
                disabled={disabled}
                canEditOrder={Boolean(onReferenceAssetIdsChange)}
                onMoveBefore={() => moveBefore(item.assetId)}
                onMoveAfter={() => moveAfter(item.assetId)}
                onRemove={() => remove(item.assetId)}
              />
            ))}
          </div>
        </DragDropProvider>
      ) : null}
    </div>
  );
}

function ReferenceImageThumb({
  item,
  index,
  count,
  disabled,
  canEditOrder,
  onMoveBefore,
  onMoveAfter,
  onRemove,
}: {
  item: ReferenceImageItem;
  index: number;
  count: number;
  disabled: boolean;
  canEditOrder: boolean;
  onMoveBefore: () => void;
  onMoveAfter: () => void;
  onRemove: () => void;
}) {
  const name = referenceImageName(item);
  const { ref, isDragging, isDropTarget } = useSortable({
    id: item.assetId,
    index,
    group: "moodboard-reference-images",
    type: "moodboard-reference-image",
    accept: "moodboard-reference-image",
    disabled: disabled || !canEditOrder,
  });

  return (
    <div
      ref={ref}
      className={cn(
        "group/reference relative grid h-12 aspect-square shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-surface text-muted-foreground transition-[opacity,border-color,box-shadow]",
        isDragging && "opacity-55",
        isDropTarget && "border-primary shadow-[0_0_0_2px_rgba(48,112,255,0.18)]",
      )}
      title={name}
    >
      {item.url ? (
        <img src={item.url} alt={name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <ImageIcon size={16} strokeWidth={1.75} />
      )}
      <span className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/45 px-1 py-0.5 text-center text-[9px] font-medium tabular-nums leading-none text-white">
        #{index + 1}
      </span>
      {canEditOrder ? (
        <>
          <button
            type="button"
            disabled={disabled || index === 0}
            className="sr-only"
            onClick={(event) => {
              event.stopPropagation();
              onMoveBefore();
            }}
          >
            Move reference image {name} before previous
          </button>
          <button
            type="button"
            disabled={disabled || index >= count - 1}
            className="sr-only"
            onClick={(event) => {
              event.stopPropagation();
              onMoveAfter();
            }}
          >
            Move reference image {name} after next
          </button>
          <button
            type="button"
            aria-label={`Remove reference image ${name}`}
            disabled={disabled}
            className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/65 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 group-hover/reference:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <Trash2 size={11} strokeWidth={1.8} />
          </button>
        </>
      ) : null}
    </div>
  );
}

type ImageGenerateOptions = {
  referenceAssetIds: string[];
  params?: ImageGenerationParams;
};

const QUICK_EDIT_PARAMS_NODE: MoodboardNode = {
  id: "quick-edit-params",
  boardId: "",
  type: "image",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0,
  zIndex: 0,
  data: {},
  createdAt: 0,
  updatedAt: 0,
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
      onContextMenu={stopToolbarEvent}
    >
      {children}
    </div>
  );
}

function ShortcutHint({ children }: { children: ReactNode }) {
  return <span className="ml-1 rounded border border-border/80 bg-surface px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">{children}</span>;
}

function TabHint() {
  return <ShortcutHint>Tab</ShortcutHint>;
}

export function SelectionToolbar({
  node,
  onDuplicate,
  onDelete,
  onImageAction,
  onQuickEdit,
  onSendToAgent,
}: {
  node: MoodboardNode;
  onDuplicate: () => void;
  onDelete: () => void;
  onImageAction?: (action: string) => void;
  onQuickEdit?: () => void;
  onSendToAgent?: () => void;
}) {
  const imageLike = node.type === "image";
  return (
    <TooltipProvider delayDuration={120}>
      <ToolbarChrome className="flex items-center gap-0.5 p-0.5">
        {onSendToAgent ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Send to Agent" size="sm" variant="ghost" onClick={onSendToAgent} className="h-8 gap-1.5 px-2 text-xs font-medium">
                  <SendHorizontal size={14} strokeWidth={1.75} />
                  Send to Agent
                  <ShortcutHint>Enter</ShortcutHint>
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Send to Agent</TooltipContent>
            </Tooltip>
            <span className="mx-0.5 h-5 w-px bg-border" />
          </>
        ) : null}
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
  onSendToAgent,
}: {
  nodes: MoodboardNode[];
  onDuplicate: () => void;
  onAlign: (type: MoodboardAlignType) => void;
  onArrange: () => void;
  onDelete: () => void;
  onImageAction?: (action: string) => void;
  onSendToAgent?: () => void;
}) {
  const [alignOpen, setAlignOpen] = useState(false);
  const imageOnly = nodes.length > 0 && nodes.every((node) => node.type === "image");

  return (
    <TooltipProvider delayDuration={120}>
      <ToolbarChrome className="flex items-center gap-0.5 p-0.5">
        <span className="px-2 text-xs font-medium text-muted-foreground">{nodes.length} selected</span>
        <span className="mx-0.5 h-5 w-px bg-border" />
        {onSendToAgent ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Send to Agent" size="sm" variant="ghost" onClick={onSendToAgent} className="h-8 gap-1.5 px-2 text-xs font-medium">
                  <SendHorizontal size={14} strokeWidth={1.75} />
                  Send to Agent
                  <ShortcutHint>Enter</ShortcutHint>
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={2}>Send to Agent</TooltipContent>
            </Tooltip>
            <span className="mx-0.5 h-5 w-px bg-border" />
          </>
        ) : null}
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
        className="app-no-drag absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-card/95 p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
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
        className="app-no-drag absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
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
        className="app-no-drag absolute bottom-3 right-3 z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
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
  referenceImages,
  referencePickActive = false,
  onModelChange,
  onParamsChange,
  onPromptChange,
  onReferenceAssetIdsChange,
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
  referenceImages?: ReferenceImageItem[];
  referencePickActive?: boolean;
  onModelChange: (model: string) => void;
  onParamsChange?: (params: ImageGenerationParams) => void;
  onPromptChange: (prompt: string) => void;
  onReferenceAssetIdsChange?: (assetIds: string[]) => void;
  onGenerate: (prompt: string, params: ImageGenerationParams, options: ImageGenerateOptions) => Promise<void>;
  onUploadFiles?: (files: FileList) => void;
  onUploadReferenceFiles?: (files: FileList) => void;
  onSelectCanvasReference?: () => void;
}) {
  const [prompt, setPrompt] = useState(generatorPrompt(node));
  const [params, setParams] = useState(() => imageGenerationParamsForNode(node, imageProviderId));
  const nodeReferenceAssetIds = referenceAssetIdsFromNode(node);
  const [currentReferenceAssetIds, setCurrentReferenceAssetIds] = useState(nodeReferenceAssetIds);
  const [submitting, setSubmitting] = useState(false);
  const generating = busy || submitting;
  const nodeReferenceAssetIdsKey = assetIdsKey(nodeReferenceAssetIds);
  const promptRef = usePromptAutofocus<HTMLTextAreaElement>();
  const resolvedReferenceImages = referenceImages ?? referenceImagesFromNode(node);

  useEffect(() => {
    setPrompt(generatorPrompt(node));
  }, [node]);

  useEffect(() => {
    setParams(imageGenerationParamsForNode(node, imageProviderId));
  }, [imageProviderId, node]);

  useEffect(() => {
    setCurrentReferenceAssetIds(nodeReferenceAssetIds);
  }, [nodeReferenceAssetIdsKey]);

  const changeReferenceAssetIds = (assetIds: string[]) => {
    setCurrentReferenceAssetIds(assetIds);
    onReferenceAssetIdsChange?.(assetIds);
  };

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
      await onGenerate(next, params, { referenceAssetIds: currentReferenceAssetIds });
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
      onContextMenu={stopToolbarEvent}
      onDragEnter={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDragOver={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDrop={(event) => handleToolbarFileDrop(event, onUploadFiles)}
    >
      <div className="min-h-0 px-2.5 pb-2.5 pt-2">
        <ReferenceImageControl
          disabled={generating}
          referenceAssetIds={currentReferenceAssetIds}
          referenceImages={resolvedReferenceImages}
          referencePickActive={referencePickActive}
          onReferenceAssetIdsChange={changeReferenceAssetIds}
          onUploadReferenceFiles={onUploadReferenceFiles}
          onSelectCanvasReference={onSelectCanvasReference}
        />
        <Textarea
          ref={promptRef}
          aria-label="Image generator prompt"
          rows={2}
          value={prompt}
          autoFocus
          disabled={generating}
          placeholder="Describe the image material to generate..."
          onFocus={(event) => moveTextControlCaretToEnd(event.currentTarget)}
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
          className="h-7 max-w-36 gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
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
  node,
  busy,
  models,
  model,
  imageProviderId = "",
  referenceAssetIds = [],
  referenceImages = [],
  referencePickActive = false,
  onModelChange,
  onReferenceAssetIdsChange,
  onGenerate,
  onUploadFiles,
  onUploadReferenceFiles,
  onSelectCanvasReference,
}: {
  node?: MoodboardNode;
  busy: boolean;
  models: string[];
  model: string;
  imageProviderId?: string;
  referenceAssetIds?: string[];
  referenceImages?: ReferenceImageItem[];
  referencePickActive?: boolean;
  onModelChange: (model: string) => void;
  onReferenceAssetIdsChange?: (assetIds: string[]) => void;
  onGenerate: (prompt: string, options: ImageGenerateOptions) => Promise<void>;
  onUploadFiles?: (files: FileList) => void;
  onUploadReferenceFiles?: (files: FileList) => void;
  onSelectCanvasReference?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [params, setParams] = useState(() => imageGenerationParamsForNode(node ?? QUICK_EDIT_PARAMS_NODE, imageProviderId));
  const [submitting, setSubmitting] = useState(false);
  const generating = busy || submitting;
  const modelOptions = models.length ? models : [model].filter(Boolean);
  const promptRef = usePromptAutofocus<HTMLTextAreaElement>();

  useEffect(() => {
    setParams(imageGenerationParamsForNode(node ?? QUICK_EDIT_PARAMS_NODE, imageProviderId));
  }, [imageProviderId, node]);

  const patchParams = (patch: ImageGenerationParams) => {
    const baseNode = node ?? QUICK_EDIT_PARAMS_NODE;
    const next = imageGenerationParamsForNode({ ...baseNode, data: { ...baseNode.data, generationParams: { ...params, ...patch } } }, imageProviderId);
    setParams(next);
  };

  const submit = async () => {
    const next = prompt.trim();
    if (!next || generating) return;
    setSubmitting(true);
    try {
      await onGenerate(next, { referenceAssetIds, params });
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
      onContextMenu={stopToolbarEvent}
      onDragEnter={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDragOver={(event) => handleToolbarFileDrag(event, onUploadFiles)}
      onDrop={(event) => handleToolbarFileDrop(event, onUploadFiles)}
    >
      <div className="min-h-0 px-2.5 pb-2.5 pt-2">
        <ReferenceImageControl
          disabled={generating}
          referenceAssetIds={referenceAssetIds}
          referenceImages={referenceImages}
          referencePickActive={referencePickActive}
          onReferenceAssetIdsChange={onReferenceAssetIdsChange}
          onUploadReferenceFiles={onUploadReferenceFiles}
          onSelectCanvasReference={onSelectCanvasReference}
        />
        <Textarea
          ref={promptRef}
          aria-label="Quick edit prompt"
          rows={2}
          value={prompt}
          autoFocus
          disabled={generating}
          placeholder="Describe the variation or edit..."
          onFocus={(event) => moveTextControlCaretToEnd(event.currentTarget)}
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
