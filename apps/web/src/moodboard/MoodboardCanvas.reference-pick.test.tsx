import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";

const controllerMock = vi.hoisted(() => ({
  current: null as any,
  props: null as any,
  useMoodboardCanvasController: vi.fn((props: any) => {
    controllerMock.props = props;
    return controllerMock.current;
  }),
}));

const dndMock = vi.hoisted(() => ({
  onDragEnd: null as ((event: any) => void) | null,
}));

vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: ({ children, onDragEnd }: any) => {
    dndMock.onDragEnd = onDragEnd;
    return <div data-mock-dnd-provider>{children}</div>;
  },
}));

vi.mock("@dnd-kit/react/sortable", () => ({
  useSortable: () => ({
    ref: vi.fn(),
    isDragging: false,
    isDropTarget: false,
  }),
}));

vi.mock("@dezin/leafer-react", () => ({
  Frame: ({ children }: any) => <div data-mock-frame>{children}</div>,
  Img: () => <div data-mock-image />,
  Leafer: ({ children }: any) => <div>{children}</div>,
  Rect: () => <div data-mock-rect />,
  Txt: ({ children, text }: any) => <span>{text ?? children}</span>,
}));

vi.mock("@leafer-in/resize", () => ({}));
vi.mock("@leafer-in/scroll", () => ({
  ScrollBar: class {
    destroy() {}
  },
}));
vi.mock("leafer-editor", () => ({
  DragEvent: { START: "drag.start", DRAG: "drag", END: "drag.end" },
  EditorEvent: { SELECT: "editor.select", HOVER: "editor.hover" },
  EditorMoveEvent: { MOVE: "editor.move" },
  EditorRotateEvent: { ROTATE: "editor.rotate" },
  EditorScaleEvent: { SCALE: "editor.scale" },
  Platform: {
    toURL: (source: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`,
  },
  PointerEvent: { TAP: "pointer.tap", DOWN: "pointer.down", DOUBLE_TAP: "pointer.double-tap", MENU: "pointer.menu" },
  PropertyEvent: { LEAFER_CHANGE: "property.leafer-change" },
  ZoomEvent: { START: "zoom.start", ZOOM: "zoom", END: "zoom.end" },
}));

vi.mock("./useMoodboardCanvasController.ts", () => ({
  useMoodboardCanvasController: controllerMock.useMoodboardCanvasController,
}));

import { MoodboardCanvas } from "./MoodboardCanvas.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  controllerMock.current = null;
  controllerMock.props = null;
  dndMock.onDragEnd = null;
});

function generatorNode(): MoodboardNode {
  return {
    id: "gen-1",
    boardId: "board-1",
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
}

function noteNode(id = "note-1"): MoodboardNode {
  return {
    id,
    boardId: "board-1",
    type: "note",
    x: 120,
    y: 140,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: id === "note-1" ? "Material tone" : "Lighting direction" },
    createdAt: 1,
    updatedAt: 1,
  };
}

function baseCanvasMock(selected: MoodboardNode) {
  return {
    appRef: { current: null },
    hostRef: { current: document.createElement("div") },
    runtimeReady: true,
    tool: "select",
    zoom: 1,
    layersOpen: false,
    layerTree: [],
    collapsedLayerIds: new Set<string>(),
    selected,
    selectedIds: [selected.id],
    selectedNodes: [selected],
    selectionRect: { left: 200, top: 180, bottom: 260 },
    sectionDraftRect: null,
    contextMenu: null,
    contextTargetId: null,
    handleAppReady: vi.fn(),
    handleLayerCreated: vi.fn(),
    setTool: vi.fn(),
    setLayersOpen: vi.fn(),
    changeZoom: vi.fn(),
    fitView: vi.fn(),
    fitNodes: vi.fn(),
    uploadFiles: vi.fn(),
    patchNode: vi.fn(),
    patchNodeData: vi.fn(),
    patchSelectedData: vi.fn(),
    recordHistory: vi.fn(),
    duplicateNode: vi.fn(),
    duplicateNodes: vi.fn(),
    deleteNode: vi.fn(),
    deleteNodes: vi.fn(),
    alignNodes: vi.fn(),
    arrangeNodes: vi.fn(),
    setContextMenu: vi.fn(),
    addImageGeneratorAt: vi.fn(),
    addNoteAt: vi.fn(),
    addSectionAt: vi.fn(),
    copyNodes: vi.fn(),
    pasteCopiedNodes: vi.fn(),
    moveNodesLayerStep: vi.fn(),
    bringNodesToFront: vi.fn(),
    sendNodesToBack: vi.fn(),
    toggleLayerCollapsed: vi.fn(),
    toggleNodeVisible: vi.fn(),
    toggleNodeLocked: vi.fn(),
    setNodesVisible: vi.fn(),
    setNodesLocked: vi.fn(),
    hoverLayer: vi.fn(),
    selectLayer: vi.fn(),
    selectLayers: vi.fn(),
    reorderLayer: vi.fn(),
    renameNode: vi.fn(),
    getLastCanvasPoint: vi.fn(() => null),
  };
}

test("MoodboardCanvas sends the single selected node to Agent from the toolbar and Enter shortcut", () => {
  const node = noteNode();
  const onSendToAgent = vi.fn();
  controllerMock.current = baseCanvasMock(node);
  const Canvas = MoodboardCanvas as any;

  render(
    <Canvas
      nodes={[node]}
      selectedIds={[node.id]}
      onSendToAgent={onSendToAgent}
      onImageModelChange={() => {}}
      onSelectIds={() => {}}
      onNodesChange={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onAddImageGenerator={() => {}}
      onUploadFiles={() => {}}
      onGenerateImage={async () => {}}
    />,
  );

  fireEvent.click(screen.getByText("Send to Agent").closest("button")!);
  expect(onSendToAgent).toHaveBeenCalledWith([node]);

  fireEvent.keyDown(window, { key: "Enter" });
  expect(onSendToAgent).toHaveBeenLastCalledWith([node]);
  expect(onSendToAgent).toHaveBeenCalledTimes(2);
});

test("MoodboardCanvas sends multi-selected nodes to Agent from the toolbar and Enter shortcut", () => {
  const first = noteNode("note-1");
  const second = noteNode("note-2");
  const onSendToAgent = vi.fn();
  controllerMock.current = {
    ...baseCanvasMock(first),
    selected: null,
    selectedIds: [first.id, second.id],
    selectedNodes: [first, second],
  };
  const Canvas = MoodboardCanvas as any;

  render(
    <Canvas
      nodes={[first, second]}
      selectedIds={[first.id, second.id]}
      onSendToAgent={onSendToAgent}
      onImageModelChange={() => {}}
      onSelectIds={() => {}}
      onNodesChange={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onAddImageGenerator={() => {}}
      onUploadFiles={() => {}}
      onGenerateImage={async () => {}}
    />,
  );

  fireEvent.click(screen.getByText("Send to Agent").closest("button")!);
  expect(onSendToAgent).toHaveBeenCalledWith([first, second]);

  fireEvent.keyDown(window, { key: "Enter" });
  expect(onSendToAgent).toHaveBeenLastCalledWith([first, second]);
  expect(onSendToAgent).toHaveBeenCalledTimes(2);
});

test("MoodboardCanvas hides generator controls and shows a top banner while picking a canvas reference", async () => {
  const node = generatorNode();
  controllerMock.current = baseCanvasMock(node);

  render(
    <MoodboardCanvas
      nodes={[node]}
      selectedIds={[node.id]}
      imageModels={["gpt-image-1"]}
      imageModel="gpt-image-1"
      onImageModelChange={() => {}}
      onSelectIds={() => {}}
      onNodesChange={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onAddImageGenerator={() => {}}
      onUploadFiles={() => {}}
      onGenerateImage={async () => {}}
    />,
  );

  fireEvent.click(screen.getByLabelText("Add reference image"));
  fireEvent.click(screen.getByRole("button", { name: "从画布选择" }));

  expect(screen.getByRole("status", { name: "Canvas reference picking" })).toHaveTextContent("Select an image on the canvas");
  expect(screen.queryByLabelText("Image generator prompt")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Exit canvas reference picking" }));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Canvas reference picking" })).toBeNull());
});

test("MoodboardCanvas renders thumbnails for persisted reference assets without stored urls", () => {
  const node = generatorNode();
  node.data.referenceAssetIds = ["asset-1"];
  controllerMock.current = baseCanvasMock(node);

  render(
    <MoodboardCanvas
      nodes={[node]}
      selectedIds={[node.id]}
      imageModels={["gpt-image-1"]}
      imageModel="gpt-image-1"
      moodboardAssets={[
        {
          id: "asset-1",
          boardId: "board-1",
          kind: "image",
          fileName: "Reference.png",
          mimeType: "image/png",
          width: 120,
          height: 120,
          source: "upload",
          createdAt: 1,
        },
      ]}
      onImageModelChange={() => {}}
      onSelectIds={() => {}}
      onNodesChange={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onAddImageGenerator={() => {}}
      onUploadFiles={() => {}}
      onGenerateImage={async () => {}}
    />,
  );

  const referenceImages = screen.getByLabelText("Reference images");
  expect(within(referenceImages).getByAltText("Reference.png")).toHaveAttribute("src", "/api/moodboards/board-1/assets/asset-1");
});

test("MoodboardCanvas updates reference thumbnail order and badges immediately", async () => {
  const node = generatorNode();
  node.data.referenceAssetIds = ["asset-1", "asset-2"];
  controllerMock.current = baseCanvasMock(node);

  render(
    <MoodboardCanvas
      nodes={[node]}
      selectedIds={[node.id]}
      imageModels={["gpt-image-1"]}
      imageModel="gpt-image-1"
      moodboardAssets={[
        {
          id: "asset-1",
          boardId: "board-1",
          kind: "image",
          fileName: "First.png",
          mimeType: "image/png",
          width: 120,
          height: 120,
          source: "upload",
          createdAt: 1,
          url: "/assets/first.png",
        },
        {
          id: "asset-2",
          boardId: "board-1",
          kind: "image",
          fileName: "Second.png",
          mimeType: "image/png",
          width: 120,
          height: 120,
          source: "upload",
          createdAt: 2,
          url: "/assets/second.png",
        },
      ]}
      onImageModelChange={() => {}}
      onSelectIds={() => {}}
      onNodesChange={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onAddImageGenerator={() => {}}
      onUploadFiles={() => {}}
      onGenerateImage={async () => {}}
    />,
  );

  const referenceImages = screen.getByLabelText("Reference images");
  expect(within(referenceImages).getAllByRole("img", { hidden: true }).map((image) => image.getAttribute("alt"))).toEqual(["First.png", "Second.png"]);

  fireEvent.click(screen.getByText("Move reference image Second.png before previous"));

  await waitFor(() => {
    const images = within(referenceImages).getAllByRole("img", { hidden: true });
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["Second.png", "First.png"]);
    expect(images[0]?.parentElement).toHaveTextContent("#1");
    expect(images[1]?.parentElement).toHaveTextContent("#2");
  });
});

test("MoodboardCanvas commits reference thumbnail order from drag end", async () => {
  const node = generatorNode();
  node.data.referenceAssetIds = ["asset-1", "asset-2"];
  const canvas = baseCanvasMock(node);
  controllerMock.current = canvas;

  render(
    <MoodboardCanvas
      nodes={[node]}
      selectedIds={[node.id]}
      imageModels={["gpt-image-1"]}
      imageModel="gpt-image-1"
      moodboardAssets={[
        {
          id: "asset-1",
          boardId: "board-1",
          kind: "image",
          fileName: "First.png",
          mimeType: "image/png",
          width: 120,
          height: 120,
          source: "upload",
          createdAt: 1,
          url: "/assets/first.png",
        },
        {
          id: "asset-2",
          boardId: "board-1",
          kind: "image",
          fileName: "Second.png",
          mimeType: "image/png",
          width: 120,
          height: 120,
          source: "upload",
          createdAt: 2,
          url: "/assets/second.png",
        },
      ]}
      onImageModelChange={() => {}}
      onSelectIds={() => {}}
      onNodesChange={() => {}}
      onAddNote={() => {}}
      onAddSection={() => {}}
      onAddImageGenerator={() => {}}
      onUploadFiles={() => {}}
      onGenerateImage={async () => {}}
    />,
  );

  expect(dndMock.onDragEnd).toBeTypeOf("function");
  dndMock.onDragEnd?.({
    canceled: false,
    operation: {
      canceled: true,
      source: { id: "asset-2" },
      target: { id: "asset-1" },
    },
  });

  await waitFor(() => {
    const referenceImages = screen.getByLabelText("Reference images");
    const images = within(referenceImages).getAllByRole("img", { hidden: true });
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["Second.png", "First.png"]);
    expect(images[0]?.parentElement).toHaveTextContent("#1");
    expect(images[1]?.parentElement).toHaveTextContent("#2");
  });
  expect(canvas.patchNodeData).toHaveBeenCalledWith("gen-1", { referenceAssetIds: ["asset-2", "asset-1"] });
});
