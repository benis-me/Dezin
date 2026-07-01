import type { ReactNode } from "react";
import { ArrowDownToLine, ArrowUpToLine, Copy, Eye, EyeOff, Lock, LockOpen, SquareDashedMousePointer, StickyNote, Trash2, WandSparkles } from "lucide-react";
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
}) {
  return (
    <>
      <button type="button" aria-label="Close canvas menu" className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div
        className="fixed z-50 w-56 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-pop"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        {targetId ? <MenuLabel>Selection</MenuLabel> : null}
        {targetId && onDuplicate ? <MenuButton icon={<Copy size={14} strokeWidth={1.75} />} label="Duplicate" onClick={onDuplicate} /> : null}
        {targetId && onBringToFront ? <MenuButton icon={<ArrowUpToLine size={14} strokeWidth={1.75} />} label="Bring to front" onClick={onBringToFront} /> : null}
        {targetId && onSendToBack ? <MenuButton icon={<ArrowDownToLine size={14} strokeWidth={1.75} />} label="Send to back" onClick={onSendToBack} /> : null}
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
        {targetId && onDelete ? <MenuButton icon={<Trash2 size={14} strokeWidth={1.75} />} label="Delete" onClick={onDelete} destructive /> : null}
        {targetId ? <div className="my-1 h-px bg-border" /> : null}
        <MenuLabel>Canvas</MenuLabel>
        <MenuButton icon={<StickyNote size={14} strokeWidth={1.75} />} label="Add note here" onClick={onAddNote} />
        <MenuButton icon={<SquareDashedMousePointer size={14} strokeWidth={1.75} />} label="Add section here" onClick={onAddSection} />
        <MenuButton icon={<WandSparkles size={14} strokeWidth={1.75} />} label="Add image generator here" onClick={onGenerate} />
      </div>
    </>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function MenuButton({ icon, label, destructive = false, onClick }: { icon: ReactNode; label: string; destructive?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
        destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
