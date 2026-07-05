import { CircleAlert, RotateCw, X } from "lucide-react";
import type { RuntimeError } from "../lib/preview-runtime-errors.ts";

interface Props {
  fatal: RuntimeError | null;
  nonFatal: RuntimeError[];
  onFixFatal: () => void;
  onFixNonFatal: () => void;
  onReload: () => void;
  onDismissFatal: () => void;
  onDismissNonFatal: (sig: string) => void;
}

/**
 * A non-blocking, dismissible bubble pinned to the bottom-right of the preview. It never
 * masks the preview: the wrapper is `pointer-events-none` so clicks in the empty area pass
 * through to the artifact, and only the card itself is interactive.
 */
export function PreviewRuntimeErrorOverlay(props: Props) {
  const { fatal, nonFatal, onFixFatal, onFixNonFatal, onReload, onDismissFatal, onDismissNonFatal } = props;
  if (!fatal && nonFatal.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-20 w-[min(22rem,calc(100%-1.5rem))]">
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-card shadow-lg">
        {fatal ? (
          <div className="border-b border-border p-3">
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5 text-destructive">
                <CircleAlert size={14} strokeWidth={2} className="shrink-0" />
                <span className="text-xs font-semibold">Preview error</span>
              </div>
              <button type="button" aria-label="Dismiss" onClick={onDismissFatal} className="shrink-0 text-muted-foreground hover:text-foreground">
                <X size={13} />
              </button>
            </div>
            <p className="mb-2 break-words font-mono text-[11px] leading-relaxed text-foreground">{fatal.message}</p>
            {fatal.stack ? (
              <pre className="mb-2 max-h-24 overflow-auto rounded-md border border-border bg-surface-2 p-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">{fatal.stack}</pre>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={onFixFatal} className="rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background hover:opacity-90">
                Fix with Agent
              </button>
              <button type="button" onClick={onReload} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-surface-2">
                <RotateCw size={11} strokeWidth={1.8} />
                Reload
              </button>
            </div>
          </div>
        ) : null}

        {nonFatal.length > 0 ? (
          <div className="p-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {nonFatal.length} console {nonFatal.length === 1 ? "error" : "errors"}
              </span>
              <button type="button" onClick={onFixNonFatal} className="text-[11px] font-medium text-foreground hover:underline">
                Fix with Agent
              </button>
            </div>
            <ul className="max-h-32 space-y-0.5 overflow-auto">
              {nonFatal.map((e) => (
                <li key={e.sig} className="flex items-start justify-between gap-2 rounded-md px-1 py-0.5">
                  <span className="min-w-0 break-words font-mono text-[10px] text-muted-foreground">
                    {e.message}
                    {e.count > 1 ? ` ×${e.count}` : ""}
                  </span>
                  <button type="button" aria-label="Dismiss" onClick={() => onDismissNonFatal(e.sig)} className="shrink-0 text-muted-foreground hover:text-foreground">
                    <X size={11} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
