import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  SquareDashedMousePointer,
  StickyNote,
  Trash2,
  WandSparkles,
} from "lucide-react";
import type { MoodboardNode } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { isNodeLocked, isNodeVisible, type ContextMenuState } from "./canvas-utils.ts";

export function MoodboardContextMenu({
  menu,
  targetId,
  targetNode,
  onClose,
  onAddNote,
  onAddSection,
  onGenerate,
  onDuplicate,
  onBringToFront,
  onSendToBack,
  onToggleVisible,
  onToggleLocked,
  onDelete,
  onZoomIn,
  onZoomOut,
  onFitView,
  onResetZoom,
}: {
  menu: ContextMenuState;
  targetId: string | null;
  targetNode: MoodboardNode | null;
  onClose: () => void;
  onAddNote: () => void;
  onAddSection: () => void;
  onGenerate: () => void;
  onDuplicate?: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onToggleVisible?: () => void;
  onToggleLocked?: () => void;
  onDelete?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitView?: () => void;
  onResetZoom?: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => ({ x: menu.x, y: menu.y }));

  const updatePosition = useCallback(() => {
    const element = menuRef.current;
    if (!element) {
      setPosition({ x: menu.x, y: menu.y });
      return;
    }

    const rect = element.getBoundingClientRect();
    const padding = 8;
    const maxX = Math.max(padding, window.innerWidth - rect.width - padding);
    const maxY = Math.max(padding, window.innerHeight - rect.height - padding);
    setPosition({
      x: Math.min(maxX, Math.max(padding, menu.x)),
      y: Math.min(maxY, Math.max(padding, menu.y)),
    });
  }, [menu.x, menu.y]);

  useLayoutEffect(() => {
    setPosition({ x: menu.x, y: menu.y });
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
    };
  }, [menu.x, menu.y, updatePosition]);

  return (
    <>
      <button
        type="button"
        aria-label="Close canvas menu"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-50 w-56 rounded-md border border-border bg-card p-1 text-sm text-popover-foreground shadow-none"
        style={{ left: position.x, top: position.y }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {targetId ? <MenuLabel>Selection</MenuLabel> : null}
        {targetId && onDuplicate ? <MenuButton icon={<Copy size={14} strokeWidth={1.75} />} label="Duplicate" shortcut="Cmd D" onClick={onDuplicate} /> : null}
        {targetId && onBringToFront ? <MenuButton icon={<ArrowUpToLine size={14} strokeWidth={1.75} />} label="Bring to front" shortcut="]" onClick={onBringToFront} /> : null}
        {targetId && onSendToBack ? <MenuButton icon={<ArrowDownToLine size={14} strokeWidth={1.75} />} label="Send to back" shortcut="[" onClick={onSendToBack} /> : null}
        {targetNode && onToggleVisible ? (
          <MenuButton
            icon={isNodeVisible(targetNode) ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
            label={isNodeVisible(targetNode) ? "Hide layer" : "Show layer"}
            onClick={onToggleVisible}
          />
        ) : null}
        {targetNode && onToggleLocked ? (
          <MenuButton
            icon={isNodeLocked(targetNode) ? <LockOpen size={14} strokeWidth={1.75} /> : <Lock size={14} strokeWidth={1.75} />}
            label={isNodeLocked(targetNode) ? "Unlock layer" : "Lock layer"}
            onClick={onToggleLocked}
          />
        ) : null}
        {targetId && onDelete ? <MenuButton icon={<Trash2 size={14} strokeWidth={1.75} />} label="Delete" shortcut="Del" onClick={onDelete} destructive /> : null}
        {!targetId ? (
          <>
            <MenuLabel>Canvas</MenuLabel>
            <MenuButton icon={<StickyNote size={14} strokeWidth={1.75} />} label="Add note here" shortcut="S" onClick={onAddNote} />
            <MenuButton icon={<SquareDashedMousePointer size={14} strokeWidth={1.75} />} label="Add section here" onClick={onAddSection} />
            <MenuButton icon={<WandSparkles size={14} strokeWidth={1.75} />} label="Add image generator here" onClick={onGenerate} />
          </>
        ) : null}
        {onZoomIn || onZoomOut || onFitView || onResetZoom ? <div className="my-1 h-px bg-border" /> : null}
        {onZoomIn || onZoomOut || onFitView || onResetZoom ? <MenuLabel>View</MenuLabel> : null}
        {onFitView ? <MenuButton icon={<Maximize2 size={14} strokeWidth={1.75} />} label="Fit view" shortcut="Shift 1" onClick={onFitView} /> : null}
        {onZoomIn ? <MenuButton icon={<Plus size={14} strokeWidth={1.75} />} label="Zoom in" shortcut="Cmd +" onClick={onZoomIn} /> : null}
        {onZoomOut ? <MenuButton icon={<Minus size={14} strokeWidth={1.75} />} label="Zoom out" shortcut="Cmd -" onClick={onZoomOut} /> : null}
        {onResetZoom ? <MenuButton icon={<RotateCcw size={14} strokeWidth={1.75} />} label="Reset zoom" shortcut="Cmd 0" onClick={onResetZoom} /> : null}
      </div>
    </>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function MenuButton({
  icon,
  label,
  shortcut,
  destructive = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
        destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? <span className="ml-3 shrink-0 text-[10px] font-medium text-muted-foreground">{shortcut}</span> : null}
    </button>
  );
}
