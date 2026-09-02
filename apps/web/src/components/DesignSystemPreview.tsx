import type { DesignSystemCard, Swatch } from "../lib/api.ts";

const FALLBACK_SWATCH: Swatch = {
  bg: "var(--surface)",
  surface: "var(--surface-2)",
  fg: "var(--foreground)",
  accent: "var(--muted-foreground)",
};

function readableAccentForeground(accent: string, fallback: string): string {
  const match = accent.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return fallback;
  const raw = match[1]!.length === 3
    ? match[1]!.replace(/(.)/g, "$1$1")
    : match[1]!;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16) / 255);
  const luminance = channels
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const darkContrast = (luminance + 0.05) / 0.05;
  const lightContrast = 1.05 / (luminance + 0.05);
  return darkContrast >= lightContrast ? "#111111" : "#ffffff";
}

/** A compact, on-hover specimen, loaded only when someone asks to see it. */
export default function DesignSystemPreview({ system }: { system: DesignSystemCard }) {
  const sw = system.swatch ?? FALLBACK_SWATCH;
  const accentForeground = readableAccentForeground(sw.accent, sw.fg);
  return (
    <div className="dz-animate-in w-56 overflow-hidden rounded-lg border border-border bg-popover shadow-pop">
      <div className="px-3 py-2.5" style={{ background: sw.bg, color: sw.fg }}>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold tracking-tight">{system.name}</span>
        </div>
        <div className="mt-0.5 text-[11px]" style={{ opacity: 0.55 }}>
          Aa · the quick brown fox
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className="rounded px-2 py-0.5 text-[11px] font-medium"
            style={{ background: sw.accent, color: accentForeground }}
          >
            Button
          </span>
          <span
            className="rounded px-2 py-0.5 text-[11px]"
            style={{ background: sw.surface, color: sw.fg, border: `1px solid ${sw.accent}22` }}
          >
            Input
          </span>
        </div>
      </div>
      <div className="flex h-5">
        {[sw.bg, sw.surface, sw.fg, sw.accent].map((color, index) => (
          <span key={index} className="flex-1" style={{ background: color }} />
        ))}
      </div>
      {system.category ? (
        <div className="truncate px-3 py-1.5 text-[11px] text-muted-foreground">{system.category}</div>
      ) : null}
    </div>
  );
}
