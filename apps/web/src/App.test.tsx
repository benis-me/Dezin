import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { test, expect, afterEach, beforeEach, vi } from "vitest";
import App, { designCanvasAttachmentItems, homeBootstrapFingerprint } from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
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
    schemaVersion: 2,
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

function renderApp(client = api) {
  return render(
    <ApiProvider client={client}>
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
  renderApp({
    ...api,
    getDesignCanvas: async (projectId) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return api.getDesignCanvas(projectId);
    },
  });
  expect(await screen.findByRole("main", { name: "Design canvas" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Add Design node" })).toBeInTheDocument();
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
    schemaVersion: 2,
    id: "job-ready-export",
    kind: "implementation-export",
    runnerId: "fixture",
    model: null,
    status: "ready",
    nodeId: null,
    parentJobId: null,
    contextHash: "context",
    canvasRevision: 1,
    expectedHeadVersionId: null,
    versionId: null,
    exportId: "export-ready-1",
    error: null,
    cancelRequested: false,
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
    const exportDisclosure = await screen.findByRole("button", { name: "Implementation export · ready" });
    expect(exportDisclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(exportDisclosure);
    expect(exportDisclosure).toHaveAttribute("aria-expanded", "true");
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
  const bootstrapDesignProject = vi.fn(async () => ({
    project: {
      id: "p1",
      name: "A dashboard for pricing experiments",
      createdAt: 1,
      updatedAt: 1,
    },
    bootstrap: {
      job: {
        schemaVersion: 1 as const,
        id: "bootstrap-p1",
        projectId: "p1",
        requestHash: "request-hash",
        status: "ready" as const,
        completedPhase: "ready" as const,
        mainJobId: "job-main",
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
      reused: false,
    },
  }));
  const generateProjectTitle = vi.fn(async () => ({
    id: "p1",
    name: "Pricing Control Room",
    createdAt: 1,
    updatedAt: 2,
  }));
  render(
    <ApiProvider client={makeFakeApi({ ...api, bootstrapDesignProject, generateProjectTitle })}>
      <App />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Describe your design"), { target: { value: "A dashboard for pricing experiments" } });
  fireEvent.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(bootstrapDesignProject).toHaveBeenCalled());
  await waitFor(() => expect(generateProjectTitle).toHaveBeenCalledWith(
    "p1",
    "A dashboard for pricing experiments",
    undefined,
  ));
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

test("Home retry fingerprint stays bounded while exact attachment bytes remain authoritative", async () => {
  const base64 = btoa("x".repeat(256 * 1024));
  const request = {
    schemaVersion: 1 as const,
    name: "Large attachment",
    prompt: "Use the reference",
    items: [{
      asset: { name: "large.txt", mimeType: "text/plain", base64 },
      binding: {
        type: "create-node" as const,
        node: { id: "node-large", kind: "document" as const, name: "Large" },
      },
    }],
  };

  const first = await homeBootstrapFingerprint(request);
  const replay = await homeBootstrapFingerprint(request);
  const changed = await homeBootstrapFingerprint({
    ...request,
    items: [{ ...request.items[0]!, asset: { ...request.items[0]!.asset, base64: btoa(`${"x".repeat(256 * 1024 - 1)}y`) } }],
  });

  expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(first.length).toBe(71);
  expect(replay).toBe(first);
  expect(changed).not.toBe(first);
  expect(first).not.toContain(base64.slice(0, 64));
});

test("Home sends attached bytes through one durable bootstrap before navigating", async () => {
  const bootstrapDesignProject = vi.fn(async () => ({
    project: { id: "atomic-home", name: "Untitled", createdAt: 1, updatedAt: 1 },
    bootstrap: {
      job: {
        schemaVersion: 1 as const,
        id: "bootstrap-home",
        projectId: "atomic-home",
        requestHash: "a".repeat(64),
        status: "ready" as const,
        completedPhase: "ready" as const,
        mainJobId: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
      reused: false,
    },
  }));
  const createProject = vi.fn(api.createProject);
  const importDesignCanvasAssets = vi.fn(api.importDesignCanvasAssets);
  render(
    <ApiProvider client={makeFakeApi({ ...api, createProject, importDesignCanvasAssets, bootstrapDesignProject })}>
      <App />
    </ApiProvider>,
  );

  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  expect(imageInput).not.toBeNull();
  fireEvent.change(imageInput!, { target: { files: [validPngFile("direction.png")] } });
  await screen.findByLabelText("Remove direction.png");
  fireEvent.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(bootstrapDesignProject).toHaveBeenCalledTimes(1));
  expect(bootstrapDesignProject).toHaveBeenCalledWith(expect.objectContaining({
    schemaVersion: 1,
    idempotencyKey: expect.any(String),
    name: "Recreate the reference screenshot faithfully.",
    prompt: "Recreate the reference screenshot faithfully.",
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
  }));
  expect(createProject).not.toHaveBeenCalled();
  expect(importDesignCanvasAssets).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/projects/atomic-home");
});

test("Home retries an ambiguous bootstrap with the same idempotency key before navigating", async () => {
  const bootstrapDesignProject = vi.fn()
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValue({
      project: { id: "recovered-home", name: "Recovered", createdAt: 1, updatedAt: 1 },
      bootstrap: {
        job: {
          schemaVersion: 1,
          id: "bootstrap-recovered",
          projectId: "recovered-home",
          requestHash: "b".repeat(64),
          status: "ready",
          completedPhase: "ready",
          mainJobId: "job-main",
          error: null,
          createdAt: 1,
          updatedAt: 1,
        },
        reused: true,
      },
    });
  const deleteProject = vi.fn(async () => undefined);
  render(
    <ApiProvider client={makeFakeApi({
      ...api,
      bootstrapDesignProject,
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

  await waitFor(() => expect(bootstrapDesignProject).toHaveBeenCalledTimes(1));
  expect(window.location.pathname).toBe("/");
  fireEvent.click(screen.getByLabelText("Design"));
  await waitFor(() => expect(bootstrapDesignProject).toHaveBeenCalledTimes(2));
  const firstKey = bootstrapDesignProject.mock.calls[0]?.[0]?.idempotencyKey;
  const retryKey = bootstrapDesignProject.mock.calls[1]?.[0]?.idempotencyKey;
  expect(retryKey).toBe(firstKey);
  expect(deleteProject).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/projects/recovered-home");
});
