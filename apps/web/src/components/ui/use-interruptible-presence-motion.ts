import { useCallback, useRef, type Ref } from "react";

interface PresenceMotionOptions {
  openDurationMs?: number;
  closeDurationMs?: number;
  distancePx?: number;
  openScale?: number;
  closedScale?: number;
  skipAnimationOnInstantOpen?: boolean;
}

interface PresenceAnimationState {
  animation: Animation;
  target: "open" | "closed";
  reducedMotion: boolean;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function closedTransform(element: HTMLElement, distancePx: number, scale: number): string {
  switch (element.dataset.side) {
    case "top": return `translate3d(0, ${distancePx}px, 0) scale(${scale})`;
    case "left": return `translate3d(${distancePx}px, 0, 0) scale(${scale})`;
    case "right": return `translate3d(${-distancePx}px, 0, 0) scale(${scale})`;
    default: return `translate3d(0, ${-distancePx}px, 0) scale(${scale})`;
  }
}

/**
 * Radix keeps presence content mounted for its CSS exit animation. This layer
 * replaces only the visual opacity/transform track with WAAPI so a rapid
 * open/close reversal starts from the exact current frame instead of jumping to
 * a keyframe endpoint. The CSS animation remains in place as Radix's presence
 * clock and as the no-WAAPI fallback.
 */
export function useInterruptiblePresenceMotion<T extends HTMLElement>(
  forwardedRef?: Ref<T>,
  {
    openDurationMs = 250,
    closeDurationMs = 150,
    distancePx = 8,
    openScale = 0.97,
    closedScale = 0.99,
    skipAnimationOnInstantOpen = false,
  }: PresenceMotionOptions = {},
): (node: T | null) => void {
  const runningRef = useRef<PresenceAnimationState | null>(null);
  const detachRef = useRef<() => void>(() => undefined);
  const attachedNodeRef = useRef<T | null>(null);
  const detachTimerRef = useRef<number | null>(null);
  const initializedNodesRef = useRef(new WeakSet<T>());
  const setRef = useCallback((node: T | null) => {
    assignRef(forwardedRef, node);
    if (!node) {
      // Radix composes refs across Tooltip/Popper layers. A harmless rerender can
      // synchronously (or across a microtask) emit `null` followed by the same
      // DOM node. Cleaning up immediately cancels the in-flight WAAPI entrance,
      // so the reattachment restarts at opacity 0 and visibly flashes.
      if (attachedNodeRef.current && detachTimerRef.current === null) {
        const expectedNode = attachedNodeRef.current;
        detachTimerRef.current = window.setTimeout(() => {
          detachTimerRef.current = null;
          if (attachedNodeRef.current !== expectedNode) return;
          detachRef.current();
          attachedNodeRef.current = null;
        }, 0);
      }
      return;
    }

    if (detachTimerRef.current !== null) {
      window.clearTimeout(detachTimerRef.current);
      detachTimerRef.current = null;
    }
    // A same-node callback-ref churn is not a new visual presence lifecycle.
    // Keep its observer and compositor animation alive at the current frame.
    if (attachedNodeRef.current === node) return;

    detachRef.current();
    attachedNodeRef.current = node;

    let freshAttachment = !initializedNodesRef.current.has(node);
    initializedNodesRef.current.add(node);
    const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    const run = () => {
      const element = node;
      const target = element.dataset.state === "closed" ? "closed" : "open";
      const reducedMotion = reducedMotionQuery?.matches ?? false;
      if (!freshAttachment
        && runningRef.current?.target === target
        && runningRef.current.reducedMotion === reducedMotion) return;
      if (typeof element.animate !== "function") {
        runningRef.current?.animation.cancel();
        runningRef.current = null;
        freshAttachment = false;
        return;
      }
      const instantOpen = skipAnimationOnInstantOpen
        && target === "open"
        && element.dataset.state === "instant-open";
      if (reducedMotion || instantOpen) {
        runningRef.current?.animation.cancel();
        const finalFrame = target === "open"
          ? { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }
          : { opacity: 0, transform: "translate3d(0, 0, 0) scale(1)" };
        const animation = element.animate([finalFrame, finalFrame], {
          duration: 0,
          fill: "both",
        });
        runningRef.current = { animation, target, reducedMotion };
        freshAttachment = false;
        return;
      }
      const computed = getComputedStyle(element);
      const currentOpacity = Number.parseFloat(computed.opacity);
      const computedTransform = computed.transform;
      const currentTransform = freshAttachment && target === "open"
        ? closedTransform(element, distancePx, openScale)
        : !computedTransform || computedTransform === "none"
        ? target === "open"
          ? closedTransform(element, distancePx, openScale)
          : "translate3d(0, 0, 0) scale(1)"
        : computedTransform;
      runningRef.current?.animation.cancel();
      const animation = element.animate([
        {
          opacity: freshAttachment && target === "open"
            ? 0
            : Number.isFinite(currentOpacity)
              ? currentOpacity
              : target === "open" ? 0 : 1,
          transform: currentTransform,
        },
        target === "open"
          ? { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }
          : { opacity: 0, transform: closedTransform(element, distancePx * 0.7, closedScale) },
      ], {
        duration: target === "open" ? openDurationMs : closeDurationMs,
        // Entrances and exits both respond immediately. An ease-in on close
        // makes a transient menu feel as though it hesitates after dismissal.
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "both",
      });
      runningRef.current = { animation, target, reducedMotion };
      freshAttachment = false;
    };
    run();
    const observer = new MutationObserver(run);
    // Radix may flip `data-side` while its popper measures collisions. That is
    // positioning metadata, not a presence transition; restarting the visual
    // track here causes a visible flash during an otherwise-stable open state.
    observer.observe(node, { attributes: true, attributeFilter: ["data-state"] });
    reducedMotionQuery?.addEventListener("change", run);
    detachRef.current = () => {
      observer.disconnect();
      reducedMotionQuery?.removeEventListener("change", run);
      runningRef.current?.animation.cancel();
      runningRef.current = null;
      detachRef.current = () => undefined;
    };
  }, [closeDurationMs, closedScale, distancePx, forwardedRef, openDurationMs, openScale, skipAnimationOnInstantOpen]);

  return setRef;
}
