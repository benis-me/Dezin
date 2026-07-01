import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";
import { SelectionToolbar } from "./MoodboardCanvasToolbars.tsx";
import { MoodboardContextMenu } from "./MoodboardContextMenu.tsx";
import { MoodboardPropertiesPanel } from "./MoodboardPropertiesPanel.tsx";

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

  expect(screen.getByText("Properties").closest("aside")).toHaveStyle({ width: "360px" });
  expect(localStorage.getItem("dezin:moodboard:properties-width")).toBe("360");
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
