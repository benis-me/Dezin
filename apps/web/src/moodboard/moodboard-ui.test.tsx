import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { MoodboardAgentPanel } from "./MoodboardAgentPanel.tsx";
import { SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardLayerPanel } from "./MoodboardLayerPanel.tsx";
import { MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";
import {
  contextTargetIdFromEvent,
  eventClientPoint,
  getFloatingChromeSafeRect,
  moveContainedNodesWithSections,
  normalizeCanvasRect,
  nodeIdFromTarget,
  reorderLayerInputs,
  rectFromBounds,
  resolveFloatingChromeRect,
  resolveFloatingRect,
  sameFloatingRect,
} from "./canvas-utils.ts";
import { createSnapLines, createSnapPointsFromBounds, resolveSnapDeltas } from "./leafer-adapter/snap-geometry.ts";
import { selectAppNodesByIds } from "./leafer-adapter/editor-selection.ts";
import { createSectionNode } from "./moodboard-board-utils.ts";

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

test("contextTargetIdFromEvent falls back to the editor selection", () => {
  expect(contextTargetIdFromEvent(null, { data: { nodeId: "selected-node" } })).toBe("selected-node");
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

test("sameFloatingRect ignores subpixel jitter during drag", () => {
  expect(sameFloatingRect({ left: 120, top: 80, bottom: 220 }, { left: 120.25, top: 80.2, bottom: 220.4 })).toBe(true);
  expect(sameFloatingRect({ left: 120, top: 80, bottom: 220 }, { left: 121, top: 80, bottom: 220 })).toBe(false);
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

test("MoodboardScreen loading state keeps the board split layout", async () => {
  vi.doMock("./MoodboardCanvas.tsx", () => ({ MoodboardCanvas: () => <div data-testid="mock-moodboard-canvas" /> }));
  const { MoodboardScreen } = await import("../screens/MoodboardScreen.tsx");

  render(
    <ApiProvider client={makeFakeApi({ getMoodboard: async () => new Promise(() => {}) })}>
      <MoodboardScreen boardId="b1" onBack={() => {}} onOpenSettings={() => {}} />
    </ApiProvider>,
  );

  expect(screen.getByText("Loading moodboard")).toBeInTheDocument();
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
