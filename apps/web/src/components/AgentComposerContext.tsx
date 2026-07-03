import type { ReactNode } from "react";
import { FileText, FolderOpen, GripVertical, Images, Layers, MousePointerClick, Paperclip, X } from "lucide-react";
import { cn } from "../lib/utils.ts";

export type AgentComposerContextItem<PreviewTarget = unknown> =
  | { id: string; type: "file"; title: string; subtitle?: string; name: string; path: string }
  | { id: string; type: "local-path"; title: string; subtitle?: string; path: string }
  | { id: string; type: "project"; title: string; subtitle?: string; projectId: string; name: string; referencePath?: string }
  | { id: string; type: "moodboard"; title: string; subtitle?: string; moodboardId: string; name?: string }
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

function contextIcon(type: AgentComposerContextItem["type"]): ReactNode {
  switch (type) {
    case "file":
      return <Paperclip size={12} strokeWidth={1.75} />;
    case "local-path":
      return <FolderOpen size={12} strokeWidth={1.75} />;
    case "project":
      return <Layers size={12} strokeWidth={1.75} />;
    case "moodboard":
      return <Images size={12} strokeWidth={1.75} />;
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

  return (
    <div aria-label="Agent context cards" className={cn("mb-2 flex flex-wrap gap-1.5", className)}>
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`agent-context-card-${item.id}`}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const activeId = event.dataTransfer.getData("application/x-dezin-agent-context-id") || event.dataTransfer.getData("text/plain");
            if (activeId) onChange(moveContextItem(items, activeId, item.id));
          }}
          className="group flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 px-1 py-1 text-xs text-foreground-2"
          title={item.subtitle ? `${item.title}: ${item.subtitle}` : item.title}
        >
          <button
            type="button"
            aria-label={`Drag ${item.title}`}
            draggable
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-dezin-agent-context-id", item.id);
              event.dataTransfer.setData("text/plain", item.id);
            }}
            className="grid h-5 w-4 shrink-0 cursor-grab place-items-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical size={12} strokeWidth={1.75} />
          </button>
          <span className="shrink-0 text-brand">{contextIcon(item.type)}</span>
          <span className="min-w-0 truncate font-medium">{item.title}</span>
          {item.subtitle ? <span className="min-w-0 truncate text-muted-foreground">· {item.subtitle}</span> : null}
          <button
            type="button"
            aria-label={`Remove ${item.title}`}
            onClick={() => onRemove(item.id)}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          >
            <X size={11} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
