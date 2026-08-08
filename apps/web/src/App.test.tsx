import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { test, expect, afterEach, beforeEach, vi } from "vitest";
import App, { designCanvasAttachmentItems } from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
import { peekPendingDesignCanvasIntent } from "./lib/pending-design-canvas.ts";
import { makeFakeApi } from "./test/fake-api.ts";
import { validPngFile } from "./test/image-fixtures.ts";
import type { DesignJob } from "./design-canvas/types.ts";

beforeEach(() => {
  window.history.pushState({}, "", "/");
  localStorage.setItem("dezin.onboarded", "1"); // skip first-run onboarding in app tests
});
afterEach(cleanup);

const api = makeFakeApi({
  listDesignSystems: async () => [
    { id: "modern-minimal", name: "Modern Minimal", category: "Modern & Minimal", summary: "neutral" },
  ],
  getDesignCanvas: async (projectId) => ({
    schemaVersion: 1,
    projectId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeOrder: [],
    nodes: [],
    undoDepth: 0,
    redoDepth: 0,
    createdAt: 1,
    updatedAt: 1,
  }),
});

function renderApp() {
  return render(
    <ApiProvider client={api}>
      <App />
    </ApiProvider>,
  );
}

test("renders the shell and the Home screen by default", () => {
  renderApp();
  expect(screen.getByText("Dezin")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Start a design" })).toBeInTheDocument();
});

test("routes to each screen", async () => {
  window.history.pushState({}, "", "/design-systems");
  renderApp();
  expect(await screen.findByRole("heading", { name: "Design systems" })).toBeInTheDocument();
  expect(await screen.findByText("Modern Minimal")).toBeInTheDocument();
  cleanup();

  window.history.pushState({}, "", "/projects/new");
  renderApp();
  expect(await screen.findByRole("main", { name: "Design canvas" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add Design node" })).toBeInTheDocument();
});

test("a Project screen wires a ready Export to the browser-safe path fallback", async () => {
  window.history.pushState({}, "", "/projects/export-project");
  const writeText = vi.fn(async () => {});
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const readyExport: DesignJob = {
    id: "job-ready-export",
    kind: "implementation-export",
    runnerId: "fixture",
    model: null,
    status: "ready",
    nodeId: null,
    parentJobId: null,
    contextHash: "context",
    versionId: null,
    exportId: "export-ready-1",
    error: null,
    activity: [],
    createdAt: 1,
    updatedAt: 2,
    finishedAt: 2,
  };
  try {
    render(
      <ApiProvider client={makeFakeApi({
        ...api,
        getProject: async () => ({
          id: "export-project",
          name: "Export Project",
          projectPath: "/tmp/dezin-export-project",
          createdAt: 1,
          updatedAt: 1,
        }),
        listDesignJobs: async () => [readyExport],
      })}>
        <App />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Main Agent" }));
    expect(await screen.findByTitle("/tmp/dezin-export-project/design/exports/export-ready-1")).toBeInTheDocument();
    const reveal = screen.getByRole("button", { name: "Reveal export" });
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "/tmp/dezin-export-project/design/exports/export-ready-1",
    ));
    expect(await screen.findByText("Finder unavailable · path copied.")).toBeInTheDocument();
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("the gear navigates to route-driven Settings and close returns to the prior route", async () => {
  renderApp();
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  fireEvent.click(screen.getByLabelText("Settings"));
  expect(window.location.pathname).toBe("/settings");
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Appearance" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(window.location.pathname).toBe("/"));
});

test("route-driven Settings keeps the background screen mounted and uses browser back on close", async () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  renderApp();
  const prompt = screen.getByLabelText("Describe your design");
  fireEvent.change(prompt, { target: { value: "Keep this draft while settings are open" } });
  fireEvent.click(screen.getByLabelText("Settings"));
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByLabelText("Describe your design")).toHaveValue("Keep this draft while settings are open");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(back).toHaveBeenCalledTimes(1);
});

test("direct /settings renders Settings instead of falling back to Home", async () => {
  window.history.pushState({}, "", "/settings");
  renderApp();
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Appearance" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Start a design" })).toBeNull();
});

test("closing a direct /settings entry replaces it instead of pushing a history trap", async () => {
  window.history.pushState({}, "", "/settings");
  const replaceState = vi.spyOn(window.history, "replaceState");
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  expect(replaceState).toHaveBeenCalledWith({}, "", "/");
  expect(window.location.pathname).toBe("/");
});

test("the theme toggle flips the .dark class", () => {
  renderApp();
  const before = document.documentElement.classList.contains("dark");
  fireEvent.click(screen.getByLabelText(/Switch to (light|dark) mode/));
  expect(document.documentElement.classList.contains("dark")).toBe(!before);
});

test("creating a project asks the daemon for a generated title in the background", async () => {
  const createProject = vi.fn(async () => ({
    id: "p1",
    name: "A dashboard for pricing experiments",
    createdAt: 1,
    updatedAt: 1,
  }));
  const generateProjectTitle = vi.fn(async () => ({
    id: "p1",
    name: "Pricing Control Room",
    createdAt: 1,
    updatedAt: 2,
  }));
  render(
    <ApiProvider client={makeFakeApi({ ...api, createProject, generateProjectTitle })}>
      <App />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Describe your design"), { target: { value: "A dashboard for pricing experiments" } });
  fireEvent.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(createProject).toHaveBeenCalled());
  await waitFor(() => expect(generateProjectTitle).toHaveBeenCalledWith("p1", "A dashboard for pricing experiments"));
});

test("Home attachment mapping keeps exact source Version identity in the atomic import", () => {
  expect(designCanvasAttachmentItems({
    images: [],
    refs: [{
      name: "Checkout source",
      base64: "",
      projectReference: {
        sourceProjectId: "source-project",
        sourceNodeId: "node-page",
        sourceVersionId: "version-exact",
      },
    }],
  })).toEqual([{
    asset: {
      name: "Checkout source.html",
      mimeType: "text/html",
      sourceVersion: {
        projectId: "source-project",
        nodeId: "node-page",
        versionId: "version-exact",
      },
    },
    binding: {
      type: "create-node",
      node: {
        id: "node-home-reference-1",
        kind: "document",
        name: "Checkout source",
        geometry: { x: 100, y: 100, width: 360, height: 260 },
      },
    },
  }]);
});

test("Home sends attached bytes through one Canvas batch without the retired ref-upload path", async () => {
  const createProject = vi.fn(async () => ({ id: "atomic-home", name: "Untitled", createdAt: 1, updatedAt: 1 }));
  const getDesignCanvas = vi.fn(async (projectId: string) => ({
    schemaVersion: 1 as const,
    projectId,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeOrder: [],
    nodes: [],
    undoDepth: 0,
    redoDepth: 0,
    createdAt: 1,
    updatedAt: 1,
  }));
  const importDesignCanvasAssets = vi.fn(async (projectId: string) => ({
    ...(await getDesignCanvas(projectId)),
    revision: 1,
  }));
  render(
    <ApiProvider client={makeFakeApi({ ...api, createProject, getDesignCanvas, importDesignCanvasAssets })}>
      <App />
    </ApiProvider>,
  );

  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  expect(imageInput).not.toBeNull();
  fireEvent.change(imageInput!, { target: { files: [validPngFile("direction.png")] } });
  await screen.findByLabelText("Remove direction.png");
  fireEvent.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(importDesignCanvasAssets).toHaveBeenCalledTimes(1));
  expect(importDesignCanvasAssets).toHaveBeenCalledWith("atomic-home", {
    expectedRevision: 0,
    items: [{
      asset: {
        name: "direction.png",
        mimeType: "image/png",
        base64: expect.any(String),
      },
      binding: {
        type: "create-node",
        node: {
          id: "node-home-image-1",
          kind: "image",
          name: "direction.png",
          geometry: { x: 100, y: 100, width: 360, height: 260 },
        },
      },
    }],
  });
});

test("Home removes a just-created Project when its atomic attachment import fails", async () => {
  const createProject = vi.fn(async () => ({ id: "failed-home", name: "Untitled", createdAt: 1, updatedAt: 1 }));
  const importDesignCanvasAssets = vi.fn(async () => { throw new Error("batch rejected"); });
  const deleteProject = vi.fn(async () => undefined);
  render(
    <ApiProvider client={makeFakeApi({
      ...api,
      createProject,
      importDesignCanvasAssets,
      deleteProject,
    })}>
      <App />
    </ApiProvider>,
  );

  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  expect(imageInput).not.toBeNull();
  fireEvent.change(imageInput!, { target: { files: [validPngFile("rollback.png")] } });
  await screen.findByLabelText("Remove rollback.png");
  fireEvent.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("failed-home"));
  expect(importDesignCanvasAssets).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe("/");
  expect(peekPendingDesignCanvasIntent("failed-home")).toBeNull();
});
