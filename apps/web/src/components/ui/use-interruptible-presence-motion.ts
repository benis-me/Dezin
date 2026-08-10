import { useCallback, useLayoutEffect, useRef, type Ref } from "react";

interface PresenceMotionOptions {
  openDurationMs?: number;
  closeDurationMs?: number;
  distancePx?: number;
  openScale?: number;
  closedScale?: number;
}

interface PresenceAnimationState {
  animation: Animation;
  target: "open" | "closed";
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
    openDurationMs = 220,
    closeDurationMs = 150,
    distancePx = 7,
    openScale = 0.975,
    closedScale = 0.985,
  }: PresenceMotionOptions = {},
): (node: T | null) => void {
  const localRef = useRef<T | null>(null);
  const runningRef = useRef<PresenceAnimationState | null>(null);
  const setRef = useCallback((node: T | null) => {
    localRef.current = node;
    assignRef(forwardedRef, node);
  }, [forwardedRef]);

  useLayoutEffect(() => {
    const element = localRef.current;
    if (!element) return;
    const run = () => {
      const target = element.dataset.state === "closed" ? "closed" : "open";
      if (runningRef.current?.target === target) return;
      if (typeof element.animate !== "function"
        || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        runningRef.current?.animation.cancel();
        runningRef.current = null;
        return;
      }
      const computed = getComputedStyle(element);
      const currentOpacity = Number.parseFloat(computed.opacity);
      const currentTransform = computed.transform === "none"
        ? target === "open"
          ? closedTransform(element, distancePx, openScale)
          : "translate3d(0, 0, 0) scale(1)"
        : computed.transform;
      runningRef.current?.animation.cancel();
      const animation = element.animate([
        { opacity: Number.isFinite(currentOpacity) ? currentOpacity : target === "open" ? 0 : 1, transform: currentTransform },
        target === "open"
          ? { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }
          : { opacity: 0, transform: closedTransform(element, distancePx * 0.7, closedScale) },
      ], {
        duration: target === "open" ? openDurationMs : closeDurationMs,
        easing: target === "open" ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
        fill: "both",
      });
      runningRef.current = { animation, target };
    };
    run();
    const observer = new MutationObserver(run);
    observer.observe(element, { attributes: true, attributeFilter: ["data-state", "data-side"] });
    return () => {
      observer.disconnect();
      runningRef.current?.animation.cancel();
      runningRef.current = null;
    };
  }, [closeDurationMs, closedScale, distancePx, openDurationMs, openScale]);

  return setRef;
}
