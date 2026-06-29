import type { Layout } from "react-resizable-panels";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function readStoredPanelPercent(key: string, min: number, max: number): number | null {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null || stored.trim() === "") return null;
    const raw = Number(stored);
    if (Number.isFinite(raw)) {
      const percent = raw <= 1 ? raw * 100 : raw;
      return clamp(percent, min, max);
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return null;
}

export function readPanelPercent(key: string, fallback: number, min: number, max: number): number {
  const stored = readStoredPanelPercent(key, min, max);
  if (stored !== null) return stored;
  return fallback;
}

export function panelPercentFromPixels(pixels: number, totalPixels: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(pixels) || !Number.isFinite(totalPixels) || totalPixels <= 0) return fallback;
  return clamp((pixels / totalPixels) * 100, min, max);
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
  "dezin-resize-separator app-no-drag";
