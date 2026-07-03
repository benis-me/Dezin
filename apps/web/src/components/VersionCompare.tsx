import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject } from "react";
import { Columns2, GripVertical, SlidersHorizontal } from "lucide-react";
import { Dialog, Segmented } from "./ui/index.ts";
import { previewSandboxForSrc } from "../lib/preview-sandbox.ts";

interface Side {
  url: string;
  label: string;
}

function frameDocument(frame: HTMLIFrameElement | null): Document | null {
  try {
    return frame?.contentDocument ?? frame?.contentWindow?.document ?? null;
  } catch {
    return null;
  }
}

function frameScrollElement(doc: Document): HTMLElement | null {
  return (doc.scrollingElement as HTMLElement | null) ?? doc.documentElement ?? doc.body ?? null;
}

function applyDocumentScroll(doc: Document | null, top: number, left: number): void {
  if (!doc) return;
  const root = frameScrollElement(doc);
  if (!root) return;
  root.scrollTop = top;
  root.scrollLeft = left;
  if (doc.documentElement && doc.documentElement !== root) {
    doc.documentElement.scrollTop = top;
    doc.documentElement.scrollLeft = left;
  }
  if (doc.body && doc.body !== root) {
    doc.body.scrollTop = top;
    doc.body.scrollLeft = left;
  }
}

function postScrollSync(frame: HTMLIFrameElement | null, top: number, left: number): void {
  try {
    frame?.contentWindow?.postMessage({ source: "dezin-parent", type: "sync-scroll", top, left }, "*");
  } catch {
    // Cross-origin frames can still receive postMessage, but tolerate browser edge cases.
  }
}

function syncFrameScroll(frame: HTMLIFrameElement | null, top: number, left: number): void {
  applyDocumentScroll(frameDocument(frame), top, left);
  postScrollSync(frame, top, left);
}

function addFrameScrollListener(win: Window | null, onScroll: EventListener): void {
  try {
    win?.addEventListener("scroll", onScroll, { passive: true });
  } catch {
    // The iframe may have navigated cross-origin between attach and cleanup.
  }
}

function removeFrameScrollListener(win: Window | null, onScroll: EventListener): void {
  try {
    win?.removeEventListener("scroll", onScroll);
  } catch {
    // WindowProxy can throw SecurityError after the iframe has navigated cross-origin.
  }
}

export function bindFrameScroll(sourceDoc: Document, targetFrame: HTMLIFrameElement | null, syncingRef: MutableRefObject<boolean>): () => void {
  const sourceWindow = sourceDoc.defaultView;
  const onScroll = (): void => {
    if (syncingRef.current) return;
    const source = frameScrollElement(sourceDoc);
    if (!source) return;
    syncingRef.current = true;
    syncFrameScroll(targetFrame, source.scrollTop, source.scrollLeft);
    window.setTimeout(() => {
      syncingRef.current = false;
    }, 0);
  };
  addFrameScrollListener(sourceWindow, onScroll);
  try {
    sourceDoc.addEventListener("scroll", onScroll, true);
  } catch {
    // Detached/cross-origin frame documents are best-effort for scroll sync.
  }
  return () => {
    removeFrameScrollListener(sourceWindow, onScroll);
    try {
      sourceDoc.removeEventListener("scroll", onScroll, true);
    } catch {
      // Ignore iframe teardown races; postMessage bridge still handles live frames.
    }
  };
}

