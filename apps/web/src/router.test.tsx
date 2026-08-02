import { render, screen, cleanup, act } from "@testing-library/react";
import { test, expect, afterEach } from "vitest";
import { parsePath, routeToPath, navigate, useRoute, type Route } from "./router.tsx";

afterEach(cleanup);

test("parsePath maps only current routes", () => {
  expect(parsePath("/")).toEqual({ name: "home" });
  expect(parsePath("/projects/abc")).toEqual({ name: "project", id: "abc" });
  expect(parsePath("/projects/a%20b")).toEqual({ name: "project", id: "a b" });
  expect(parsePath("/projects/p-1/canvas")).toEqual({ name: "project-canvas", id: "p-1" });
  expect(parsePath("/projects/%ZZ/canvas")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/canvas/extra")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/artifacts/a-1")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/resources/r-1")).toEqual({ name: "home" });
  expect(parsePath("/effects")).toEqual({ name: "effects" });
  expect(parsePath("/effects/new")).toEqual({ name: "effect-new" });
  expect(parsePath("/effects/paper-texture")).toEqual({ name: "effect", id: "paper-texture" });
  expect(parsePath("/moodboards/board-1")).toEqual({ name: "moodboard", id: "board-1" });
  expect(parsePath("/design-systems")).toEqual({ name: "design-systems" });
  expect(parsePath("/settings")).toEqual({ name: "settings" });
  expect(parsePath("/totally/unknown")).toEqual({ name: "home" });
});

test("routeToPath round-trips through parsePath", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "project", id: "p1" },
    { name: "project-canvas", id: "p 1" },
    { name: "effects" },
    { name: "effect-new" },
    { name: "effect", id: "paper-texture" },
    { name: "moodboards" },
    { name: "moodboard", id: "board 1" },
    { name: "design-systems" },
    { name: "design-system-new" },
    { name: "design-system", id: "system 1" },
    { name: "settings" },
  ];
  for (const route of routes) {
    expect(parsePath(routeToPath(route))).toEqual(route);
  }
});

function Probe() {
  const route = useRoute();
  return <div data-testid="r">{route.name === "project" ? `project:${route.id}` : route.name}</div>;
}

test("useRoute reflects navigate()", () => {
  window.history.pushState({}, "", "/");
  render(<Probe />);
  expect(screen.getByTestId("r").textContent).toBe("home");

  act(() => navigate("/projects/p1"));
  expect(screen.getByTestId("r").textContent).toBe("project:p1");
  expect(window.location.pathname).toBe("/projects/p1");

  act(() => navigate("/settings"));
  expect(screen.getByTestId("r").textContent).toBe("settings");
});

test("useRoute reacts to popstate (back/forward)", () => {
  window.history.pushState({}, "", "/");
  render(<Probe />);
  act(() => {
    window.history.pushState({}, "", "/design-systems");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByTestId("r").textContent).toBe("design-systems");
});

test("navigate is a no-op when the path is unchanged", () => {
  window.history.pushState({}, "", "/settings");
  const before = window.history.length;
  navigate("/settings");
  expect(window.history.length).toBe(before);
});
