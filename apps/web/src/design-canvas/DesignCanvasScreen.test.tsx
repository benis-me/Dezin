import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import type { AgentInfo } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import {
  EMBEDDED_PREVIEW_CONTEXT_MENU_MESSAGE,
  EMBEDDED_PREVIEW_CONTEXT_MENU_READY_MESSAGE,
  PREVIEW_BRIDGE_PROTOCOL,
} from "../lib/preview-channel.ts";
import type { DesignAgentTurnRequest, DesignCanvasApi } from "./api.ts";
import { preferredGeneratedNodeGeometry } from "./DesignCanvasNode.tsx";
import {
  cancelSpatialFocusAnimations,
  DesignCanvasScreen,
  synchronizeFocusTransitionDuration,
} from "./DesignCanvasScreen.tsx";
import { CanvasAgentPanel, composerBeamActive, floatingAgentTransform } from "./FloatingNodeAgent.tsx";
import type {
  DesignAgentTurnResult,
  DesignCanvas,
  DesignCanvasIntent,
  DesignExportResult,
  DesignJob,
  DesignNode,
  DesignThread,
  DesignThreadScope,
} from "./types.ts";

const PROJECT_ID = "canvas-project";
const CLAUDE_AGENT: AgentInfo = {
  id: "claude",
  command: "claude",
  available: true,
  availability: "ready",
  version: "1",
  models: ["sonnet", "opus"],
};
const CODEBUDDY_AGENT: AgentInfo = {
  id: "codebuddy",
  command: "codebuddy",
  available: true,
  availability: "ready",
  version: "1",
  models: ["hy3-ioa"],
};

test("focus chrome adopts the actual remaining duration for opening reversals", () => {
  const opening = { nodeId: "page-1", phase: "opening" as const, durationMs: 420 };
  expect(synchronizeFocusTransitionDuration(opening, "page-1", "opening", 137.4)).toEqual({
    nodeId: "page-1",
    phase: "opening",
    durationMs: 137,
  });
  expect(synchronizeFocusTransitionDuration(opening, "page-2", "opening", 80)).toBe(opening);
  expect(synchronizeFocusTransitionDuration(opening, "page-1", "closing", 80)).toBe(opening);
});

test("reduced-motion focus settling finishes and removes only spatial focus animations", () => {
  const root = document.createElement("main");
  const focusedNode = document.createElement("div");
  focusedNode.className = "design-canvas-node";
  focusedNode.dataset.nodeFocusRole = "source";
  const frame = document.createElement("div");
  frame.className = "design-canvas-node__frame";
  focusedNode.append(frame);
  const dismiss = document.createElement("div");
  dismiss.className = "design-canvas-focus-dismiss";
  const generation = document.createElement("div");
  generation.className = "design-canvas-node__generation-glow";
  root.append(focusedNode, dismiss, generation);

  const spatialAnimations = [frame, dismiss].map((target) => ({
    effect: { target },
    finish: vi.fn(),
    commitStyles: vi.fn(),
    cancel: vi.fn(),
  }));
  const statusAnimation = {
    effect: { target: generation },
    finish: vi.fn(),
    commitStyles: vi.fn(),
    cancel: vi.fn(),
  };
  Object.defineProperty(root, "getAnimations", {
    configurable: true,
    value: () => [...spatialAnimations, statusAnimation],
  });

  expect(cancelSpatialFocusAnimations(root)).toBe(2);
  for (const animation of spatialAnimations) {
    expect(animation.finish).toHaveBeenCalledOnce();
    expect(animation.commitStyles).toHaveBeenCalledOnce();
    expect(animation.cancel).toHaveBeenCalledOnce();
  }
  expect(statusAnimation.cancel).not.toHaveBeenCalled();
});

test("floating Agent transform endpoints keep length units through Motion interpolation", () => {
  expect(floatingAgentTransform(-6.25, 8.5, 0.98)).toBe(
    "translate3d(-6.25px, 8.5px, 0px) scale(0.98)",
  );
  expect(floatingAgentTransform(0, 0, 1)).toBe(
    "translate3d(0px, 0px, 0px) scale(1)",
  );
});

