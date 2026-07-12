import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoodboardConversation, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { MoodboardAgentPanel } from "./MoodboardAgentPanel.tsx";
import { CanvasActionBar, CanvasViewBar, GeneratorPromptToolbar, MultiSelectionToolbar, QuickEditPromptToolbar, SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardCanvasNode } from "./MoodboardCanvasNode.tsx";
import { MoodboardCanvas } from "./MoodboardCanvas.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardMultiPropertiesPanel, MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import { MoodboardSectionLabels } from "./MoodboardSectionLabels.tsx";
import {
  allMoodboardNodeIds,
  buildLayerTree,
  clientPointToCanvasPoint,
  containedNodeIdsForSection,
  contextTargetIdFromEvent,
  eventClientPoint,
  generatorModel,
  getFloatingChromeSafeRect,
  isEditableShortcutTarget,
  isResetZoomShortcut,
  isTemporaryHandShortcut,
  MOODBOARD_REVIEW_CAPABILITIES,
  readInitialLayersOpen,
  moveContainedNodesWithSections,
  normalizeCanvasRect,
  nodeIdFromTarget,
  nodeIdsFromTarget,
  nudgeNodeInputs,
  reorderLayerInputs,
  collectFloatingOccluderRects,
  rectFromBounds,
  resolveAnchoredZoomTransform,
  resolveCanvasFitTransform,
  resolveFloatingChromeRect,
  resolveFloatingRect,
  sameFloatingRect,
  sameIdList,
} from "./canvas-utils.ts";
import {
  createMoodboardHistorySnapshot,
  pushMoodboardUndo,
  redoMoodboardHistory,
  undoMoodboardHistory,
  uniqueExistingIds,
} from "./canvas-history.ts";
import { createSnapLines, createSnapPointsFromBounds, resolveSnapDeltas } from "./leafer-adapter/snap-geometry.ts";
import { selectAppNodesByIds } from "./leafer-adapter/editor-selection.ts";
import { MOODBOARD_LEAFER_EDITOR_CONFIG } from "./moodboard-canvas-config.ts";
import { createSectionNode } from "./moodboard-board-utils.ts";
import { MOODBOARD_SCROLLBAR_PADDING } from "./useLeaferMoodboardRuntime.ts";
import { mergeDraftMoodboardNodes } from "./useMoodboardCanvasController.ts";

const leaferDomProps = (props: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(props).map(([key, value]) => [key, typeof value === "boolean" ? String(value) : value]));

vi.mock("@dezin/leafer-react", () => ({
  Frame: ({ children, ...props }: any) => (
    <div data-mock-frame {...leaferDomProps(props)}>
      {children}
    </div>
  ),
  Img: (props: any) => <image {...leaferDomProps(props)} />,
  Leafer: ({ children, ...props }: any) => <div {...leaferDomProps(props)}>{children}</div>,
  Rect: (props: any) => <rect {...leaferDomProps(props)} />,
  Txt: ({ children, text, ...props }: any) => <text {...leaferDomProps(props)}>{text ?? children}</text>,
  ViewportLighter: class {
    destroy() {}
    show() {}
  },
}));

vi.mock("@leafer-in/resize", () => ({}));

vi.mock("@leafer-in/scroll", () => ({
  ScrollBar: class {
    constructor() {}
    destroy() {}
    update() {}
  },
}));

