import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../lib/utils.ts";

const COLLAPSE_DURATION_MS = 220;
const COLLAPSE_SETTLE_BUFFER_MS = 40;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function measuredContentSize(content: HTMLElement): number {
  return Math.max(content.scrollHeight, content.getBoundingClientRect().height);
}

export function AgentCollapsible({
  open,
  id,
  className,
  children,
}: {
  open: boolean;
  id?: string;
  className: string;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const openRef = useRef(open);
  const frameRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  openRef.current = open;

  const cancelPendingMotion = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const finishMotion = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    root.style.blockSize = openRef.current ? "" : "0px";
    root.removeAttribute("data-agent-collapsible-moving");
    if (!openRef.current) setPresent(false);
  }, []);

  const restartSettleClock = useCallback(() => {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(
      finishMotion,
      COLLAPSE_DURATION_MS + COLLAPSE_SETTLE_BUFFER_MS,
    );
  }, [finishMotion]);

  useLayoutEffect(() => {
    if (open && !present) setPresent(true);
  }, [open, present]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root) return;

    cancelPendingMotion();

    if (!mountedRef.current) {
      mountedRef.current = true;
      root.style.blockSize = open ? "" : "0px";
      return;
    }

    if (!content) return;

    if (prefersReducedMotion()) {
      root.style.blockSize = open ? "" : "0px";
      root.removeAttribute("data-agent-collapsible-moving");
      if (!open) setPresent(false);
      return;
    }

    // Freeze the exact rendered frame first. The following message therefore
    // keeps its top position through the React commit instead of jumping to the
    // disclosure's final layout before motion begins.
    const currentSize = root.getBoundingClientRect().height;
    root.style.blockSize = `${currentSize}px`;
    root.setAttribute("data-agent-collapsible-moving", "");
    void root.offsetHeight;

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const nextContent = contentRef.current;
      const nextRoot = rootRef.current;
      if (!nextContent || !nextRoot) return;
      nextRoot.style.blockSize = openRef.current ? `${measuredContentSize(nextContent)}px` : "0px";
      restartSettleClock();
    });

    return cancelPendingMotion;
  }, [cancelPendingMotion, open, present, restartSettleClock]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const root = rootRef.current;
    if (!content || !root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!openRef.current || !root.hasAttribute("data-agent-collapsible-moving")) return;
      const nextSize = `${measuredContentSize(content)}px`;
      if (root.style.blockSize === nextSize) return;
      root.style.blockSize = nextSize;
      restartSettleClock();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [present, restartSettleClock]);

  useLayoutEffect(() => cancelPendingMotion, [cancelPendingMotion]);

  return (
    <div
      ref={rootRef}
      id={id}
      className={cn(className, "agent-collapsible")}
      data-collapsed={!open || undefined}
      data-state={open ? "open" : "closed"}
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={(event) => {
        if (event.currentTarget !== event.target) return;
        if (event.propertyName && event.propertyName !== "block-size" && event.propertyName !== "height") return;
        finishMotion();
      }}
    >
      {present ? (
        <div ref={contentRef} data-agent-collapsible-content="">
          {children}
        </div>
      ) : null}
    </div>
  );
}
