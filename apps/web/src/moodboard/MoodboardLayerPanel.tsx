import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  ImagePlus,
  Layers,
  Lock,
  LockOpen,
  SquareDashedMousePointer,
  StickyNote,
} from "lucide-react";
import type { MoodboardNode } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { assetUrl, isNodeLocked, isNodeVisible, layerLabel, nodeFill, nodeStroke, type LayerTreeItem } from "./canvas-utils.ts";

export function MoodboardLayerPanel({
  items,
  selectedId,
  collapsedIds,
  onToggleCollapsed,
  onSelect,
  onHover,
  onRename,
  onToggleVisible,
  onToggleLocked,
  onReorder,
}: {
  items: LayerTreeItem[];
  selectedId: string | null;
  collapsedIds: Set<string>;
  onToggleCollapsed: (id: string) => void;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onToggleVisible: (id: string) => void;
  onToggleLocked: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) return;
    const escaped = typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(selectedId) : selectedId.replace(/["\\]/g, "\\$&");
    const row = scrollRef.current?.querySelector(`[data-moodboard-layer-id="${escaped}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedId, items]);

  return (
    <aside
      data-moodboard-floating-occluder
      className="app-no-drag absolute left-3 top-3 z-20 flex max-h-[calc(100%-5rem)] w-60 select-none flex-col overflow-hidden rounded-md border border-border bg-card/95 text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
    >
      <div className="flex h-9 items-center gap-2 border-b border-border/70 px-3 text-xs font-medium">
        <Layers size={14} strokeWidth={1.75} />
        Layers
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1">
        {items.length === 0 ? (
          <p className="px-3 py-5 text-xs text-muted-foreground">No canvas items yet.</p>
        ) : (
          items.map((item) => (
            <LayerItem
              key={item.node.id}
              item={item}
              depth={0}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              onToggleCollapsed={onToggleCollapsed}
              onSelect={onSelect}
              onHover={onHover}
              onRename={onRename}
              onToggleVisible={onToggleVisible}
              onToggleLocked={onToggleLocked}
              draggingId={draggingId}
              onDragStart={setDraggingId}
              onDragEnd={() => setDraggingId(null)}
              onDropOn={(targetId) => {
                if (draggingId && draggingId !== targetId) onReorder(draggingId, targetId);
                setDraggingId(null);
              }}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function LayerItem({
  item,
  depth,
  selectedId,
  collapsedIds,
  onToggleCollapsed,
  onSelect,
  onHover,
  onRename,
  onToggleVisible,
  onToggleLocked,
  draggingId,
  onDragStart,
  onDragEnd,
  onDropOn,
}: {
  item: LayerTreeItem;
  depth: number;
  selectedId: string | null;
  collapsedIds: Set<string>;
  onToggleCollapsed: (id: string) => void;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onToggleVisible: (id: string) => void;
  onToggleLocked: (id: string) => void;
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropOn: (targetId: string) => void;
}) {
  const { node, children } = item;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(layerLabel(node));
  const selected = selectedId === node.id;
  const collapsed = collapsedIds.has(node.id);
  const hasChildren = children.length > 0;

  useEffect(() => {
    if (!editing) setDraft(layerLabel(node));
  }, [editing, node]);

  const commitRename = () => {
    setEditing(false);
    onRename(node.id, draft.trim() || layerLabel(node));
  };

  return (
    <div onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}>
      <div
        role="button"
        tabIndex={0}
        draggable={!editing}
        data-moodboard-layer-id={node.id}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => setEditing(true)}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-dezin-moodboard-layer", node.id);
          event.dataTransfer.setData("text/plain", node.id);
          onDragStart(node.id);
        }}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          if (!draggingId || draggingId === node.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDropOn(node.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(node.id);
          }
        }}
        className={cn(
          "group flex h-8 min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-left text-xs transition-colors",
          selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/45 hover:text-foreground",
          draggingId === node.id && "opacity-45",
          draggingId && draggingId !== node.id && "data-[drop-target=true]:bg-accent/70",
        )}
        data-drop-target={draggingId && draggingId !== node.id ? "true" : undefined}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <button
          type="button"
          aria-label={collapsed ? "Expand layer" : "Collapse layer"}
          disabled={!hasChildren}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed(node.id);
          }}
          className={cn("grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-surface-2", !hasChildren && "opacity-0")}
        >
          {collapsed ? <ChevronRight size={13} strokeWidth={1.75} /> : <ChevronDown size={13} strokeWidth={1.75} />}
        </button>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left">
          <LayerThumbnail node={node} />
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") {
                  setEditing(false);
                  setDraft(layerLabel(node));
                }
              }}
              className="h-6 min-w-0 flex-1 rounded border border-ring/40 bg-background px-1 text-xs text-foreground outline-none"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className={cn("truncate", !isNodeVisible(node) && "opacity-45")}>{layerLabel(node)}</span>
          )}
        </span>
        <button
          type="button"
          aria-label={isNodeVisible(node) ? "Hide layer" : "Show layer"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleVisible(node.id);
          }}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-surface-2 hover:text-foreground group-hover:opacity-100"
        >
          {isNodeVisible(node) ? <Eye size={13} strokeWidth={1.75} /> : <EyeOff size={13} strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          aria-label={isNodeLocked(node) ? "Unlock layer" : "Lock layer"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleLocked(node.id);
          }}
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-opacity hover:bg-surface-2 hover:text-foreground",
            isNodeLocked(node) ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {isNodeLocked(node) ? <Lock size={13} strokeWidth={1.75} /> : <LockOpen size={13} strokeWidth={1.75} />}
        </button>
      </div>
      {!collapsed
        ? children.map((child) => (
            <LayerItem
              key={child.node.id}
              item={child}
              depth={depth + 1}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              onToggleCollapsed={onToggleCollapsed}
              onSelect={onSelect}
              onHover={onHover}
              onRename={onRename}
              onToggleVisible={onToggleVisible}
              onToggleLocked={onToggleLocked}
              draggingId={draggingId}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDropOn={onDropOn}
            />
          ))
        : null}
    </div>
  );
}

function LayerIcon({ node }: { node: MoodboardNode }) {
  if (node.type === "image" || node.type === "image-generator") return <ImagePlus size={12} strokeWidth={1.75} />;
  if (node.type === "section") return <SquareDashedMousePointer size={12} strokeWidth={1.75} />;
  return <StickyNote size={12} strokeWidth={1.75} />;
}

function LayerThumbnail({ node }: { node: MoodboardNode }) {
  const url = assetUrl(node);
  const checker =
    "linear-gradient(45deg, var(--checker, rgba(0,0,0,0.04)) 25%, transparent 25%), linear-gradient(-45deg, var(--checker, rgba(0,0,0,0.04)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--checker, rgba(0,0,0,0.04)) 75%), linear-gradient(-45deg, transparent 75%, var(--checker, rgba(0,0,0,0.04)) 75%)";

  return (
    <span
      data-testid={`moodboard-layer-thumbnail-${node.id}`}
      className="relative grid size-5 shrink-0 place-items-center overflow-hidden rounded border border-border bg-card"
      style={{ backgroundImage: checker, backgroundSize: "8px 8px", backgroundPosition: "0 0, 0 -4px, -4px 4px, 4px 0px" }}
    >
      {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : <LayerPreviewSwatch node={node} />}
    </span>
  );
}

function LayerPreviewSwatch({ node }: { node: MoodboardNode }) {
  if (node.type === "image-generator") {
    return (
      <span className="grid h-full w-full place-items-center bg-surface-2 text-muted-foreground">
        <ImagePlus size={12} strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <span
      className={cn("grid h-full w-full place-items-center text-muted-foreground", node.type === "section" && "border border-dashed")}
      style={{ background: nodeFill(node), borderColor: nodeStroke(node) }}
    >
      <LayerIcon node={node} />
    </span>
  );
}
