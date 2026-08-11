import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const subscribers = new Set<() => void>();
let activeMediaQuery: MediaQueryList | null = null;

function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber();
}

function attachMediaQuery(): void {
  if (activeMediaQuery || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  activeMediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  activeMediaQuery.addEventListener("change", notifySubscribers);
}

function detachMediaQuery(): void {
  activeMediaQuery?.removeEventListener("change", notifySubscribers);
  activeMediaQuery = null;
}

function readReducedMotionPreference(): boolean {
  if (activeMediaQuery) return activeMediaQuery.matches;
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

function subscribeToReducedMotionPreference(onChange: () => void): () => void {
  subscribers.add(onChange);
  attachMediaQuery();
  return () => {
    subscribers.delete(onChange);
    if (subscribers.size === 0) detachMediaQuery();
  };
}

/**
 * Unlike Motion's cached preference hook, this stays in sync when macOS,
 * Electron emulation, or DevTools changes the media query at runtime.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotionPreference,
    readReducedMotionPreference,
    () => false,
  );
}
