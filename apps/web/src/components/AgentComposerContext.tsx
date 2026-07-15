import type { ReactNode } from "react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { FileText, FolderOpen, GripVertical, Image as ImageIcon, Images, Layers, MousePointerClick, Paperclip, Sparkles, X } from "lucide-react";
import { cn } from "../lib/utils.ts";
import {
  RUN_CONTEXT_MAX_ITEMS,
  decodeRunContextRefs,
  decodeRunSelectionRefs,
  type RunContextRef,
  type RunSelectionRef,
} from "../lib/api.ts";

export type AgentComposerContextItem<PreviewTarget = unknown> =
  | {
      id: string;
      type: "file";
      title: string;
      subtitle?: string;
      name: string;
      path: string;
      /** Daemon-owned upload identity; legacy upload endpoints currently return the stored path as this identity. */
      uploadedFileId?: string;
      previewUrl?: string;
      mimeType?: string;
      size?: number;
    }
  | { id: string; type: "local-path"; title: string; subtitle?: string; path: string }
  | { id: string; type: "project"; title: string; subtitle?: string; projectId: string; name: string; referencePath?: string }
  | { id: string; type: "moodboard"; title: string; subtitle?: string; moodboardId: string; name?: string }
  | { id: string; type: "effect"; title: string; subtitle?: string; effectId: string; name?: string }
  | { id: string; type: "preview-target"; title: string; subtitle?: string; selector: string; note?: string; target: PreviewTarget }
  | { id: string; type: "canvas-node"; title: string; subtitle?: string; nodeId: string; nodeType: string; body: string }
  | { id: string; type: "text-context"; title: string; subtitle?: string; body: string };

export interface StructuredComposerContext {
  contextRefs: RunContextRef[];
  selection: RunSelectionRef[];
}

export class UnsupportedComposerContextError extends Error {
  readonly itemIds: string[];

  constructor(items: readonly AgentComposerContextItem[]) {
    super(`Standard context cannot safely resolve: ${items.map((item) => item.title).join(", ")}`);
    this.name = "UnsupportedComposerContextError";
    this.itemIds = items.map((item) => item.id);
  }
}

/**
 * Convert UI cards to bounded, structured Standard context. The daemon snapshots owned identities
 * and persists untrusted inline content; none of it is copied into the visible user message.
 */
export function serializeStructuredComposerContext<PreviewTarget>(
  items: readonly AgentComposerContextItem<PreviewTarget>[],
  previewSelection: (
    item: Extract<AgentComposerContextItem<PreviewTarget>, { type: "preview-target" }>,
  ) => RunSelectionRef,
): StructuredComposerContext {
  if (items.length > RUN_CONTEXT_MAX_ITEMS) {
    throw new TypeError(`Standard context exceeds ${RUN_CONTEXT_MAX_ITEMS} items`);
  }
  const unsupported = items.filter((item) => item.type === "local-path" || item.type === "project");
  if (unsupported.length) throw new UnsupportedComposerContextError(unsupported);
  const contextRefs: RunContextRef[] = [];
  const selection: RunSelectionRef[] = [];
  for (const item of items) {
    switch (item.type) {
      case "moodboard":
        contextRefs.push({
          kind: "owned-source",
          id: item.id,
          title: item.title,
          resourceKind: "moodboard",
          source: { type: "moodboard", moodboardId: item.moodboardId },
        });
        break;
      case "effect":
        contextRefs.push({
          kind: "owned-source",
          id: item.id,
          title: item.title,
          resourceKind: "effect",
          source: { type: "effect", effectId: item.effectId },
        });
        break;
      case "preview-target": {
        const resolvedSelection = previewSelection(item);
        if (!resolvedSelection.locator) throw new TypeError("Preview selection must include its full stable locator");
        selection.push(resolvedSelection);
        break;
      }
      case "canvas-node":
        contextRefs.push({ kind: "inline", id: item.id, title: item.title, content: item.body, trustLevel: "untrusted" });
        selection.push({ kind: "node", id: item.nodeId, locator: { nodeType: item.nodeType } });
        break;
      case "file":
        contextRefs.push({
          kind: "owned-source",
          id: item.id,
          title: item.title,
          resourceKind: "file",
          source: { type: "uploaded-file", uploadedFileId: item.uploadedFileId ?? item.path },
        });
        break;
      case "text-context":
        contextRefs.push({ kind: "inline", id: item.id, title: item.title, content: item.body, trustLevel: "untrusted" });
        break;
      case "local-path":
      case "project":
        throw new UnsupportedComposerContextError([item]);
    }
  }
  return {
    contextRefs: decodeRunContextRefs(contextRefs),
    selection: decodeRunSelectionRefs(selection),
  };
}

