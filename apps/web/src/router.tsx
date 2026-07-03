/**
 * A tiny pushState router — no react-router. A typed Route union, navigate() over
 * the History API, and a useRoute() hook via useSyncExternalStore. A minimal,
 * dependency-light hash router.
 */

import { useSyncExternalStore } from "react";
import type { AnchorHTMLAttributes, ReactNode, MouseEvent } from "react";

export type Route =
  | { name: "home" }
  | { name: "project"; id: string }
  | { name: "effects" }
  | { name: "effect-new" }
  | { name: "effect"; id: string }
  | { name: "moodboards" }
  | { name: "moodboard"; id: string }
  | { name: "design-systems" }
  | { name: "design-system-new" }
  | { name: "design-system"; id: string }
  | { name: "settings" };

const NAV_EVENT = "dezin:navigate";

export function parsePath(pathname: string): Route {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return { name: "home" };
  if (segs[0] === "projects" && segs[1]) return { name: "project", id: decodeURIComponent(segs[1]) };
  if (segs[0] === "effects" && segs[1] === "new") return { name: "effect-new" };
  if (segs[0] === "effects" && segs[1]) return { name: "effect", id: decodeURIComponent(segs[1]) };
  if (segs[0] === "effects") return { name: "effects" };
  if (segs[0] === "moodboards" && segs[1]) return { name: "moodboard", id: decodeURIComponent(segs[1]) };
  if (segs[0] === "moodboards") return { name: "moodboards" };
  if (segs[0] === "design-systems" && segs[1] === "new") return { name: "design-system-new" };
  if (segs[0] === "design-systems" && segs[1]) return { name: "design-system", id: decodeURIComponent(segs[1]) };
  if (segs[0] === "design-systems") return { name: "design-systems" };
  if (segs[0] === "settings") return { name: "settings" };
  return { name: "home" };
}

export function routeToPath(route: Route): string {
  switch (route.name) {
    case "project":
      return `/projects/${encodeURIComponent(route.id)}`;
    case "effects":
      return "/effects";
    case "effect-new":
      return "/effects/new";
    case "effect":
      return `/effects/${encodeURIComponent(route.id)}`;
    case "moodboards":
      return "/moodboards";
    case "moodboard":
      return `/moodboards/${encodeURIComponent(route.id)}`;
    case "design-systems":
      return "/design-systems";
    case "design-system-new":
      return "/design-systems/new";
    case "design-system":
      return `/design-systems/${encodeURIComponent(route.id)}`;
    case "settings":
      return "/settings";
    case "home":
    default:
      return "/";
  }
}

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

// useSyncExternalStore needs a stable snapshot: cache the Route while the path is unchanged.
let cachedPath: string | null = null;
let cachedRoute: Route = { name: "home" };

function getSnapshot(): Route {
  const p = window.location.pathname;
  if (p !== cachedPath) {
    cachedPath = p;
    cachedRoute = parsePath(p);
  }
  return cachedRoute;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type LinkProps = { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>;

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onClick?.(e);
    navigate(to);
  };
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
