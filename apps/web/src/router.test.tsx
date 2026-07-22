import { render, screen, cleanup, act } from "@testing-library/react";
import { test, expect, afterEach } from "vitest";
import { parsePath, routeToPath, navigate, useRoute, type Route } from "./router.tsx";

afterEach(cleanup);

test("parsePath maps URLs to typed routes", () => {
  expect(parsePath("/")).toEqual({ name: "home" });
  expect(parsePath("/projects/abc")).toEqual({ name: "project", id: "abc" });
  expect(parsePath("/projects/a%20b")).toEqual({ name: "project", id: "a b" });
  expect(parsePath("/projects/p-1/canvas")).toEqual({ name: "project-canvas", id: "p-1" });
  expect(parsePath("/projects/p-1/artifacts/a-1")).toEqual({
    name: "project-artifact",
    id: "p-1",
    artifactId: "a-1",
  });
  expect(parsePath("/projects/p%201/artifacts/a%2F1")).toEqual({
    name: "project-artifact",
    id: "p 1",
    artifactId: "a/1",
  });
  expect(parsePath("/projects/p%201/artifacts/a%2F1/revisions/r%2F1")).toEqual({
    name: "project-artifact-revision",
    id: "p 1",
    artifactId: "a/1",
    revisionId: "r/1",
  });
  expect(parsePath("/projects/p%201/resources/research%2F1")).toEqual({
    name: "project-resource",
    id: "p 1",
    resourceId: "research/1",
  });
  expect(parsePath("/projects/p%201/resources/research%2F1/revisions/revision%2F1")).toEqual({
    name: "project-resource-revision",
    id: "p 1",
    resourceId: "research/1",
    revisionId: "revision/1",
  });
  expect(parsePath("/projects/%ZZ/canvas")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/canvas/extra")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/artifacts/a-1/extra")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/artifacts/a-1/revisions/%ZZ")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/artifacts/a-1/revisions/r-1/extra")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/resources/r-1/revisions/%ZZ")).toEqual({ name: "home" });
  expect(parsePath("/projects/p-1/resources/r-1/revisions/v-1/extra")).toEqual({ name: "home" });
  expect(parsePath("/effects")).toEqual({ name: "effects" });
  expect(parsePath("/effects/new")).toEqual({ name: "effect-new" });
  expect(parsePath("/effects/paper-texture")).toEqual({ name: "effect", id: "paper-texture" });
  expect(parsePath("/design-systems")).toEqual({ name: "design-systems" });
  expect(parsePath("/settings")).toEqual({ name: "settings" });
  expect(parsePath("/totally/unknown")).toEqual({ name: "home" });
});

test("routeToPath round-trips through parsePath", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "project", id: "p1" },
    { name: "project-canvas", id: "p 1" },
    { name: "project-artifact", id: "p 1", artifactId: "a/1" },
    { name: "project-artifact-revision", id: "p 1", artifactId: "a/1", revisionId: "r/1" },
    { name: "project-resource", id: "p 1", resourceId: "research/1" },
    { name: "project-resource-revision", id: "p 1", resourceId: "research/1", revisionId: "revision/1" },
    { name: "effects" },
    { name: "effect-new" },
    { name: "effect", id: "paper-texture" },
    { name: "design-systems" },
    { name: "settings" },
  ];
  for (const r of routes) {
    expect(parsePath(routeToPath(r))).toEqual(r);
  }
});

function Probe() {
  const r = useRoute();
  return <div data-testid="r">{r.name === "project" ? `project:${r.id}` : r.name}</div>;
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
