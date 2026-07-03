import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";

const runtimeMocks = vi.hoisted(() => ({
  lastOptions: null as any,
  changeZoom: vi.fn(),
  fitView: vi.fn(),
  getLastCanvasPoint: vi.fn((): { x: number; y: number } | null => null),
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
import { toInput } from "./canvas-utils.ts";
import { serializeMoodboardClipboardNodes } from "./moodboard-clipboard.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

test("useMoodboardCanvasController preserves data across consecutive data and geometry patches", () => {
  let controller!: ReturnType<typeof useMoodboardCanvasController>;
  let latestNodes: any[] = [];
  const onNodesChange = vi.fn((nodes) => {
    latestNodes = nodes;
  });

  function PatchProbe() {
    controller = useMoodboardCanvasController({
      nodes: [generator("g1")],
      selectedIds: ["g1"],
      onSelectIds: () => {},
      onNodesChange,
      onAddNote: () => {},
      onAddSection: () => {},
      onAddImageGenerator: () => {},
      onUploadFiles: () => {},
      onGenerateImage: async () => {},
    } as any);
    return null;
  }

  render(<PatchProbe />);

  controller.patchNodeData("g1", { generationParams: { aspectRatio: "16:9", size: "1536x1024" } });
  controller.patchNode("g1", { width: 360, height: 203 });

  expect(latestNodes[0]).toMatchObject({
    width: 360,
    height: 203,
    data: { generatorPrompt: "soft light", generationParams: { aspectRatio: "16:9", size: "1536x1024" } },
  });
});

function mockSystemClipboard() {
  const items: Array<Record<string, unknown>> = [];
  const write = vi.fn(async () => {});
  const read = vi.fn(async () => [] as unknown[]);
  class FakeClipboardItem {
    constructor(data: Record<string, unknown>) {
      items.push(data);
    }
  }
  vi.stubGlobal("ClipboardItem", FakeClipboardItem as unknown as typeof ClipboardItem);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, read } });
  return { items, write, read };
}

function dispatchPaste(clipboardData: { getData: (type: string) => string; files?: File[]; items?: unknown[] }) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { configurable: true, value: clipboardData });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

function renderController(props: Partial<Parameters<typeof useMoodboardCanvasController>[0]>) {
  let controller!: ReturnType<typeof useMoodboardCanvasController>;
  function Probe() {
    controller = useMoodboardCanvasController({
      nodes: [],
      selectedIds: [],
      onSelectIds: () => {},
      onNodesChange: () => {},
      onAddNote: () => {},
      onAddSection: () => {},
      onAddImageGenerator: () => {},
      onUploadFiles: () => {},
      onGenerateImage: async () => {},
      ...props,
    } as Parameters<typeof useMoodboardCanvasController>[0]);
    return null;
  }
  render(<Probe />);
  return () => controller;
}

test("copying a single image node writes both the node payload and an image blob to the system clipboard", async () => {
  const { items, write } = mockSystemClipboard();
  const pngBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => pngBlob }));
  vi.stubGlobal("fetch", fetchMock);

  const getController = renderController({ nodes: [image("img1", "asset-1")], selectedIds: ["img1"] });

  await act(async () => {
    getController().copyNodes(["img1"]);
  });
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));

  expect(fetchMock).toHaveBeenCalledWith("/asset/asset-1.png");
  expect(Object.keys(items[0])).toEqual(expect.arrayContaining(["text/plain", "image/png"]));
});

test("copying a note writes only the node payload, never an image", async () => {
  const { items, write } = mockSystemClipboard();
  const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob([]) }));
  vi.stubGlobal("fetch", fetchMock);

  const getController = renderController({ nodes: [note("n1")], selectedIds: ["n1"] });

  await act(async () => {
    getController().copyNodes(["n1"]);
  });
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));

  expect(fetchMock).not.toHaveBeenCalled();
  expect(Object.keys(items[0])).toEqual(["text/plain"]);
});

test("pasting moodboard node JSON via the paste event adds an offset copy to the board", async () => {
  const onNodesChange = vi.fn();
  runtimeMocks.getLastCanvasPoint.mockReturnValue({ x: 500, y: 400 });
  const source = image("img1", "asset-1");
  renderController({ nodes: [source], selectedIds: [], onNodesChange });

  const text = serializeMoodboardClipboardNodes("board-1", [toInput(source)]);
  dispatchPaste({ getData: (type) => (type === "text/plain" ? text : ""), files: [] });

  await waitFor(() => expect(onNodesChange).toHaveBeenCalled());
  const latest = onNodesChange.mock.calls.at(-1)![0] as Array<{ id?: string }>;
  expect(latest).toHaveLength(2);
  expect(latest.filter((node) => node.id !== "img1")).toHaveLength(1);
});

test("pasting an external image via the paste event uploads it at the cursor", async () => {
  const onUploadFiles = vi.fn();
  runtimeMocks.getLastCanvasPoint.mockReturnValue({ x: 640, y: 480 });
  renderController({ nodes: [], selectedIds: [], onUploadFiles });

  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  dispatchPaste({ getData: () => "", files: [file] });

  await waitFor(() => expect(onUploadFiles).toHaveBeenCalled());
  expect(onUploadFiles).toHaveBeenCalledWith([file], { x: 640, y: 480 });
});

test("pasteFromSystemClipboard uploads an image read from the async clipboard at the given point", async () => {
  const onUploadFiles = vi.fn();
  const { read } = mockSystemClipboard();
  const pngBlob = new Blob([new Uint8Array([9, 9, 9])], { type: "image/png" });
  read.mockResolvedValue([
    { types: ["image/png"], getType: async () => pngBlob },
  ]);

  const getController = renderController({ nodes: [], selectedIds: [], onUploadFiles });

  await act(async () => {
    await getController().pasteFromSystemClipboard({ x: 700, y: 500 });
  });

  await waitFor(() => expect(onUploadFiles).toHaveBeenCalledTimes(1));
  const [files, point] = onUploadFiles.mock.calls[0]!;
  expect(files).toHaveLength(1);
  expect((files as File[])[0].type).toBe("image/png");
  expect(point).toEqual({ x: 700, y: 500 });
});
