import type { Layout } from "react-resizable-panels";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function readPanelPercent(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw)) {
      const percent = raw <= 1 ? raw * 100 : raw;
      return clamp(percent, min, max);
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return fallback;
}

export function twoPanelLayout(firstId: string, firstPercent: number, secondId: string): Layout {
  const first = clamp(firstPercent, 1, 99);
  return { [firstId]: first, [secondId]: 100 - first };
}

export function savePanelFraction(key: string, layout: Layout, panelId: string): void {
  const percent = layout[panelId];
  if (!Number.isFinite(percent)) return;
  try {
    localStorage.setItem(key, String(percent / 100));
  } catch {
    /* localStorage may be unavailable */
  }
}

export const RESIZE_SEPARATOR_CLASS =
  "app-no-drag w-px cursor-col-resize bg-border outline-none transition-colors hover:bg-primary focus-visible:bg-primary data-[separator=active]:bg-primary";
