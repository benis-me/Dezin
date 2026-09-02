import type { Swatch } from "../lib/api.ts";

/**
 * The square mark shown before a design-system name: the system's own surface
 * and accent colours. Built-in systems are named for the public products whose
 * design language inspired them, but Dezin does not ship those companies'
 * trademarks or logos; the palette is the identity.
 */
export function DesignSystemMark({ swatch, className = "size-6" }: { id?: string; swatch?: Swatch; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-md border border-border-strong/40 ${className}`}
      style={{ background: swatch?.surface ?? "var(--surface-2)" }}
    >
      <span className="size-2.5 rounded-full" style={{ background: swatch?.accent ?? "var(--muted-foreground)" }} />
    </span>
  );
}
