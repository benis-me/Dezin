import { useEffect, useRef } from "react";

/**
 * Keep a list live without SSE: re-run `refresh` when the window regains focus, when the tab
 * becomes visible again, and on a light interval while the tab is visible. The latest `refresh`
 * is always used (held in a ref), so callers need not memoize it and the listeners/interval are
 * attached only once.
 */
export function useAutoRefresh(refresh: () => void, options: { intervalMs?: number; enabled?: boolean } = {}): void {
  const { intervalMs = 12000, enabled = true } = options;
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    const tick = (): void => {
      if (!document.hidden) latest.current();
    };
    const onFocus = (): void => latest.current();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", tick);
    const timer = intervalMs > 0 ? window.setInterval(tick, intervalMs) : undefined;
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", tick);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [intervalMs, enabled]);
}