export interface LegacyPrototypeComposerSerialization {
  brief: string;
  moodboardRefs: Array<{ id: string; name?: string }>;
  effectRefs: Array<{ id: string; name?: string }>;
}

/**
 * Compatibility bridge for legacy Prototype runs, whose daemon contract still consumes one
 * flattened brief. Standard runs must use serializeStructuredComposerContext instead.
 */
export function serializeLegacyPrototypeComposerContext<PreviewTarget>(
  message: string,
  items: readonly AgentComposerContextItem<PreviewTarget>[],
  formatPreviewTarget: (target: PreviewTarget) => string,
): LegacyPrototypeComposerSerialization {
  const moodboardRefs = items
    .filter((item): item is Extract<AgentComposerContextItem<PreviewTarget>, { type: "moodboard" }> => item.type === "moodboard")
    .map((item) => ({ id: item.moodboardId, name: item.name }));
  const effectRefs = items
    .filter((item): item is Extract<AgentComposerContextItem<PreviewTarget>, { type: "effect" }> => item.type === "effect")
    .map((item) => ({ id: item.effectId, name: item.name }));
  const previewTargets = items.filter(
    (item): item is Extract<AgentComposerContextItem<PreviewTarget>, { type: "preview-target" }> => item.type === "preview-target",
  );
  const fileReferencePaths = items.flatMap((item) => {
    if (item.type === "file") return [item.path];
    if (item.type === "project" && item.referencePath) return [item.referencePath];
    return [];
  });
  const localPathItems = items.filter(
    (item): item is Extract<AgentComposerContextItem<PreviewTarget>, { type: "local-path" }> => item.type === "local-path",
  );
  const textContextItems = items.filter(
    (item): item is Extract<AgentComposerContextItem<PreviewTarget>, { type: "text-context" }> => item.type === "text-context",
  );
  const base = message.trim() || (previewTargets.length ? "Refine the marked element(s) per the notes." : "");
  const targets = previewTargets.length
    ? `\n\nScoped edit — change ONLY the element(s) below and keep the rest of the design byte-for-byte unchanged:\n${previewTargets
        .map((item) => formatPreviewTarget(item.target))
        .join("\n")}`
    : "";
  const fileRefs = fileReferencePaths.length
    ? `\n\nReference files (read them from disk): ${fileReferencePaths.join(", ")}`
    : "";
  const localPathRefs = localPathItems.length
    ? `\n\nReference local paths: ${localPathItems.map((item) => item.path).join(", ")}`
    : "";
  const textContextRefs = textContextItems.length
    ? `\n\n${textContextItems.map((item) => `${item.title}:\n${item.body}`).join("\n\n")}`
    : "";
  const boardRefs = moodboardRefs.length
    ? `\n\nMoodboard references (available to the Agent at run time): ${moodboardRefs
        .map((ref) => `${ref.name?.trim() || "Untitled moodboard"} (${ref.id})`)
        .join(", ")}`
    : "";
  const renderedEffectRefs = effectRefs.length
    ? `\n\nEffect references (available to the Agent at run time): ${effectRefs
        .map((ref) => `${ref.name?.trim() || "Untitled effect"} (${ref.id})`)
        .join(", ")}`
    : "";
  return {
    brief: base + targets + fileRefs + localPathRefs + textContextRefs + boardRefs + renderedEffectRefs,
    moodboardRefs,
    effectRefs,
  };
}

