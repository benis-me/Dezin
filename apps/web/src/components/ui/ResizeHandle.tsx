import { type MouseEvent as ReactMouseEvent, type RefObject } from "react";

/**
 * A vertical drag separator between two horizontal panes. The caller owns the split
 * fraction (and any persistence); this just reports the new clamped fraction on drag.
 */
export function ResizeHandle({
  containerRef,
  onResize,
  min = 0.2,
  max = 0.6,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onResize: (fraction: number) => void;
  min?: number;
  max?: number;
}) {
  const start = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const onMove = (ev: MouseEvent): void => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      onResize(Math.min(max, Math.max(min, (ev.clientX - rect.left) / rect.width)));
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      onMouseDown={start}
      className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary"
    />
  );
}
