import type { CSSProperties } from "react";

export interface CanvasEdgeThemeInput {
  kind: "prototype" | "relationship";
  active: boolean;
  broken?: boolean;
  supporting?: boolean;
}

export interface CanvasEdgeTheme {
  halo: CSSProperties;
  path: CSSProperties;
}

/**
 * One visual contract for every workspace relationship. Geometry remains
 * edge-specific; stroke hierarchy, canvas separation, and interaction weight
 * stay consistent here.
 */
export function canvasEdgeTheme({
  kind,
  active,
  broken = false,
  supporting = false,
}: CanvasEdgeThemeInput): CanvasEdgeTheme {
  const prototype = kind === "prototype";
  const foreground = broken
    ? "var(--destructive)"
    : active
      ? "var(--foreground)"
      : "var(--muted-foreground)";
  return {
    halo: {
      stroke: "var(--dezin-canvas-plane, var(--background))",
      strokeWidth: active ? (prototype ? 4 : 3.6) : (prototype ? 3.4 : 3),
      strokeLinecap: "round",
      strokeLinejoin: "round",
      opacity: prototype ? 0.94 : 0.92,
      pointerEvents: "none",
      vectorEffect: "non-scaling-stroke",
    },
    path: {
      stroke: foreground,
      strokeWidth: active ? (prototype ? 1.75 : 1.55) : (prototype ? 1.1 : 1.1),
      strokeDasharray: !prototype && supporting ? "2 5" : undefined,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      opacity: prototype
        ? active || broken ? 0.94 : 0.6
        : active ? 0.84 : 0.5,
      vectorEffect: "non-scaling-stroke",
    },
  };
}
