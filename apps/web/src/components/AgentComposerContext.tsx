import type { ReactNode } from "react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { FileText, FolderOpen, GripVertical, Image as ImageIcon, Images, Layers, MousePointerClick, Paperclip, Sparkles, X } from "lucide-react";
import { cn } from "../lib/utils.ts";

export type AgentComposerContextItem<PreviewTarget = unknown> =
  | {
      id: string;
      type: "file";
      title: string;
      subtitle?: string;
      name: string;
      path: string;
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

function contextIcon(kind: ContextIconKind): ReactNode {
  switch (kind) {
    case "file":
      return <Paperclip size={12} strokeWidth={1.75} />;
    case "folder":
      return <FolderOpen size={12} strokeWidth={1.75} />;
    case "image":
      return <ImageIcon size={12} strokeWidth={1.75} />;
    case "project":
      return <Layers size={12} strokeWidth={1.75} />;
    case "moodboard":
      return <Images size={12} strokeWidth={1.75} />;
    case "effect":
      return <Sparkles size={12} strokeWidth={1.75} />;
    case "preview-target":
      return <MousePointerClick size={12} strokeWidth={1.75} />;
    case "canvas-node":
      return <Images size={12} strokeWidth={1.75} />;
    case "text-context":
      return <FileText size={12} strokeWidth={1.75} />;
  }
}

export function AgentComposerContextCards<T extends AgentComposerContextItem>({
  items,
  onChange,
  onRemove,
  className,
  density = "panel",
  sortable = true,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  onRemove: (id: string) => void;
  className?: string;
  density?: "hero" | "panel";
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
      data-context-layout="rail"
      data-context-density={density}
      className={cn("min-w-0 border-t border-border/70 pt-2.5", className)}
    >
      <div className="flex min-w-0 gap-2 overflow-x-auto pb-0.5 pr-1 [scrollbar-width:thin]">
        <DragDropProvider onDragEnd={handleDragEnd}>
          {items.map((item, index) => (
            <AgentComposerContextCard
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              density={density}
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
  density,
  sortable,
  onMoveBefore,
  onMoveAfter,
  onRemove,
}: {
  item: T;
  index: number;
  count: number;
  density: "hero" | "panel";
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
  const visibleMeta = meta === typeLabel ? undefined : meta;
  const showGrip = sortable && count > 1;

  return (
    <div
      ref={ref}
      role="listitem"
      data-testid={`agent-context-card-${item.id}`}
      data-context-icon={iconKind}
      className={cn(
        "group flex shrink-0 select-none items-center overflow-hidden rounded-lg border border-border bg-card text-xs text-foreground-2 transition-[opacity,border-color,box-shadow,transform,background-color] duration-150 ease-out motion-reduce:transition-none",
        density === "hero" ? "h-[4.75rem] w-60 basis-60 gap-2 p-1.5" : "h-10 w-52 basis-52 gap-1.5 px-1.5",
        isDragging && "opacity-55 ring-2 ring-ring/30",
        isDropTarget && "border-ring ring-2 ring-ring/30",
      )}
      title={meta ? `${item.title}: ${meta}` : item.title}
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-surface-2 text-brand",
          density === "hero" ? "h-full w-16" : "size-7",
        )}
        aria-hidden={item.type === "file" && item.previewUrl ? undefined : true}
      >
        {item.type === "file" && item.previewUrl ? (
          <img className="size-full object-cover" src={item.previewUrl} alt={item.title} />
        ) : (
          contextIcon(iconKind)
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{item.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-none text-muted-foreground">
          <span className="shrink-0">{typeLabel}</span>
          {visibleMeta ? (
            <span className="min-w-0 truncate">· {visibleMeta}</span>
          ) : null}
        </span>
      </span>
      {showGrip ? (
        <button
          ref={handleRef}
          type="button"
          aria-label={`Drag ${item.title}`}
          className="grid h-6 w-4 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <GripVertical size={12} strokeWidth={1.75} />
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
        className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X size={11} strokeWidth={2} />
      </button>
    </div>
  );
}