/** Visual diff between two versions/branches: side-by-side, or a before/after slider. */
export function VersionCompare({ open, onClose, a, b }: { open: boolean; onClose: () => void; a: Side; b: Side }) {
  const [mode, setMode] = useState<"slider" | "split">("slider");
  const [pos, setPos] = useState(50);
  const wrapRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLIFrameElement>(null);
  const bRef = useRef<HTMLIFrameElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const syncingScrollRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let frameCleanups: Array<() => void> = [];
    const cleanupFrameScroll = (): void => {
      for (const cleanup of frameCleanups) {
        try {
          cleanup();
        } catch {
          // Never let iframe teardown errors unmount the app.
        }
      }
      frameCleanups = [];
    };
    const attachFrameScroll = (): void => {
      cleanupFrameScroll();
      const aDoc = frameDocument(aRef.current);
      const bDoc = frameDocument(bRef.current);
      if (aDoc) frameCleanups.push(bindFrameScroll(aDoc, bRef.current, syncingScrollRef));
      if (bDoc) frameCleanups.push(bindFrameScroll(bDoc, aRef.current, syncingScrollRef));
    };
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { source?: string; type?: string; top?: unknown; left?: unknown } | null;
      if (!data || data.source !== "dezin" || data.type !== "scroll") return;
      const sourceWindow = event.source;
      const targetFrame = sourceWindow === aRef.current?.contentWindow ? bRef.current : sourceWindow === bRef.current?.contentWindow ? aRef.current : null;
      if (!targetFrame) return;
      const top = typeof data.top === "number" && Number.isFinite(data.top) ? data.top : 0;
      const left = typeof data.left === "number" && Number.isFinite(data.left) ? data.left : 0;
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      syncFrameScroll(targetFrame, top, left);
      window.setTimeout(() => {
        syncingScrollRef.current = false;
      }, 0);
    };
    const aFrame = aRef.current;
    const bFrame = bRef.current;
    attachFrameScroll();
    aFrame?.addEventListener("load", attachFrameScroll);
    bFrame?.addEventListener("load", attachFrameScroll);
    window.addEventListener("message", onMessage);
    return () => {
      aFrame?.removeEventListener("load", attachFrameScroll);
      bFrame?.removeEventListener("load", attachFrameScroll);
      window.removeEventListener("message", onMessage);
      cleanupFrameScroll();
    };
  }, [open, mode, a.url, b.url]);

  // Drive the drag through the DOM directly (no per-frame React re-render of the iframes),
  // and turn off the iframes' hit-testing so fast drags don't get swallowed by them.
  const drag = (e: ReactMouseEvent): void => {
    e.preventDefault();
    let p = pos;
    if (aRef.current) aRef.current.style.pointerEvents = "none";
    if (bRef.current) bRef.current.style.pointerEvents = "none";
    const move = (ev: MouseEvent): void => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      p = Math.min(99, Math.max(1, ((ev.clientX - rect.left) / rect.width) * 100));
      if (aRef.current) aRef.current.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
      if (handleRef.current) handleRef.current.style.left = `${p}%`;
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      if (aRef.current) aRef.current.style.pointerEvents = "";
      if (bRef.current) bRef.current.style.pointerEvents = "";
      setPos(p);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const tag = "pointer-events-none absolute top-2.5 z-10 rounded-md bg-foreground/85 px-2 py-0.5 text-[11px] font-medium text-background";

  return (
    <Dialog open={open} onClose={onClose} label="Compare versions" className="sm:max-w-[92vw]" showClose>
      <div className="flex h-[82vh] flex-col">
        {/* toggle sits on the left so it never collides with the Dialog close button */}
        <div className="flex items-center gap-3 border-b border-border py-2 pl-3 pr-12">
          <Segmented
            ariaLabel="Compare mode"
            size="sm"
            value={mode}
            onChange={(v) => setMode(v as typeof mode)}
            options={[
              { value: "slider", title: "Before / after slider", icon: <SlidersHorizontal size={14} strokeWidth={1.75} /> },
              { value: "split", title: "Side by side", icon: <Columns2 size={14} strokeWidth={1.75} /> },
            ]}
          />
          <span className="truncate text-sm font-medium">
            {a.label} <span className="text-muted-foreground">↔</span> {b.label}
          </span>
        </div>
        <div ref={wrapRef} className="relative flex-1 overflow-hidden bg-surface-2">
          {mode === "split" ? (
            <div className="flex h-full">
              <div className="relative h-full flex-1 border-r border-border">
                <span className={`${tag} left-2.5`}>{a.label}</span>
                <iframe key={a.url} ref={aRef} src={a.url} title={a.label} sandbox={previewSandboxForSrc(a.url)} className="h-full w-full bg-white" />
              </div>
              <div className="relative h-full flex-1">
                <span className={`${tag} left-2.5`}>{b.label}</span>
                <iframe key={b.url} ref={bRef} src={b.url} title={b.label} sandbox={previewSandboxForSrc(b.url)} className="h-full w-full bg-white" />
              </div>
            </div>
          ) : (
            <>
              {/* Current fills the pane; the compared version is clipped to the left side. */}
              <iframe
                key={b.url}
                ref={bRef}
                src={b.url}
                title={b.label}
                sandbox={previewSandboxForSrc(b.url)}
                className="absolute inset-0 h-full w-full bg-white"
              />
              <iframe
                key={a.url}
                ref={aRef}
                src={a.url}
                title={a.label}
                sandbox={previewSandboxForSrc(a.url)}
                className="absolute inset-0 h-full w-full bg-white"
                style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
              />
              <span className={`${tag} left-2.5`}>{a.label}</span>
              <span className={`${tag} right-2.5`}>{b.label}</span>
              <button
                ref={handleRef}
                type="button"
                aria-label="Drag to compare"
                onMouseDown={drag}
                className="absolute inset-y-0 z-20 flex w-9 -translate-x-1/2 cursor-col-resize items-center justify-center"
                style={{ left: `${pos}%` }}
              >
                <span data-testid="compare-divider-line" className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary" />
                <span className="relative grid size-7 place-items-center rounded-full border border-border bg-card shadow-pop">
                  <GripVertical size={14} strokeWidth={2} className="text-foreground" />
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
