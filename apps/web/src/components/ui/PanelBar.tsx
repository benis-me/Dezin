import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * The canonical sub-panel toolbar — a 36px bar with a bottom hairline, used for the
 * Code / Files / Quality / History pane headers so they share one rhythm.
 */
export function PanelBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("label-mono flex h-9 shrink-0 items-center gap-2 border-b border-border px-3", className)}>
      {children}
    </div>
  );
}
