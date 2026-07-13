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
  | { name: "project-canvas"; id: string }
  | { name: "project-artifact"; id: string; artifactId: string }
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

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parsePath(pathname: string): Route {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return { name: "home" };
  if (segs[0] === "projects" && segs.length === 4 && segs[1] && segs[2] === "artifacts" && segs[3]) {
    const id = decodeSegment(segs[1]);
    const artifactId = decodeSegment(segs[3]);
    if (id !== null && artifactId !== null) return { name: "project-artifact", id, artifactId };
    return { name: "home" };
  }
  if (segs[0] === "projects" && segs.length === 3 && segs[1] && segs[2] === "canvas") {
    const id = decodeSegment(segs[1]);
    return id === null ? { name: "home" } : { name: "project-canvas", id };
  }
  if (segs[0] === "projects" && segs.length === 2 && segs[1]) {
    const id = decodeSegment(segs[1]);
    return id === null ? { name: "home" } : { name: "project", id };
  }
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
    case "project-canvas":
      return `/projects/${encodeURIComponent(route.id)}/canvas`;
    case "project-artifact":
      return `/projects/${encodeURIComponent(route.id)}/artifacts/${encodeURIComponent(route.artifactId)}`;
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

export function replace(path: string): void {
  if (path === window.location.pathname) return;
  window.history.replaceState({}, "", path);
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
