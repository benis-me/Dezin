import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";
import { MoodboardAgentPanel } from "./MoodboardAgentPanel.tsx";
import { SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import {
  eventClientPoint,
  nodeIdFromTarget,
  reorderLayerInputs,
  resolveFloatingChromeRect,
  resolveFloatingRect,
  sameFloatingRect,
} from "./canvas-utils.ts";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  expect(screen.getByText("Reset zoom")).toBeInTheDocument();
});

test("MoodboardContextMenu separates selection actions from blank-canvas creation actions", () => {
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
  expect(screen.getByText("Duplicate")).toBeInTheDocument();
  expect(screen.queryByText("Add note here")).toBeNull();
  expect(screen.queryByText("Add image generator here")).toBeNull();
  expect(screen.getByText("View")).toBeInTheDocument();
});

test("eventClientPoint reads Leafer native event origins for context menus", () => {
  expect(eventClientPoint({ origin: { clientX: 260, clientY: 144 }, clientX: 0, clientY: 0 })).toEqual({ x: 260, y: 144 });
});

test("nodeIdFromTarget reads reconciler node ids from parent data", () => {
  expect(nodeIdFromTarget({ data: { id: "n1" } })).toBe("n1");
  expect(nodeIdFromTarget({ parent: { data: { nodeId: "n2" } } })).toBe("n2");
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
  ).toEqual({ left: 484, top: 216, bottom: 188 });
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
  ).toEqual({ left: 8, top: 8 });

  expect(
    resolveFloatingChromeRect({
      anchor: { left: 310, top: 20, bottom: 284 },
      containerWidth: 320,
      containerHeight: 300,
      surfaceWidth: 180,
      surfaceHeight: 36,
      placement: "bottom",
    }),
  ).toEqual({ left: 132, top: 256 });
});

test("sameFloatingRect ignores subpixel jitter during drag", () => {
  expect(sameFloatingRect({ left: 120, top: 80, bottom: 220 }, { left: 120.25, top: 80.2, bottom: 220.4 })).toBe(true);
  expect(sameFloatingRect({ left: 120, top: 80, bottom: 220 }, { left: 121, top: 80, bottom: 220 })).toBe(false);
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

test("MoodboardAgentPanel renders project-style assistant messages with copy actions", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

  render(
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
    />,
  );

  expect(screen.getByText("Collect warm references")).toBeInTheDocument();
  expect(screen.getByText("Bold direction")).toBeInTheDocument();
  expect(screen.getByText("Use warmer texture.")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Copy message"));
  expect(writeText).toHaveBeenCalledWith("**Bold direction**\n\nUse warmer texture.");
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

test("SelectionToolbar exposes object visibility and lock actions", () => {
  const onToggleVisible = vi.fn();
  const onToggleLocked = vi.fn();
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
      onDuplicate={() => {}}
      onBringToFront={() => {}}
      onSendToBack={() => {}}
      onToggleVisible={onToggleVisible}
      onToggleLocked={onToggleLocked}
      onDelete={() => {}}
    />,
  );

  fireEvent.click(screen.getByLabelText("Hide layer"));
  fireEvent.click(screen.getByLabelText("Lock layer"));

  expect(onToggleVisible).toHaveBeenCalledOnce();
  expect(onToggleLocked).toHaveBeenCalledOnce();
});
