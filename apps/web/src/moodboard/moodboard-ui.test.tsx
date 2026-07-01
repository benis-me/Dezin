import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { MoodboardAgentPanel } from "./MoodboardAgentPanel.tsx";
import { CanvasViewBar, GeneratorPromptToolbar, MultiSelectionToolbar, QuickEditPromptToolbar, SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardMultiPropertiesPanel, MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import {
  contextTargetIdFromEvent,
  eventClientPoint,
  generatorModel,
  getFloatingChromeSafeRect,
  isEditableShortcutTarget,
  isTemporaryHandShortcut,
  readInitialLayersOpen,
  moveContainedNodesWithSections,
  normalizeCanvasRect,
  nodeIdFromTarget,
  nodeIdsFromTarget,
  nudgeNodeInputs,
  reorderLayerInputs,
  rectFromBounds,
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

test("MoodboardContextMenu separates selection actions from blank-canvas creation actions", () => {
  const onCopy = vi.fn();
  const onPaste = vi.fn();
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
  expect(screen.getByText("]")).toBeInTheDocument();
  expect(screen.getByText("[")).toBeInTheDocument();
  expect(screen.getByText("Del")).toBeInTheDocument();
  expect(screen.queryByText("Add note here")).toBeNull();
  expect(screen.queryByText("Add image generator here")).toBeNull();
  expect(screen.getByText("View")).toBeInTheDocument();
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

test("nodeIdFromTarget reads reconciler node ids from parent data", () => {
  expect(nodeIdFromTarget({ data: { id: "n1" } })).toBe("n1");
  expect(nodeIdFromTarget({ parent: { data: { nodeId: "n2" } } })).toBe("n2");
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

test("normalizeCanvasRect turns drag endpoints into a positive drawing rect", () => {
  expect(normalizeCanvasRect({ x: 320, y: 220 }, { x: 120, y: 90 })).toEqual({ x: 120, y: 90, width: 200, height: 130 });
});

test("Awen snap geometry resolves the nearest axis delta for moodboard nodes", () => {
  const candidates = createSnapPointsFromBounds({ x: 100, y: 80, width: 160, height: 120 }, "candidate");
  const target = createSnapPointsFromBounds({ x: 263, y: 230, width: 80, height: 60 }, "target");

  expect(resolveSnapDeltas({ targetPoints: target, snapLines: createSnapLines(candidates), threshold: 6 }).x?.delta).toBe(-3);
});

test("Awen editor selection adapter maps node ids onto the Leafer editor target", () => {
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

test("Awen editor selection adapter prefers editor.select when Leafer exposes it", () => {
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

test("createSectionNode keeps dragged section dimensions", () => {
  expect(createSectionNode(4, { x: 120, y: 90, width: 260, height: 180 })).toMatchObject({
    type: "section",
    x: 120,
    y: 90,
    width: 260,
    height: 180,
  });
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

test("MoodboardAgentPanel renders project-style assistant messages with copy actions", () => {
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

  fireEvent.click(screen.getByLabelText("Copy message"));
  expect(writeText).toHaveBeenCalledWith("**Bold direction**\n\nUse warmer texture.");
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
  expect(screen.getByText("Loading moodboard")).toBeInTheDocument();
  expect(screen.queryByLabelText("Message")).toBeNull();
});

test("MoodboardAgentPanel drops files into the moodboard upload path", () => {
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
  fireEvent.dragOver(composer);
  expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
  fireEvent.drop(composer, { dataTransfer: { files } });

  expect(onUploadFiles).toHaveBeenCalledWith(files);
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

test("SelectionToolbar exposes compact object actions", () => {
  const onDuplicate = vi.fn();
  const onDelete = vi.fn();
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
    <SelectionToolbar
      node={node}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
    />,
  );

  fireEvent.click(screen.getByLabelText("Duplicate"));
  fireEvent.click(screen.getByLabelText("Delete"));

  expect(onDuplicate).toHaveBeenCalledOnce();
  expect(onDelete).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Bring to front")).toBeNull();
  expect(screen.queryByLabelText("Hide layer")).toBeNull();
  expect(screen.queryByLabelText("Lock layer")).toBeNull();
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

  render(<SelectionToolbar node={node} onDuplicate={() => {}} onDelete={() => {}} onImageAction={onImageAction} onQuickEdit={onQuickEdit} />);

  fireEvent.click(screen.getByText("Quick edit"));
  fireEvent.click(screen.getByLabelText("Remove background"));
  fireEvent.click(screen.getByLabelText("Edit region"));
  fireEvent.click(screen.getByLabelText("Extract layer"));

  expect(onQuickEdit).toHaveBeenCalledOnce();
  expect(onImageAction).toHaveBeenCalledWith("Remove background");
  expect(onImageAction).toHaveBeenCalledWith("Edit region");
  expect(onImageAction).toHaveBeenCalledWith("Extract layer");
});

test("MultiSelectionToolbar exposes batch node actions", () => {
  const onDuplicate = vi.fn();
  const onAlign = vi.fn();
  const onArrange = vi.fn();
  const onDelete = vi.fn();
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

  render(
    <MultiSelectionToolbar
      nodes={[first, second]}
      onDuplicate={onDuplicate}
      onAlign={onAlign}
      onArrange={onArrange}
      onDelete={onDelete}
    />,
  );

  expect(screen.getByText("2 selected")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Duplicate selected"));
  fireEvent.click(screen.getByLabelText("Align selected"));
  fireEvent.click(screen.getByText("Align left"));
  fireEvent.click(screen.getByLabelText("Arrange selected"));
  fireEvent.click(screen.getByLabelText("Delete selected"));

  expect(onDuplicate).toHaveBeenCalledOnce();
  expect(onAlign).toHaveBeenCalledWith("left");
  expect(onArrange).toHaveBeenCalledOnce();
  expect(onDelete).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Bring selected to front")).toBeNull();
  expect(screen.queryByLabelText("Hide selected")).toBeNull();
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
      busy={true}
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
});

test("QuickEditPromptToolbar submits image variations with the selected model", async () => {
  const onModelChange = vi.fn();
  const onGenerate = vi.fn().mockResolvedValue(undefined);

  render(
    <QuickEditPromptToolbar
      busy={false}
      models={["gpt-image-1"]}
      model="gpt-image-1"
      onModelChange={onModelChange}
      onGenerate={onGenerate}
    />,
  );

  fireEvent.change(screen.getByLabelText("Quick edit prompt"), { target: { value: "make it warmer" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));

  expect(onGenerate).toHaveBeenCalledWith("make it warmer");
  expect(screen.getByLabelText("Image generation model")).toHaveTextContent("gpt-image-1");
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

test("Moodboard layers default closed until the user opens them", () => {
  expect(readInitialLayersOpen()).toBe(false);
  localStorage.setItem("dezin:moodboard:layers-open", "1");
  expect(readInitialLayersOpen()).toBe(true);
});
