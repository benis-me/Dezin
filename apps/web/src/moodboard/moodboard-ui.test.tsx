import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoodboardNode } from "../lib/api.ts";
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
        onResetZoom={() => {}}
      />,
    );
  });

  const menu = screen.getByRole("menu");
  expect(menu).toHaveStyle({ left: "268px", top: "112px" });
  expect(screen.getByText("View")).toBeInTheDocument();
  expect(screen.getByText("Reset zoom")).toBeInTheDocument();
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
