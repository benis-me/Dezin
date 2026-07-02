import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";

const runtimeMocks = vi.hoisted(() => ({
  lastOptions: null as any,
  changeZoom: vi.fn(),
  fitView: vi.fn(),
  getLastCanvasPoint: vi.fn(() => null),
  hoverInRuntime: vi.fn(),
  refreshSelectionInRuntime: vi.fn(),
  selectIdsInRuntime: vi.fn(),
  selectInRuntime: vi.fn(),
  syncNodeInputsInRuntime: vi.fn(),
}));

vi.mock("./useLeaferMoodboardRuntime.ts", () => ({
  useLeaferMoodboardRuntime: vi.fn((options) => {
    runtimeMocks.lastOptions = options;
    return {
      appRef: { current: null },
      hostRef: { current: null },
      runtimeReady: true,
      selectionRect: null,
      isTransforming: false,
      sectionDraftRect: null,
      zoom: 1,
      changeZoom: runtimeMocks.changeZoom,
      fitView: runtimeMocks.fitView,
      fitNodes: vi.fn(() => true),
      handleAppReady: vi.fn(),
      handleLayerCreated: vi.fn(),
      selectInRuntime: runtimeMocks.selectInRuntime,
      selectIdsInRuntime: runtimeMocks.selectIdsInRuntime,
      refreshSelectionInRuntime: runtimeMocks.refreshSelectionInRuntime,
      syncNodeInputsInRuntime: runtimeMocks.syncNodeInputsInRuntime,
      hoverInRuntime: runtimeMocks.hoverInRuntime,
      getLastCanvasPoint: runtimeMocks.getLastCanvasPoint,
    };
  }),
}));

import { useMoodboardCanvasController } from "./useMoodboardCanvasController.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  runtimeMocks.lastOptions = null;
  Object.entries(runtimeMocks).forEach(([key, mock]) => {
    if (key !== "lastOptions") mock.mockClear();
  });
});

function note(id: string, x = 100): MoodboardNode {
  return {
    id,
    boardId: "board-1",
    type: "note",
    x,
    y: 120,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: id },
    createdAt: 1,
    updatedAt: 1,
  };
}

function image(id: string, assetId: string): MoodboardNode {
  return {
    id,
    boardId: "board-1",
    type: "image",
    x: 320,
    y: 120,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 1,
    data: { assetId, url: `/asset/${assetId}.png` },
    createdAt: 1,
    updatedAt: 1,
  };
}

function generator(id: string): MoodboardNode {
  return {
    id,
    boardId: "board-1",
    type: "image-generator",
    x: 100,
    y: 120,
    width: 360,
    height: 240,
    rotation: 0,
    zIndex: 0,
    data: { generatorPrompt: "soft light" },
    createdAt: 1,
    updatedAt: 1,
  };
}

function Probe({ nodes, viewKey }: { nodes: MoodboardNode[]; viewKey: string }) {
  useMoodboardCanvasController({
    viewKey,
    nodes,
    selectedIds: [],
    onSelectIds: () => {},
    onNodesChange: () => {},
    onAddNote: () => {},
    onAddSection: () => {},
    onAddImageGenerator: () => {},
    onUploadFiles: () => {},
    onGenerateImage: async () => {},
  });
  return null;
}

test("useMoodboardCanvasController fits the canvas once when entering a populated board", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

  const { rerender } = render(<Probe viewKey="board-1" nodes={[note("n1")]} />);
  await waitFor(() => expect(runtimeMocks.fitView).toHaveBeenCalledTimes(1));

  rerender(<Probe viewKey="board-1" nodes={[note("n1", 180), note("n2", 440)]} />);
  expect(runtimeMocks.fitView).toHaveBeenCalledTimes(1);

  rerender(<Probe viewKey="board-2" nodes={[note("n3")]} />);
  await waitFor(() => expect(runtimeMocks.fitView).toHaveBeenCalledTimes(2));
});

test("useMoodboardCanvasController routes canvas reference picking without changing selection", () => {
  const onSelectIds = vi.fn();
  const onReferenceNodePick = vi.fn();
  const nodes = [generator("g1"), generator("g2"), image("img1", "asset-1")];

  function PickProbe() {
    useMoodboardCanvasController({
      nodes,
      selectedIds: ["g1"],
      onSelectIds,
      onNodesChange: () => {},
      onAddNote: () => {},
      onAddSection: () => {},
      onAddImageGenerator: () => {},
      onUploadFiles: () => {},
      onGenerateImage: async () => {},
      referencePickActive: true,
      onReferenceNodePick,
    } as any);
    return null;
  }

  render(<PickProbe />);

  runtimeMocks.lastOptions.onSelectIds(["g2"]);
  expect(onSelectIds).not.toHaveBeenCalled();
  expect(onReferenceNodePick).not.toHaveBeenCalled();

  runtimeMocks.lastOptions.onSelectIds(["img1"]);
  expect(onReferenceNodePick).toHaveBeenCalledWith(nodes[2]);
  expect(onSelectIds).not.toHaveBeenCalled();

  runtimeMocks.lastOptions.onBlankTap({ x: 10, y: 20 });
  expect(onSelectIds).not.toHaveBeenCalled();
});

test("useMoodboardCanvasController selects a newly added image generator when the add callback returns its id", () => {
  const onSelectIds = vi.fn();
  const onAddImageGenerator = vi.fn(() => "new-generator");
  let controller!: ReturnType<typeof useMoodboardCanvasController>;

  function AddProbe() {
    controller = useMoodboardCanvasController({
      nodes: [image("img1", "asset-1")],
      selectedIds: ["img1"],
      onSelectIds,
      onNodesChange: () => {},
      onAddNote: () => {},
      onAddSection: () => {},
      onAddImageGenerator,
      onUploadFiles: () => {},
      onGenerateImage: async () => {},
    } as any);
    return null;
  }

  render(<AddProbe />);

  controller.addImageGeneratorAt({ x: 40, y: 50 }, { generatorPrompt: "soft light" });

  expect(onAddImageGenerator).toHaveBeenCalledWith({ x: 40, y: 50 }, { generatorPrompt: "soft light" });
  expect(onSelectIds).toHaveBeenCalledWith(["new-generator"]);
  expect(runtimeMocks.selectIdsInRuntime).toHaveBeenCalledWith(["new-generator"]);
});