vi.mock("leafer-editor", () => {
  class LeaferShape {
    constructor(public props: Record<string, unknown> = {}) {}
    destroy() {}
    remove() {}
  }

  return {
    Box: LeaferShape,
    DragEvent: { START: "drag.start", DRAG: "drag", END: "drag.end" },
    EditorEvent: { SELECT: "editor.select", HOVER: "editor.hover" },
    EditorMoveEvent: { BEFORE_MOVE: "editor.before-move", MOVE: "editor.move" },
    EditorRotateEvent: { ROTATE: "editor.rotate" },
    EditorScaleEvent: { BEFORE_SCALE: "editor.before-scale", SCALE: "editor.scale" },
    Group: LeaferShape,
    KeyEvent: { DOWN: "key.down", UP: "key.up" },
    Line: LeaferShape,
    Platform: {
      toURL: (source: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`,
    },
    PointerEvent: { TAP: "pointer.tap", DOWN: "pointer.down", DOUBLE_TAP: "pointer.double-tap", MENU: "pointer.menu", UP: "pointer.up" },
    PropertyEvent: { LEAFER_CHANGE: "property.leafer-change" },
    Text: LeaferShape,
    ZoomEvent: { START: "zoom.start", ZOOM: "zoom", END: "zoom.end" },
  };
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function historyInput(id: string, x: number, y: number): SaveMoodboardNodeInput {
  return {
    id,
    type: "note",
    x,
    y,
    width: 160,
    height: 120,
    rotation: 0,
    zIndex: 1,
    data: { content: id },
  };
}

test("MoodboardContextMenu clamps to the visible viewport after measuring itself", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 224,
    bottom: 280,
    width: 224,
    height: 280,
    toJSON: () => ({}),
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

  await act(async () => {
    render(
      <MoodboardContextMenu
        menu={{ x: 10_000, y: 10_000, canvasX: 240, canvasY: 260, targetId: null }}
        targetId={null}
        targetNode={null}
        onClose={() => {}}
        onAddNote={() => {}}
        onAddSection={() => {}}
        onGenerate={() => {}}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onFitView={() => {}}
        onResetZoom={() => {}}
      />,
    );
  });

  const menu = screen.getByRole("menu");
  expect(menu).toHaveStyle({ left: "268px", top: "112px" });
  expect(screen.getByText("View")).toBeInTheDocument();
  expect(screen.getByText("Fit view")).toBeInTheDocument();
  expect(screen.getByText("Shift 1")).toBeInTheDocument();
  expect(screen.getByText("Reset zoom")).toBeInTheDocument();
  expect(screen.getByText("Cmd 0")).toBeInTheDocument();
});

test("MoodboardCanvas review capabilities keep navigation but invoke no authoring callbacks", () => {
  const node: MoodboardNode = {
    id: "n-review",
    boardId: "b1",
    type: "note",
    x: 0,
    y: 0,
    width: 180,
    height: 120,
    rotation: 0,
    zIndex: 0,
    data: { content: "Read only" },
    createdAt: 1,
    updatedAt: 1,
  };
  const onSelectIds = vi.fn();
  const onNodesChange = vi.fn();
  const onAddNote = vi.fn();
  const onAddSection = vi.fn();
  const onAddImageGenerator = vi.fn();
  const onUploadFiles = vi.fn();
  const onGenerateImage = vi.fn().mockResolvedValue(undefined);
  const { container } = render(
    <MoodboardCanvas
      nodes={[node]}
      selectedIds={[node.id]}
      capabilities={MOODBOARD_REVIEW_CAPABILITIES}
      onSelectIds={onSelectIds}
      onNodesChange={onNodesChange}
      onAddNote={onAddNote}
      onAddSection={onAddSection}
      onAddImageGenerator={onAddImageGenerator}
      onUploadFiles={onUploadFiles}
      onGenerateImage={onGenerateImage}
    />,
  );

  fireEvent.keyDown(window, { key: "Delete" });
  fireEvent.keyDown(window, { key: "d", metaKey: true });
  const root = container.querySelector("[data-moodboard-canvas-root]")!;
  const dropAllowed = fireEvent.drop(root, {
    dataTransfer: { types: ["Files"], items: [], files: [new File(["x"], "reference.png", { type: "image/png" })] },
  });

  expect(onSelectIds).not.toHaveBeenCalled();
  expect(onNodesChange).not.toHaveBeenCalled();
  expect(onAddNote).not.toHaveBeenCalled();
  expect(onAddSection).not.toHaveBeenCalled();
  expect(onAddImageGenerator).not.toHaveBeenCalled();
  expect(onUploadFiles).not.toHaveBeenCalled();
  expect(dropAllowed).toBe(false);
  expect(onGenerateImage).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Image generator" })).toBeNull();
  expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Canvas zoom options" })).toBeInTheDocument();
  expect(container.querySelector('[style*="cursor: grab"]')).not.toBeNull();
});

test("MoodboardContextMenu clamps inside the canvas host bounds", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 120,
    width: 200,
    height: 120,
    toJSON: () => ({}),
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const boundary = document.createElement("div");
  boundary.getBoundingClientRect = () => ({
    x: 100,
    y: 80,
    left: 100,
    top: 80,
    right: 500,
    bottom: 360,
    width: 400,
    height: 280,
    toJSON: () => ({}),
  });

  await act(async () => {
    render(
      <MoodboardContextMenu
        menu={{ x: 490, y: 350, canvasX: 240, canvasY: 260, targetId: null }}
        targetId={null}
        targetNode={null}
        boundaryElement={boundary}
        onClose={() => {}}
        onAddNote={() => {}}
        onAddSection={() => {}}
        onGenerate={() => {}}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onFitView={() => {}}
        onResetZoom={() => {}}
      />,
    );
  });

  expect(screen.getByRole("menu")).toHaveStyle({ left: "290px", top: "230px" });
});

test("resolveAnchoredZoomTransform keeps the viewport anchor on the same canvas point", () => {
  const transform = resolveAnchoredZoomTransform({
    currentX: -200,
    currentY: -120,
    currentScale: 1,
    nextScale: 2,
    anchorX: 400,
    anchorY: 300,
  });

  expect(transform).toEqual({ scale: 2, x: -800, y: -540 });
  expect((400 - transform.x) / transform.scale).toBe(600);
  expect((300 - transform.y) / transform.scale).toBe(420);
});

test("buildLayerTree sorts sections by the same effective z-index used on canvas", () => {
  const section: MoodboardNode = {
    id: "section",
    boardId: "b",
    type: "section",
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    rotation: 0,
    zIndex: 99,
    data: {},
    createdAt: 1,
    updatedAt: 1,
  };
  const note: MoodboardNode = {
    ...section,
    id: "note",
    type: "note",
    x: 500,
    y: 0,
    width: 120,
    height: 80,
    zIndex: 0,
  };
  const child: MoodboardNode = {
    ...note,
    id: "child",
    x: 40,
    y: 40,
    zIndex: 10,
  };

  const tree = buildLayerTree([section, note, child]);

  expect(tree.map((item) => item.node.id)).toEqual(["note", "section"]);
  expect(tree[1]?.children.map((item) => item.node.id)).toEqual(["child"]);
});

test("MoodboardContextMenu starts clamped before the measurement frame", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

  render(
    <MoodboardContextMenu
      menu={{ x: 490, y: 390, canvasX: 240, canvasY: 260, targetId: null }}
      targetId={null}
      targetNode={null}
      onClose={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onGenerate={() => {}}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
      onFitView={() => {}}
      onResetZoom={() => {}}
    />,
  );

  expect(screen.getByRole("menu")).not.toHaveStyle({ left: "490px", top: "390px" });
});

test("MoodboardContextMenu measures before the animation frame so edge menus do not jump", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 224,
    bottom: 280,
    width: 224,
    height: 280,
    toJSON: () => ({}),
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

  render(
    <MoodboardContextMenu
      menu={{ x: 490, y: 390, canvasX: 240, canvasY: 260, targetId: null }}
      targetId={null}
      targetNode={null}
      onClose={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onGenerate={() => {}}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
      onFitView={() => {}}
      onResetZoom={() => {}}
    />,
  );

  expect(screen.getByRole("menu")).toHaveStyle({ left: "266px", top: "110px" });
});

test("MoodboardContextMenu separates selection actions from blank-canvas creation actions", () => {
  const onCopy = vi.fn();
  const onPaste = vi.fn();
  const onMoveForward = vi.fn();
  const onMoveBackward = vi.fn();
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "Direction note" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MoodboardContextMenu
      menu={{ x: 24, y: 32, canvasX: 240, canvasY: 260, targetId: node.id }}
      targetId={node.id}
      targetNode={node}
        onClose={() => {}}
        onAddNote={() => {}}
        onAddSection={() => {}}
        onGenerate={() => {}}
        onCopy={onCopy}
        onPaste={onPaste}
        onDuplicate={() => {}}
        onMoveForward={onMoveForward}
        onMoveBackward={onMoveBackward}
      onBringToFront={() => {}}
      onSendToBack={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onDelete={() => {}}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
      onFitView={() => {}}
      onResetZoom={() => {}}
    />,
  );

  expect(screen.getByText("Selection")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Copy"));
  fireEvent.click(screen.getByText("Paste"));
  expect(onCopy).toHaveBeenCalledOnce();
  expect(onPaste).toHaveBeenCalledOnce();
  expect(screen.getByText("Duplicate")).toBeInTheDocument();
  expect(screen.getByText("Cmd C")).toBeInTheDocument();
  expect(screen.getByText("Cmd V")).toBeInTheDocument();
  expect(screen.getByText("Cmd D")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Move forward"));
  fireEvent.click(screen.getByText("Move backward"));
  expect(onMoveForward).toHaveBeenCalledOnce();
  expect(onMoveBackward).toHaveBeenCalledOnce();
  expect(screen.getByText("Cmd ↑")).toBeInTheDocument();
  expect(screen.getByText("Cmd ↓")).toBeInTheDocument();
  expect(screen.getByText("]")).toBeInTheDocument();
  expect(screen.getByText("[")).toBeInTheDocument();
  expect(screen.getByText("Del")).toBeInTheDocument();
  expect(screen.queryByText("Add note here")).toBeNull();
  expect(screen.queryByText("Add image generator here")).toBeNull();
  expect(screen.getByText("View")).toBeInTheDocument();
});

test("MoodboardContextMenu exposes Set as cover for image nodes", () => {
  const onSetAsCover = vi.fn();
  const node: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { assetId: "asset-1", url: "/asset.png" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MoodboardContextMenu
      menu={{ x: 24, y: 32, canvasX: 240, canvasY: 260, targetId: node.id }}
      targetId={node.id}
      targetNode={node}
      onClose={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onGenerate={() => {}}
      onSetAsCover={onSetAsCover}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Set as cover" }));
  expect(onSetAsCover).toHaveBeenCalledOnce();
  expect(screen.queryByText("Add note here")).toBeNull();
});

test("MoodboardContextMenu exposes paste on the blank canvas menu", () => {
  const onPaste = vi.fn();
  render(
    <MoodboardContextMenu
      menu={{ x: 24, y: 32, canvasX: 240, canvasY: 260, targetId: null }}
      targetId={null}
      targetNode={null}
      onClose={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onGenerate={() => {}}
      onPaste={onPaste}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
      onFitView={() => {}}
      onResetZoom={() => {}}
    />,
  );

  fireEvent.click(screen.getByText("Paste"));
  expect(onPaste).toHaveBeenCalledOnce();
  expect(screen.getByText("Add note here")).toBeInTheDocument();
});

test("resolveCanvasFitTransform centers nodes inside visible canvas chrome", () => {
  const next = resolveCanvasFitTransform({
    containerWidth: 1000,
    containerHeight: 800,
    contentRect: rectFromBounds(100, 120, 300, 280),
    occluders: [rectFromBounds(720, 0, 1000, 800), rectFromBounds(0, 740, 1000, 800)],
    padding: 100,
    maxScale: 2,
  });

  expect(next).toEqual({ scale: 2, x: -40, y: -30 });
});

test("collectFloatingOccluderRects reads sibling panels relative to the canvas host", () => {
  const root = document.createElement("div");
  const host = document.createElement("div");
  const panel = document.createElement("aside");
  panel.setAttribute("data-moodboard-floating-occluder", "");
  root.append(host, panel);
  host.getBoundingClientRect = () => ({
    x: 100,
    y: 40,
    left: 100,
    top: 40,
    right: 1100,
    bottom: 840,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  });
  panel.getBoundingClientRect = () => ({
    x: 820,
    y: 40,
    left: 820,
    top: 40,
    right: 1100,
    bottom: 840,
    width: 280,
    height: 800,
    toJSON: () => ({}),
  });

  expect(collectFloatingOccluderRects(host, root)).toEqual([rectFromBounds(720, 0, 1000, 800)]);
});

test("eventClientPoint reads Leafer native event origins for context menus", () => {
  expect(eventClientPoint({ origin: { clientX: 260, clientY: 144 }, clientX: 0, clientY: 0 })).toEqual({ x: 260, y: 144 });
});

test("eventClientPoint maps canvas page points to viewport coordinates when native client points are missing", () => {
  expect(
    eventClientPoint(
      {
        getPagePoint: () => ({ x: 100, y: 50 }),
        x: 100,
        y: 50,
      },
      { containerLeft: 10, containerTop: 20, tree: { x: 5, y: 7, scaleX: 2, scaleY: 3 } },
    ),
  ).toEqual({ x: 215, y: 177 });
});

test("clientPointToCanvasPoint maps host pointer coordinates into canvas space", () => {
  expect(
    clientPointToCanvasPoint({
      clientX: 250,
      clientY: 180,
      containerLeft: 100,
      containerTop: 80,
      tree: { x: 10, y: 20, scaleX: 2, scaleY: 4 },
    }),
  ).toEqual({ x: 70, y: 20 });
});

test("nodeIdFromTarget reads reconciler node ids from parent data", () => {
  expect(nodeIdFromTarget({ data: { id: "n1" } })).toBe("n1");
  expect(nodeIdFromTarget({ parent: { data: { nodeId: "n2" } } })).toBe("n2");
});

test("nodeIdFromTarget reads selected nodes from editor resize handles", () => {
  const editorTarget = { data: { nodeId: "img1" } };
  const resizeHandle = { pointType: "resize", editor: { target: editorTarget }, parent: null };

  expect(nodeIdFromTarget(resizeHandle)).toBe("img1");
});

test("nodeIdsFromTarget reads multi-selection editor targets in order", () => {
  expect(nodeIdsFromTarget([{ data: { nodeId: "a" } }, { parent: { data: { nodeId: "b" } } }, { data: { nodeId: "a" } }])).toEqual(["a", "b"]);
});

test("contextTargetIdFromEvent only uses the right-clicked target", () => {
  expect(contextTargetIdFromEvent(null, { data: { nodeId: "selected-node" } })).toBeNull();
  expect(contextTargetIdFromEvent({ parent: { data: { nodeId: "event-node" } } }, { data: { nodeId: "selected-node" } })).toBe("event-node");
});

test("resolveFloatingRect follows world bounds and clamps within the canvas", () => {
  expect(
    resolveFloatingRect({
      containerWidth: 500,
      containerHeight: 320,
      containerLeft: 40,
      containerTop: 20,
      frame: { x: 0, y: 0, width: 200, height: 120 },
      world: { x: 460, y: 280, width: 200, height: 120 },
    }),
  ).toEqual({ left: 484, top: 252, bottom: 188, targetLeft: 420, targetRight: 500 });
});

test("resolveFloatingRect accepts Leafer-local world bounds without subtracting the host offset", () => {
  expect(
    resolveFloatingRect({
      containerWidth: 800,
      containerHeight: 500,
      containerLeft: 400,
      containerTop: 80,
      frame: { x: 100, y: 90, width: 200, height: 120 },
      tree: { x: 0, y: 0, scaleX: 1 },
      world: { x: 100, y: 90, width: 200, height: 120 },
    }),
  ).toEqual({ left: 200, top: 82, bottom: 222, targetLeft: 100, targetRight: 300 });
});

test("resolveFloatingRect follows live tree transforms over stale world bounds", () => {
  expect(
    resolveFloatingRect({
      containerWidth: 800,
      containerHeight: 600,
      containerLeft: 400,
      containerTop: 80,
      frame: { x: 100, y: 90, width: 200, height: 120 },
      tree: { x: 10, y: 20, scaleX: 2 },
      world: { x: 100, y: 90, width: 200, height: 120 },
    }),
  ).toEqual({ left: 410, top: 192, bottom: 452, targetLeft: 210, targetRight: 610 });
});

test("resolveFloatingRect keeps the selected target bounds for side toolbar placement", () => {
  expect(
    resolveFloatingRect({
      containerWidth: 800,
      containerHeight: 600,
      containerLeft: 0,
      containerTop: 0,
      frame: { x: 100, y: 90, width: 200, height: 120 },
      tree: { x: 10, y: 20, scaleX: 2 },
    }),
  ).toMatchObject({ left: 410, targetLeft: 210, targetRight: 610 });
});

test("generatorModel reads the image model stored on a generator node", () => {
  const node: MoodboardNode = {
    id: "gen1",
    boardId: "b1",
    type: "image-generator",
    x: 100,
    y: 90,
    width: 240,
    height: 160,
    rotation: 0,
    zIndex: 0,
    data: { generatorModel: "gpt-image-1" },
    createdAt: 1,
    updatedAt: 1,
  };

  expect(generatorModel(node)).toBe("gpt-image-1");
  expect(generatorModel({ ...node, data: {} })).toBe("");
});

test("Moodboard history snapshots drive undo and redo without losing selection", () => {
  const original = historyInput("n1", 100, 120);
  const moved = { ...original, x: 180, y: 220 };
  const initialSnapshot = createMoodboardHistorySnapshot([original], ["n1"]);
  const movedSnapshot = createMoodboardHistorySnapshot([moved], ["n1"]);
  const state = pushMoodboardUndo({ undoStack: [], redoStack: [] }, initialSnapshot);

  const undo = undoMoodboardHistory(state, movedSnapshot);
  expect(undo.snapshot).toEqual(initialSnapshot);
  expect(undo.state.undoStack).toHaveLength(0);
  expect(undo.state.redoStack).toEqual([movedSnapshot]);

  const redo = redoMoodboardHistory(undo.state, initialSnapshot);
  expect(redo.snapshot).toEqual(movedSnapshot);
  expect(redo.state.undoStack).toEqual([initialSnapshot]);
  expect(redo.state.redoStack).toHaveLength(0);
});

test("Moodboard history ignores duplicate snapshots and invalid selected ids", () => {
  const node = historyInput("n1", 100, 120);
  const snapshot = createMoodboardHistorySnapshot([node], ["missing", "n1", "n1"]);
  const state = pushMoodboardUndo(pushMoodboardUndo({ undoStack: [], redoStack: [] }, snapshot), snapshot);

  expect(snapshot.selectedIds).toEqual(["n1"]);
  expect(state.undoStack).toHaveLength(1);
  expect(uniqueExistingIds(["a", "b", "a"], ["a"])).toEqual(["a"]);
});

test("resolveFloatingChromeRect keeps measured toolbars inside the canvas", () => {
  expect(
    resolveFloatingChromeRect({
      anchor: { left: 12, top: 6, bottom: 290 },
      containerWidth: 320,
      containerHeight: 300,
      surfaceWidth: 180,
      surfaceHeight: 36,
      placement: "top",
    }),
  ).toEqual({ left: 12, top: 130 });

  expect(
    resolveFloatingChromeRect({
      anchor: { left: 310, top: 20, bottom: 284 },
      containerWidth: 320,
      containerHeight: 300,
      surfaceWidth: 180,
      surfaceHeight: 36,
      placement: "bottom",
    }),
  ).toEqual({ left: 130, top: 134 });
});

test("resolveFloatingChromeRect avoids floating canvas panels", () => {
  const safe = getFloatingChromeSafeRect(rectFromBounds(0, 0, 900, 600), [
    rectFromBounds(12, 12, 252, 540),
    rectFromBounds(608, 12, 888, 540),
    rectFromBounds(330, 548, 570, 588),
  ]);

  expect(safe).toEqual({ left: 260, top: 8, right: 600, bottom: 540, width: 340, height: 532 });
  expect(
    resolveFloatingChromeRect({
      anchor: { left: 80, top: 60, bottom: 220 },
      containerWidth: 900,
      containerHeight: 600,
      surfaceWidth: 180,
      surfaceHeight: 36,
      placement: "top",
      occluders: [
        rectFromBounds(12, 12, 252, 540),
        rectFromBounds(608, 12, 888, 540),
        rectFromBounds(330, 548, 570, 588),
      ],
    }),
  ).toEqual({ left: 260, top: 24 });
});

test("resolveFloatingChromeRect falls back to a side placement when vertical space is blocked", () => {
  expect(
    resolveFloatingChromeRect({
      anchor: { left: 100, targetLeft: 90, targetRight: 110, top: 48, bottom: 72 },
      containerWidth: 220,
      containerHeight: 120,
      surfaceWidth: 80,
      surfaceHeight: 100,
      placement: "top",
      padding: 8,
    }),
  ).toEqual({ left: 110, top: 10 });
});

test("resolveFloatingChromeRect can disable side placement for selection toolbars", () => {
  expect(
    resolveFloatingChromeRect({
      anchor: { left: 100, targetLeft: 90, targetRight: 110, top: 48, bottom: 72 },
      containerWidth: 220,
      containerHeight: 120,
      surfaceWidth: 80,
      surfaceHeight: 100,
      placement: "top",
      padding: 8,
      allowSidePlacement: false,
    }),
  ).toEqual({ left: 60, top: 8 });
});

test("normalizeCanvasRect turns drag endpoints into a positive drawing rect", () => {
  expect(normalizeCanvasRect({ x: 320, y: 220 }, { x: 120, y: 90 })).toEqual({ x: 120, y: 90, width: 200, height: 130 });
});

test("Moodboard snap geometry resolves the nearest axis delta for moodboard nodes", () => {
  const candidates = createSnapPointsFromBounds({ x: 100, y: 80, width: 160, height: 120 }, "candidate");
  const target = createSnapPointsFromBounds({ x: 263, y: 230, width: 80, height: 60 }, "target");

  expect(resolveSnapDeltas({ targetPoints: target, snapLines: createSnapLines(candidates), threshold: 6 }).x?.delta).toBe(-3);
});

test("Moodboard editor selection adapter maps node ids onto the Leafer editor target", () => {
  const nodes = new Map([
    ["a", { id: "a" }],
    ["b", { id: "b" }],
  ]);
  const app = {
    editor: { target: undefined as unknown },
    findId: (id: string) => nodes.get(id),
  };

  selectAppNodesByIds(app as any, ["a"]);
  expect(app.editor.target).toBe(nodes.get("a"));

  selectAppNodesByIds(app as any, ["a", "b"]);
  expect(app.editor.target).toEqual([nodes.get("a"), nodes.get("b")]);

  selectAppNodesByIds(app as any, []);
  expect(app.editor.target).toBeUndefined();
});

test("Moodboard editor selection adapter prefers editor.select when Leafer exposes it", () => {
  const nodes = new Map([
    ["a", { id: "a" }],
    ["b", { id: "b" }],
  ]);
  const select = vi.fn();
  const app = {
    editor: { select, target: undefined as unknown },
    findId: (id: string) => nodes.get(id),
  };

  selectAppNodesByIds(app as any, ["a", "b"]);
  expect(select).toHaveBeenCalledWith([nodes.get("a"), nodes.get("b")]);
  expect(app.editor.target).toEqual([nodes.get("a"), nodes.get("b")]);

  selectAppNodesByIds(app as any, []);
  expect(select).toHaveBeenCalledWith([]);
  expect(app.editor.target).toBeUndefined();
});

test("sameFloatingRect ignores subpixel jitter during drag", () => {
  expect(sameFloatingRect({ left: 120, top: 80, bottom: 220 }, { left: 120.25, top: 80.2, bottom: 220.4 })).toBe(true);
  expect(sameFloatingRect({ left: 120, top: 80, bottom: 220 }, { left: 121, top: 80, bottom: 220 })).toBe(false);
  expect(
    sameFloatingRect(
      { left: 120, top: 80, bottom: 220, targetLeft: 72, targetRight: 168 },
      { left: 120, top: 80, bottom: 220, targetLeft: 88, targetRight: 152 },
    ),
  ).toBe(false);
});

test("sameIdList treats identical selection ids as stable", () => {
  expect(sameIdList(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameIdList(["a", "b"], ["b", "a"])).toBe(false);
  expect(sameIdList(["a"], ["a", "b"])).toBe(false);
});

test("allMoodboardNodeIds preserves canvas order for select all", () => {
  expect(allMoodboardNodeIds([{ id: "first" }, { id: "second" }, { id: "third" }])).toEqual(["first", "second", "third"]);
});

test("Moodboard Leafer editor keeps the selection chrome visible while dragging", () => {
  expect(MOODBOARD_LEAFER_EDITOR_CONFIG.hideOnMove).toBe(false);
  expect(MOODBOARD_LEAFER_EDITOR_CONFIG.skewable).toBe(false);
  expect(MOODBOARD_LEAFER_EDITOR_CONFIG.flipable).toBe(false);
});

test("canvas shortcuts ignore editable targets", () => {
  const input = document.createElement("input");
  const select = document.createElement("select");
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  const nestedTextbox = document.createElement("span");
  const textbox = document.createElement("div");
  textbox.setAttribute("role", "textbox");
  textbox.append(nestedTextbox);

  expect(isEditableShortcutTarget(input)).toBe(true);
  expect(isEditableShortcutTarget(select)).toBe(true);
  expect(isEditableShortcutTarget(editable)).toBe(true);
  expect(isEditableShortcutTarget(nestedTextbox)).toBe(true);
  expect(isEditableShortcutTarget(document.createElement("button"))).toBe(false);
});

test("temporary hand shortcut only uses bare space", () => {
  expect(isTemporaryHandShortcut({ key: " ", metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
  expect(isTemporaryHandShortcut({ key: "Space", metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  expect(isTemporaryHandShortcut({ key: " ", metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
  expect(isTemporaryHandShortcut({ key: " ", metaKey: false, ctrlKey: true, altKey: false })).toBe(false);
  expect(isTemporaryHandShortcut({ key: " ", metaKey: false, ctrlKey: false, altKey: true })).toBe(false);
});

test("reset zoom shortcut accepts zero and editor-style nine variants", () => {
  expect(isResetZoomShortcut({ key: "0", metaKey: true, ctrlKey: false })).toBe(true);
  expect(isResetZoomShortcut({ key: "9", metaKey: false, ctrlKey: true })).toBe(true);
  expect(isResetZoomShortcut({ key: "1", metaKey: true, ctrlKey: false })).toBe(false);
  expect(isResetZoomShortcut({ key: "9", metaKey: false, ctrlKey: false })).toBe(false);
});

test("createSectionNode keeps dragged section dimensions", () => {
  expect(createSectionNode(4, { x: 120, y: 90, width: 260, height: 180 })).toMatchObject({
    type: "section",
    x: 120,
    y: 90,
    width: 260,
    height: 180,
    zIndex: -1,
  });
});

test("MoodboardCanvasNode keeps section labels out of the Leafer node body", () => {
  const section: MoodboardNode = {
    id: "section-1",
    boardId: "b1",
    type: "section",
    x: 120,
    y: 140,
    width: 320,
    height: 160,
    rotation: 0,
    zIndex: -1,
    data: { title: "Direction" },
    createdAt: 1,
    updatedAt: 1,
  };

  const { container } = render(<MoodboardCanvasNode node={section} />);

  expect(container.querySelector('text[text="Direction"]')).toBeNull();
  expect(container.querySelector("rect")).toHaveAttribute("hittable", "false");
});

test("MoodboardCanvasNode renders node bodies with square corners", () => {
  const base = {
    boardId: "b1",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const nodes: MoodboardNode[] = [
    { ...base, id: "image-1", type: "image", data: { url: "/asset.png", assetId: "asset-1" } },
    { ...base, id: "generator-1", type: "image-generator", data: { generatorPrompt: "soft light" } },
    { ...base, id: "video-1", type: "video", data: {} },
    { ...base, id: "note-1", type: "note", data: { text: "Note" } },
    { ...base, id: "section-1", type: "section", zIndex: -1, data: { title: "Direction" } },
  ];

  const { container } = render(
    <>
      {nodes.map((node) => (
        <MoodboardCanvasNode key={node.id} node={node} />
      ))}
    </>,
  );

  expect(container.querySelectorAll("[cornerradius], [cornerRadius]")).toHaveLength(0);
});

test("MoodboardCanvasNode keeps generated image prompts out of the canvas node body", () => {
  const image: MoodboardNode = {
    id: "image-1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 320,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { url: "/asset.png", assetId: "asset-1", prompt: "warm editorial lamp" },
    createdAt: 1,
    updatedAt: 1,
  };

  const { container } = render(<MoodboardCanvasNode node={image} />);

  expect(container.querySelector('text[text="warm editorial lamp"]')).toBeNull();
  expect(container.querySelectorAll("rect")).toHaveLength(1);
});

test("MoodboardCanvasNode renders image generators without a dashed border and with the mountain image icon", () => {
  const generator: MoodboardNode = {
    id: "generator-1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 320,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light" },
    createdAt: 1,
    updatedAt: 1,
  };

  const { container } = render(<MoodboardCanvasNode node={generator} />);

  expect(container.querySelectorAll("[dashpattern], [dashPattern]")).toHaveLength(0);
  expect(container.querySelectorAll("rect")).toHaveLength(1);
  const icon = container.querySelector("image");
  expect(icon).toHaveAttribute("url", expect.stringContaining("IconImageMountainFill18"));
  expect(icon).toHaveAttribute("width", "36");
  expect(icon).toHaveAttribute("height", "36");
});

test("MoodboardCanvasNode renders a loading sweep while an image generator is generating", () => {
  const generator: MoodboardNode = {
    id: "generator-1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 320,
    height: 180,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generatorStatus: "generating" },
    createdAt: 1,
    updatedAt: 1,
  };

  const { container } = render(<MoodboardCanvasNode node={generator} />);

  expect(container.querySelectorAll('rect[data-loading-sweep="true"]')).toHaveLength(3);
});

test("MoodboardSectionLabels lets section titles be edited outside the canvas node", () => {
  const onRename = vi.fn();
  const onSelect = vi.fn();
  const section: MoodboardNode = {
    id: "section-1",
    boardId: "b1",
    type: "section",
    x: 120,
    y: 140,
    width: 320,
    height: 160,
    rotation: 0,
    zIndex: -1,
    data: { title: "Direction" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MoodboardSectionLabels
      nodes={[section]}
      appRef={{ current: { findId: () => ({ x: 120, y: 140 }) } }}
      onRename={onRename}
      onSelect={onSelect}
    />,
  );

  fireEvent.click(screen.getByText("Direction"));
  expect(onSelect).toHaveBeenCalledWith("section-1");
  fireEvent.doubleClick(screen.getByText("Direction"));
  fireEvent.change(screen.getByDisplayValue("Direction"), { target: { value: "Edited direction" } });
  fireEvent.blur(screen.getByDisplayValue("Edited direction"));
  expect(onRename).toHaveBeenCalledWith("section-1", "Edited direction");
});

test("MoodboardSectionLabels renders below canvas toolbars", () => {
  const section: MoodboardNode = {
    id: "section-1",
    boardId: "b1",
    type: "section",
    x: 120,
    y: 140,
    width: 320,
    height: 160,
    rotation: 0,
    zIndex: -1,
    data: { title: "Direction" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MoodboardSectionLabels
      nodes={[section]}
      appRef={{ current: { findId: () => ({ x: 120, y: 140 }) } }}
      onRename={() => {}}
      onSelect={() => {}}
    />,
  );

  const labelLayer = screen.getByText("Direction").parentElement;
  expect(labelLayer).toHaveClass("z-10");
  expect(labelLayer).not.toHaveClass("z-20");
});

test("moodboard scrollbars stay one pixel from the canvas edge", () => {
  expect(MOODBOARD_SCROLLBAR_PADDING).toBe(1);
});

test("mergeDraftMoodboardNodes overlays live geometry without mutating persisted nodes", () => {
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 320,
    height: 240,
    rotation: 0,
    zIndex: 2,
    data: { fileName: "reference.png" },
    createdAt: 1,
    updatedAt: 2,
  };

  const merged = mergeDraftMoodboardNodes([node], [
    {
      id: "n1",
      type: "image",
      x: 188,
      y: 212,
      width: 360,
      height: 260,
      rotation: 4,
      zIndex: 2,
      data: { fileName: "reference.png" },
    },
  ]);

  expect(merged[0]).toMatchObject({ x: 188, y: 212, width: 360, height: 260, rotation: 4, updatedAt: 2 });
  expect(merged[0]?.data).toEqual(node.data);
  expect(node).toMatchObject({ x: 120, y: 140, width: 320, height: 240, rotation: 0 });
});

test("MoodboardPropertiesPanel can be resized from its left edge", () => {
  localStorage.removeItem("dezin:moodboard:properties-width");
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generatorStatus: "ready" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(<MoodboardPropertiesPanel node={node} onPatch={() => {}} onPatchData={() => {}} onGenerate={() => {}} />);
  const separator = screen.getByLabelText("Resize properties panel");
  fireEvent.mouseDown(separator, { clientX: 400 });
  fireEvent.mouseMove(document, { clientX: 320 });
  fireEvent.mouseUp(document);

  expect(separator.closest("aside")).toHaveStyle({ width: "360px" });
  expect(localStorage.getItem("dezin:moodboard:properties-width")).toBe("360");
});

test("MoodboardLayerPanel selects rows without letting inline actions bubble", () => {
  const onSelect = vi.fn();
  const onToggleVisible = vi.fn();
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "Direction note" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MoodboardLayerPanel
      items={[{ node, children: [] }]}
      selectedId={null}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelect={onSelect}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={onToggleVisible}
      onToggleLocked={() => {}}
      onReorder={() => {}}
    />,
  );

  fireEvent.click(screen.getByText("Direction note"));
  expect(onSelect).toHaveBeenCalledWith("n1");

  onSelect.mockClear();
  fireEvent.click(screen.getByLabelText("Hide layer"));
  expect(onToggleVisible).toHaveBeenCalledWith("n1");
  expect(onSelect).not.toHaveBeenCalled();
});

test("MoodboardLayerPanel exposes selected layer duplicate and delete actions", () => {
  const onSelectIds = vi.fn();
  const onDuplicateSelected = vi.fn();
  const onDeleteSelected = vi.fn();
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "Direction note" },
    createdAt: 1,
    updatedAt: 1,
  };
  const { rerender } = render(
    <MoodboardLayerPanel
      items={[{ node, children: [] }]}
      selectedIds={[]}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelectIds={onSelectIds}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onReorder={() => {}}
      onDuplicateSelected={onDuplicateSelected}
      onDeleteSelected={onDeleteSelected}
    />,
  );

  expect(screen.queryByLabelText("Duplicate selected layers")).toBeNull();
  expect(screen.queryByLabelText("Delete selected layers")).toBeNull();

  rerender(
    <MoodboardLayerPanel
      items={[{ node, children: [] }]}
      selectedIds={["n1"]}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelectIds={onSelectIds}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onReorder={() => {}}
      onDuplicateSelected={onDuplicateSelected}
      onDeleteSelected={onDeleteSelected}
    />,
  );

  fireEvent.click(screen.getByLabelText("Duplicate selected layers"));
  fireEvent.click(screen.getByLabelText("Delete selected layers"));

  expect(onDuplicateSelected).toHaveBeenCalledWith(["n1"]);
  expect(onDeleteSelected).toHaveBeenCalledWith(["n1"]);
  expect(onSelectIds).not.toHaveBeenCalled();
});

test("MoodboardLayerPanel supports command toggle and shift range selection", () => {
  const onSelectIds = vi.fn();
  const first: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 3,
    data: { content: "First" },
    createdAt: 1,
    updatedAt: 1,
  };
  const second: MoodboardNode = { ...first, id: "n2", zIndex: 2, data: { content: "Second" } };
  const third: MoodboardNode = { ...first, id: "n3", zIndex: 1, data: { content: "Third" } };
  const { rerender } = render(
    <MoodboardLayerPanel
      items={[
        { node: first, children: [] },
        { node: second, children: [] },
        { node: third, children: [] },
      ]}
      selectedIds={["n1"]}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelectIds={onSelectIds}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onReorder={() => {}}
    />,
  );

  fireEvent.click(screen.getByText("Second"), { metaKey: true });
  expect(onSelectIds).toHaveBeenLastCalledWith(["n1", "n2"]);

  rerender(
    <MoodboardLayerPanel
      items={[
        { node: first, children: [] },
        { node: second, children: [] },
        { node: third, children: [] },
      ]}
      selectedIds={["n1"]}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelectIds={onSelectIds}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onReorder={() => {}}
    />,
  );

  fireEvent.click(screen.getByText("Third"), { shiftKey: true });
  expect(onSelectIds).toHaveBeenLastCalledWith(["n1", "n2", "n3"]);
});

test("MoodboardLayerPanel marks adjacent selected rows as one grouped selection", () => {
  const first: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 3,
    data: { content: "First" },
    createdAt: 1,
    updatedAt: 1,
  };
  const second: MoodboardNode = { ...first, id: "n2", zIndex: 2, data: { content: "Second" } };
  const third: MoodboardNode = { ...first, id: "n3", zIndex: 1, data: { content: "Third" } };

  render(
    <MoodboardLayerPanel
      items={[
        { node: first, children: [] },
        { node: second, children: [] },
        { node: third, children: [] },
      ]}
      selectedIds={["n1", "n2"]}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelectIds={() => {}}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onReorder={() => {}}
    />,
  );

  expect(screen.getByText("First").closest("[data-moodboard-layer-id]")).toHaveAttribute("data-selected-next", "true");
  expect(screen.getByText("Second").closest("[data-moodboard-layer-id]")).toHaveAttribute("data-selected-previous", "true");
  expect(screen.getByText("Third").closest("[data-moodboard-layer-id]")).not.toHaveAttribute("data-selected-previous");
});

test("MoodboardLayerPanel supports drag reordering rows", () => {
  const onReorder = vi.fn();
  const first: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 2,
    data: { content: "First" },
    createdAt: 1,
    updatedAt: 1,
  };
  const second: MoodboardNode = { ...first, id: "n2", zIndex: 1, data: { content: "Second" } };
  const dataTransfer = {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: vi.fn(),
  };

  render(
    <MoodboardLayerPanel
      items={[
        { node: first, children: [] },
        { node: second, children: [] },
      ]}
      selectedId={null}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelect={() => {}}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onReorder={onReorder}
    />,
  );

  fireEvent.dragStart(screen.getByText("First").closest("[data-moodboard-layer-id]")!, { dataTransfer });
  fireEvent.dragOver(screen.getByText("Second").closest("[data-moodboard-layer-id]")!, { dataTransfer });
  fireEvent.drop(screen.getByText("Second").closest("[data-moodboard-layer-id]")!, { dataTransfer });

  expect(onReorder).toHaveBeenCalledWith("n1", "n2");
});

test("MoodboardLayerPanel shows actual image thumbnails when a node has media", () => {
  const node: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 40,
    y: 50,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { fileName: "Reference", url: "dezin://assets/reference.png" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MoodboardLayerPanel
      items={[{ node, children: [] }]}
      selectedId={null}
      collapsedIds={new Set()}
      onToggleCollapsed={() => {}}
      onSelect={() => {}}
      onHover={() => {}}
      onRename={() => {}}
      onToggleVisible={() => {}}
      onToggleLocked={() => {}}
      onReorder={() => {}}
    />,
  );

  expect(screen.getByTestId("moodboard-layer-thumbnail-img1").querySelector("img")).toHaveAttribute("src", "dezin://assets/reference.png");
});

test("reorderLayerInputs normalizes z-index after a layer drop", () => {
  const a: MoodboardNode = {
    id: "a",
    boardId: "b1",
    type: "note",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 3,
    data: { content: "A" },
    createdAt: 1,
    updatedAt: 1,
  };
  const b: MoodboardNode = { ...a, id: "b", zIndex: 2, data: { content: "B" } };
  const c: MoodboardNode = { ...a, id: "c", zIndex: 1, data: { content: "C" } };

  expect(reorderLayerInputs([a, b, c], "c", "a").map((node) => `${node.id}:${node.zIndex}`)).toEqual(["c:3", "a:2", "b:1"]);
});

test("moveContainedNodesWithSections moves geometrically contained nodes with a dragged section", () => {
  const section: MoodboardNode = {
    id: "s1",
    boardId: "b1",
    type: "section",
    x: 0,
    y: 0,
    width: 300,
    height: 220,
    rotation: 0,
    zIndex: 0,
    data: { title: "Group" },
    createdAt: 1,
    updatedAt: 1,
  };
  const inside: MoodboardNode = {
    ...section,
    id: "n1",
    type: "note",
    x: 80,
    y: 70,
    width: 80,
    height: 60,
    zIndex: 1,
    data: { content: "Inside" },
  };
  const outside: MoodboardNode = {
    ...inside,
    id: "n2",
    x: 420,
    data: { content: "Outside" },
  };

  const result = moveContainedNodesWithSections([section, inside, outside], [
    { id: "s1", type: "section", x: 40, y: 30, width: 300, height: 220, rotation: 0, zIndex: 0, data: { title: "Group" } },
    { id: "n1", type: "note", x: 80, y: 70, width: 80, height: 60, rotation: 0, zIndex: 1, data: { content: "Inside" } },
    { id: "n2", type: "note", x: 420, y: 70, width: 80, height: 60, rotation: 0, zIndex: 2, data: { content: "Outside" } },
  ]);

  expect(result.find((node) => node.id === "n1")).toMatchObject({ x: 120, y: 100 });
  expect(result.find((node) => node.id === "n2")).toMatchObject({ x: 420, y: 70 });
});

test("containedNodeIdsForSection returns only nodes centered inside the section", () => {
  const section: MoodboardNode = {
    id: "section",
    boardId: "b1",
    type: "section",
    x: 100,
    y: 100,
    width: 320,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { title: "Group" },
    createdAt: 1,
    updatedAt: 1,
  };
  const inside: MoodboardNode = {
    ...section,
    id: "inside",
    type: "image",
    x: 140,
    y: 160,
    width: 80,
    height: 80,
    data: { url: "dezin://asset.png" },
  };
  const outside: MoodboardNode = {
    ...inside,
    id: "outside",
    x: 12,
    y: 12,
  };

  expect(containedNodeIdsForSection([section, inside, outside], "section")).toEqual(["inside"]);
});

test("moveContainedNodesWithSections does not double-move independently dragged children", () => {
  const section: MoodboardNode = {
    id: "s1",
    boardId: "b1",
    type: "section",
    x: 0,
    y: 0,
    width: 300,
    height: 220,
    rotation: 0,
    zIndex: 0,
    data: { title: "Group" },
    createdAt: 1,
    updatedAt: 1,
  };
  const inside: MoodboardNode = {
    ...section,
    id: "n1",
    type: "note",
    x: 80,
    y: 70,
    width: 80,
    height: 60,
    zIndex: 1,
    data: { content: "Inside" },
  };

  const result = moveContainedNodesWithSections([section, inside], [
    { id: "s1", type: "section", x: 40, y: 30, width: 300, height: 220, rotation: 0, zIndex: 0, data: { title: "Group" } },
    { id: "n1", type: "note", x: 90, y: 75, width: 80, height: 60, rotation: 0, zIndex: 1, data: { content: "Inside" } },
  ]);

  expect(result.find((node) => node.id === "n1")).toMatchObject({ x: 90, y: 75 });
});

test("nudgeNodeInputs moves selected nodes and carries section children", () => {
  const section: MoodboardNode = {
    id: "s1",
    boardId: "b1",
    type: "section",
    x: 40,
    y: 40,
    width: 300,
    height: 220,
    rotation: 0,
    zIndex: 0,
    data: { title: "Group" },
    createdAt: 1,
    updatedAt: 1,
  };
  const inside: MoodboardNode = {
    ...section,
    id: "n1",
    type: "note",
    x: 80,
    y: 70,
    width: 80,
    height: 60,
    zIndex: 1,
    data: { content: "Inside" },
  };
  const outside: MoodboardNode = {
    ...inside,
    id: "n2",
    x: 420,
    data: { content: "Outside" },
  };

  const result = nudgeNodeInputs([section, inside, outside], ["s1"], { x: 10, y: -5 });

  expect(result.find((node) => node.id === "s1")).toMatchObject({ x: 50, y: 35 });
  expect(result.find((node) => node.id === "n1")).toMatchObject({ x: 90, y: 65 });
  expect(result.find((node) => node.id === "n2")).toMatchObject({ x: 420, y: 70 });
});

test("MoodboardPropertiesPanel edits node appearance data", () => {
  const onPatchData = vi.fn();
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "Reference tone" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(<MoodboardPropertiesPanel node={node} onPatch={() => {}} onPatchData={onPatchData} onGenerate={() => {}} />);
  fireEvent.change(screen.getByDisplayValue("#fff8c7"), { target: { value: "#ffeeaa" } });

  expect(onPatchData).toHaveBeenCalledWith({ fill: "#ffeeaa" });
});

test("MoodboardPropertiesPanel exposes object identity and state controls", () => {
  const onPatchData = vi.fn();
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 4,
    data: { content: "Reference tone", name: "Mood note" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(<MoodboardPropertiesPanel node={node} onPatch={() => {}} onPatchData={onPatchData} onGenerate={() => {}} />);

  expect(screen.getByText("Mood note")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Layer name"), { target: { value: "Material cue" } });
  fireEvent.click(screen.getByText("Visible"));
  fireEvent.click(screen.getByText("Unlocked"));

  expect(onPatchData).toHaveBeenCalledWith({ name: "Material cue" });
  expect(onPatchData).toHaveBeenCalledWith({ visible: false });
  expect(onPatchData).toHaveBeenCalledWith({ locked: true });
});

test("MoodboardPropertiesPanel pins image actions at the bottom and reuses generated prompts", () => {
  const onEditImage = vi.fn();
  const onUsePrompt = vi.fn();
  const node: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 4,
    data: {
      assetId: "asset-1",
      url: "dezin://assets/generated.png",
      prompt: "warm editorial lamp",
      model: "gpt-image-2",
      source: "generated",
      generationParams: { quality: "medium", aspectRatio: "16:9", size: "1536x1024" },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MoodboardPropertiesPanel
      node={node}
      onPatch={() => {}}
      onPatchData={() => {}}
      onGenerate={() => {}}
      onEditImage={onEditImage}
      onUsePrompt={onUsePrompt}
    />,
  );

  expect(screen.getByTestId("moodboard-properties-panel")).toHaveClass("bottom-4");
  expect(screen.getByTestId("moodboard-properties-actions")).toHaveClass("sticky");
  expect(screen.getByRole("button", { name: "Edit image" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reuse Prompt" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  fireEvent.click(screen.getByRole("button", { name: "Reuse Prompt" }));

  expect(onEditImage).toHaveBeenCalledOnce();
  expect(onUsePrompt).toHaveBeenCalledOnce();
});

test("MoodboardPropertiesPanel only shows edit action for ordinary images", () => {
  const node: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 4,
    data: { assetId: "asset-1", url: "dezin://assets/upload.png", source: "upload" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(<MoodboardPropertiesPanel node={node} onPatch={() => {}} onPatchData={() => {}} onGenerate={() => {}} onEditImage={() => {}} />);

  expect(screen.getByRole("button", { name: "Edit image" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use Prompt" })).toBeNull();
});

test("MoodboardMultiPropertiesPanel exposes selected layer summary and batch actions", () => {
  const onSetVisible = vi.fn();
  const onSetLocked = vi.fn();
  const onArrange = vi.fn();
  const note: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 100,
    y: 50,
    width: 80,
    height: 60,
    rotation: 0,
    zIndex: 1,
    data: { content: "Tone" },
    createdAt: 1,
    updatedAt: 1,
  };
  const image: MoodboardNode = {
    ...note,
    id: "n2",
    type: "image",
    x: 220,
    y: 90,
    width: 120,
    height: 100,
    zIndex: 2,
    data: { url: "dezin://assets/reference.png", visible: false, locked: true },
  };

  render(<MoodboardMultiPropertiesPanel nodes={[note, image]} onSetVisible={onSetVisible} onSetLocked={onSetLocked} onArrange={onArrange} />);

  expect(screen.getByText("Multiple layers")).toBeInTheDocument();
  expect(screen.getByText("2 selected")).toBeInTheDocument();
  expect(screen.getByText("Note")).toBeInTheDocument();
  expect(screen.getByText("Image")).toBeInTheDocument();
  expect(screen.getByText("240")).toBeInTheDocument();
  expect(screen.getByText("140")).toBeInTheDocument();

  fireEvent.click(screen.getByText("1/2 visible"));
  fireEvent.click(screen.getByText("1/2 locked"));
  fireEvent.click(screen.getByRole("button", { name: "Arrange" }));

  expect(onSetVisible).toHaveBeenCalledWith(true);
  expect(onSetLocked).toHaveBeenCalledWith(true);
  expect(onArrange).toHaveBeenCalledOnce();
});

test("MoodboardAgentPanel renders project-style messages with copy actions", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

  render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[
          { id: "u1", boardId: "b1", role: "user", content: "Collect warm references", createdAt: 1 },
          { id: "a1", boardId: "b1", role: "assistant", content: "**Bold direction**\n\nUse warmer texture.", createdAt: 2 },
        ]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={async () => {}}
      />
    </ApiProvider>,
  );

  expect(screen.getByText("Collect warm references")).toBeInTheDocument();
  expect(screen.getByText("Bold direction")).toBeInTheDocument();
  expect(screen.getByText("Use warmer texture.")).toBeInTheDocument();
  expect(screen.getByLabelText("Add files and context")).toBeInTheDocument();

  const copyButtons = screen.getAllByLabelText("Copy message");
  expect(copyButtons).toHaveLength(2);

  fireEvent.click(copyButtons[0]!);
  expect(writeText).toHaveBeenCalledWith("Collect warm references");

  fireEvent.click(copyButtons[1]!);
  expect(writeText).toHaveBeenCalledWith("**Bold direction**\n\nUse warmer texture.");
});

test("MoodboardAgentPanel does not submit Enter while an IME composition is active", async () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={onSend}
      />
    </ApiProvider>,
  );
  const composer = screen.getByLabelText("Message");
  fireEvent.change(composer, { target: { value: "正在输入" } });
  fireEvent.keyDown(composer, { key: "Enter", shiftKey: false, isComposing: true });
  await Promise.resolve();
  expect(onSend).not.toHaveBeenCalled();
  expect(composer).toHaveValue("正在输入");
});

test("MoodboardAgentPanel renders canvas insertion as a removable sendable context card", async () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={onSend}
      />
    </ApiProvider>,
  );

  rerender(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        composerInsertion={{
          id: 1,
          items: [
            {
              id: "canvas-node:note-1",
              type: "canvas-node",
              title: "Material tone",
              subtitle: "note",
              nodeId: "note-1",
              nodeType: "note",
              body: "Material tone [note, id:note-1] at x:10, y:20, 180x80",
            },
          ],
        }}
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={onSend}
      />
    </ApiProvider>,
  );

  const message = screen.getByLabelText("Message") as HTMLTextAreaElement;
  await waitFor(() => expect(message).toHaveFocus());
  expect(message).toHaveValue("");
  const rail = screen.getByRole("list", { name: "Attached context" });
  expect(within(rail).getByText("Canvas selection")).toBeInTheDocument();
  expect(within(rail).getByText("Material tone")).toBeInTheDocument();
  expect(within(rail).getByText("· note")).toBeInTheDocument();
  const actions = screen.getByTestId("moodboard-composer-actions");
  expect(actions.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.dragOver(rail, {
    dataTransfer: { types: ["application/x-dezin-agent-context"], files: [] },
  });
  expect(screen.queryByText("Add images to this moodboard")).toBeNull();

  const draft = "Keep this direction";
  fireEvent.change(message, { target: { value: draft } });
  const remove = within(rail).getByLabelText("Remove Material tone");
  remove.focus();
  expect(remove).toHaveFocus();
  fireEvent.click(remove);
  await waitFor(() => expect(message).toHaveFocus());
  expect(message).toHaveValue(draft);
  expect(message.selectionStart).toBe(draft.length);
  expect(message.selectionEnd).toBe(draft.length);
  fireEvent.change(message, { target: { value: "" } });

  rerender(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        composerInsertion={{
          id: 2,
          items: [
            {
              id: "canvas-node:note-1",
              type: "canvas-node",
              title: "Material tone",
              subtitle: "note",
              nodeId: "note-1",
              nodeType: "note",
              body: "Material tone [note, id:note-1] at x:10, y:20, 180x80",
            },
          ],
        }}
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={onSend}
      />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getByRole("list", { name: "Attached context" })).toBeInTheDocument());

  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() =>
    expect(onSend).toHaveBeenCalledWith("Selected moodboard node:\n1. Material tone [note, id:note-1] at x:10, y:20, 180x80"),
  );
  await waitFor(() => expect(screen.queryByRole("list", { name: "Attached context" })).toBeNull());
});

test("MoodboardAgentPanel exposes moodboard conversations in the project conversation control", () => {
  const conversations: MoodboardConversation[] = [
    { id: "c1", boardId: "b1", title: "Conversation 1", createdAt: 1, turns: 2 },
    { id: "c2", boardId: "b1", title: "Alternate direction", createdAt: 2, turns: 0 },
  ];
  const onConversationChange = vi.fn();
  const onCreateConversation = vi.fn();
  const onRenameConversation = vi.fn();
  const onDeleteConversation = vi.fn();

  render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        conversations={conversations}
        activeConversationId="c1"
        busy={false}
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onConversationChange={onConversationChange}
        onCreateConversation={onCreateConversation}
        onRenameConversation={onRenameConversation}
        onDeleteConversation={onDeleteConversation}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={async () => {}}
      />
    </ApiProvider>,
  );

  fireEvent.click(screen.getByLabelText("Conversations"));
  fireEvent.click(screen.getByText("Alternate direction").closest("button")!);
  expect(onConversationChange).toHaveBeenCalledWith("c2");

  fireEvent.click(screen.getByLabelText("Conversations"));
  fireEvent.click(screen.getByLabelText("New conversation"));
  expect(onCreateConversation).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByLabelText("Conversations"));
  fireEvent.click(screen.getByLabelText("Rename Conversation 1"));
  fireEvent.change(screen.getByLabelText("Conversation name"), { target: { value: "Warm direction" } });
  fireEvent.blur(screen.getByLabelText("Conversation name"));
  expect(onRenameConversation).toHaveBeenCalledWith("c1", "Warm direction");

  fireEvent.click(screen.getByLabelText("Delete Conversation 1"));
  expect(onDeleteConversation).toHaveBeenCalledWith("c1");
});

test("MoodboardAgentPanel keeps the real shell while loading", () => {
  render(
    <MoodboardAgentPanel
      loading
      boardName="Moodboard"
      messages={[]}
      busy
      agents={[]}
      agent=""
      model=""
      onBack={() => {}}
      onAgentChange={() => {}}
      onModelChange={() => {}}
      onRescanAgents={async () => {}}
      onSend={async () => {}}
    />,
  );

  expect(screen.getByLabelText("Back to moodboards")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading moodboard");
  expect(screen.queryByLabelText("Message")).toBeNull();
  expect(screen.getByTestId("moodboard-agent-messages")).toHaveClass("overflow-hidden");
  expect(screen.getByTestId("moodboard-agent-messages")).not.toHaveClass("overflow-auto");
});

test("MoodboardAgentPanel shows progress immediately for an empty active conversation", () => {
  render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        busy
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={async () => {}}
      />
    </ApiProvider>,
  );

  expect(screen.getByText("Working...")).toBeInTheDocument();
  expect(screen.queryByText(/Ask for visual direction/)).toBeNull();
  expect(screen.getByTestId("moodboard-agent-messages")).toHaveClass("overflow-auto");
});

test("MoodboardAgentPanel drops files into the moodboard upload path without creating Agent context", async () => {
  const user = userEvent.setup();
  const onUploadFiles = vi.fn();
  const files = [new File(["image"], "reference.png", { type: "image/png" })] as unknown as FileList;

  render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onUploadFiles={onUploadFiles}
        onSend={async () => {}}
      />
    </ApiProvider>,
  );

  const composer = screen.getByLabelText("Message").closest("div")!;
  fireEvent.dragOver(composer, { dataTransfer: { types: ["Files"], files } });
  const overlay = screen.getByText("Add images to this moodboard").closest("div");
  expect(overlay).toHaveClass("inset-1", "rounded-xl", "border-dashed", "border-ring");
  fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files } });

  expect(onUploadFiles).toHaveBeenCalledWith(files);
  expect(screen.queryByRole("list", { name: "Attached context" })).toBeNull();

  await user.click(screen.getByLabelText("Add files and context"));
  expect(await screen.findByRole("menuitem", { name: "Add images to board" })).toBeInTheDocument();
});

test("MoodboardAgentPanel empty state does not force a scroll container", () => {
  render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Material board"
        messages={[]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={async () => {}}
      />
    </ApiProvider>,
  );

  expect(screen.getByTestId("moodboard-agent-messages")).toHaveClass("overflow-hidden");
  expect(screen.getByTestId("moodboard-agent-messages")).not.toHaveClass("overflow-auto");
});

test("MoodboardAgentPanel shows a scroll-to-bottom control when reading older messages", async () => {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "moodboard-agent-messages" ? 1200 : 0;
  });
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "moodboard-agent-messages" ? 360 : 0;
  });

  try {
    render(
      <ApiProvider client={makeFakeApi()}>
        <MoodboardAgentPanel
          boardName="Material board"
          messages={[
            { id: "u1", boardId: "b1", role: "user", content: "First request", createdAt: 1 },
            { id: "a1", boardId: "b1", role: "assistant", content: "Second response", createdAt: 2 },
          ]}
          busy={false}
          agents={[]}
          agent=""
          model=""
          onBack={() => {}}
          onAgentChange={() => {}}
          onModelChange={() => {}}
          onRescanAgents={async () => {}}
          onSend={async () => {}}
        />
      </ApiProvider>,
    );

    const scroller = screen.getByTestId("moodboard-agent-messages");
    await waitFor(() => expect(scroller.scrollTop).toBe(1200));
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();

    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    const jump = await screen.findByRole("button", { name: "Scroll to bottom" });
    expect(jump.textContent).toBe("");
    expect(jump.className).not.toContain("shadow");

    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(1200);
  } finally {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
});

test("MoodboardAgentPanel scroll control shows a subtle loading ring while busy", async () => {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "moodboard-agent-messages" ? 1200 : 0;
  });
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "moodboard-agent-messages" ? 360 : 0;
  });

  try {
    render(
      <ApiProvider client={makeFakeApi()}>
        <MoodboardAgentPanel
          boardName="Material board"
          messages={[{ id: "u1", boardId: "b1", role: "user", content: "First request", createdAt: 1 }]}
          busy={true}
          agents={[]}
          agent=""
          model=""
          onBack={() => {}}
          onAgentChange={() => {}}
          onModelChange={() => {}}
          onRescanAgents={async () => {}}
          onSend={async () => {}}
        />
      </ApiProvider>,
    );

    const scroller = screen.getByTestId("moodboard-agent-messages");
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    const jump = await screen.findByRole("button", { name: "Scroll to bottom" });
    expect(jump.className).toContain("before:animate-spin");
  } finally {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
});

test("MoodboardScreen loading state keeps the board split layout", async () => {
  vi.doMock("./MoodboardCanvas.tsx", () => ({ MoodboardCanvas: () => <div data-testid="mock-moodboard-canvas" /> }));
  const { MoodboardScreen } = await import("../screens/MoodboardScreen.tsx");

  render(
    <ApiProvider client={makeFakeApi({ getMoodboard: async () => new Promise(() => {}) })}>
      <MoodboardScreen boardId="b1" onBack={() => {}} onOpenSettings={() => {}} />
    </ApiProvider>,
  );

  expect(screen.getAllByText("Loading moodboard")).toHaveLength(2);
  expect(screen.getByRole("separator", { name: "Resize moodboard agent panel" })).toHaveAttribute("data-separator");
  expect(screen.getByRole("region", { name: "Moodboard canvas" })).toBeInTheDocument();

  vi.doUnmock("./MoodboardCanvas.tsx");
});

test("MoodboardPropertiesPanel shows concrete layout values", () => {
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "section",
    x: 120,
    y: 140,
    width: 320,
    height: 160,
    rotation: 15,
    zIndex: 7,
    data: { title: "Section" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(<MoodboardPropertiesPanel node={node} onPatch={() => {}} onPatchData={() => {}} onGenerate={() => {}} />);

  expect(screen.getByText("320 x 160")).toBeInTheDocument();
  expect(screen.getByText("2.00:1")).toBeInTheDocument();
  expect(screen.getByText("15 deg")).toBeInTheDocument();
});

test("SelectionToolbar exposes compact object actions", async () => {
  const user = userEvent.setup();
  const onDuplicate = vi.fn();
  const onDelete = vi.fn();
  const onRestoreOriginalSize = vi.fn();
  const onSendToAgent = vi.fn();
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "Reference tone" },
    createdAt: 1,
    updatedAt: 1,
  };
  const Toolbar = SelectionToolbar as any;

  render(
    <Toolbar
      node={node}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onRestoreOriginalSize={onRestoreOriginalSize}
      onSendToAgent={onSendToAgent}
    />,
  );

  expect(screen.getByRole("button", { name: "Send to Agent" })).toHaveTextContent("Enter");
  fireEvent.click(screen.getByRole("button", { name: "Send to Agent" }));
  fireEvent.click(screen.getByLabelText("Duplicate"));
  expect(screen.queryByLabelText("Delete")).toBeNull();
  await user.click(screen.getByLabelText("More node actions"));
  await user.click(screen.getByRole("menuitem", { name: "Restore original size" }));
  await user.click(screen.getByLabelText("More node actions"));
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));

  expect(onSendToAgent).toHaveBeenCalledOnce();
  expect(onDuplicate).toHaveBeenCalledOnce();
  expect(onRestoreOriginalSize).toHaveBeenCalledOnce();
  expect(onDelete).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Bring to front")).toBeNull();
  expect(screen.queryByLabelText("Hide layer")).toBeNull();
  expect(screen.queryByLabelText("Lock layer")).toBeNull();
});

test("SelectionToolbar keeps toolbar clicks out of the canvas event layer", () => {
  const onDuplicate = vi.fn();
  const onCanvasClick = vi.fn();
  const node: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "Reference tone" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <div onClick={onCanvasClick}>
      <SelectionToolbar node={node} onDuplicate={onDuplicate} onDelete={() => {}} />
    </div>,
  );

  fireEvent.click(screen.getByLabelText("Duplicate"));

  expect(onDuplicate).toHaveBeenCalledOnce();
  expect(onCanvasClick).not.toHaveBeenCalled();
});

test("SelectionToolbar surfaces image-edit actions for image nodes", () => {
  const onImageAction = vi.fn();
  const onQuickEdit = vi.fn();
  const node: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { url: "dezin://assets/reference.png" },
    createdAt: 1,
    updatedAt: 1,
  };

  const { container } = render(<SelectionToolbar node={node} onDuplicate={() => {}} onDelete={() => {}} onImageAction={onImageAction} onQuickEdit={onQuickEdit} />);

  fireEvent.click(screen.getByText("Quick edit"));
  fireEvent.click(screen.getByLabelText("Remove background"));
  fireEvent.click(screen.getByLabelText("Edit region"));
  fireEvent.click(screen.getByLabelText("Extract layer"));

  expect(onQuickEdit).toHaveBeenCalledOnce();
  expect(onImageAction).toHaveBeenCalledWith("Remove background");
  expect(onImageAction).toHaveBeenCalledWith("Edit region");
  expect(onImageAction).toHaveBeenCalledWith("Extract layer");
  expect(container.querySelector(".h-5.w-px.bg-border")).not.toBeNull();
});

test("MultiSelectionToolbar exposes batch node actions", async () => {
  const user = userEvent.setup();
  const onDuplicate = vi.fn();
  const onAlign = vi.fn();
  const onArrange = vi.fn();
  const onDelete = vi.fn();
  const onSendToAgent = vi.fn();
  const first: MoodboardNode = {
    id: "n1",
    boardId: "b1",
    type: "note",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "Reference tone" },
    createdAt: 1,
    updatedAt: 1,
  };
  const second: MoodboardNode = {
    ...first,
    id: "n2",
    data: { content: "Hidden reference", visible: false, locked: true },
  };
  const Toolbar = MultiSelectionToolbar as any;

  render(
    <Toolbar
      nodes={[first, second]}
      onDuplicate={onDuplicate}
      onAlign={onAlign}
      onArrange={onArrange}
      onDelete={onDelete}
      onSendToAgent={onSendToAgent}
    />,
  );

  expect(screen.getByText("2 selected")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send to Agent" }));
  fireEvent.click(screen.getByLabelText("Duplicate selected"));
  fireEvent.click(screen.getByLabelText("Align selected"));
  expect(screen.getByText("Align right").closest("[data-moodboard-toolbar]")).not.toBeNull();
  fireEvent.click(screen.getByText("Align left"));
  fireEvent.click(screen.getByLabelText("Arrange selected"));
  expect(screen.queryByLabelText("Delete selected")).toBeNull();
  await user.click(screen.getByLabelText("More selected actions"));
  await user.click(screen.getByRole("menuitem", { name: "Delete selected" }));

  expect(onSendToAgent).toHaveBeenCalledOnce();
  expect(onDuplicate).toHaveBeenCalledOnce();
  expect(onAlign).toHaveBeenCalledWith("left");
  expect(onArrange).toHaveBeenCalledOnce();
  expect(onDelete).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Bring selected to front")).toBeNull();
  expect(screen.queryByLabelText("Hide selected")).toBeNull();
});

test("MoodboardContextMenu exposes Send to Agent and Quick Edit for image selections", () => {
  const onSendToAgent = vi.fn();
  const onQuickEdit = vi.fn();
  const node: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { url: "dezin://assets/reference.png" },
    createdAt: 1,
    updatedAt: 1,
  };
  const Menu = MoodboardContextMenu as any;

  render(
    <Menu
      menu={{ x: 24, y: 32, canvasX: 240, canvasY: 260, targetId: node.id }}
      targetId={node.id}
      targetNode={node}
      onClose={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onGenerate={() => {}}
      onSendToAgent={onSendToAgent}
      onQuickEdit={onQuickEdit}
    />,
  );

  expect(screen.getByText("Enter")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Send to Agent"));
  fireEvent.click(screen.getByText("Quick Edit"));

  expect(onSendToAgent).toHaveBeenCalledOnce();
  expect(onQuickEdit).toHaveBeenCalledOnce();
});

test("MultiSelectionToolbar does not expose quick edit for multi-image selections", () => {
  const image: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { url: "dezin://assets/reference.png" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <MultiSelectionToolbar
      nodes={[image, { ...image, id: "img2" }]}
      onDuplicate={() => {}}
      onAlign={() => {}}
      onArrange={() => {}}
      onDelete={() => {}}
      onImageAction={() => {}}
    />,
  );

  expect(screen.queryByText("Quick edit")).toBeNull();
  expect(screen.getByLabelText("Remove backgrounds")).toBeInTheDocument();
});

test("GeneratorPromptToolbar exposes a compact image model selector", () => {
  const onModelChange = vi.fn();
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generatorStatus: "ready" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <GeneratorPromptToolbar
      node={node}
      busy={false}
      models={["gpt-image-1", "gpt-image-2"]}
      model="gpt-image-1"
      onModelChange={onModelChange}
      onPromptChange={() => {}}
      onGenerate={async () => {}}
    />,
  );

  expect(screen.getByLabelText("Image generator prompt")).toHaveValue("soft light");
  expect(screen.getByLabelText("Image generation model")).toHaveTextContent("gpt-image-1");
  expect(screen.getByLabelText("Image generation model")).toHaveTextContent(/^Image/);
  expect(screen.queryByText("Prompt required")).toBeNull();
  expect(screen.getByRole("button", { name: "Generate" }).querySelector("svg")).toBeNull();

  fireEvent.click(screen.getByLabelText("Image generation model"));
  fireEvent.click(screen.getByRole("button", { name: /gpt-image-2/ }));
  expect(onModelChange).toHaveBeenCalledWith("gpt-image-2");
});

test("GeneratorPromptToolbar places the prompt caret at the end after autofocus", async () => {
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generatorStatus: "ready" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <GeneratorPromptToolbar
      node={node}
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={() => {}}
      onPromptChange={() => {}}
      onGenerate={async () => {}}
    />,
  );

  const prompt = screen.getByLabelText("Image generator prompt") as HTMLTextAreaElement;
  await waitFor(() => expect(prompt).toHaveFocus());
  expect(prompt.selectionStart).toBe("soft light".length);
  expect(prompt.selectionEnd).toBe("soft light".length);
});

test("GeneratorPromptToolbar exposes model parameters and submits them with the prompt", async () => {
  const onGenerate = vi.fn().mockResolvedValue(undefined);
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generationParams: { quality: "medium", aspectRatio: "1:1", size: "1024x1024" } },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <GeneratorPromptToolbar
      node={node}
      busy={false}
      imageProviderId="openai"
      models={["gpt-image-2"]}
      model="gpt-image-2"
      onModelChange={() => {}}
      onPromptChange={() => {}}
      onGenerate={onGenerate}
    />,
  );

  fireEvent.click(screen.getByLabelText("Image generation parameters"));
  expect(screen.getByText("Image settings")).toBeInTheDocument();
  expect(screen.getByLabelText("Image generation parameters")).toHaveClass("rounded-md");
  expect(screen.getByLabelText("Image generation parameters")).not.toHaveClass("rounded-full");
  fireEvent.click(screen.getByRole("button", { name: "High" }));
  fireEvent.click(screen.getByRole("button", { name: "16:9" }));
  fireEvent.click(screen.getByRole("button", { name: "1536 x 1024" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));

  await waitFor(() =>
    expect(onGenerate).toHaveBeenCalledWith(
      "soft light",
      expect.objectContaining({
        quality: "high",
        aspectRatio: "16:9",
        size: "1536x1024",
        count: 1,
      }),
      expect.objectContaining({ referenceAssetIds: [] }),
    ),
  );
});

test("GeneratorPromptToolbar keeps aspect ratio buttons selected across repeated changes", () => {
  const onResizeNode = vi.fn();
  const onParamsChange = vi.fn();
  const initialNode: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generationParams: { quality: "medium", aspectRatio: "1:1", size: "1024x1024" } },
    createdAt: 1,
    updatedAt: 1,
  };

  function ToolbarProbe() {
    const [node, setNode] = useState(initialNode);
    return (
      <GeneratorPromptToolbar
        node={node}
        busy={false}
        imageProviderId="openai"
        models={["gpt-image-2"]}
        model="gpt-image-2"
        onModelChange={() => {}}
        onPromptChange={() => {}}
        onParamsChange={(params) => {
          onParamsChange(params);
          setNode((current) => ({ ...current, data: { ...current.data, generationParams: params } }));
        }}
        onResizeNode={(size) => {
          onResizeNode(size);
          setNode((current) => ({ ...current, ...size }));
        }}
        onGenerate={async () => {}}
      />
    );
  }

  render(<ToolbarProbe />);

  fireEvent.click(screen.getByLabelText("Image generation parameters"));
  const square = screen.getByRole("button", { name: "1:1" });
  const wide = screen.getByRole("button", { name: "16:9" });
  const tall = screen.getByRole("button", { name: "9:16" });

  expect(square).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(wide);
  expect(wide).toHaveAttribute("aria-pressed", "true");
  expect(square).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(tall);
  expect(tall).toHaveAttribute("aria-pressed", "true");
  expect(wide).toHaveAttribute("aria-pressed", "false");

  expect(onResizeNode).toHaveBeenCalledWith({ width: 360, height: 203 });
  expect(onResizeNode).toHaveBeenLastCalledWith({ width: 120, height: 213 });
  expect(onParamsChange).toHaveBeenLastCalledWith(expect.objectContaining({ aspectRatio: "9:16", size: "1024x1536" }));
});

test("GeneratorPromptToolbar shows reference image previews from supplied board assets", () => {
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: {
      generatorPrompt: "soft light",
      referenceAssetIds: ["asset-a", "asset-b"],
    },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <GeneratorPromptToolbar
      node={node}
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      referenceImages={[
        { assetId: "asset-a", url: "/api/moodboards/b1/assets/asset-a", name: "first reference.png" },
        { assetId: "asset-b", url: "/api/moodboards/b1/assets/asset-b", name: "second reference.png" },
      ]}
      onModelChange={() => {}}
      onPromptChange={() => {}}
      onGenerate={async () => {}}
    />,
  );

  expect(screen.getByAltText("first reference.png")).toHaveAttribute("src", "/api/moodboards/b1/assets/asset-a");
  expect(screen.getByAltText("second reference.png")).toHaveAttribute("src", "/api/moodboards/b1/assets/asset-b");
  expect(screen.getByText("#1")).toBeInTheDocument();
  expect(screen.getByText("#2")).toBeInTheDocument();
});

test("GeneratorPromptToolbar exposes reference image actions and submits reference asset ids", async () => {
  const onGenerate = vi.fn().mockResolvedValue(undefined);
  const onUploadReferenceFiles = vi.fn();
  const onSelectCanvasReference = vi.fn();
  const onReferenceAssetIdsChange = vi.fn();
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: {
      generatorPrompt: "soft light",
      referenceAssetIds: ["asset-a", "asset-b"],
      referenceAssets: [
        { assetId: "asset-a", url: "/api/moodboards/b1/assets/asset-a", name: "first reference.png" },
        { assetId: "asset-b", url: "/api/moodboards/b1/assets/asset-b", name: "second reference.png" },
      ],
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const files = [new File(["image"], "material.png", { type: "image/png" })] as unknown as FileList;
  const Toolbar = GeneratorPromptToolbar as any;

  render(
    <Toolbar
      node={node}
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={() => {}}
      onPromptChange={() => {}}
      onGenerate={onGenerate}
      onUploadReferenceFiles={onUploadReferenceFiles}
      onSelectCanvasReference={onSelectCanvasReference}
      onReferenceAssetIdsChange={onReferenceAssetIdsChange}
    />,
  );

  const referenceStrip = screen.getByLabelText("Reference images");
  expect(referenceStrip).toHaveTextContent("first reference.png");
  expect(referenceStrip).toHaveTextContent("second reference.png");
  expect(screen.getByAltText("first reference.png")).toHaveAttribute("src", "/api/moodboards/b1/assets/asset-a");

  fireEvent.click(screen.getByRole("button", { name: "Move reference image second reference.png before previous" }));
  expect(onReferenceAssetIdsChange).toHaveBeenCalledWith(["asset-b", "asset-a"]);
  expect(within(referenceStrip).getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual(["second reference.png", "first reference.png"]);

  fireEvent.click(screen.getByRole("button", { name: "Remove reference image second reference.png" }));
  expect(onReferenceAssetIdsChange).toHaveBeenLastCalledWith(["asset-a"]);
  expect(within(referenceStrip).getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual(["first reference.png"]);

  fireEvent.click(screen.getByLabelText("Add reference image"));
  expect(screen.getByRole("button", { name: "从本地上传图片" }).closest("[data-slot='popover-content']")).not.toHaveClass("rounded-xl");
  expect(screen.getByRole("button", { name: "从本地上传图片" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "从画布选择" }));
  expect(onSelectCanvasReference).toHaveBeenCalledOnce();

  const input = screen.getByLabelText("Upload reference image") as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
  expect(onUploadReferenceFiles).toHaveBeenCalledWith(files);

  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  await waitFor(() =>
    expect(onGenerate).toHaveBeenCalledWith(
      "soft light",
      expect.any(Object),
      expect.objectContaining({ referenceAssetIds: ["asset-a"] }),
    ),
  );
});

test("GeneratorPromptToolbar starts reference input as a square add tile", () => {
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <GeneratorPromptToolbar
      node={node}
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={() => {}}
      onPromptChange={() => {}}
      onGenerate={async () => {}}
    />,
  );

  const addButton = screen.getByLabelText("Add reference image");
  expect(addButton.className).toContain("aspect-square");
  expect(addButton).not.toHaveTextContent("参考图");
});

test("GeneratorPromptToolbar enters a disabled loading state while generating", async () => {
  let finish!: () => void;
  const onGenerate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light", generatorStatus: "ready" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <GeneratorPromptToolbar
      node={node}
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={() => {}}
      onPromptChange={() => {}}
      onGenerate={onGenerate}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Generate" }));

  expect(await screen.findByRole("button", { name: /Generating/ })).toBeDisabled();
  expect(screen.getByLabelText("Image generator prompt")).toBeDisabled();
  expect(screen.getByLabelText("Image generation model")).toBeDisabled();

  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).not.toBeDisabled());
});

test("GeneratorPromptToolbar keeps prompt interactions out of the canvas event layer", () => {
  const onCanvasPointerDown = vi.fn();
  const onCanvasClick = vi.fn();
  const onCanvasContextMenu = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(
    <div onPointerDown={onCanvasPointerDown} onClick={onCanvasClick} onContextMenu={onCanvasContextMenu}>
      <GeneratorPromptToolbar
        node={node}
        busy={false}
        models={["gpt-image-1"]}
        model="gpt-image-1"
        onModelChange={() => {}}
        onPromptChange={() => {}}
        onGenerate={async () => {}}
      />
    </div>,
  );

  fireEvent.pointerDown(screen.getByLabelText("Image generator prompt"));
  fireEvent.click(screen.getByLabelText("Image generation model"));
  const contextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  screen.getByLabelText("Image generator prompt").dispatchEvent(contextEvent);

  expect(onCanvasPointerDown).not.toHaveBeenCalled();
  expect(onCanvasClick).not.toHaveBeenCalled();
  expect(onCanvasContextMenu).not.toHaveBeenCalled();
  expect(contextEvent.defaultPrevented).toBe(false);
});

test("GeneratorPromptToolbar accepts dropped image files through the upload path", () => {
  const onUploadFiles = vi.fn();
  const node: MoodboardNode = {
    id: "g1",
    boardId: "b1",
    type: "image-generator",
    x: 120,
    y: 140,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light" },
    createdAt: 1,
    updatedAt: 1,
  };
  const files = [new File(["image"], "material.png", { type: "image/png" })] as unknown as FileList;

  render(
    <GeneratorPromptToolbar
      node={node}
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={() => {}}
      onPromptChange={() => {}}
      onGenerate={async () => {}}
      onUploadFiles={onUploadFiles}
    />,
  );

  const toolbar = screen.getByLabelText("Image generator prompt").closest("[data-moodboard-toolbar]")!;
  fireEvent.dragOver(toolbar, { dataTransfer: { files } });
  fireEvent.drop(toolbar, { dataTransfer: { files } });

  expect(onUploadFiles).toHaveBeenCalledWith(files);
});

test("QuickEditPromptToolbar submits image variations with the selected model", async () => {
  const onModelChange = vi.fn();
  const onGenerate = vi.fn().mockResolvedValue(undefined);

  render(
    <QuickEditPromptToolbar
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      imageProviderId="openai"
      onModelChange={onModelChange}
      onGenerate={onGenerate}
    />,
  );

  fireEvent.click(screen.getByLabelText("Image generation parameters"));
  fireEvent.click(screen.getByRole("button", { name: "High" }));
  fireEvent.change(screen.getByLabelText("Quick edit prompt"), { target: { value: "make it warmer" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));

  expect(onGenerate).toHaveBeenCalledWith(
    "make it warmer",
    expect.objectContaining({
      referenceAssetIds: [],
      params: expect.objectContaining({ quality: "high" }),
    }),
  );
  expect(screen.getByLabelText("Image generation model")).toHaveTextContent("gpt-image-1");
});

test("QuickEditPromptToolbar focuses the prompt when it appears", async () => {
  render(
    <QuickEditPromptToolbar
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={() => {}}
      onGenerate={async () => {}}
    />,
  );

  await waitFor(() => expect(screen.getByLabelText("Quick edit prompt")).toHaveFocus());
});

test("QuickEditPromptToolbar exposes reference image actions and submits references", async () => {
  const onGenerate = vi.fn().mockResolvedValue(undefined);
  const onUploadReferenceFiles = vi.fn();
  const onSelectCanvasReference = vi.fn();

  render(
    <QuickEditPromptToolbar
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      referenceAssetIds={["asset-ref"]}
      onModelChange={() => {}}
      onGenerate={onGenerate}
      onUploadReferenceFiles={onUploadReferenceFiles}
      onSelectCanvasReference={onSelectCanvasReference}
    />,
  );

  fireEvent.click(screen.getByLabelText("Add reference image"));
  fireEvent.click(screen.getByRole("button", { name: "从画布选择" }));
  expect(onSelectCanvasReference).toHaveBeenCalledOnce();

  fireEvent.change(screen.getByLabelText("Quick edit prompt"), { target: { value: "make it warmer" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  await waitFor(() =>
    expect(onGenerate).toHaveBeenCalledWith("make it warmer", expect.objectContaining({ referenceAssetIds: ["asset-ref"] })),
  );
});

test("MoodboardPropertiesPanel labels reusable image prompts as Reuse Prompt", () => {
  const onUsePrompt = vi.fn();
  const node: MoodboardNode = {
    id: "img1",
    boardId: "b1",
    type: "image",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { source: "generated", prompt: "soft light", model: "gpt-image-1", assetId: "asset-1", url: "/asset.png" },
    createdAt: 1,
    updatedAt: 1,
  };

  render(<MoodboardPropertiesPanel node={node} onPatch={() => {}} onPatchData={() => {}} onGenerate={() => {}} onEditImage={() => {}} onUsePrompt={onUsePrompt} />);

  expect(screen.queryByRole("button", { name: "Use Prompt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reuse Prompt" }));
  expect(onUsePrompt).toHaveBeenCalledWith(node);
});

test("QuickEditPromptToolbar keeps the prompt disabled while the image edit is running", async () => {
  let finish!: () => void;
  const onGenerate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );

  render(
    <QuickEditPromptToolbar
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={() => {}}
      onGenerate={onGenerate}
    />,
  );

  fireEvent.change(screen.getByLabelText("Quick edit prompt"), { target: { value: "make it warmer" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));

  expect(await screen.findByRole("button", { name: /Generating/ })).toBeDisabled();
  expect(screen.getByLabelText("Quick edit prompt")).toBeDisabled();
  expect(screen.getByLabelText("Image generation model")).toBeDisabled();

  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled());
  expect(screen.getByLabelText("Quick edit prompt")).not.toBeDisabled();
  expect(screen.getByLabelText("Quick edit prompt")).toHaveValue("");
});

test("CanvasViewBar groups layers and presentation controls at the canvas edge", () => {
  const onToggleLayers = vi.fn();
  const onTogglePresentation = vi.fn();

  render(
    <CanvasViewBar
      layersOpen={false}
      presentationMode={false}
      onToggleLayers={onToggleLayers}
      onTogglePresentation={onTogglePresentation}
    />,
  );

  fireEvent.click(screen.getByLabelText("Layers"));
  fireEvent.click(screen.getByLabelText("Presentation mode"));

  expect(onToggleLayers).toHaveBeenCalledOnce();
  expect(onTogglePresentation).toHaveBeenCalledOnce();
});

test("CanvasActionBar uses md rounded items in the bottom toolbar", () => {
  render(<CanvasActionBar tool="select" onToolChange={() => {}} onAddImageGenerator={() => {}} />);

  for (const label of ["Select", "Hand", "Add note", "Add section", "Image generator"]) {
    const button = screen.getByRole("button", { name: label });
    expect(button.className).toContain("rounded-md");
    expect(button.className).not.toContain("rounded-lg");
  }
});

test("Moodboard layers default closed until the user opens them", () => {
  expect(readInitialLayersOpen()).toBe(false);
  localStorage.setItem("dezin:moodboard:layers-open", "1");
  expect(readInitialLayersOpen()).toBe(true);
});

test("context target resolution keeps selected nodes active when tapping editor resize handles", () => {
  const editorTarget = { data: { nodeId: "img1" } };
  const resizeHandle = { pointType: "resize", editor: { target: editorTarget }, parent: null };

  expect(contextTargetIdFromEvent(resizeHandle, editorTarget)).toBe("img1");
});
