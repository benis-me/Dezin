import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ClipboardCopy,
  ClipboardPaste,
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

const ESTIMATED_MENU_RECT = { width: 224, height: 320 };

export function MoodboardContextMenu({
  menu,
  targetId,
  targetNode,
  onClose,
  onAddNote,
  onAddSection,
  onGenerate,
  onCopy,
  onPaste,
  onDuplicate,
  onMoveForward,
  onMoveBackward,
  onBringToFront,
  onSendToBack,
  onToggleVisible,
  onToggleLocked,
  onDelete,
  onZoomIn,
  onZoomOut,
  onFitView,
  onResetZoom,
  boundaryElement,
}: {
  menu: ContextMenuState;
  targetId: string | null;
  targetNode: MoodboardNode | null;
  onClose: () => void;
  onAddNote: () => void;
  onAddSection: () => void;
  onGenerate: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onDuplicate?: () => void;
  onMoveForward?: () => void;
  onMoveBackward?: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onToggleVisible?: () => void;
  onToggleLocked?: () => void;
  onDelete?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitView?: () => void;
  onResetZoom?: () => void;
  boundaryElement?: HTMLElement | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const getInitialPosition = useCallback(
    () => resolveMenuPosition(menu.x, menu.y, ESTIMATED_MENU_RECT, boundaryElement?.getBoundingClientRect()),
    [boundaryElement, menu.x, menu.y],
  );
  const [position, setPosition] = useState(getInitialPosition);

  const updatePosition = useCallback(() => {
    const element = menuRef.current;
    if (!element) {
      setPosition(getInitialPosition());
      return;
    }

    const measured = element.getBoundingClientRect();
    const rect = measured.width > 0 && measured.height > 0 ? measured : ESTIMATED_MENU_RECT;
    setPosition(resolveMenuPosition(menu.x, menu.y, rect, boundaryElement?.getBoundingClientRect()));
  }, [boundaryElement, getInitialPosition, menu.x, menu.y]);

  useLayoutEffect(() => {
    setPosition(getInitialPosition());
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    const observer = boundaryElement && typeof ResizeObserver === "function" ? new ResizeObserver(updatePosition) : null;
    if (boundaryElement) observer?.observe(boundaryElement);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      observer?.disconnect();
    };
  }, [boundaryElement, getInitialPosition, updatePosition]);

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
        {targetId && onCopy ? <MenuButton icon={<ClipboardCopy size={14} strokeWidth={1.75} />} label="Copy" shortcut="Cmd C" onClick={onCopy} /> : null}
        {targetId && onPaste ? <MenuButton icon={<ClipboardPaste size={14} strokeWidth={1.75} />} label="Paste" shortcut="Cmd V" onClick={onPaste} /> : null}
        {targetId && onDuplicate ? <MenuButton icon={<Copy size={14} strokeWidth={1.75} />} label="Duplicate" shortcut="Cmd D" onClick={onDuplicate} /> : null}
        {targetId && (onMoveForward || onMoveBackward || onBringToFront || onSendToBack) ? <div className="my-1 h-px bg-border" /> : null}
        {targetId && onMoveForward ? <MenuButton icon={<ArrowUp size={14} strokeWidth={1.75} />} label="Move forward" shortcut="Cmd ↑" onClick={onMoveForward} /> : null}
        {targetId && onMoveBackward ? <MenuButton icon={<ArrowDown size={14} strokeWidth={1.75} />} label="Move backward" shortcut="Cmd ↓" onClick={onMoveBackward} /> : null}
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
            {onPaste ? <MenuButton icon={<ClipboardPaste size={14} strokeWidth={1.75} />} label="Paste" shortcut="Cmd V" onClick={onPaste} /> : null}
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

function resolveMenuPosition(x: number, y: number, menuRect: Pick<DOMRect, "width" | "height">, boundaryRect?: Pick<DOMRect, "left" | "top" | "right" | "bottom"> | null) {
  const padding = 8;
  const bounds = boundaryRect ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const minX = bounds.left + padding;
  const minY = bounds.top + padding;
  const maxX = Math.max(minX, bounds.right - menuRect.width - padding);
  const maxY = Math.max(minY, bounds.bottom - menuRect.height - padding);
  let nextX = x;
  let nextY = y;
  let flippedX = false;
  let flippedY = false;
  if (nextX + menuRect.width > bounds.right - padding) {
    nextX = x - menuRect.width;
    flippedX = true;
  }
  if (nextX < minX) nextX = flippedX ? maxX : minX;
  if (nextY + menuRect.height > bounds.bottom - padding) {
    nextY = y - menuRect.height;
    flippedY = true;
  }
  if (nextY < minY) nextY = flippedY ? maxY : minY;
  return {
    x: Math.min(maxX, Math.max(minX, nextX)),
    y: Math.min(maxY, Math.max(minY, nextY)),
  };
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
