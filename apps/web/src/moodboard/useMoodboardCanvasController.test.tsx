import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";

const runtimeMocks = vi.hoisted(() => ({
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
  useLeaferMoodboardRuntime: vi.fn(() => ({
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
  })),
}));

import { useMoodboardCanvasController } from "./useMoodboardCanvasController.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.values(runtimeMocks).forEach((mock) => mock.mockClear());
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
