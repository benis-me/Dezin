import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { PropertyEvent } from "leafer-editor";
import type { MoodboardNode } from "../lib/api.ts";
import { nodeTitle } from "./canvas-utils.ts";

export function MoodboardSectionLabels({
  nodes,
  appRef,
  onSelect,
  onRename,
}: {
  nodes: MoodboardNode[];
  appRef: RefObject<any>;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const sections = nodes.filter((node) => node.type === "section");
  if (sections.length === 0) return null;
  return (
    <div aria-hidden={false} className="pointer-events-none absolute inset-0 z-20">
      {sections.map((node) => (
        <SectionLabel key={node.id} node={node} appRef={appRef} onSelect={onSelect} onRename={onRename} />
      ))}
    </div>
  );
}

function SectionLabel({
  node,
  appRef,
  onSelect,
  onRename,
}: {
  node: MoodboardNode;
  appRef: RefObject<any>;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const labelRef = useRef<HTMLElement | HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const syncPosition = useCallback(() => {
    const element = labelRef.current;
    if (!element) return;
    const app = appRef.current;
    const frame = app?.findId?.(node.id);
    const tree = app?.tree;
    const scaleX = Number(tree?.scaleX ?? tree?.scale ?? 1) || 1;
    const scaleY = Number(tree?.scaleY ?? tree?.scale ?? 1) || 1;
    const treeX = Number(tree?.x ?? 0) || 0;
    const treeY = Number(tree?.y ?? 0) || 0;
    const x = treeX + Number(frame?.x ?? node.x) * scaleX;
    const y = treeY + Number(frame?.y ?? node.y) * scaleY - 20;
    element.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }, [appRef, node.id, node.x, node.y]);

  useEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        syncPosition();
      });
    };
    const syncNow = () => {
      if (frame != null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      syncPosition();
    };
    syncNow();
    const tree = appRef.current?.tree;
    tree?.on?.(PropertyEvent.LEAFER_CHANGE, schedule);
    tree?.on?.("move", schedule);
    tree?.on?.("move.end", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      tree?.off?.(PropertyEvent.LEAFER_CHANGE, schedule);
      tree?.off?.("move", schedule);
      tree?.off?.("move.end", schedule);
      window.removeEventListener("resize", schedule);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [appRef, syncPosition]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const save = (value: string) => {
    onRename(node.id, value.trim() || "Section");
    setEditing(false);
  };

  const baseClass =
    "pointer-events-auto app-no-drag absolute left-0 top-0 h-5 rounded-sm px-1 text-[13px] font-medium leading-5 text-muted-foreground outline-none will-change-transform";

  if (editing) {
    return (
      <input
        ref={(element) => {
          inputRef.current = element;
          labelRef.current = element;
        }}
        aria-label="Section title"
        className={`${baseClass} min-w-28 border border-ring bg-background text-foreground ring-2 ring-ring/20`}
        defaultValue={nodeTitle(node)}
        onBlur={(event) => save(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
    );
  }

  return (
    <span
      ref={labelRef}
      data-moodboard-section-label
      className={`${baseClass} cursor-default select-none hover:bg-background/70 hover:text-foreground`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        setEditing(true);
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {nodeTitle(node)}
    </span>
  );
}
