import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CircleAlert, Columns2, GripVertical, LoaderCircle, RotateCw, SlidersHorizontal, X } from "lucide-react";
import { Dialog, Segmented } from "./ui/index.ts";
import { previewDocumentSrc, usePreviewChannel, type PreviewChannelMessage } from "../lib/preview-channel.ts";
import { usePreviewRuntimeErrors, type RuntimeError } from "../lib/preview-runtime-errors.ts";
import { previewSandboxForSrc } from "../lib/preview-sandbox.ts";

type SideBase = {
  bridgeNonce?: string;
  label: string;
  retry?: () => void;
};

export type VersionCompareSide = SideBase & (
  | { status: "loading"; url?: never; error?: never }
  | { status: "ready"; url: string; error?: never }
  | { status: "error"; url?: never; error: string }
  // Keep existing branch-comparison callers compatible while new acquisition flows use explicit state.
  | { status?: undefined; url?: string; error?: string }
);

function sideStatus(side: VersionCompareSide): "loading" | "ready" | "error" {
  if (side.status !== undefined) return side.status;
  if (side.error || !side.url) return "error";
  return "ready";
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

function syncFrameScroll(
  frame: HTMLIFrameElement | null,
  top: number,
  left: number,
  sendScroll?: (top: number, left: number) => void,
): void {
  applyDocumentScroll(frameDocument(frame), top, left);
  sendScroll?.(top, left);
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

export function bindFrameScroll(
  sourceDoc: Document,
  targetFrame: HTMLIFrameElement | null,
  syncingRef: MutableRefObject<boolean>,
  sendScroll?: (top: number, left: number) => void,
): () => void {
  const sourceWindow = sourceDoc.defaultView;
  const onScroll = (): void => {
    if (syncingRef.current) return;
    const source = frameScrollElement(sourceDoc);
    if (!source) return;
    syncingRef.current = true;
    syncFrameScroll(targetFrame, source.scrollTop, source.scrollLeft, sendScroll);
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

function CompareRuntimeNotice({
  label,
  fatal,
  nonFatal,
  side,
  onReload,
  onDismissFatal,
  onDismissNonFatal,
}: {
  label: string;
  fatal: RuntimeError | null;
  nonFatal: RuntimeError[];
  side: "left" | "right";
  onReload: () => void;
  onDismissFatal: () => void;
  onDismissNonFatal: (sig: string) => void;
}) {
  const visible = fatal ?? nonFatal.at(-1) ?? null;
  if (visible === null) return null;
  const dismiss = fatal ? onDismissFatal : () => onDismissNonFatal(visible.sig);
  return (
    <div
      role="alert"
      aria-label={`${label} preview error`}
      className={`absolute bottom-3 z-30 w-[min(20rem,calc(50%-1.25rem))] rounded-lg border border-border bg-card/95 p-3 shadow-lg backdrop-blur-sm ${side === "left" ? "left-3" : "right-3"}`}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-destructive">
          <CircleAlert aria-hidden size={14} strokeWidth={2} className="shrink-0" />
          <strong className="truncate text-xs">{label} preview error</strong>
        </div>
        <button type="button" aria-label={`Dismiss ${label} preview error`} onClick={dismiss} className="shrink-0 text-muted-foreground hover:text-foreground">
          <X aria-hidden size={13} />
        </button>
      </div>
      <p className="line-clamp-3 break-words font-mono text-[11px] leading-relaxed text-foreground">{visible.message}</p>
      {nonFatal.length > 1 && !fatal ? (
        <p className="mt-1 text-[10px] text-muted-foreground">{nonFatal.length} console errors in this pane</p>
      ) : null}
      <button
        type="button"
        aria-label={`Reload ${label} preview`}
        onClick={onReload}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-surface-2"
      >
        <RotateCw aria-hidden size={11} strokeWidth={1.8} />
        Reload pane
      </button>
    </div>
  );
}

/** Visual diff between two versions/branches: side-by-side, or a before/after slider. */
export function VersionCompare({
  open,
  onClose,
  a,
  b,
}: {
  open: boolean;
  onClose: () => void;
  a: VersionCompareSide;
  b: VersionCompareSide;
}) {
  const [mode, setMode] = useState<"slider" | "split">("slider");
  const [pos, setPos] = useState(50);
  const wrapRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLIFrameElement>(null);
  const bRef = useRef<HTMLIFrameElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const syncingScrollRef = useRef(false);
  const aSendRef = useRef<(message: { type: string } & Record<string, unknown>) => boolean>(() => false);
  const bSendRef = useRef<(message: { type: string } & Record<string, unknown>) => boolean>(() => false);
  const aStatus = sideStatus(a);
  const bStatus = sideStatus(b);
  const hasFailedPane = aStatus === "error" || bStatus === "error";
  const canRenderSlider = aStatus === "ready" && bStatus === "ready" && Boolean(a.url && b.url);
  const aErrors = usePreviewRuntimeErrors({
    iframeRef: aRef,
    previewSrc: a.url ?? null,
    runActive: false,
    listenToWindow: false,
  });
  const bErrors = usePreviewRuntimeErrors({
    iframeRef: bRef,
    previewSrc: b.url ?? null,
    runActive: false,
    listenToWindow: false,
  });
  const syncFromA = useCallback((message: PreviewChannelMessage): void => {
    aErrors.ingestMessage(message);
    if (message.type !== "scroll" || syncingScrollRef.current) return;
    const top = typeof message.top === "number" && Number.isFinite(message.top) ? message.top : 0;
    const left = typeof message.left === "number" && Number.isFinite(message.left) ? message.left : 0;
    syncingScrollRef.current = true;
    syncFrameScroll(bRef.current, top, left, (nextTop, nextLeft) => {
      bSendRef.current({ type: "sync-scroll", top: nextTop, left: nextLeft });
    });
    window.setTimeout(() => { syncingScrollRef.current = false; }, 0);
  }, [aErrors.ingestMessage]);
  const syncFromB = useCallback((message: PreviewChannelMessage): void => {
    bErrors.ingestMessage(message);
    if (message.type !== "scroll" || syncingScrollRef.current) return;
    const top = typeof message.top === "number" && Number.isFinite(message.top) ? message.top : 0;
    const left = typeof message.left === "number" && Number.isFinite(message.left) ? message.left : 0;
    syncingScrollRef.current = true;
    syncFrameScroll(aRef.current, top, left, (nextTop, nextLeft) => {
      aSendRef.current({ type: "sync-scroll", top: nextTop, left: nextLeft });
    });
    window.setTimeout(() => { syncingScrollRef.current = false; }, 0);
  }, [bErrors.ingestMessage]);
  const aChannel = usePreviewChannel({
    iframeRef: aRef,
    previewSrc: a.url ?? null,
    bridgeNonce: a.bridgeNonce ?? null,
    enabled: open && Boolean(a.url && a.bridgeNonce),
    onMessage: syncFromA,
  });
  const bChannel = usePreviewChannel({
    iframeRef: bRef,
    previewSrc: b.url ?? null,
    bridgeNonce: b.bridgeNonce ?? null,
    enabled: open && Boolean(b.url && b.bridgeNonce),
    onMessage: syncFromB,
  });
  aSendRef.current = aChannel.send;
  bSendRef.current = bChannel.send;

  useEffect(() => {
    if (!open) dragCleanupRef.current?.();
    return () => dragCleanupRef.current?.();
  }, [open]);

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
      if (aDoc) frameCleanups.push(bindFrameScroll(aDoc, bRef.current, syncingScrollRef, (top, left) => {
        bChannel.send({ type: "sync-scroll", top, left });
      }));
      if (bDoc) frameCleanups.push(bindFrameScroll(bDoc, aRef.current, syncingScrollRef, (top, left) => {
        aChannel.send({ type: "sync-scroll", top, left });
      }));
    };
    const aFrame = aRef.current;
    const bFrame = bRef.current;
    attachFrameScroll();
    aFrame?.addEventListener("load", attachFrameScroll);
    bFrame?.addEventListener("load", attachFrameScroll);
    return () => {
      aFrame?.removeEventListener("load", attachFrameScroll);
      bFrame?.removeEventListener("load", attachFrameScroll);
      cleanupFrameScroll();
    };
  }, [a.url, aChannel.send, b.url, bChannel.send, mode, open]);

  const frame = (side: VersionCompareSide, ref: MutableRefObject<HTMLIFrameElement | null>, onLoad: () => void) => {
    const status = sideStatus(side);
    if (status === "ready" && side.url) {
      return (
        <iframe
          key={side.url}
          ref={ref}
          src={previewDocumentSrc(side.url)}
          title={side.label}
          sandbox={previewSandboxForSrc(previewDocumentSrc(side.url))}
          onLoad={onLoad}
          className="h-full w-full bg-white"
        />
      );
    }
    if (status === "loading") {
      return (
        <div className="grid h-full place-items-center p-8">
          <div
            role="status"
            aria-label={`${side.label} preview loading`}
            className="flex max-w-sm items-start gap-2 rounded-lg border border-border bg-card p-4 text-left"
          >
            <LoaderCircle aria-hidden size={15} className="mt-0.5 shrink-0 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-semibold text-foreground">Preparing preview</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Acquiring an isolated preview for this Revision…</p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid h-full place-items-center p-8">
        <div role="alert" aria-label={`${side.label} preview unavailable`} className="max-w-sm rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-sm font-semibold text-foreground">Preview unavailable</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{side.error ?? "This saved version could not be prepared."}</p>
          {side.retry ? (
            <button
              type="button"
              aria-label={`Retry ${side.label} preview`}
              onClick={side.retry}
              className="mt-3 inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-surface-2"
            >
              <RotateCw aria-hidden size={11} strokeWidth={1.8} />
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderDividerPosition = useCallback((value: number): void => {
    if (aRef.current) aRef.current.style.clipPath = `inset(0 ${100 - value}% 0 0)`;
    if (handleRef.current) handleRef.current.style.left = `${value}%`;
  }, []);
  const commitDividerPosition = useCallback((value: number): void => {
    const next = Math.min(99, Math.max(1, value));
    renderDividerPosition(next);
    setPos(next);
  }, [renderDividerPosition]);

  // Drive pointer drags through the DOM directly (no per-frame React re-render of the iframes),
  // and turn off the iframes' hit-testing so fast mouse, pen, and touch drags stay captured.
  const drag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (typeof e.button === "number" && e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    dragCleanupRef.current?.();
    let p = pos;
    const pointerId = Number.isFinite(e.pointerId) ? e.pointerId : null;
    const handle = e.currentTarget;
    const comparedFrame = aRef.current;
    const currentFrame = bRef.current;
    try { if (pointerId !== null) handle.setPointerCapture(pointerId); } catch { /* JSDOM and detached handles may not implement capture. */ }
    if (comparedFrame) comparedFrame.style.pointerEvents = "none";
    if (currentFrame) currentFrame.style.pointerEvents = "none";
    const move = (ev: PointerEvent): void => {
      if (pointerId !== null && Number.isFinite(ev.pointerId) && ev.pointerId !== pointerId) return;
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || !Number.isFinite(ev.clientX)) return;
      p = Math.min(99, Math.max(1, ((ev.clientX - rect.left) / rect.width) * 100));
      renderDividerPosition(p);
      handleRef.current?.setAttribute("aria-valuenow", String(Math.round(p)));
      handleRef.current?.setAttribute("aria-valuetext", `${Math.round(p)}% compared version`);
    };
    const cleanupDrag = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      handle.removeEventListener("lostpointercapture", lostCapture);
      document.body.style.cursor = "";
      if (comparedFrame) comparedFrame.style.pointerEvents = "";
      if (currentFrame) currentFrame.style.pointerEvents = "";
      if (dragCleanupRef.current === cleanupDrag) dragCleanupRef.current = null;
    };
    const up = (ev: PointerEvent): void => {
      if (pointerId !== null && Number.isFinite(ev.pointerId) && ev.pointerId !== pointerId) return;
      cleanupDrag();
      commitDividerPosition(p);
    };
    const lostCapture = (): void => {
      cleanupDrag();
      commitDividerPosition(p);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    handle.addEventListener("lostpointercapture", lostCapture, { once: true });
    dragCleanupRef.current = cleanupDrag;
  };

  const moveDividerWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = pos - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = pos + step;
    else if (event.key === "PageDown") next = pos - 10;
    else if (event.key === "PageUp") next = pos + 10;
    else if (event.key === "Home") next = 1;
    else if (event.key === "End") next = 99;
    if (next === null) return;
    event.preventDefault();
    commitDividerPosition(next);
  };

  const reloadPane = (
    ref: MutableRefObject<HTMLIFrameElement | null>,
    errors: typeof aErrors,
  ): void => {
    errors.reset();
    const frame = ref.current;
    if (frame) frame.src = frame.src;
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
            value={hasFailedPane ? "split" : mode}
            onChange={(v) => {
              if (!hasFailedPane) setMode(v as typeof mode);
            }}
            options={hasFailedPane
              ? [{ value: "split", title: "Side by side", icon: <Columns2 size={14} strokeWidth={1.75} /> }]
              : [
                  { value: "slider", title: "Before / after slider", icon: <SlidersHorizontal size={14} strokeWidth={1.75} /> },
                  { value: "split", title: "Side by side", icon: <Columns2 size={14} strokeWidth={1.75} /> },
                ]}
          />
          <span className="truncate text-sm font-medium">
            {a.label} <span className="text-muted-foreground">↔</span> {b.label}
          </span>
        </div>
        <div ref={wrapRef} className="relative flex-1 overflow-hidden bg-surface-2">
          {mode === "split" || !canRenderSlider ? (
            <div className="flex h-full">
              <div className="relative h-full flex-1 border-r border-border">
                <span className={`${tag} left-2.5`}>{a.label}</span>
                {frame(a, aRef, aChannel.connect)}
              </div>
              <div className="relative h-full flex-1">
                <span className={`${tag} left-2.5`}>{b.label}</span>
                {frame(b, bRef, bChannel.connect)}
              </div>
            </div>
          ) : (
            <>
              {/* Current fills the pane; the compared version is clipped to the left side. */}
              <iframe
                key={b.url}
                ref={bRef}
                src={b.url ? previewDocumentSrc(b.url) : undefined}
                title={b.label}
                sandbox={previewSandboxForSrc(b.url ? previewDocumentSrc(b.url) : null)}
                onLoad={bChannel.connect}
                className="absolute inset-0 h-full w-full bg-white"
              />
              <iframe
                key={a.url}
                ref={aRef}
                src={a.url ? previewDocumentSrc(a.url) : undefined}
                title={a.label}
                sandbox={previewSandboxForSrc(a.url ? previewDocumentSrc(a.url) : null)}
                onLoad={aChannel.connect}
                className="absolute inset-0 h-full w-full bg-white"
                style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
              />
              <span className={`${tag} left-2.5`}>{a.label}</span>
              <span className={`${tag} right-2.5`}>{b.label}</span>
              <div
                ref={handleRef}
                role="slider"
                tabIndex={0}
                aria-label="Drag to compare"
                aria-orientation="horizontal"
                aria-valuemin={1}
                aria-valuemax={99}
                aria-valuenow={Math.round(pos)}
                aria-valuetext={`${Math.round(pos)}% compared version`}
                onPointerDown={drag}
                onKeyDown={moveDividerWithKeyboard}
                className="absolute inset-y-0 z-20 flex w-9 touch-none -translate-x-1/2 cursor-col-resize items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                style={{ left: `${pos}%` }}
              >
                <span data-testid="compare-divider-line" className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary" />
                <span className="relative grid size-7 place-items-center rounded-full border border-border bg-card shadow-pop">
                  <GripVertical size={14} strokeWidth={2} className="text-foreground" />
                </span>
              </div>
            </>
          )}
          <CompareRuntimeNotice
            label={a.label}
            fatal={aErrors.fatal}
            nonFatal={aErrors.nonFatal}
            side="left"
            onReload={() => reloadPane(aRef, aErrors)}
            onDismissFatal={aErrors.dismissFatal}
            onDismissNonFatal={aErrors.dismissNonFatal}
          />
          <CompareRuntimeNotice
            label={b.label}
            fatal={bErrors.fatal}
            nonFatal={bErrors.nonFatal}
            side="right"
            onReload={() => reloadPane(bRef, bErrors)}
            onDismissFatal={bErrors.dismissFatal}
            onDismissNonFatal={bErrors.dismissNonFatal}
          />
        </div>
      </div>
    </Dialog>
  );
}