export function upsertContextItems<T extends AgentComposerContextItem>(items: T[], incoming: T[]): T[] {
  const next = [...items];
  for (const item of incoming) {
    const index = next.findIndex((existing) => existing.id === item.id);
    if (index === -1) next.push(item);
    else next[index] = item;
  }
  return next;
}

export function removeContextItem<T extends AgentComposerContextItem>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

export function moveContextItem<T extends AgentComposerContextItem>(items: T[], activeId: string, overId: string): T[] {
  if (activeId === overId) return items;
  const from = items.findIndex((item) => item.id === activeId);
  const to = items.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (!item) return items;
  next.splice(to, 0, item);
  return next;
}

type ContextIconKind = "file" | "folder" | "image" | "project" | "moodboard" | "effect" | "preview-target" | "canvas-node" | "text-context";

const IMAGE_FILE_EXTENSIONS = new Set(["avif", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp"]);

function extensionFromPath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const name = clean.split(/[\\/]/).filter(Boolean).at(-1) ?? clean;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function contextIconKind(item: AgentComposerContextItem): ContextIconKind {
  switch (item.type) {
    case "file":
      return IMAGE_FILE_EXTENSIONS.has(extensionFromPath(item.name || item.path)) ? "image" : "file";
    case "local-path": {
      const extension = extensionFromPath(item.path);
      if (IMAGE_FILE_EXTENSIONS.has(extension)) return "image";
      return extension ? "file" : "folder";
    }
    case "project":
      return "project";
    case "moodboard":
      return "moodboard";
    case "effect":
      return "effect";
    case "preview-target":
      return "preview-target";
    case "canvas-node":
      return "canvas-node";
    case "text-context":
      return "text-context";
  }
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${Math.round(size)} ${Math.round(size) === 1 ? "byte" : "bytes"}`;
  const kilobytes = size / 1024;
  if (kilobytes < 1024) return `${Number(kilobytes.toFixed(1))} KB`;
  return `${Number((kilobytes / 1024).toFixed(1))} MB`;
}

function contextTypeLabel(item: AgentComposerContextItem, iconKind: ContextIconKind): string {
  if (iconKind === "image") return "Image";
  switch (item.type) {
    case "file":
      return "File";
    case "local-path":
      return iconKind === "folder" ? "Folder" : "File";
    case "project":
      return "Project";
    case "moodboard":
      return "Moodboard";
    case "effect":
      return "Effect";
    case "preview-target":
      return "Selected element";
    case "canvas-node":
      return "Canvas selection";
    case "text-context":
      return "Imported context";
  }
}

function contextMeta(item: AgentComposerContextItem): string | undefined {
  if (item.type === "file" && typeof item.size === "number") return formatFileSize(item.size);
  if (item.type === "canvas-node") return item.nodeType;
  return item.subtitle;
}

function contextIcon(kind: ContextIconKind, size = 12): ReactNode {
  switch (kind) {
    case "file":
      return <Paperclip size={size} strokeWidth={1.75} />;
    case "folder":
      return <FolderOpen size={size} strokeWidth={1.75} />;
    case "image":
      return <ImageIcon size={size} strokeWidth={1.75} />;
    case "project":
      return <Layers size={size} strokeWidth={1.75} />;
    case "moodboard":
      return <Images size={size} strokeWidth={1.75} />;
    case "effect":
      return <Sparkles size={size} strokeWidth={1.75} />;
    case "preview-target":
      return <MousePointerClick size={size} strokeWidth={1.75} />;
    case "canvas-node":
      return <Images size={size} strokeWidth={1.75} />;
    case "text-context":
      return <FileText size={size} strokeWidth={1.75} />;
  }
}

export function AgentComposerContextCards<T extends AgentComposerContextItem>({
  items,
  onChange,
  onRemove,
  className,
  sortable = true,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  onRemove: (id: string) => void;
  className?: string;
  sortable?: boolean;
}) {
  if (!items.length) return null;

  const handleDragEnd = (event: DragEndEvent) => {
    const sourceId = String(event.operation.source?.id ?? "");
    const targetId = String(event.operation.target?.id ?? "");
    if (!sourceId || !targetId || sourceId === targetId) return;
    onChange(moveContextItem(items, sourceId, targetId));
  };
  const moveBefore = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    if (index <= 0) return;
    onChange(moveContextItem(items, id, items[index - 1]!.id));
  };
  const moveAfter = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0 || index >= items.length - 1) return;
    const next = [...items];
    [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
    onChange(next);
  };

  return (
    <div
      role="list"
      aria-label="Attached context"
      data-testid="agent-context-rail"
      data-context-layout="top-rail"
      className={cn("min-w-0 border-b border-border/70 pb-2", className)}
    >
      <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5 pr-1 [scrollbar-width:thin]">
        <DragDropProvider onDragEnd={handleDragEnd}>
          {items.map((item, index) => (
            <AgentComposerContextCard
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              sortable={sortable}
              onMoveBefore={() => moveBefore(item.id)}
              onMoveAfter={() => moveAfter(item.id)}
              onRemove={() => onRemove(item.id)}
            />
          ))}
        </DragDropProvider>
      </div>
    </div>
  );
}

function AgentComposerContextCard<T extends AgentComposerContextItem>({
  item,
  index,
  count,
  sortable,
  onMoveBefore,
  onMoveAfter,
  onRemove,
}: {
  item: T;
  index: number;
  count: number;
  sortable: boolean;
  onMoveBefore: () => void;
  onMoveAfter: () => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({
    id: item.id,
    index,
    group: "agent-composer-context",
    type: "agent-composer-context",
    accept: "agent-composer-context",
    disabled: !sortable || count < 2,
  });
  const iconKind = contextIconKind(item);
  const typeLabel = contextTypeLabel(item, iconKind);
  const meta = contextMeta(item);
  const tooltipMeta = Array.from(
    new Set(
      [typeLabel, item.type === "file" ? item.path : undefined, meta].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ).join(" · ");
  const showGrip = sortable && count > 1;

  return (
    <div
      ref={showGrip ? ref : undefined}
      role="listitem"
      data-testid={`agent-context-card-${item.id}`}
      data-context-icon={iconKind}
      title={tooltipMeta ? `${item.title}: ${tooltipMeta}` : item.title}
      className={cn(
        "group flex h-9 w-fit min-w-28 max-w-[184px] shrink-0 select-none items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-card px-1.5 text-xs text-foreground-2 transition-[opacity,border-color,background-color] duration-150 ease-out motion-reduce:transition-none",
        isDragging && "opacity-55 ring-2 ring-ring/30",
        isDropTarget && "border-ring ring-2 ring-ring/30",
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-surface-2 text-brand">
        {item.type === "file" && item.previewUrl ? (
          <img className="size-full object-cover" src={item.previewUrl} alt={item.title} />
        ) : (
          contextIcon(iconKind, 12)
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.title}</span>
      {showGrip ? (
        <button
          ref={handleRef}
          type="button"
          aria-label={`Drag ${item.title}`}
          className="grid h-6 w-3 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground/60 opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 focus:opacity-100 active:cursor-grabbing"
        >
          <GripVertical size={11} strokeWidth={1.75} />
        </button>
      ) : null}
      {showGrip ? (
        <>
          <button type="button" disabled={index === 0} className="sr-only" onClick={onMoveBefore}>
            Move {item.title} before previous context card
          </button>
          <button type="button" disabled={index >= count - 1} className="sr-only" onClick={onMoveAfter}>
            Move {item.title} after next context card
          </button>
        </>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${item.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}
