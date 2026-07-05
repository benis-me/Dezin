import { useState } from "react";
import { CircleAlert, RotateCw, X } from "lucide-react";
import type { RuntimeError } from "../lib/preview-runtime-errors.ts";
import { cn } from "@/lib/utils.ts";

interface Props {
  fatal: RuntimeError | null;
  nonFatal: RuntimeError[];
  onFixFatal: () => void;
  onFixNonFatal: () => void;
  onReload: () => void;
  onDismissFatal: () => void;
  onDismissNonFatal: (sig: string) => void;
}

export function PreviewRuntimeErrorOverlay(props: Props) {
  const { fatal, nonFatal, onFixFatal, onFixNonFatal, onReload, onDismissFatal, onDismissNonFatal } = props;
  const [open, setOpen] = useState(false);
  if (!fatal && nonFatal.length === 0) return null;

  return (
    <>
      {fatal ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-surface/85 backdrop-blur-sm p-6">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-destructive">
              <CircleAlert size={16} strokeWidth={2} />
              <h2 className="text-sm font-semibold">This preview crashed</h2>
            </div>
            <p className="mb-3 break-words font-mono text-xs text-foreground">{fatal.message}</p>
            {fatal.stack ? (
              <pre className="mb-3 max-h-32 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] text-muted-foreground">{fatal.stack}</pre>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={onFixFatal} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90">Fix with Agent</button>
              <button type="button" onClick={onReload} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-2"><RotateCw size={12} strokeWidth={1.8} />Reload</button>
              <button type="button" onClick={onDismissFatal} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-2">Dismiss</button>
            </div>
          </div>
        </div>
      ) : null}

      {nonFatal.length > 0 ? (
        <div className="absolute bottom-3 right-3 z-20">
          <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/15">
            <CircleAlert size={12} strokeWidth={2} />Errors · {nonFatal.length}
          </button>
          {open ? (
            <div className="mt-2 w-80 rounded-lg border border-border bg-card p-2 shadow-sm">
              <ul className="max-h-56 space-y-1 overflow-auto">
                {nonFatal.map((e) => (
                  <li key={e.sig} className={cn("flex items-start justify-between gap-2 rounded-md px-2 py-1 text-[11px]")}>
                    <span className="min-w-0 break-words font-mono text-muted-foreground">{e.message}{e.count > 1 ? ` ×${e.count}` : ""}</span>
                    <button type="button" aria-label="Dismiss" onClick={() => onDismissNonFatal(e.sig)} className="shrink-0 text-muted-foreground hover:text-foreground"><X size={12} /></button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={onFixNonFatal} className="mt-2 w-full rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90">Fix with Agent</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
