import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * A vertical drag separator between two horizontal panes. The caller owns the split
 * fraction (and any persistence); this just reports the new clamped fraction on drag.
 */
export function ResizeHandle({
  containerRef,
  onResize,
  value,
  label = "Resize panels",
  min = 0.2,
  max = 0.6,
  className,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onResize: (fraction: number) => void;
  value?: number;
  label?: string;
  min?: number;
  max?: number;
  className?: string;
}) {
  const clamp = (fraction: number): number => Math.min(max, Math.max(min, fraction));

  const start = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const onMove = (ev: MouseEvent): void => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      onResize(clamp((ev.clientX - rect.left) / rect.width));
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

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (value === undefined) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 0.05 : 0.02;
    onResize(clamp(value + (e.key === "ArrowRight" ? step : -step)));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}
      tabIndex={0}
      onMouseDown={start}
      onKeyDown={onKeyDown}
      className={cn(
        "app-no-drag w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary focus-visible:bg-primary focus-visible:outline-none",
        className,
      )}
    />
  );
}