function node(overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id: "page-1",
    kind: "page",
    name: "Landing page",
    geometry: { x: 80, y: 80, width: 480, height: 360 },
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function canvas(nodes: DesignNode[] = [], revision = 1, undoDepth = 0, redoDepth = 0): DesignCanvas {
  return {
    schemaVersion: 2,
    projectId: PROJECT_ID,
    revision,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeOrder: nodes.map((item) => item.id),
    nodes,
    undoDepth,
    redoDepth,
    createdAt: 1,
    updatedAt: revision,
  };
}

const thread: DesignThread = {
  schemaVersion: 2,
  id: "thread-main",
  scope: { type: "main" },
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

const job: DesignJob = {
  schemaVersion: 2,
  id: "job-1",
  kind: "main-agent",
  runnerId: "fixture",
  model: null,
  status: "ready",
  nodeId: null,
  parentJobId: null,
  contextHash: "context",
  canvasRevision: 1,
  expectedHeadVersionId: null,
  versionId: null,
  exportId: null,
  error: null,
  cancelRequested: false,
  activity: [{ id: "activity-1", kind: "status", text: "Coordinating Node Agents", createdAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
  finishedAt: 2,
};

function createCanvasApi(initial: DesignCanvas) {
  let current = initial;
  const applyIntents = vi.fn(async (_projectId: string, request: { baseRevision: number; intents: readonly DesignCanvasIntent[] }) => {
    let nodes = current.nodes.map((item) => ({ ...item, geometry: { ...item.geometry } }));
    for (const intent of request.intents) {
      if (intent.type === "add-node") {
        const item = intent.node;
        const id = item.id ?? `${item.kind}-${nodes.length + 1}`;
        nodes.push(node({
          id,
          kind: item.kind,
          name: item.name ?? item.kind,
          geometry: { x: 100, y: 100, width: 400, height: 300, ...item.geometry },
          assetId: item.assetId ?? null,
        }));
      } else if (intent.type === "remove-node") {
        nodes = nodes.filter((item) => item.id !== intent.nodeId);
      } else if (intent.type === "update-node") {
        nodes = nodes.map((item) => item.id === intent.nodeId ? {
          ...item,
          name: intent.patch.name ?? item.name,
          geometry: { ...item.geometry, ...intent.patch.geometry },
          selectedVersionId: intent.patch.selectedVersionId === undefined ? item.selectedVersionId : intent.patch.selectedVersionId,
        } : item);
      } else if (intent.type === "replace-layout") {
        const byId = new Map(intent.nodes.map((item) => [item.nodeId, item.geometry]));
        nodes = nodes.map((item) => ({ ...item, geometry: byId.get(item.id) ?? item.geometry }));
      }
    }
    current = canvas(nodes, request.baseRevision + 1, current.undoDepth + 1);
    return current;
  });
  const api: DesignCanvasApi = {
    getCanvas: vi.fn(async () => current),
    // eslint-disable-next-line require-yield
    streamInvalidations: vi.fn(async function* () {}),
    applyIntents,
    undo: vi.fn(async (_projectId, revision) => (current = canvas(current.nodes, revision + 1, Math.max(0, current.undoDepth - 1), 1))),
    redo: vi.fn(async (_projectId, revision) => (current = canvas(current.nodes, revision + 1, 1, 0))),
    importLocalFiles: vi.fn(async (_projectId: string, files: readonly File[], position: { x: number; y: number }) => {
      const imported = files.map((file, index) => node({
        id: `asset-${index + 1}`,
        kind: file.type.startsWith("image/") ? "image" : "file",
        name: file.name,
        geometry: { x: position.x + index * 30, y: position.y + index * 30, width: 320, height: 260 },
        state: "ready",
        assetId: `asset-${index + 1}`,
        currentVersionId: `version-asset-${index + 1}-1`,
        selectedVersionId: `version-asset-${index + 1}-1`,
        versionCount: 1,
      }));
      current = canvas([...current.nodes, ...imported], current.revision + 1, current.undoDepth + 1);
      return current;
    }),
    appendMaterialVersion: vi.fn(async (_projectId: string, nodeId: string) => {
      current = canvas(current.nodes.map((item) => item.id === nodeId ? {
        ...item,
        currentVersionId: `version-${nodeId}-${item.versionCount + 1}`,
        selectedVersionId: `version-${nodeId}-${item.versionCount + 1}`,
        versionCount: item.versionCount + 1,
      } : item), current.revision + 1, current.undoDepth + 1);
      return current;
    }),
    importProjectVersion: vi.fn(async () => current),
    listNodeVersions: vi.fn(async (_projectId, nodeId) => {
      const item = current.nodes.find((candidate) => candidate.id === nodeId);
      if (!item?.currentVersionId) return [];
      const material = item.kind === "image" || item.kind === "video" || item.kind === "document" || item.kind === "file";
      return [{
        id: item.currentVersionId,
        nodeId,
        sequence: item.versionCount,
        contentKind: material ? "asset" as const : "html" as const,
        assetId: material ? item.assetId : null,
        mimeType: material ? (item.kind === "image" ? "image/png" : "application/octet-stream") : null,
        fileName: material ? item.name : null,
        checksum: "sum",
        bytes: 128,
        contextHash: material ? null : "context",
        jobId: null,
        runnerId: null,
        model: null,
        createdAt: 1,
      }];
    }),
    getExactVersionPreview: vi.fn(async (_projectId, nodeId, versionId) => ({ nodeId, versionId, url: `https://preview.local/${nodeId}/${versionId}` })),
    downloadExactVersionHtml: vi.fn(async () => new Blob(["<!doctype html><html></html>"], { type: "text/html" })),
    getThread: vi.fn(async (_projectId, scope) => ({ ...thread, scope })),
    submitAgentTurn: vi.fn(async (_projectId: string, scope: DesignThreadScope, request: DesignAgentTurnRequest): Promise<DesignAgentTurnResult> => ({
      thread: { ...thread, scope, messages: [{ id: "message-1", role: "user", content: request.prompt, jobId: job.id, createdAt: 2 }] },
      job,
      canvas: current,
    })),
    listJobs: vi.fn(async () => []),
    cancelJob: vi.fn(async (): Promise<DesignJob> => ({ ...job, status: "cancelled" })),
    retryJob: vi.fn(async (_projectId: string, failedJobId: string) => ({
      retryOfJobId: failedJobId,
      thread,
      job: { ...job, id: `retry-${failedJobId}`, status: "queued" as const },
      canvas: current,
    })),
    startImplementationExport: vi.fn(async (): Promise<DesignExportResult> => ({
      exportId: "export-1",
      job: { ...job, kind: "implementation-export", exportId: "export-1" },
    })),
  };
  return { api, applyIntents };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("generated Node previews have kind-aware fit dimensions without resizing material Assets", () => {
  expect(preferredGeneratedNodeGeometry(node({ kind: "page" }))).toMatchObject({ width: 800, height: 600 });
  expect(preferredGeneratedNodeGeometry(node({ kind: "research" }))).toMatchObject({ width: 680, height: 500 });
  expect(preferredGeneratedNodeGeometry(node({ kind: "image" }))).toMatchObject({ width: 480, height: 360 });
});

test("Node previews stay title-bar-free at every canvas zoom", async () => {
  const zoomedCanvas = canvas([node({
    name: "7666005930341717169001.webp",
    geometry: { x: 80, y: 80, width: 360, height: 260 },
  })]);
  zoomedCanvas.viewport = { x: 0, y: 0, zoom: 0.5 };
  const { api } = createCanvasApi(zoomedCanvas);
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const flowNode = await screen.findByTestId("rf__node-page-1");
  expect(flowNode.querySelector(".design-canvas-node__chrome")).toBeNull();
  expect(flowNode.querySelector(".design-canvas-node__identity")).toBeNull();
  expect(flowNode.querySelector(".design-canvas-node__state-anchor")).toBeNull();
});

test("empty projects expose Quick Start and toolbar/right-click share one node catalog", async () => {
  const user = userEvent.setup();
  const { api, applyIntents } = createCanvasApi(canvas());
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  expect(await screen.findByRole("heading", { name: "Quick Start" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export code" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: /^Create a page\b/ }));
  await waitFor(() => expect(applyIntents).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
    intents: [expect.objectContaining({ type: "add-node", node: expect.objectContaining({ kind: "page" }) })],
  })));
  await waitFor(() => expect(document.querySelector(".react-flow__resize-control")).not.toBeNull());
  expect(await screen.findByLabelText("Page Agent panel", { selector: "section" })).toHaveAttribute("data-agent-size", "compact");
  expect(screen.queryByRole("button", { name: "Close Node focus" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Add Design node" }));
  expect(screen.getByRole("menu", { name: "Add Design node" })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: /Research/ }));
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(2));
  expect(await screen.findByLabelText("Research Agent panel", { selector: "section" })).toHaveAttribute("data-agent-size", "compact");

  fireEvent.contextMenu(screen.getByLabelText("Infinite Design canvas"), { clientX: 320, clientY: 260 });
  expect(screen.getByRole("menu", { name: "Add Design node" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: /Component/ }));
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(3));
});

test("a blank-canvas context menu exits before opening Figma import", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  render(
    <ApiProvider client={makeFakeApi()}>
      <DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />
    </ApiProvider>,
  );

  const surface = await screen.findByLabelText("Infinite Design canvas");
  expect(surface).toHaveAttribute("tabindex", "0");
  fireEvent.contextMenu(surface, { clientX: 320.6, clientY: 259.6 });
  const menu = screen.getByRole("menu", { name: "Add Design node" });
  await user.click(within(menu).getByRole("menuitem", { name: "Import from Figma" }));

  await waitFor(() => expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument());
  expect(await screen.findByRole("dialog", { name: "Import from Figma" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Figma file URL" })).toHaveFocus();
});

test("Cancel and Escape return Figma import focus to the Canvas", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  render(
    <ApiProvider client={makeFakeApi()}>
      <DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />
    </ApiProvider>,
  );
  const surface = await screen.findByLabelText("Infinite Design canvas");
  const openImport = async () => {
    fireEvent.contextMenu(surface, { clientX: 320, clientY: 260 });
    await user.click(screen.getByRole("menuitem", { name: "Import from Figma" }));
    return screen.findByRole("dialog", { name: "Import from Figma" });
  };

  await openImport();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import from Figma" })).not.toBeInTheDocument());
  expect(surface).toHaveFocus();

  await openImport();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import from Figma" })).not.toBeInTheDocument());
  expect(surface).toHaveFocus();
});

test("Canvas menus use dismissible animated primitives and toolbars keep the requested order", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const tools = await screen.findByRole("toolbar", { name: "Canvas tools" });
  expect(within(tools).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Select tool",
    "Hand tool",
    "Add Design node",
  ]);
  expect(within(tools).getByRole("button", { name: "Add Design node" })).toHaveTextContent("");
  const view = screen.getByRole("toolbar", { name: "Canvas view controls" });
  expect(within(view).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Arrange nodes",
    "Fit canvas",
    "Zoom out",
    "Zoom in",
  ]);
  expect(within(view).getAllByRole("button").map((button) => button.getAttribute("data-size"))).toEqual([
    "icon-sm",
    "icon-sm",
    "icon-sm",
    "icon-sm",
  ]);
  expect(within(view).getByLabelText("Canvas zoom")).toHaveTextContent("100%");
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Redo" })).not.toBeInTheDocument();

  await user.hover(within(view).getByRole("button", { name: "Fit canvas" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Fit canvas");
  await user.unhover(within(view).getByRole("button", { name: "Fit canvas" }));

  await user.click(within(tools).getByRole("button", { name: "Add Design node" }));
  const addMenu = screen.getByRole("menu", { name: "Add Design node" });
  expect(addMenu).toHaveAttribute("data-state", "open");
  expect(addMenu).toHaveClass("design-node-catalog");
  await user.click(screen.getByRole("heading", { name: "Editorial" }));
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument());

  fireEvent.contextMenu(screen.getByLabelText("Infinite Design canvas"), { clientX: 320, clientY: 260 });
  expect(screen.getByRole("menu", { name: "Add Design node" })).toHaveAttribute("data-state", "open");
  await user.click(screen.getByRole("heading", { name: "Editorial" }));
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument());
});

test("topbar project actions are independent icon buttons and the Project name is editable", async () => {
  const user = userEvent.setup();
  const onOpenSettings = vi.fn();
  const onRenameProject = vi.fn(async () => {});
  const { api } = createCanvasApi(canvas([node()]));
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[CLAUDE_AGENT]}
      onRenameProject={onRenameProject}
      onOpenSettings={onOpenSettings}
    />,
  );

  const actions = await screen.findByRole("toolbar", { name: "Project actions" });
  const iconActions = within(actions).getAllByRole("button");
  expect(iconActions.map((button) => button.getAttribute("aria-label"))).toEqual(["Main Agent", "Export code", "Settings"]);
  expect(iconActions.every((button) => button.textContent === "")).toBe(true);
  expect(iconActions.every((button) => button.getAttribute("data-size") === "icon-sm")).toBe(true);
  expect(iconActions.every((button) => !button.hasAttribute("title"))).toBe(true);
  expect(screen.queryByRole("group", { name: "Design actions" })).not.toBeInTheDocument();

  const settingsAction = within(actions).getByRole("button", { name: "Settings" });
  await user.hover(settingsAction);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Settings");
  await user.unhover(settingsAction);
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

  await user.click(screen.getByRole("button", { name: /Rename project: Editorial/ }));
  const nameInput = screen.getByRole("textbox", { name: "Project name" });
  await user.clear(nameInput);
  await user.type(nameInput, "Afterlight Tokyo{Enter}");
  await waitFor(() => expect(onRenameProject).toHaveBeenCalledWith("Afterlight Tokyo"));
  expect(screen.getByRole("button", { name: /Rename project: Afterlight Tokyo/ })).toHaveTextContent("Afterlight Tokyo");

  await user.click(within(actions).getByRole("button", { name: "Settings" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
});

test("Canvas failure removes every canvas control and disables topbar actions", async () => {
  const { api } = createCanvasApi(canvas());
  vi.mocked(api.getCanvas).mockRejectedValue(new Error("storage unavailable"));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const failure = await screen.findByRole("alert");
  expect(within(failure).getByText("Canvas unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("toolbar", { name: "Canvas tools" })).not.toBeInTheDocument();
  expect(screen.queryByRole("toolbar", { name: "Canvas view controls" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Main Agent" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export code" })).toBeDisabled();
});

test("Agent panels preserve the native context menu without opening the canvas Node catalog", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node()]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.doubleClick(await screen.findByTestId("rf__node-page-1"));
  const nodePanel = await screen.findByLabelText("Landing page Agent panel", { selector: "section" });
  const nodeEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  expect(nodePanel.dispatchEvent(nodeEvent)).toBe(true);
  expect(nodeEvent.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Main Agent" }));
  const mainPanel = screen.getByLabelText("Main Agent panel");
  const composer = within(mainPanel).getByRole("textbox", { name: "Main Agent message" });
  expect(composer.closest(".design-canvas-agent__composer-shell")).not.toHaveAttribute(
    "data-agent-component",
  );
  const beam = composer.closest<HTMLElement>(".design-canvas-agent__composer-beam");
  expect(beam?.style.getPropertyValue("--beam-strength")).toBe("0.56");
  expect(beam).toHaveAttribute(
    "data-beam-theme",
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const initiallyDark = document.documentElement.classList.contains("dark");
  try {
    document.documentElement.classList.toggle("dark", !initiallyDark);
    await waitFor(() => expect(beam).toHaveAttribute("data-beam-theme", initiallyDark ? "light" : "dark"));
  } finally {
    document.documentElement.classList.toggle("dark", initiallyDark);
  }
  await waitFor(() => expect(beam).toHaveAttribute("data-beam-theme", initiallyDark ? "dark" : "light"));
  expect(beam).not.toHaveAttribute("data-active");
  fireEvent.focus(composer);
  await waitFor(() => expect(beam).toHaveAttribute("data-active"));
  fireEvent.blur(composer, { relatedTarget: null });
  await waitFor(() => expect(beam).not.toHaveAttribute("data-active"));
  const mainEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  expect(mainPanel.dispatchEvent(mainEvent)).toBe(true);
  expect(mainEvent.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument();
});

test("Agent composer keeps a visible static Beam focus boundary for reduced motion", () => {
  expect(composerBeamActive(false, false)).toBe(false);
  expect(composerBeamActive(true, false)).toBe(true);
  expect(composerBeamActive(true, null)).toBe(true);
  expect(composerBeamActive(true, true)).toBe(false);
});

test("selected Nodes have no redundant Agent or delete buttons and expose kind-specific context menus", async () => {
  const page = node({ id: "page-menu", name: "Checkout" });
  const image = node({
    id: "image-menu",
    kind: "image",
    name: "Hero reference.png",
    geometry: { x: 620, y: 80, width: 360, height: 260 },
    state: "ready",
    currentVersionId: "version-image",
    selectedVersionId: "version-image",
    versionCount: 1,
    assetId: "asset-image",
  });
  const { api } = createCanvasApi(canvas([page, image]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const pageFlowNode = await screen.findByTestId("rf__node-page-menu");
  expect(pageFlowNode.querySelectorAll(
    ".design-canvas-node__resize-control--enabled.design-canvas-node__resize-control--affordance",
  )).toHaveLength(4);
  fireEvent.click(pageFlowNode);
  expect(await screen.findByLabelText("Checkout Agent panel", { selector: "section" })).toHaveAttribute("data-agent-size", "compact");
  expect(document.querySelector(".react-flow__resize-control")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Open Agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Checkout" })).not.toBeInTheDocument();

  fireEvent.contextMenu(screen.getByTestId("rf__node-page-menu"), { clientX: 180, clientY: 180 });
  expect(screen.queryByLabelText("Checkout Agent panel", { selector: "section" })).not.toBeInTheDocument();
  const pageMenu = await screen.findByRole("menu", { name: "Page Node actions" });
  expect(within(pageMenu).getByRole("menuitem", { name: "Create page with Agent" })).toBeInTheDocument();
  expect(within(pageMenu).queryByRole("menuitem", { name: "Import from Figma" })).not.toBeInTheDocument();
  expect(within(pageMenu).queryByRole("menuitem", { name: /revision/ })).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });

  fireEvent.contextMenu(screen.getByTestId("rf__node-image-menu"), { clientX: 720, clientY: 180 });
  const imageMenu = await screen.findByRole("menu", { name: "Image Node actions" });
  expect(within(imageMenu).getByRole("menuitem", { name: "Inspect image with Agent" })).toBeInTheDocument();
  expect(within(imageMenu).getByRole("menuitem", { name: "Add image revision…" })).toBeInTheDocument();
  expect(within(imageMenu).queryByRole("menuitem", { name: /Create page/ })).not.toBeInTheDocument();
});

test("keyboard corner resizing follows the same persisted geometry path as pointer resizing", async () => {
  const target = node({ id: "page-keyboard-persist", name: "Keyboard resize" });
  const { api, applyIntents } = createCanvasApi(canvas([target]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const flowNode = await screen.findByTestId("rf__node-page-keyboard-persist");
  expect(flowNode).toHaveAttribute("aria-label", "Keyboard resize, Page, Not generated");
  fireEvent.click(flowNode);

  const bottomRight = await screen.findByRole("button", {
    name: "Resize Keyboard resize from bottom right",
  });
  fireEvent.keyDown(bottomRight, { key: "ArrowRight" });

  await waitFor(() => expect(applyIntents).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
    intents: [{
      type: "update-node",
      nodeId: target.id,
      patch: {
        geometry: { x: 80, y: 80, width: 488, height: 360 },
      },
    }],
  })));
});

test("a selected Node keeps the same Agent panel DOM while its position morphs into focus", async () => {
  const target = node({ id: "page-panel-morph", name: "Panel morph" });
  const { api } = createCanvasApi(canvas([target]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const flowNode = await screen.findByTestId("rf__node-page-panel-morph");
  fireEvent.click(flowNode);
  const compactPanel = await screen.findByLabelText("Panel morph Agent panel", { selector: "section" });
  expect(compactPanel).toHaveAttribute("data-agent-size", "compact");

  fireEvent.doubleClick(flowNode);
  await waitFor(() => expect(compactPanel).toHaveAttribute("data-agent-size", "focus"));
  expect(screen.getByLabelText("Panel morph Agent panel", { selector: "section" })).toBe(compactPanel);
});

test("opening a context menu cancels a pending focused Node Agent reveal", async () => {
  const target = node({ id: "page-context-focus", name: "Focus context" });
  const { api } = createCanvasApi(canvas([target]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const flowNode = await screen.findByTestId("rf__node-page-context-focus");
  fireEvent.doubleClick(flowNode);
  fireEvent.contextMenu(flowNode, { clientX: 180, clientY: 180 });

  expect(screen.queryByLabelText("Focus context Agent panel", { selector: "section" })).not.toBeInTheDocument();
  expect(await screen.findByRole("menu", { name: "Page Node actions" })).toBeInTheDocument();
  await new Promise((resolve) => window.setTimeout(resolve, 180));
  expect(screen.queryByLabelText("Focus context Agent panel", { selector: "section" })).not.toBeInTheDocument();
});

test("dismissing a Node context menu never swaps its closing content to the Canvas catalog", async () => {
  const target = node({ id: "page-context-stable", name: "Stable menu" });
  const { api } = createCanvasApi(canvas([target]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const flowNode = await screen.findByTestId("rf__node-page-context-stable");
  fireEvent.contextMenu(flowNode, { clientX: 180, clientY: 180 });
  expect(await screen.findByRole("menu", { name: "Page Node actions" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Stable menu Agent panel", { selector: "section" })).not.toBeInTheDocument();

  const pane = document.querySelector<HTMLElement>(".react-flow__pane");
  expect(pane).not.toBeNull();
  fireEvent.pointerDown(pane!);
  fireEvent.click(pane!);

  const closingContent = document.querySelector<HTMLElement>('[data-slot="context-menu-content"]');
  if (closingContent) expect(closingContent).toHaveAttribute("aria-label", "Page Node actions");
  expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument();
});

test("add-node retries preserve one explicit id and open only that Node after a 409 refresh", async () => {
  const initial = canvas();
  const foreign = node({ id: "foreign-page", name: "Foreign page" });
  const canonical = canvas([foreign], 2);
  const { api, applyIntents } = createCanvasApi(initial);
  vi.mocked(api.getCanvas)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(canonical);
  const conflict = Object.assign(new Error("revision conflict"), { status: 409 });
  applyIntents
    .mockRejectedValueOnce(conflict)
    .mockImplementationOnce(async (_projectId, request) => {
      const intent = request.intents[0];
      if (!intent || intent.type !== "add-node" || !intent.node.id) throw new Error("Expected explicit add-node id");
      return canvas([
        foreign,
        node({ id: intent.node.id, kind: intent.node.kind, name: intent.node.name ?? "Page", geometry: { ...foreign.geometry, ...intent.node.geometry } }),
      ], 3, 1);
    });

  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);
  await screen.findByRole("heading", { name: "Quick Start" });
  fireEvent.click(screen.getByRole("button", { name: /^Create a page\b/ }));

  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(2));
  const firstIntent = applyIntents.mock.calls[0]?.[1].intents[0];
  const replayedIntent = applyIntents.mock.calls[1]?.[1].intents[0];
  expect(firstIntent?.type).toBe("add-node");
  expect(replayedIntent?.type).toBe("add-node");
  if (firstIntent?.type !== "add-node" || replayedIntent?.type !== "add-node") throw new Error("Expected add-node intents");
  expect(firstIntent.node.id).toMatch(/^page-[0-9a-f-]{36}$/);
  expect(replayedIntent.node.id).toBe(firstIntent.node.id);
  await waitFor(() => expect(document.querySelector(".react-flow__resize-control")).not.toBeNull());
  expect(await screen.findByLabelText("Page Agent panel", { selector: "section" })).toHaveAttribute("data-agent-size", "compact");
  expect(screen.queryByLabelText("Foreign page Agent panel", { selector: "section" })).not.toBeInTheDocument();
});

test("history stays keyboard-only and shortcuts remain locked while a scoped Node Job is active", async () => {
  const activeNode = node({ state: "generating", activeJobId: "job-active" });
  const { api } = createCanvasApi(canvas([activeNode], 4, 2, 1));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  await screen.findByRole("button", { name: "Add Design node" });
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Redo" })).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: "z", metaKey: true });
  fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: "y", metaKey: true });
  expect(api.undo).not.toHaveBeenCalled();
  expect(api.redo).not.toHaveBeenCalled();
});

test("double-clicking a ready generated Node enters focus with an operable strict-sandbox iframe", async () => {
  const ready = node({ state: "failed", currentVersionId: "version-1", versionCount: 1, error: "Latest run failed" });
  const { api } = createCanvasApi(canvas([ready]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const frame = await screen.findByTitle("Landing page, version version-1");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(frame).toHaveAttribute("tabindex", "-1");
  expect(screen.getByText("Latest run failed")).toBeInTheDocument();
  const shield = screen.getByRole("button", { name: "Select Landing page; double click to focus and interact" });
  expect(shield).not.toHaveClass("nodrag");
  fireEvent.click(shield);
  expect(frame).toHaveAttribute("tabindex", "-1");
  expect(screen.queryByRole("button", { name: "Close Node focus" })).not.toBeInTheDocument();

  fireEvent.doubleClick(shield);
  await waitFor(() => expect(frame).toHaveAttribute("tabindex", "0"));
  expect(screen.getAllByRole("button", { name: "Close Node focus" })).toHaveLength(1);
  expect(document.querySelector(".design-canvas-focus-dismiss")).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button", { name: "Desktop preview" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Tablet preview" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Mobile preview" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export preview HTML" })).toBeInTheDocument();
  expect(screen.getByRole("toolbar", { name: "Focused preview tools" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Node Agent/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Select Landing page; double click to focus and interact" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Main Agent" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  expect(screen.getByLabelText("Main Agent panel")).toBeInTheDocument();
});

test("focused Page export downloads the daemon-authored portable exact Version", async () => {
  const ready = node({
    id: "page-portable-export",
    name: "Portable landing",
    state: "ready",
    currentVersionId: "version-portable",
    selectedVersionId: "version-portable",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([ready]));
  const portable = new Blob(["<!doctype html><html><body>portable</body></html>"], { type: "text/html" });
  vi.mocked(api.downloadExactVersionHtml).mockResolvedValue(portable);
  const createObjectURL = vi.fn(() => "blob:portable-version");
  const revokeObjectURL = vi.fn();
  const NativeUrl = URL;
  class TestUrl extends NativeUrl {}
  Object.assign(TestUrl, { createObjectURL, revokeObjectURL });
  vi.stubGlobal("URL", TestUrl);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.doubleClick(await screen.findByRole("button", {
    name: "Select Portable landing; double click to focus and interact",
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Export preview HTML" }));

  await waitFor(() => expect(api.downloadExactVersionHtml).toHaveBeenCalledWith(
    PROJECT_ID,
    ready.id,
    ready.currentVersionId,
  ));
  expect(createObjectURL).toHaveBeenCalledWith(portable);
  expect(click).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:portable-version");
});

test("focused Page export failure stays visible, dismissible, and retryable", async () => {
  const ready = node({
    id: "page-portable-retry",
    name: "Retry landing",
    state: "ready",
    currentVersionId: "version-retry",
    selectedVersionId: "version-retry",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([ready]));
  vi.mocked(api.downloadExactVersionHtml)
    .mockRejectedValueOnce(new Error("Asset integrity check failed"))
    .mockResolvedValueOnce(new Blob(["<!doctype html><html></html>"], { type: "text/html" }));
  const NativeUrl = URL;
  class TestUrl extends NativeUrl {}
  Object.assign(TestUrl, { createObjectURL: () => "blob:retry", revokeObjectURL: vi.fn() });
  vi.stubGlobal("URL", TestUrl);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.doubleClick(await screen.findByRole("button", {
    name: "Select Retry landing; double click to focus and interact",
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Export preview HTML" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't export this preview. Asset integrity check failed");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss preview export error" }));
  expect(screen.queryByText(/Asset integrity check failed/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Export preview HTML" }));
  await waitFor(() => expect(api.downloadExactVersionHtml).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/Asset integrity check failed/)).not.toBeInTheDocument();
});

test("exact iframe identity and src stay stable across focus open and close", async () => {
  const target = node({
    id: "page-stable-frame",
    name: "Stateful page",
    state: "ready",
    currentVersionId: "version-stable-frame",
    selectedVersionId: "version-stable-frame",
    versionCount: 1,
  });
  const exactUrl = `/api/projects/${PROJECT_ID}/design-canvas/nodes/${target.id}/versions/${target.currentVersionId}/preview`;
  const embeddedUrl = `${exactUrl}/embed`;
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.getExactVersionPreview).mockResolvedValue({
    nodeId: target.id,
    versionId: target.currentVersionId!,
    url: exactUrl,
  });
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const frame = await screen.findByTitle(`Stateful page, version ${target.currentVersionId}`) as HTMLIFrameElement;
  expect(frame).toHaveAttribute("src", embeddedUrl);
  expect(frame).toHaveAttribute("tabindex", "-1");

  fireEvent.doubleClick(screen.getByRole("button", { name: "Select Stateful page; double click to focus and interact" }));
  await waitFor(() => expect(frame).toHaveAttribute("tabindex", "0"));
  expect(screen.getByTitle(`Stateful page, version ${target.currentVersionId}`)).toBe(frame);
  expect(frame).toHaveAttribute("src", embeddedUrl);

  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  expect(screen.getByTitle(`Stateful page, version ${target.currentVersionId}`)).toBe(frame);
  expect(frame).toHaveAttribute("src", embeddedUrl);
  expect(frame).toHaveAttribute("tabindex", "-1");
});

test("the iframe keeps one logical renderer viewport across canvas, focus, and the closing handoff", async () => {
  const target = node({
    id: "page-stable-renderer-viewport",
    name: "Stable renderer page",
    state: "ready",
    currentVersionId: "version-stable-renderer-viewport",
    selectedVersionId: "version-stable-renderer-viewport",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const frame = await screen.findByTitle(`Stable renderer page, version ${target.currentVersionId}`) as HTMLIFrameElement;
  const canvasPlane = frame.closest<HTMLElement>(".design-canvas-node__content-plane");
  expect(canvasPlane).not.toBeNull();
  const logicalWidth = canvasPlane!.style.width;
  const logicalHeight = canvasPlane!.style.height;
  expect(logicalWidth).toMatch(/^calc\(.+px\)$/);
  expect(logicalHeight).toMatch(/^calc\(.+px\)$/);
  expect(canvasPlane).toHaveAttribute("data-content-plane-state", "canvas");

  fireEvent.doubleClick(screen.getByRole("button", { name: "Select Stable renderer page; double click to focus and interact" }));
  await waitFor(() => expect(frame).toHaveAttribute("tabindex", "0"));
  expect(frame.closest(".design-canvas-node__content-plane")).toBe(canvasPlane);
  expect(canvasPlane!.style.width).toBe(logicalWidth);
  expect(canvasPlane!.style.height).toBe(logicalHeight);
  expect(canvasPlane).toHaveAttribute("data-content-plane-state", "focus");

  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  expect(screen.getByTitle(`Stable renderer page, version ${target.currentVersionId}`)).toBe(frame);
  expect(frame.closest(".design-canvas-node__content-plane")).toBe(canvasPlane);
  expect(canvasPlane!.style.width).toBe(logicalWidth);
  expect(canvasPlane!.style.height).toBe(logicalHeight);
  expect(canvasPlane).toHaveAttribute("data-content-plane-state", "canvas");
});

test("a special-ratio video keeps one logical media plane through focus and the closing handoff", async () => {
  const target = node({
    id: "video-stable-renderer-viewport",
    kind: "video",
    name: "Ultrawide motion reference",
    geometry: { x: 80, y: 80, width: 400, height: 300 },
    state: "ready",
    assetId: "asset-video-stable-renderer",
    currentVersionId: "version-video-stable-renderer",
    selectedVersionId: "version-video-stable-renderer",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  const rendered = render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const video = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLVideoElement>("video.design-canvas-node__asset--video");
    expect(element).not.toBeNull();
    return element!;
  });
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 2_560 },
    videoHeight: { configurable: true, value: 1_080 },
  });
  fireEvent.loadedMetadata(video);
  await waitFor(() => expect(api.applyIntents).toHaveBeenCalledWith(PROJECT_ID, {
    baseRevision: 1,
    intents: [{
      type: "update-node",
      nodeId: target.id,
      patch: { geometry: { x: 80, y: 80, width: 420, height: 177.188 } },
    }],
  }));

  const canvasPlane = video.closest<HTMLElement>(".design-canvas-node__content-plane");
  expect(canvasPlane).not.toBeNull();
  const logicalWidth = canvasPlane!.style.width;
  const logicalHeight = canvasPlane!.style.height;
  const canvasTransform = canvasPlane!.style.transform;
  const canvasScale = Number(/scale\(([^)]+)\)/.exec(canvasTransform)?.[1]);
  expect(canvasScale).toBeGreaterThan(0);
  expect(canvasPlane).toHaveAttribute("data-content-plane-state", "canvas");

  fireEvent.doubleClick(screen.getByRole("button", { name: "Select Ultrawide motion reference; double click to focus and interact" }));
  await waitFor(() => expect(canvasPlane).toHaveAttribute("data-content-plane-state", "focus"));
  const source = video.closest<HTMLElement>(".design-canvas-node");
  const startScaleX = Number(source?.style.getPropertyValue("--design-node-focus-start-scale-x"));
  const startScaleY = Number(source?.style.getPropertyValue("--design-node-focus-start-scale-y"));
  expect(startScaleX).toBeCloseTo(canvasScale, 4);
  expect(startScaleY).toBeCloseTo(canvasScale, 4);
  expect(rendered.container.querySelector("video.design-canvas-node__asset--video")).toBe(video);
  expect(video.closest(".design-canvas-node__content-plane")).toBe(canvasPlane);
  expect(canvasPlane!.style.width).toBe(logicalWidth);
  expect(canvasPlane!.style.height).toBe(logicalHeight);

  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-node-focus", "closing");
  expect(canvasPlane).toHaveAttribute("data-content-plane-state", "focus");
  expect(canvasPlane!.style.width).toBe(logicalWidth);
  expect(canvasPlane!.style.height).toBe(logicalHeight);
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  expect(rendered.container.querySelector("video.design-canvas-node__asset--video")).toBe(video);
  expect(video.closest(".design-canvas-node__content-plane")).toBe(canvasPlane);
  expect(canvasPlane!.style.width).toBe(logicalWidth);
  expect(canvasPlane!.style.height).toBe(logicalHeight);
  expect(canvasPlane!.style.transform).toBe(canvasTransform);
  expect(canvasPlane).toHaveAttribute("data-content-plane-state", "canvas");
});

test("video metadata arriving during an active focus flight rebases from the same visual rect", async () => {
  const target = node({
    id: "video-flight-metadata",
    kind: "video",
    name: "Flight metadata video",
    geometry: { x: 80, y: 80, width: 400, height: 300 },
    state: "ready",
    assetId: "asset-video-flight-metadata",
    currentVersionId: "version-video-flight-metadata",
    selectedVersionId: "version-video-flight-metadata",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  const originalAnimate = HTMLElement.prototype.animate;
  const nodeAnimations: Array<{
    target: HTMLElement;
    frames: Keyframe[];
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: function animate(
      this: HTMLElement,
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    ): Animation {
      const cancel = vi.fn();
      if (this.classList.contains("design-canvas-node")) {
        nodeAnimations.push({
          target: this,
          frames: Array.isArray(keyframes) ? keyframes : [],
          cancel,
        });
      }
      return {
        cancel,
        finished: new Promise<Animation>(() => undefined),
      } as unknown as Animation;
    },
  });

  try {
    const rendered = render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);
    const video = await waitFor(() => {
      const element = rendered.container.querySelector<HTMLVideoElement>("video.design-canvas-node__asset--video");
      expect(element).not.toBeNull();
      return element!;
    });
    const plane = video.closest<HTMLElement>(".design-canvas-node__content-plane")!;
    const source = video.closest<HTMLElement>(".design-canvas-node")!;

    fireEvent.doubleClick(screen.getByRole("button", { name: "Select Flight metadata video; double click to focus and interact" }));
    await waitFor(() => expect(nodeAnimations).toHaveLength(1));
    const previousLayout = {
      width: Number.parseFloat(source.style.width),
      height: Number.parseFloat(source.style.height),
    };
    const live = { x: 140, y: 80, scaleX: 0.82, scaleY: 0.78 };
    source.style.transform = `matrix(${live.scaleX}, 0, 0, ${live.scaleY}, ${live.x}, ${live.y})`;

    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 2_560 },
      videoHeight: { configurable: true, value: 1_080 },
    });
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(nodeAnimations).toHaveLength(2));

    const nextLayout = {
      width: Number.parseFloat(source.style.width),
      height: Number.parseFloat(source.style.height),
    };
    const firstRebasedFrame = nodeAnimations[1]!.frames[0]!;
    const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\) scale\(([-\d.]+), ([-\d.]+)\)/
      .exec(String(firstRebasedFrame.transform));
    expect(match).not.toBeNull();
    const rebased = {
      x: Number(match![1]),
      y: Number(match![2]),
      scaleX: Number(match![3]),
      scaleY: Number(match![4]),
    };

    expect(nextLayout.width * rebased.scaleX).toBeCloseTo(previousLayout.width * live.scaleX, 4);
    expect(nextLayout.height * rebased.scaleY).toBeCloseTo(previousLayout.height * live.scaleY, 4);
    expect(nextLayout.width / 2 + rebased.x).toBeCloseTo(previousLayout.width / 2 + live.x, 4);
    expect(nextLayout.height / 2 + rebased.y).toBeCloseTo(previousLayout.height / 2 + live.y, 4);
    expect(nodeAnimations[0]!.cancel).toHaveBeenCalledOnce();
    expect(rendered.container.querySelector("video.design-canvas-node__asset--video")).toBe(video);
    expect(video.closest(".design-canvas-node__content-plane")).toBe(plane);
    expect(video.closest(".design-canvas-node")).toBe(source);
  } finally {
    if (originalAnimate) {
      Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: originalAnimate });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  }
});

test("undoing automatic video ratio correction restores geometry and keeps the next focus uniform", async () => {
  const target = node({
    id: "video-ratio-undo",
    kind: "video",
    name: "Undo ratio video",
    geometry: { x: 80, y: 80, width: 400, height: 300 },
    state: "ready",
    assetId: "asset-video-ratio-undo",
    currentVersionId: "version-video-ratio-undo",
    selectedVersionId: "version-video-ratio-undo",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.undo).mockImplementation(async (_projectId, revision) => canvas([target], revision + 1, 0, 1));
  const rendered = render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);
  const video = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLVideoElement>("video.design-canvas-node__asset--video");
    expect(element).not.toBeNull();
    return element!;
  });
  const plane = video.closest<HTMLElement>(".design-canvas-node__content-plane")!;
  const originalLogicalSize = { width: plane.style.width, height: plane.style.height };

  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 2_560 },
    videoHeight: { configurable: true, value: 1_080 },
  });
  fireEvent.loadedMetadata(video);
  await waitFor(() => expect(api.applyIntents).toHaveBeenCalledWith(PROJECT_ID, {
    baseRevision: 1,
    intents: [{
      type: "update-node",
      nodeId: target.id,
      patch: { geometry: { x: 80, y: 80, width: 420, height: 177.188 } },
    }],
  }));
  await waitFor(() => expect(plane.style.height).not.toBe(originalLogicalSize.height));

  fireEvent.keyDown(window, { key: "z", metaKey: true });
  await waitFor(() => expect(api.undo).toHaveBeenCalledWith(PROJECT_ID, 2));
  await waitFor(() => {
    expect(plane.style.width).toBe(originalLogicalSize.width);
    expect(plane.style.height).toBe(originalLogicalSize.height);
  });
  expect(rendered.container.querySelector("video.design-canvas-node__asset--video")).toBe(video);

  const canvasScale = Number(/scale\(([^)]+)\)/.exec(plane.style.transform)?.[1]);
  fireEvent.doubleClick(screen.getByRole("button", { name: "Select Undo ratio video; double click to focus and interact" }));
  await waitFor(() => expect(plane).toHaveAttribute("data-content-plane-state", "focus"));
  const source = video.closest<HTMLElement>(".design-canvas-node")!;
  expect(Number(source.style.getPropertyValue("--design-node-focus-start-scale-x"))).toBeCloseTo(canvasScale, 4);
  expect(Number(source.style.getPropertyValue("--design-node-focus-start-scale-y"))).toBeCloseTo(canvasScale, 4);
  expect(video.closest(".design-canvas-node__content-plane")).toBe(plane);
});

test.each([
  { mimeType: "application/json", fileName: "renamed.data", expectedMode: "code", webTools: false },
  { mimeType: "application/typescript", fileName: "extensionless-source", expectedMode: "code", webTools: false },
  { mimeType: "text/html", fileName: "landing.renamed", expectedMode: "code", webTools: false },
])("exact $mimeType metadata drives imported file focus as $expectedMode", async ({
  mimeType,
  fileName,
  expectedMode,
  webTools,
}) => {
  const target = node({
    id: `file-${mimeType.replace(/\W+/g, "-")}`,
    kind: "file",
    name: "Untitled imported file",
    state: "ready",
    assetId: "asset-exact-metadata",
    currentVersionId: `version-${mimeType.replace(/\W+/g, "-")}`,
    selectedVersionId: `version-${mimeType.replace(/\W+/g, "-")}`,
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.listNodeVersions).mockResolvedValue([{
    id: target.currentVersionId!,
    nodeId: target.id,
    sequence: 1,
    contentKind: "asset",
    assetId: target.assetId,
    mimeType,
    fileName,
    checksum: "sum-exact-metadata",
    bytes: 24,
    contextHash: null,
    jobId: null,
    runnerId: null,
    model: null,
    createdAt: 1,
  }]);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    blob: async () => ({ size: 17, text: async () => "export const x = 1" }),
  })));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const shield = await screen.findByRole("button", { name: "Select Untitled imported file; double click to focus and interact" });
  await waitFor(() => expect(document.querySelector(".design-typed-material")).toHaveAttribute("data-presentation", "code"));
  fireEvent.doubleClick(shield);
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-focused-content", expectedMode));
  if (webTools) expect(screen.getByRole("button", { name: "Desktop preview" })).toBeInTheDocument();
  else expect(screen.queryByRole("button", { name: "Desktop preview" })).not.toBeInTheDocument();
});

test("exact generated Page metadata keeps browser layout and website tools", async () => {
  const target = node({
    id: "page-exact-browser-layout",
    kind: "page",
    name: "Renamed page",
    state: "ready",
    currentVersionId: "version-exact-browser-layout",
    selectedVersionId: "version-exact-browser-layout",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.listNodeVersions).mockResolvedValue([{
    id: target.currentVersionId!,
    nodeId: target.id,
    sequence: 1,
    contentKind: "html",
    assetId: null,
    mimeType: "text/html",
    fileName: "extensionless-artifact",
    checksum: "sum-page-metadata",
    bytes: 128,
    contextHash: "context",
    jobId: null,
    runnerId: null,
    model: null,
    createdAt: 1,
  }]);
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const shield = await screen.findByRole("button", { name: "Select Renamed page; double click to focus and interact" });
  fireEvent.doubleClick(shield);
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-focused-content", "web"));
  expect(screen.getByRole("button", { name: "Desktop preview" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export preview HTML" })).toBeInTheDocument();
});

test("focused previews accept context menus only over their iframe's private MessagePort", async () => {
  const target = node({
    id: "page-embedded-menu",
    name: "Embedded page",
    state: "ready",
    currentVersionId: "version-embedded-menu",
    selectedVersionId: "version-embedded-menu",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.getExactVersionPreview).mockResolvedValue({
    nodeId: target.id,
    versionId: target.currentVersionId!,
    url: `/api/projects/${PROJECT_ID}/design-canvas/nodes/${target.id}/versions/${target.currentVersionId}/preview`,
  });
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const frame = await screen.findByTitle(`Embedded page, version ${target.currentVersionId}`) as HTMLIFrameElement;
  expect(frame).toHaveAttribute(
    "src",
    `/api/projects/${PROJECT_ID}/design-canvas/nodes/${target.id}/versions/${target.currentVersionId}/preview/embed`,
  );
  expect(frame).toHaveAttribute("tabindex", "-1");
  expect(frame.contentWindow).not.toBeNull();
  const nonce = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  const channel = new MessageChannel();
  const rejectedChannel = new MessageChannel();
  const readyMessage = {
    source: "dezin",
    type: EMBEDDED_PREVIEW_CONTEXT_MENU_READY_MESSAGE,
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    nonce,
  };
  window.dispatchEvent(new MessageEvent("message", {
    data: readyMessage,
    source: frame.contentWindow,
    ports: [channel.port2],
  }));
  window.dispatchEvent(new MessageEvent("message", {
    data: readyMessage,
    source: frame.contentWindow,
    ports: [rejectedChannel.port2],
  }));

  const message = {
    source: "dezin",
    type: EMBEDDED_PREVIEW_CONTEXT_MENU_MESSAGE,
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    nonce,
    clientX: 24,
    clientY: 30,
  };
  window.dispatchEvent(new MessageEvent("message", { data: message, source: window }));
  expect(screen.queryByRole("menu", { name: "Page Node actions" })).not.toBeInTheDocument();

  window.dispatchEvent(new MessageEvent("message", { data: message, source: frame.contentWindow }));
  expect(screen.queryByRole("menu", { name: "Page Node actions" })).not.toBeInTheDocument();

  rejectedChannel.port1.postMessage(message);
  expect(screen.queryByRole("menu", { name: "Page Node actions" })).not.toBeInTheDocument();

  channel.port1.start();
  // The one-shot child handshake happens while this is still an ordinary canvas
  // preview. The parent keeps the port but rejects menu actions until focus.
  channel.port1.postMessage(message);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect(screen.queryByRole("menu", { name: "Page Node actions" })).not.toBeInTheDocument();

  fireEvent.doubleClick(screen.getByRole("button", { name: "Select Embedded page; double click to focus and interact" }));
  await waitFor(() => expect(frame).toHaveAttribute("tabindex", "0"));
  expect(screen.getByTitle(`Embedded page, version ${target.currentVersionId}`)).toBe(frame);
  expect(frame).toHaveAttribute(
    "src",
    `/api/projects/${PROJECT_ID}/design-canvas/nodes/${target.id}/versions/${target.currentVersionId}/preview/embed`,
  );
  channel.port1.postMessage(message);
  const menu = await screen.findByRole("menu", { name: "Page Node actions" });
  expect(within(menu).getByRole("menuitem", { name: "Fit this Node" })).toHaveAttribute("data-disabled");

  channel.port1.close();
  rejectedChannel.port1.close();
});

test("an uninstrumented preview fallback cannot claim the private context-menu port", async () => {
  const target = node({
    id: "page-legacy-preview",
    name: "Legacy preview",
    state: "ready",
    currentVersionId: "version-legacy-preview",
    selectedVersionId: "version-legacy-preview",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.getExactVersionPreview).mockResolvedValue({
    nodeId: target.id,
    versionId: target.currentVersionId!,
    url: "/legacy-preview",
  });
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const frame = await screen.findByTitle(`Legacy preview, version ${target.currentVersionId}`) as HTMLIFrameElement;
  fireEvent.doubleClick(screen.getByRole("button", { name: "Select Legacy preview; double click to focus and interact" }));
  await waitFor(() => expect(frame).toHaveAttribute("src", "/legacy-preview"));
  const channel = new MessageChannel();
  const nonce = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  window.dispatchEvent(new MessageEvent("message", {
    data: {
      source: "dezin",
      type: EMBEDDED_PREVIEW_CONTEXT_MENU_READY_MESSAGE,
      protocol: PREVIEW_BRIDGE_PROTOCOL,
      nonce,
    },
    source: frame.contentWindow,
    ports: [channel.port2],
  }));
  channel.port1.postMessage({
    source: "dezin",
    type: EMBEDDED_PREVIEW_CONTEXT_MENU_MESSAGE,
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    nonce,
    clientX: 24,
    clientY: 30,
  });
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect(screen.queryByRole("menu", { name: "Page Node actions" })).not.toBeInTheDocument();
  channel.port1.close();
});

test("material Nodes use the selected immutable Version for preview and expose the shared Version selector", async () => {
  const user = userEvent.setup();
  const material = node({
    id: "image-1",
    kind: "image",
    name: "Direction reference",
    state: "ready",
    assetId: "asset-1234567890abcdef1234567890abcdef",
    currentVersionId: "version-image-current",
    selectedVersionId: "version-image-selected",
    versionCount: 2,
    geometry: { x: 80, y: 80, width: 360, height: 260 },
  });
  const { api } = createCanvasApi(canvas([material]));
  vi.mocked(api.listNodeVersions).mockResolvedValue([{
    id: "version-image-selected",
    nodeId: material.id,
    sequence: 1,
    contentKind: "asset",
    assetId: material.assetId,
    mimeType: "image/png",
    fileName: "direction-v1.png",
    checksum: "sum-v1",
    bytes: 128,
    contextHash: null,
    jobId: null,
    runnerId: null,
    model: null,
    createdAt: 1,
  }, {
    id: "version-image-current",
    nodeId: material.id,
    sequence: 2,
    contentKind: "asset",
    assetId: "asset-current",
    mimeType: "image/png",
    fileName: "direction-v2.png",
    checksum: "sum-v2",
    bytes: 256,
    contextHash: null,
    jobId: null,
    runnerId: null,
    model: null,
    createdAt: 2,
  }]);
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.doubleClick(await screen.findByTestId("rf__node-image-1"));
  const panel = await screen.findByLabelText("Direction reference Agent panel", { selector: "section" });
  const versionTrigger = within(panel).getByRole("combobox", { name: "Version" });
  expect(versionTrigger).toHaveTextContent("V1");
  expect(versionTrigger.textContent).toBe("V1");
  expect(versionTrigger.closest("header")).toHaveClass("design-canvas-agent__header");
  expect(panel.querySelector(".design-canvas-agent__versions")).toBeNull();
  await user.click(versionTrigger);
  expect(await screen.findByRole("option", { name: /V1 · direction-v1\.png ·/ })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("option", { name: /V1 · direction-v1\.png ·/ })).not.toBeInTheDocument());
  expect(document.querySelector(".design-canvas-surface")).toHaveAttribute("data-node-focus", "opening");
  expect(screen.getByRole("button", { name: "Close Node focus" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Desktop preview" })).not.toBeInTheDocument();
  const image = await screen.findByRole("img", { name: "Direction reference" });
  expect(image).toHaveAttribute(
    "src",
    "https://preview.local/image-1/version-image-selected",
  );
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1_728 },
    naturalHeight: { configurable: true, value: 2_304 },
  });
  fireEvent.load(image);
  const focusedMaterial = image.closest<HTMLElement>(".design-canvas-node");
  await waitFor(() => {
    const focusedWidth = Number.parseFloat(focusedMaterial?.style.width ?? "0");
    const focusedHeight = Number.parseFloat(focusedMaterial?.style.height ?? "0");
    expect(focusedWidth / focusedHeight).toBeCloseTo(1_728 / 2_304, 3);
    expect(focusedHeight).toBeLessThanOrEqual(640);
  });
  await waitFor(() => expect(api.applyIntents).toHaveBeenCalledWith(PROJECT_ID, {
    baseRevision: 1,
    intents: [{
      type: "update-node",
      nodeId: material.id,
      patch: { geometry: { x: 80, y: 80, width: 270, height: 360 } },
    }],
  }));
  expect(api.getExactVersionPreview).toHaveBeenCalledWith(
    PROJECT_ID,
    material.id,
    "version-image-selected",
    expect.any(AbortSignal),
  );
});

test("a material Node Agent adds one revision while composer attachments remain new canvas context", async () => {
  const material = node({
    id: "image-revision",
    kind: "image",
    name: "Direction reference",
    state: "ready",
    assetId: "asset-direction-v1",
    currentVersionId: "version-direction-v1",
    selectedVersionId: "version-direction-v1",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([material]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.doubleClick(await screen.findByTestId("rf__node-image-revision"));
  const panel = await screen.findByLabelText("Direction reference Agent panel", { selector: "section" });
  const revision = new File(["new"], "direction-v2.png", { type: "image/png" });
  fireEvent.change(within(panel).getByLabelText("Add revision to Direction reference"), {
    target: { files: [revision] },
  });
  await waitFor(() => expect(api.appendMaterialVersion).toHaveBeenCalledWith(PROJECT_ID, material.id, revision));

  const context = new File(["context"], "mood.png", { type: "image/png" });
  fireEvent.change(within(panel).getByLabelText("Attach files to Direction reference Agent"), {
    target: { files: [context] },
  });
  await waitFor(() => expect(api.importLocalFiles).toHaveBeenCalledWith(
    PROJECT_ID,
    [context],
    { x: material.geometry.x + material.geometry.width + 48, y: material.geometry.y },
  ));
  expect(api.appendMaterialVersion).toHaveBeenCalledTimes(1);
});

test("focus ignores adjacent Node double-clicks and remounts scope only after an explicit close", async () => {
  const user = userEvent.setup();
  const nodeA = node({ id: "page-a", name: "Node A" });
  const nodeB = node({ id: "page-b", name: "Node B", geometry: { x: 620, y: 80, width: 480, height: 360 } });
  const { api } = createCanvasApi(canvas([nodeA, nodeB]));
  vi.mocked(api.getThread).mockImplementation(async (_projectId, scope) => ({
    ...thread,
    id: scope.type === "node" ? `thread-${scope.nodeId}` : thread.id,
    scope,
    messages: scope.type === "node" && scope.nodeId === nodeA.id ? [{
      id: "message-a",
      role: "assistant",
      content: "Node A private transcript",
      jobId: null,
      createdAt: 2,
    }] : [],
  }));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.doubleClick(await screen.findByTestId("rf__node-page-a"));
  expect(await screen.findByText("Node A private transcript")).toBeInTheDocument();
  const nodeADraft = await screen.findByRole("textbox", { name: "Node A Agent message" });
  await user.type(nodeADraft, "Only for A @node b");
  await user.click(await screen.findByRole("option", { name: /Node B/ }));
  expect(screen.getByRole("button", { name: "Remove Node B reference" })).toBeInTheDocument();

  fireEvent.doubleClick(screen.getByTestId("rf__node-page-b"));
  expect(screen.getByLabelText("Node A Agent panel", { selector: "section" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Node B Agent panel", { selector: "section" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close Node focus" }));
  await waitFor(() => expect(document.querySelector(".design-canvas-surface")).not.toHaveAttribute("data-node-focus"));
  fireEvent.click(screen.getByTestId("rf__node-page-b"));
  expect(await screen.findByLabelText("Node B Agent panel", { selector: "section" })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Node A private transcript")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "Node B Agent message" })).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Remove Node B reference" })).not.toBeInTheDocument();
});

test("Agent transcripts ignore an older request that resolves after a newer refresh", async () => {
  const user = userEvent.setup();
  let resolveOlder!: (value: DesignThread) => void;
  let resolveNewer!: (value: DesignThread) => void;
  const older = { ...thread, messages: [{ id: "old", role: "assistant" as const, content: "Older transcript", jobId: null, createdAt: 2 }] };
  const newer = { ...thread, messages: [{ id: "new", role: "assistant" as const, content: "Newest transcript", jobId: null, createdAt: 3 }] };
  const { api } = createCanvasApi(canvas());
  vi.mocked(api.getThread)
    .mockImplementationOnce(() => new Promise<DesignThread>((resolve) => { resolveOlder = resolve; }))
    .mockImplementationOnce(() => new Promise<DesignThread>((resolve) => { resolveNewer = resolve; }));

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={[]}
      jobs={[]}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );
  await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(1));
  await user.type(screen.getByRole("textbox", { name: "Main Agent message" }), "refresh");
  await user.click(screen.getByRole("button", { name: "Send to Main Agent" }));
  await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(2));

  resolveNewer(newer);
  expect(await screen.findByText("Newest transcript")).toBeInTheDocument();
  resolveOlder(older);
  await Promise.resolve();
  await Promise.resolve();
  expect(screen.queryByText("Older transcript")).not.toBeInTheDocument();
  expect(screen.getByText("Newest transcript")).toBeInTheDocument();
});

test("Agent panel renders local transcript history without an artificial skeleton delay", async () => {
  const { api } = createCanvasApi(canvas());
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [{ id: "deferred-message", role: "assistant", content: "Deferred history", jobId: null, createdAt: 2 }],
  });

  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle=""
      nodes={[]}
      jobs={[]}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  expect(screen.getByRole("textbox", { name: "Main Agent message" })).toBeInTheDocument();
  expect(rendered.container.querySelector(".design-canvas-agent__transcript-placeholder")).not.toBeInTheDocument();
  expect(await screen.findByText("Deferred history")).toBeInTheDocument();
});

test("Agent transcripts render a bounded recent window and page older history on demand", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index + 1}`,
    role: "assistant" as const,
    content: `Message ${index + 1}`,
    jobId: null,
    createdAt: index + 1,
  }));
  const jobs = Array.from({ length: 14 }, (_, index): DesignJob => ({
    ...job,
    id: `job-history-${index + 1}`,
    kind: "implementation-export",
    exportId: `export-history-${index + 1}`,
    createdAt: index + 1,
    updatedAt: index + 1,
    finishedAt: index + 1,
  }));
  vi.mocked(api.getThread).mockResolvedValue({ ...thread, messages });

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle=""
      nodes={[]}
      jobs={jobs}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  expect(await screen.findByText("Message 20")).toBeInTheDocument();
  expect(screen.queryByText("Message 8")).not.toBeInTheDocument();
  expect(screen.getAllByLabelText("Implementation export · ready")).toHaveLength(6);
  expect(screen.getByRole("button", { name: "Show earlier activity 16" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Show earlier activity 16" }));
  expect(await screen.findByText("Message 1")).toBeInTheDocument();
  expect(screen.getAllByLabelText("Implementation export · ready")).toHaveLength(12);
  expect(screen.getByRole("button", { name: "Show earlier activity 2" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Show earlier activity 2" }));
  expect(screen.queryByRole("button", { name: /Show earlier activity/ })).not.toBeInTheDocument();
});

test("Agent transcript interleaves cards by creation time and always appends a new user bubble at the tail", async () => {
  const target = node({ id: "page-order", name: "Ordered page" });
  const activityJob: DesignJob = {
    ...job,
    id: "job-middle",
    kind: "node-generation",
    nodeId: target.id,
    createdAt: 20,
    updatedAt: 21,
    finishedAt: 21,
  };
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    scope: { type: "node", nodeId: target.id },
    messages: [
      { id: "message-user-old", role: "user", content: "Earlier request", jobId: null, createdAt: 5 },
      { id: "message-assistant", role: "assistant", content: "Earlier response", jobId: null, createdAt: 10 },
      { id: "message-user-new", role: "user", content: "Newest request", jobId: null, createdAt: 30 },
    ],
  });
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "node", nodeId: target.id }}
      title="Ordered page Agent"
      subtitle=""
      nodes={[target]}
      jobs={[activityJob]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  await screen.findByText("Newest request");
  const timeline = [...rendered.container.querySelectorAll<HTMLElement>(
    ".design-canvas-agent__message, .design-canvas-agent__activity",
  )];
  expect(timeline.map((item) => item.dataset.role ?? item.dataset.jobId)).toEqual([
    "user",
    "assistant",
    activityJob.id,
    "user",
  ]);
  expect(timeline.at(-1)).toHaveTextContent("Newest request");
  expect(screen.getByText("Earlier request")).toBeInTheDocument();
});

test("a submitted Agent turn stays above a Job that appears before the thread refresh", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  vi.mocked(api.getThread).mockResolvedValue(thread);
  let resolveSubmit!: () => void;
  const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
    resolveSubmit = resolve;
  }));
  const thinkingJob: DesignJob = {
    ...job,
    id: "job-optimistic-thinking",
    status: "running",
    activity: [],
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
  };
  const panel = (jobs: readonly DesignJob[]) => (
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle=""
      nodes={[]}
      jobs={jobs}
      agents={[CLAUDE_AGENT]}
      onSubmit={onSubmit}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />
  );
  const rendered = render(panel([]));

  expect(await screen.findByText("Coordinate the canvas.")).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Main Agent message" }), "Generate a new direction");
  await user.click(screen.getByRole("button", { name: "Send to Main Agent" }));
  expect(rendered.container.querySelector(".design-canvas-agent__message[data-role='user']"))
    .toHaveTextContent("Generate a new direction");

  rendered.rerender(panel([thinkingJob]));
  await screen.findByRole("status", { name: "Thinking" });
  const timeline = [...rendered.container.querySelectorAll<HTMLElement>(
    ".design-canvas-agent__message, .design-canvas-agent__thinking",
  )];
  expect(timeline).toHaveLength(2);
  expect(timeline[0]).toHaveAttribute("data-role", "user");
  expect(timeline[0]).toHaveTextContent("Generate a new direction");
  expect(timeline[1]).toHaveAttribute("aria-label", "Thinking");

  resolveSubmit();
  await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(2));
});

test("Canvas Agent accepts any available runtime provider", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  const onSubmit = vi.fn(async () => {});

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={[]}
      jobs={[]}
      agents={[
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5"] },
        CLAUDE_AGENT,
      ]}
      initialAgentCommand="codex"
      initialModel="gpt-5"
      onSubmit={onSubmit}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("Codex"));
  await user.type(screen.getByRole("textbox", { name: "Main Agent message" }), "Coordinate the redesign");
  await user.click(screen.getByRole("button", { name: "Send to Main Agent" }));

  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    "Coordinate the redesign",
    [],
    { agentCommand: "codex", model: "gpt-5" },
  ));
});

test("Canvas Agent preserves an explicitly selected compatible runtime Agent", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  const onSubmit = vi.fn(async () => {});

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={[]}
      jobs={[]}
      agents={[
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["hy3-ioa"] },
        CLAUDE_AGENT,
      ]}
      initialAgentCommand="codebuddy"
      initialModel="hy3-ioa"
      onSubmit={onSubmit}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("CodeBuddy"));
  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  expect(screen.getByRole("button", { name: /CodeBuddy/ })).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Default" }));
  await user.keyboard("{Escape}");
  await user.type(screen.getByRole("textbox", { name: "Main Agent message" }), "Use the runtime default");
  await user.click(screen.getByRole("button", { name: "Send to Main Agent" }));

  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    "Use the runtime default",
    [],
    { agentCommand: "codebuddy", model: null },
  ));
});

test("Canvas Agent keeps its action row stable and offers a generic rescan when none is available", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  const onSubmit = vi.fn(async () => {});
  const onRescanAgents = vi.fn(async () => {});

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={[]}
      jobs={[]}
      agents={[
        {
          id: "codebuddy",
          command: "codebuddy",
          available: false,
          availability: "authentication-required",
          unavailableReason: "Authentication required",
          models: ["hy3-ioa"],
        },
        {
          id: "claude",
          command: "claude",
          available: false,
          availability: "authentication-required",
          unavailableReason: "Authentication required",
          models: ["sonnet"],
        },
      ]}
      initialAgentCommand="codebuddy"
      initialModel="hy3-ioa"
      onRescanAgents={onRescanAgents}
      onSubmit={onSubmit}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const unavailable = await screen.findByRole("button", { name: "Agent unavailable" });
  expect(unavailable).toHaveAttribute("title", "No Design Agent is currently available");
  expect(screen.queryByRole("button", { name: "Agent and model" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Claude|CodeBuddy/)).not.toBeInTheDocument();
  await user.click(unavailable);
  expect(onRescanAgents).toHaveBeenCalledTimes(1);
  await user.type(screen.getByRole("textbox", { name: "Main Agent message" }), "Try to run anyway");
  expect(screen.getByRole("button", { name: "Send to Main Agent" })).toBeDisabled();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("Agent errors appear in a dismissible overlay anchored outside composer layout flow", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas());
  vi.mocked(api.getThread).mockRejectedValue(new Error("The Agent connection could not be opened"));

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={[]}
      jobs={[]}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const notice = await screen.findByRole("alert");
  expect(notice).toHaveClass("design-canvas-agent__composer-notice");
  expect(notice.parentElement).toHaveClass("design-canvas-agent__composer");
  expect(notice).toHaveTextContent("The Agent connection could not be opened");
  await user.click(within(notice).getByRole("button", { name: "Dismiss Agent error" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("Node and Main Agent composers both fail closed without a compatible runtime Agent", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node()]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.doubleClick(await screen.findByTestId("rf__node-page-1"));
  const nodePanel = await screen.findByLabelText("Landing page Agent panel", { selector: "section" });
  await waitFor(() => expect(nodePanel).toHaveStyle({ visibility: "visible" }));
  fireEvent.change(within(nodePanel).getByLabelText("Landing page Agent message"), {
    target: { value: "Generate this page" },
  });
  expect(within(nodePanel).getByLabelText("Send to Landing page Agent")).toBeDisabled();
  expect(within(nodePanel).getByRole("button", { name: "Agent unavailable" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Main Agent" }));
  const mainPanel = screen.getByLabelText("Main Agent panel");
  await user.type(within(mainPanel).getByRole("textbox", { name: "Main Agent message" }), "Coordinate the canvas");
  expect(within(mainPanel).getByRole("button", { name: "Send to Main Agent" })).toBeDisabled();
  expect(within(mainPanel).getByRole("button", { name: "Agent unavailable" })).toBeInTheDocument();
  expect(api.submitAgentTurn).not.toHaveBeenCalled();
});

test("A new Agent Job renders one Thinking placeholder, not two", async () => {
  const { api } = createCanvasApi(canvas());
  const thinkingJob = { ...job, id: "job-thinking", status: "running" as const, activity: [], finishedAt: null };
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [{ id: "message-thinking", role: "user", content: "Generate the next direction", jobId: thinkingJob.id, createdAt: 40 }],
  });
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle=""
      nodes={[]}
      jobs={[thinkingJob]}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const thinking = await screen.findByRole("status", { name: "Thinking" });
  expect(within(thinking).getByText("Thinking…")).toBeInTheDocument();
  expect(screen.queryByLabelText("Main Agent · running")).not.toBeInTheDocument();
  const timeline = [...rendered.container.querySelectorAll<HTMLElement>(
    ".design-canvas-agent__message, .design-canvas-agent__thinking",
  )];
  expect(timeline).toHaveLength(2);
  expect(timeline[0]).toHaveAttribute("data-role", "user");
  expect(timeline[1]).toHaveAttribute("aria-label", "Thinking");
});

test("a reserved Main Agent reply is represented only by Thinking directly after its user turn", async () => {
  const { api } = createCanvasApi(canvas());
  const thinkingJob = {
    ...job,
    id: "job-reserved-thinking",
    kind: "main-agent" as const,
    status: "running" as const,
    activity: [],
    createdAt: 40,
    updatedAt: 40,
    finishedAt: null,
  };
  const reservedReply = "Main Agent orchestration is queued. The final result will replace this status.";
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [
      { id: "message-reserved-user", role: "user", content: "Refine the visual hierarchy", jobId: thinkingJob.id, createdAt: 40 },
      { id: "message-reserved-assistant", role: "assistant", content: reservedReply, jobId: thinkingJob.id, createdAt: 40 },
    ],
  });
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle=""
      nodes={[]}
      jobs={[thinkingJob]}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const thinking = await screen.findByRole("status", { name: "Thinking" });
  expect(screen.queryByText(reservedReply)).not.toBeInTheDocument();
  const timeline = [...rendered.container.querySelectorAll<HTMLElement>(
    ".design-canvas-agent__message, .design-canvas-agent__thinking",
  )];
  expect(timeline).toHaveLength(2);
  expect(timeline[0]).toHaveAttribute("data-role", "user");
  expect(timeline[0]).toHaveTextContent("Refine the visual hierarchy");
  expect(timeline[1]).toBe(thinking);
});

test("A completed conversational Main Agent turn renders as a message without an activity card", async () => {
  const { api } = createCanvasApi(canvas());
  const conversationJob = {
    ...job,
    id: "job-conversation",
    conversationOnly: true,
    activity: [
      { id: "activity-reasoning", kind: "status" as const, text: "Reviewed the request", createdAt: 1 },
      { id: "activity-conversation", kind: "text" as const, text: "你好！", createdAt: 2 },
    ],
  };
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [
      { id: "message-user", role: "user", content: "你好", jobId: conversationJob.id, createdAt: 1 },
      { id: "message-assistant", role: "assistant", content: "你好！有什么我可以帮你的？", jobId: conversationJob.id, createdAt: 2 },
    ],
  });
  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle=""
      nodes={[]}
      jobs={[conversationJob]}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  expect(await screen.findByText("你好！有什么我可以帮你的？")).toBeInTheDocument();
  expect(screen.queryByLabelText("Main Agent · ready")).not.toBeInTheDocument();
  expect(screen.queryByText("Canvas plan")).not.toBeInTheDocument();
});

test("Main Agent expands the latest visible Job when a newer conversation-only turn has no task row", async () => {
  const exportJob: DesignJob = {
    ...job,
    id: "job-visible-export",
    kind: "implementation-export",
    status: "cancelled",
    exportId: "export-visible",
    createdAt: 10,
    updatedAt: 12,
    finishedAt: 12,
  };
  const conversationJob: DesignJob = {
    ...job,
    id: "job-later-conversation",
    conversationOnly: true,
    createdAt: 20,
    updatedAt: 22,
    finishedAt: 22,
  };
  const { api } = createCanvasApi(canvas());
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [
      { id: "message-later-user", role: "user", content: "Any other ideas?", jobId: conversationJob.id, createdAt: 20 },
      { id: "message-later-assistant", role: "assistant", content: "Try a quieter direction.", jobId: conversationJob.id, createdAt: 21 },
    ],
  });

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle=""
      nodes={[]}
      jobs={[exportJob, conversationJob]}
      agents={[CLAUDE_AGENT]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const exportCard = await screen.findByLabelText("Implementation export · cancelled");
  expect(within(exportCard).getByRole("button", { name: /Implementation export/ }))
    .toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByLabelText("Main Agent · ready")).not.toBeInTheDocument();
});

test("Node Agent activity stays chronological so a successful retry is the visible tail", async () => {
  const target = node();
  const failed: DesignJob = {
    ...job,
    id: "job-failed",
    kind: "node-generation",
    status: "failed",
    nodeId: target.id,
    error: "Older attempt failed",
    createdAt: 10,
    updatedAt: 11,
    finishedAt: 11,
  };
  const ready: DesignJob = {
    ...job,
    id: "job-ready",
    kind: "node-generation",
    nodeId: target.id,
    createdAt: 20,
    updatedAt: 21,
    finishedAt: 21,
  };
  const { api } = createCanvasApi(canvas([target]));
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "node", nodeId: target.id }}
      title="Landing page Agent"
      subtitle="Works from canvas context"
      nodes={[target]}
      jobs={[ready, failed]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const failedCard = rendered.container.querySelector<HTMLElement>(`[data-job-id="${failed.id}"]`)!;
  const readyCard = rendered.container.querySelector<HTMLElement>(`[data-job-id="${ready.id}"]`)!;
  expect(failedCard).toHaveAttribute("data-agent-component", "task-row");
  expect(within(failedCard).getByRole("button", { name: /Landing page generation/ }))
    .toHaveAttribute("aria-expanded", "false");
  expect(within(readyCard).getByRole("button", { name: /Landing page generation/ }))
    .toHaveAttribute("aria-expanded", "true");
  expect(readyCard).not.toHaveAttribute("data-collapsed");
  expect(within(failedCard).queryByText("Older attempt failed")).not.toBeInTheDocument();
  fireEvent.click(failedCard.querySelector<HTMLButtonElement>(".design-canvas-agent__activity-toggle")!);
  expect(await within(failedCard).findByText("Older attempt failed")).toBeInTheDocument();
  expect([...rendered.container.querySelectorAll<HTMLElement>("[data-job-id]")]
    .map((element) => element.dataset.jobId)).toEqual([failed.id, ready.id]);
});

test("a failed Node Job exposes Repair & retry with visible retryable failure feedback", async () => {
  const user = userEvent.setup();
  const target = node();
  const failed: DesignJob = {
    ...job,
    id: "job-failed-repair",
    kind: "node-generation",
    status: "failed",
    nodeId: target.id,
    error: "Generated HTML did not pass validation",
    activity: [],
    createdAt: 10,
    updatedAt: 11,
    finishedAt: 11,
  };
  const { api } = createCanvasApi(canvas([target]));
  const onRetryJob = vi.fn()
    .mockRejectedValueOnce(new Error("The failed Job could not be reopened"))
    .mockResolvedValueOnce(undefined);
  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "node", nodeId: target.id }}
      title="Landing page Agent"
      subtitle=""
      nodes={[target]}
      jobs={[failed]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onRetryJob={onRetryJob}
      onAttachFiles={async () => {}}
    />,
  );

  const retry = await screen.findByRole("button", { name: "Repair & retry Landing page generation" });
  await user.click(retry);
  expect(await screen.findByText(
    "Couldn't retry Landing page generation. The failed Job could not be reopened",
  )).toBeInTheDocument();
  expect(retry).toBeEnabled();

  await user.click(retry);
  await waitFor(() => expect(onRetryJob).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/could not be reopened/)).not.toBeInTheDocument();
});

test("Main Agent groups delegated work under semantic execution labels without repeating prompts", async () => {
  const childNodes = ["Checkout", "Header", "Pricing", "FAQ", "Footer", "Account", "Search"].map((name, index) => (
    node({ id: `node-${index + 1}`, name })
  ));
  const parentA: DesignJob = { ...job, id: "job-main-a", createdAt: 10, updatedAt: 10 };
  const parentB: DesignJob = { ...job, id: "job-main-b", createdAt: 20, updatedAt: 20 };
  const childJobs = childNodes.map((target, index): DesignJob => ({
    ...job,
    id: `job-child-${index + 1}`,
    kind: "node-generation",
    status: "queued",
    nodeId: target.id,
    parentJobId: index < 6 ? parentA.id : parentB.id,
    createdAt: 30 + index,
    updatedAt: 30 + index,
    finishedAt: null,
  }));
  const { api } = createCanvasApi(canvas(childNodes));
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [
      { id: "message-turn-a", role: "user", content: "Build six launch surfaces", jobId: parentA.id, createdAt: 10 },
      { id: "message-turn-b", role: "user", content: "Add global search", jobId: parentB.id, createdAt: 20 },
    ],
  });
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={childNodes}
      jobs={[parentA, parentB, ...childJobs]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const firstTurn = await screen.findByLabelText("Canvas execution · 6 child Agents");
  expect(firstTurn).toHaveAttribute("data-parent-job-id", parentA.id);
  expect(within(firstTurn).getByText("6 child Agents")).toBeInTheDocument();
  expect(within(firstTurn).getByText("Canvas execution")).toBeInTheDocument();
  expect(within(firstTurn).queryByText("Build six launch surfaces")).not.toBeInTheDocument();
  expect(within(firstTurn).queryByLabelText("Main Agent · ready")).not.toBeInTheDocument();
  for (const target of childNodes.slice(0, 6)) {
    const activity = within(firstTurn).getByLabelText(`Node generation · ${target.name} · queued`);
    expect(activity).toHaveAttribute("data-node-id", target.id);
    expect(activity).toHaveAttribute("data-parent-job-id", parentA.id);
  }
  expect(rendered.container.querySelectorAll('[data-job-id^="job-child-"]')).toHaveLength(7);

  const secondTurn = screen.getByLabelText("Canvas execution · 1 child Agent");
  expect(within(secondTurn).getByText("1 child Agent")).toBeInTheDocument();
  expect(within(secondTurn).getByLabelText("Node generation · Search · queued")).toBeInTheDocument();
});

test("Main Agent keeps compact failed and cancelled parent outcomes with or without child work", async () => {
  const target = node({ id: "child-node", name: "Checkout" });
  const failedParent: DesignJob = {
    ...job,
    id: "job-parent-failed",
    status: "failed",
    error: "The canvas plan could not be applied",
    activity: [],
    createdAt: 10,
    updatedAt: 12,
    finishedAt: 12,
  };
  const cancelledParent: DesignJob = {
    ...job,
    id: "job-parent-cancelled",
    status: "cancelled",
    error: "Cancellation internals should not be shown as a failure",
    activity: [],
    createdAt: 20,
    updatedAt: 22,
    finishedAt: 22,
  };
  const child: DesignJob = {
    ...job,
    id: "job-cancelled-child",
    kind: "node-generation",
    status: "ready",
    nodeId: target.id,
    parentJobId: cancelledParent.id,
    createdAt: 21,
    updatedAt: 23,
    finishedAt: 23,
  };
  const { api } = createCanvasApi(canvas([target]));
  const onRetryJob = vi.fn(async () => {});
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [
      { id: "failed-prompt", role: "user", content: "Apply the full canvas plan", jobId: failedParent.id, createdAt: 10 },
      { id: "cancelled-prompt", role: "user", content: "Stop after checkout", jobId: cancelledParent.id, createdAt: 20 },
    ],
  });
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={[target]}
      jobs={[failedParent, cancelledParent, child]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onRetryJob={onRetryJob}
      onAttachFiles={async () => {}}
    />,
  );

  await waitFor(() => expect(rendered.container.querySelector(`[data-parent-job-id="${failedParent.id}"]`)).toBeInTheDocument());
  const failedGroup = rendered.container.querySelector<HTMLElement>(`[data-parent-job-id="${failedParent.id}"]`)!;
  const failedOutcome = failedGroup.querySelector<HTMLElement>(".design-canvas-agent__activity-group-outcome")!;
  expect(failedOutcome).toHaveTextContent("Failed");
  expect(failedOutcome).toHaveTextContent("The canvas plan could not be applied");
  await userEvent.click(within(failedGroup).getByRole("button", { name: "Repair & retry Canvas plan" }));
  expect(onRetryJob).toHaveBeenCalledWith(failedParent.id);
  const cancelledGroup = rendered.container.querySelector<HTMLElement>(`[data-parent-job-id="${cancelledParent.id}"]`)!;
  const cancelledOutcome = cancelledGroup.querySelector<HTMLElement>(".design-canvas-agent__activity-group-outcome")!;
  expect(cancelledOutcome).toHaveTextContent("Cancelled");
  expect(within(cancelledGroup).queryByText(/Cancellation internals/)).not.toBeInTheDocument();
  const latestChild = within(cancelledGroup).getByLabelText("Node generation · Checkout · ready");
  expect(within(latestChild).getByRole("button", { name: /Checkout generation/ }))
    .toHaveAttribute("aria-expanded", "true");
});

test.each(["ready", "failed", "cancelled"] as const)(
  "terminal %s Jobs render recorded Thinking as a static completed phase",
  async (status) => {
    const target = node({ id: "phase-node", name: "Phase node" });
    const terminalJob: DesignJob = {
      ...job,
      id: `job-thinking-${status}`,
      kind: "node-generation",
      nodeId: target.id,
      status,
      error: status === "failed" ? "Generation failed" : null,
      activity: [{ id: "reasoning-record", kind: "text", text: "Read the frozen canvas context.", createdAt: 2 }],
      createdAt: 1,
      updatedAt: 3,
      finishedAt: 3,
    };
    const { api } = createCanvasApi(canvas([target]));
    vi.mocked(api.getThread).mockResolvedValue({
      ...thread,
      scope: { type: "node", nodeId: target.id },
    });
    const rendered = render(
      <CanvasAgentPanel
        projectId={PROJECT_ID}
        api={api}
        scope={{ type: "node", nodeId: target.id }}
        title="Phase node Agent"
        subtitle="Builds the node"
        nodes={[target]}
        jobs={[terminalJob]}
        onSubmit={async () => {}}
        onCancelJob={async () => {}}
        onAttachFiles={async () => {}}
      />,
    );

    const record = await screen.findByLabelText(`Node generation · Phase node · ${status}`);
    expect(within(record).getByRole("button", { name: /Phase node generation/ }))
      .toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(record.querySelector('[data-activity-kind="thinking"]')).toBeInTheDocument());
    const reasoning = record.querySelector<HTMLElement>('[data-activity-kind="thinking"]')!;
    expect(reasoning).not.toHaveAttribute("data-active");
    expect(reasoning.querySelector(".agent-activity-card__marker")).toHaveAttribute("data-state", "complete");
    expect(reasoning.querySelector(".agent-activity-card__pulse")).toBeNull();
    expect(within(reasoning).getByText("Completed")).toBeInTheDocument();
    rendered.unmount();
  },
);

test("running Jobs complete Thinking after later work and reactivate it only for newer reasoning", async () => {
  const target = node({ id: "phase-node-live", name: "Live phase" });
  const reasoning = { id: "reasoning-first", kind: "text" as const, text: "Inspect the canvas.", createdAt: 2 };
  const runningJob: DesignJob = {
    ...job,
    id: "job-thinking-live",
    kind: "node-generation",
    nodeId: target.id,
    status: "running",
    activity: [reasoning],
    createdAt: 1,
    updatedAt: 2,
    finishedAt: null,
  };
  const { api } = createCanvasApi(canvas([target]));
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    scope: { type: "node", nodeId: target.id },
  });
  const panel = (jobs: readonly DesignJob[]) => (
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "node", nodeId: target.id }}
      title="Live phase Agent"
      subtitle="Builds the node"
      nodes={[target]}
      jobs={jobs}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />
  );
  const rendered = render(panel([runningJob]));
  const record = await screen.findByLabelText("Node generation · Live phase · running");
  const thinking = () => record.querySelector<HTMLElement>('[data-activity-kind="thinking"]')!;
  const activeKinds = () => [...record.querySelectorAll<HTMLElement>('[data-activity-kind][data-active="true"]')]
    .map((element) => element.dataset.activityKind);

  await waitFor(() => expect(thinking()).toHaveAttribute("data-active", "true"));
  expect(thinking().querySelector(".agent-activity-card__pulse")).toBeInTheDocument();
  expect(within(thinking()).getByText("Live")).toBeInTheDocument();
  expect(activeKinds()).toEqual(["thinking"]);

  const laterActivities: Array<{ activity: DesignJob["activity"]; phase: string }> = [
    { activity: [reasoning, { id: "tool-later", kind: "tool", text: "Writing index.html", createdAt: 3 }], phase: "actions" },
    { activity: [reasoning, { id: "status-later", kind: "status", text: "Validating output", createdAt: 3 }], phase: "actions" },
    { activity: [reasoning, { id: "search-later", kind: "text", text: "Searching the web for “editorial grids”", createdAt: 3 }], phase: "search" },
    { activity: [reasoning, { id: "image-later", kind: "text", text: "Generating an image “Tokyo at dusk”", createdAt: 3 }], phase: "image-generation" },
  ];
  for (const { activity, phase } of laterActivities) {
    rendered.rerender(panel([{ ...runningJob, activity, updatedAt: 3 }]));
    await waitFor(() => expect(thinking()).not.toHaveAttribute("data-active"));
    expect(thinking().querySelector(".agent-activity-card__pulse")).toBeNull();
    expect(thinking().querySelector(".agent-activity-card__marker")).toHaveAttribute("data-state", "complete");
    expect(within(thinking()).getByText("Completed")).toBeInTheDocument();
    expect(activeKinds()).toEqual([phase]);
  }

  const cumulativeActivities: DesignJob["activity"] = [
    reasoning,
    { id: "tool-middle", kind: "tool", text: "Writing index.html", createdAt: 3 },
    { id: "search-middle", kind: "text", text: "Searching the web for “editorial grids”", createdAt: 4 },
    { id: "image-middle", kind: "text", text: "Generating an image “Tokyo at dusk”", createdAt: 5 },
    { id: "reasoning-newest", kind: "text", text: "Review the generated hierarchy.", createdAt: 6 },
  ];
  rendered.rerender(panel([{
    ...runningJob,
    activity: cumulativeActivities,
    updatedAt: 6,
  }]));
  await waitFor(() => expect(thinking()).toHaveAttribute("data-active", "true"));
  expect(thinking().querySelector(".agent-activity-card__pulse")).toBeInTheDocument();
  expect(within(thinking()).getByText("Live")).toBeInTheDocument();
  expect(activeKinds()).toEqual(["thinking"]);
  expect(record.querySelector('[data-activity-kind="actions"] li[data-state="active"]')).toBeNull();
  expect(record.querySelector('[data-activity-kind="search"]')).not.toHaveAttribute("data-active");
  expect(record.querySelector('[data-activity-kind="image-generation"]')).not.toHaveAttribute("data-active");

  rendered.rerender(panel([{
    ...runningJob,
    status: "ready",
    activity: cumulativeActivities,
    updatedAt: 7,
    finishedAt: 7,
  }]));
  await waitFor(() => expect(activeKinds()).toEqual([]));
  expect(record.querySelector('[data-activity-kind="thinking"]')).not.toHaveAttribute("data-active");
  expect(record.querySelector('[data-activity-kind="actions"] li[data-state="active"]')).toBeNull();
  expect(record.querySelector('[data-activity-kind="search"]')).not.toHaveAttribute("data-active");
  expect(record.querySelector('[data-activity-kind="image-generation"]')).not.toHaveAttribute("data-active");
});

test("Agent transcript follows live updates only while the reader remains near the tail", async () => {
  const target = node();
  const running: DesignJob = {
    ...job,
    id: "job-follow-tail",
    kind: "node-generation",
    status: "running",
    nodeId: target.id,
    finishedAt: null,
  };
  const { api } = createCanvasApi(canvas([target]));
  const props = {
    projectId: PROJECT_ID,
    api,
    scope: { type: "node", nodeId: target.id } as const,
    title: "Landing page Agent",
    subtitle: "Works from canvas context",
    nodes: [target],
    onSubmit: async () => {},
    onCancelJob: async () => {},
    onAttachFiles: async () => {},
  };
  const rendered = render(<CanvasAgentPanel {...props} jobs={[running]} />);
  const log = await screen.findByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 },
  });

  log.scrollTop = 120;
  fireEvent.scroll(log);
  rendered.rerender(<CanvasAgentPanel {...props} jobs={[{ ...running, status: "validating", updatedAt: 2 }]} />);
  await waitFor(() => expect(log.scrollTop).toBe(120));

  log.scrollTop = 700;
  fireEvent.scroll(log);
  rendered.rerender(<CanvasAgentPanel {...props} jobs={[{ ...running, status: "ready", updatedAt: 3, finishedAt: 3 }]} />);
  await waitFor(() => expect(log.scrollTop).toBe(1_000));
});

test("Job status changes have a dedicated polite atomic announcement", async () => {
  const target = node();
  const running: DesignJob = { ...job, kind: "node-generation", status: "running", nodeId: target.id, finishedAt: null };
  const { api } = createCanvasApi(canvas([target]));
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "node", nodeId: target.id }}
      title="Landing page Agent"
      subtitle="Works from canvas context"
      nodes={[target]}
      jobs={[running]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );
  const card = rendered.container.querySelector<HTMLElement>(`[data-job-id="${running.id}"]`)!;
  const status = within(card).getByRole("status");
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveAttribute("aria-atomic", "true");
  expect(status).toHaveTextContent("Landing page generation: Working");
});

test("Main Agent toggles from the topbar, sees canvas scope, and submits orchestration turns", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node()]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} agents={[CLAUDE_AGENT]} />);

  await user.click(await screen.findByRole("button", { name: "Main Agent" }));
  expect(screen.getByLabelText("Main Agent panel")).toBeInTheDocument();
  const composer = screen.getByRole("textbox", { name: "Main Agent message" });
  await user.type(composer, "Coordinate @land");
  await user.click(await screen.findByRole("option", { name: /Landing page/ }));
  expect(screen.getByRole("button", { name: "Remove Landing page reference" })).toBeInTheDocument();
  await user.type(composer, "and ask its Agent to design the checkout");
  await user.click(screen.getByRole("button", { name: "Send to Main Agent" }));
  await waitFor(() => expect(api.submitAgentTurn).toHaveBeenCalledWith(
    PROJECT_ID,
    { type: "main" },
    expect.objectContaining({
      prompt: "Coordinate Landing page and ask its Agent to design the checkout",
      context: { nodeIds: ["page-1"] },
    }),
  ));
});

test("Export waits for explicit confirmation before starting an implementation job", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[CLAUDE_AGENT]}
      initialAgentCommand="claude"
      initialModel="sonnet"
    />,
  );

  const exportButton = await screen.findByRole("button", { name: "Export code" });
  await user.click(exportButton);

  expect(api.startImplementationExport).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("dialog", { name: "Start implementation export?" });
  expect(confirmation).toHaveTextContent("fresh implementation from the selected Versions");
  expect(confirmation).toHaveTextContent("consume quota from your configured provider");
  expect(within(confirmation).getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(within(confirmation).getByRole("button", { name: "Start export" })).toBeEnabled();
});

test("Export confirmation Cancel and Escape restore focus without starting", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[CLAUDE_AGENT]}
      initialAgentCommand="claude"
    />,
  );

  const exportButton = await screen.findByRole("button", { name: "Export code" });
  await user.click(exportButton);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Start implementation export?" })).not.toBeInTheDocument();
  expect(exportButton).toHaveFocus();

  await user.click(exportButton);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Start implementation export?" })).not.toBeInTheDocument();
  expect(exportButton).toHaveFocus();
  expect(api.startImplementationExport).not.toHaveBeenCalled();
});

test("confirmed Export starts exactly once and disables duplicate confirmation while pending", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  let resolveExport!: (result: DesignExportResult) => void;
  vi.mocked(api.startImplementationExport).mockImplementation(() => new Promise((resolve) => {
    resolveExport = resolve;
  }));
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[CLAUDE_AGENT]}
      initialAgentCommand="claude"
      initialModel="sonnet"
    />,
  );

  const exportButton = await screen.findByRole("button", { name: "Export code" });
  await user.click(exportButton);
  const start = screen.getByRole("button", { name: "Start export" });
  fireEvent.click(start);
  fireEvent.click(start);

  expect(api.startImplementationExport).toHaveBeenCalledOnce();
  expect(api.startImplementationExport).toHaveBeenCalledWith(
    PROJECT_ID,
    1,
    { agentCommand: "claude", model: "sonnet" },
  );
  expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();

  resolveExport({
    exportId: "export-1",
    job: { ...job, kind: "implementation-export", exportId: "export-1" },
  });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Start implementation export?" })).not.toBeInTheDocument());
  expect(screen.getByLabelText("Main Agent panel")).toBeInTheDocument();
  expect(exportButton).toHaveFocus();
});

test("late Settings defaults replace an untouched Agent fallback before Export", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  const rendered = render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[CLAUDE_AGENT, CODEBUDDY_AGENT]}
    />,
  );

  await screen.findByRole("button", { name: "Export code" });
  rendered.rerender(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[CLAUDE_AGENT, CODEBUDDY_AGENT]}
      initialAgentCommand="codebuddy"
      initialModel="hy3-ioa"
    />,
  );

  await user.click(screen.getByRole("button", { name: "Export code" }));
  expect(api.startImplementationExport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Start export" }));
  await waitFor(() => expect(api.startImplementationExport).toHaveBeenCalledWith(
    PROJECT_ID,
    1,
    { agentCommand: "codebuddy", model: "hy3-ioa" },
  ));
});

test("Export opens Main Agent and keeps the implementation job visible through completion", async () => {
  const user = userEvent.setup();
  const revealExport = vi.fn(async () => "revealed" as const);
  const persistAgentDefaults = vi.fn(async () => {});
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  const exportJob: DesignJob = {
    ...job,
    id: "job-export",
    kind: "implementation-export",
    status: "ready",
    exportId: "export-1",
    activity: [{ id: "activity-export", kind: "status", text: "High-fidelity implementation ready", createdAt: 3 }],
    finishedAt: 3,
  };
  let exported = false;
  vi.mocked(api.startImplementationExport).mockImplementation(async () => {
    exported = true;
    return { exportId: "export-1", job: exportJob };
  });
  vi.mocked(api.listJobs).mockImplementation(async () => exported ? [exportJob] : []);
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      projectPath="/tmp/editorial"
      api={api}
      agents={[CLAUDE_AGENT]}
      initialAgentCommand="claude"
      initialModel="sonnet"
      onAgentDefaultsChange={persistAgentDefaults}
      onRevealExport={revealExport}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Main Agent" }));
  await user.click(screen.getByRole("button", { name: "Agent and model" }));
  await user.click(await screen.findByRole("button", { name: "opus" }));
  await waitFor(() => expect(persistAgentDefaults).toHaveBeenCalledWith({ agentCommand: "claude", model: "opus" }));
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Close Main Agent" }));
  await waitFor(() => expect(screen.queryByLabelText("Main Agent panel")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Export code" }));
  expect(api.startImplementationExport).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Main Agent panel")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Start export" }));
  await waitFor(() => expect(api.startImplementationExport).toHaveBeenCalledWith(
    PROJECT_ID,
    1,
    { agentCommand: "claude", model: "opus" },
  ));
  expect(await screen.findByLabelText("Main Agent panel")).toBeInTheDocument();
  expect(await screen.findByLabelText("Implementation export · ready")).toBeInTheDocument();
  expect(screen.getAllByText("Implementation export")).toHaveLength(1);
  expect(screen.getByText("Export ready")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Actions/ }));
  expect(screen.getByText("High-fidelity implementation ready")).toBeInTheDocument();
  expect(screen.getByTitle("/tmp/editorial/design/exports/export-1")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Reveal export" }));
  await waitFor(() => expect(revealExport).toHaveBeenCalledWith("export-1"));
  expect(await screen.findByText("Opened in Finder.")).toBeInTheDocument();
});

test("confirmed Export failure closes confirmation and keeps the existing visible error", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  vi.mocked(api.startImplementationExport).mockRejectedValue(new Error("Configured provider quota is exhausted."));
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[CLAUDE_AGENT]}
      initialAgentCommand="claude"
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Export code" }));
  expect(api.startImplementationExport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Start export" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Configured provider quota is exhausted.");
  expect(screen.queryByRole("dialog", { name: "Start implementation export?" })).not.toBeInTheDocument();
  expect(api.startImplementationExport).toHaveBeenCalledOnce();
});

test("Export stays disabled with provider-neutral guidance when no runtime Agent is available", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      api={api}
      agents={[{
        id: "codex",
        command: "codex",
        available: false,
        availability: "authentication-required",
        unavailableReason: "Authentication required",
        models: ["gpt-5"],
      }]}
      initialAgentCommand="codex"
      initialModel="gpt-5"
    />,
  );

  const exportButton = await screen.findByRole("button", { name: "Export code" });
  expect(exportButton).toBeDisabled();
  expect(exportButton).not.toHaveAttribute("title");
  await user.hover(exportButton.parentElement!);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("No Design Agent is currently available for export");
  await user.unhover(exportButton.parentElement!);
  await user.click(screen.getByRole("button", { name: "Main Agent" }));
  expect(within(screen.getByLabelText("Main Agent panel")).getByRole("button", { name: "Agent unavailable" })).toBeInTheDocument();
  expect(api.startImplementationExport).not.toHaveBeenCalled();
});

test("Export stays disabled while any generated Node still has projected or listed live work", async () => {
  const user = userEvent.setup();
  const nodeA = node({
    id: "page-a",
    name: "Checkout",
    state: "generating",
    currentVersionId: "version-a",
    versionCount: 1,
    activeJobId: "job-projected",
  });
  const nodeB = node({
    id: "page-b",
    name: "Account",
    state: "ready",
    currentVersionId: "version-b",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([nodeA, nodeB]));
  vi.mocked(api.listJobs).mockResolvedValue([{
    ...job,
    id: "job-listed",
    kind: "node-generation",
    status: "running",
    nodeId: nodeB.id,
    finishedAt: null,
  }]);

  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const exportButton = await screen.findByRole("button", { name: "Export code" });
  expect(exportButton).toBeDisabled();
  expect(exportButton).not.toHaveAttribute("title");
  await user.hover(exportButton.parentElement!);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Wait for Node generation to finish before exporting: Checkout, Account",
  );
  expect(api.startImplementationExport).not.toHaveBeenCalled();
});

test("file drops become material context nodes and undo/redo shortcuts call authoritative history", async () => {
  const { api } = createCanvasApi(canvas([node()], 1, 1, 1));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);
  await screen.findByTestId("rf__node-page-1");
  const surface = screen.getByLabelText("Infinite Design canvas");
  fireEvent.drop(surface, { clientX: 200, clientY: 180, dataTransfer: { files: [new File(["image"], "reference.png", { type: "image/png" })], types: ["Files"] } });
  await waitFor(() => expect(api.importLocalFiles).toHaveBeenCalledTimes(1));

  fireEvent.keyDown(window, { key: "z", metaKey: true });
  await waitFor(() => expect(api.undo).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
  await waitFor(() => expect(api.redo).toHaveBeenCalledTimes(1));
});

test("live Node generation keeps complete Thinking detail and exposes an accessible Stop state", async () => {
  const user = userEvent.setup();
  const target = node();
  const completeDetail = [
    "Preserve the complete generation reasoning, including every constraint and verification note.",
    "Expanded Thinking must not replace this information with a shortened summary.",
  ].join(" ").repeat(3);
  const liveJob: DesignJob = {
    ...job,
    id: "job-live-generation",
    kind: "node-generation",
    status: "running",
    nodeId: target.id,
    activity: Array.from({ length: 10 }, (_, index) => ({
      id: `live-reason-${index + 1}`,
      kind: "text" as const,
      text: index === 9 ? completeDetail : `Complete reasoning step ${index + 1}`,
      createdAt: index + 1,
    })),
    updatedAt: 10,
    finishedAt: null,
  };
  const { api } = createCanvasApi(canvas([target]));
  let finishCancel: (() => void) | undefined;
  const onCancelJob = vi.fn(() => new Promise<void>((resolve) => {
    finishCancel = resolve;
  }));

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "node", nodeId: target.id }}
      title="Landing page Agent"
      subtitle=""
      nodes={[target]}
      jobs={[liveJob]}
      onSubmit={async () => {}}
      onCancelJob={onCancelJob}
      onAttachFiles={async () => {}}
    />,
  );

  expect(await screen.findByText("Complete reasoning step 1")).toBeInTheDocument();
  expect(screen.getByText(completeDetail)).toBeInTheDocument();
  const stop = screen.getByRole("button", { name: "Stop Landing page generation" });
  await user.click(stop);
  expect(onCancelJob).toHaveBeenCalledWith(liveJob.id);
  expect(screen.getByRole("button", { name: "Stopping Landing page generation" })).toBeDisabled();

  finishCancel?.();
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop Landing page generation" })).toBeEnabled());
});

test("a rejected Stop stays visible and the same Job can be stopped again", async () => {
  const user = userEvent.setup();
  const target = node();
  const liveJob: DesignJob = {
    ...job,
    id: "job-stop-retry",
    kind: "node-generation",
    status: "running",
    nodeId: target.id,
    activity: [{ id: "reason-1", kind: "text", text: "Still generating", createdAt: 1 }],
    finishedAt: null,
  };
  const { api } = createCanvasApi(canvas([target]));
  const onCancelJob = vi.fn()
    .mockRejectedValueOnce(new Error("Agent process did not acknowledge cancellation"))
    .mockResolvedValueOnce(undefined);
  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "node", nodeId: target.id }}
      title="Landing page Agent"
      subtitle=""
      nodes={[target]}
      jobs={[liveJob]}
      onSubmit={async () => {}}
      onCancelJob={onCancelJob}
      onAttachFiles={async () => {}}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Stop Landing page generation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't stop Landing page generation. Agent process did not acknowledge cancellation",
  );
  const retry = screen.getByRole("button", { name: "Stop Landing page generation" });
  expect(retry).toBeEnabled();
  await user.click(retry);
  await waitFor(() => expect(onCancelJob).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/did not acknowledge cancellation/)).not.toBeInTheDocument();
});
