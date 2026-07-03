import type { ReactNode } from "react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { FileText, FolderOpen, GripVertical, Image as ImageIcon, Images, Layers, MousePointerClick, Paperclip, Sparkles, X } from "lucide-react";
import { cn } from "../lib/utils.ts";

export type AgentComposerContextItem<PreviewTarget = unknown> =
  | { id: string; type: "file"; title: string; subtitle?: string; name: string; path: string }
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
}: {
  items: T[];
  onChange: (items: T[]) => void;
  onRemove: (id: string) => void;
  className?: string;
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
    <div aria-label="Agent context cards" className={cn("mb-2 flex flex-wrap gap-1.5", className)}>
      <DragDropProvider onDragEnd={handleDragEnd}>
        {items.map((item, index) => (
          <AgentComposerContextCard
            key={item.id}
            item={item}
            index={index}
            count={items.length}
            onMoveBefore={() => moveBefore(item.id)}
            onMoveAfter={() => moveAfter(item.id)}
            onRemove={() => onRemove(item.id)}
          />
        ))}
      </DragDropProvider>
    </div>
  );
}

function AgentComposerContextCard<T extends AgentComposerContextItem>({
  item,
  index,
  count,
  onMoveBefore,
  onMoveAfter,
  onRemove,
}: {
  item: T;
  index: number;
  count: number;
  onMoveBefore: () => void;
  onMoveAfter: () => void;
  onRemove: () => void;
}) {
  const { ref, isDragging, isDropTarget } = useSortable({
    id: item.id,
    index,
    group: "agent-composer-context",
    type: "agent-composer-context",
    accept: "agent-composer-context",
    disabled: count < 2,
  });
  const iconKind = contextIconKind(item);

  return (
    <div
      ref={ref}
      data-testid={`agent-context-card-${item.id}`}
      data-context-icon={iconKind}
      className={cn(
        "group flex max-w-full touch-none select-none items-center gap-1 rounded-md border border-border bg-surface-2 px-1 py-1 text-xs text-foreground-2 transition-[opacity,border-color,box-shadow,transform] duration-150 ease-out motion-reduce:transition-none",
        count > 1 && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-55 shadow-lg",
        isDropTarget && "border-primary shadow-[0_0_0_2px_rgba(48,112,255,0.18)]",
      )}
      title={item.subtitle ? `${item.title}: ${item.subtitle}` : item.title}
    >
      <button
        type="button"
        aria-label={`Drag ${item.title}`}
        className="grid h-5 w-4 shrink-0 cursor-grab place-items-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical size={12} strokeWidth={1.75} />
      </button>
      <span className="shrink-0 text-brand" aria-hidden>
        {contextIcon(iconKind)}
      </span>
      <span className="min-w-0 truncate font-medium">{item.title}</span>
      {item.subtitle ? <span className="min-w-0 truncate text-muted-foreground">· {item.subtitle}</span> : null}
      {count > 1 ? (
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
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
      >
        <X size={11} strokeWidth={2} />
      </button>
    </div>
  );
}
