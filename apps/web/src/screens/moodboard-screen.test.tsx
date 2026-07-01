import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MoodboardCanvasTopbar } from "../moodboard/MoodboardCanvasTopbar.tsx";
import { MoodboardScreen } from "./MoodboardScreen.tsx";

vi.mock("../moodboard/useMoodboardBoard.ts", () => ({
  useMoodboardBoard: () => ({ loading: true, detail: null }),
}));

vi.mock("../moodboard/MoodboardCanvas.tsx", () => ({
  MoodboardCanvas: () => <div data-testid="mock-moodboard-canvas" />,
}));

test("MoodboardCanvasTopbar mirrors the project artifact bar shape", () => {
  const onOpenModelSettings = vi.fn();
  const controls = {
    zoom: 1,
    layersOpen: false,
    presentationMode: false,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onFitView: vi.fn(),
    onSetZoom: vi.fn(),
    onToggleLayers: vi.fn(),
    onTogglePresentation: vi.fn(),
  };

  render(<MoodboardCanvasTopbar controls={controls} onOpenModelSettings={onOpenModelSettings} />);

  expect(screen.queryByRole("tab", { name: "Canvas" })).toBeNull();
  expect(screen.queryByText(/items/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  fireEvent.click(screen.getByRole("button", { name: "Layers" }));
  fireEvent.click(screen.getByRole("button", { name: "Presentation mode" }));
  fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
  expect(controls.onZoomOut).toHaveBeenCalledOnce();
  expect(controls.onToggleLayers).toHaveBeenCalledOnce();
  expect(controls.onTogglePresentation).toHaveBeenCalledOnce();
  expect(onOpenModelSettings).toHaveBeenCalledOnce();
});

test("MoodboardCanvasTopbar uses the project toolbar active style", () => {
  const controls = {
    zoom: 1,
    layersOpen: true,
    presentationMode: false,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onFitView: vi.fn(),
    onSetZoom: vi.fn(),
    onToggleLayers: vi.fn(),
    onTogglePresentation: vi.fn(),
  };

  render(<MoodboardCanvasTopbar controls={controls} />);

  const layers = screen.getByRole("button", { name: "Layers" });
  expect(layers).toHaveClass("!bg-primary");
  expect(layers).toHaveClass("!text-primary-foreground");
  expect(layers).toHaveClass("hover:!bg-primary");
});

test("MoodboardCanvasTopbar separates zoom controls from canvas toggles", () => {
  const controls = {
    zoom: 1,
    layersOpen: false,
    presentationMode: false,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onFitView: vi.fn(),
    onSetZoom: vi.fn(),
    onToggleLayers: vi.fn(),
    onTogglePresentation: vi.fn(),
  };

  const { container } = render(<MoodboardCanvasTopbar controls={controls} />);

  expect(container.querySelectorAll(".h-5.w-px.bg-border").length).toBe(2);
});

test("MoodboardScreen loading state keeps the project-style board shell", () => {
  render(<MoodboardScreen boardId="board-1" onBack={() => {}} onOpenSettings={() => {}} />);

  expect(screen.getByLabelText("Back to moodboards")).toBeInTheDocument();
  expect(screen.getAllByRole("status").some((status) => status.textContent === "Loading moodboard")).toBe(true);
  expect(
    screen
      .getAllByRole("status")
      .some((status) => status.textContent === "Loading moodboard" && status.className.includes("rounded-lg")),
  ).toBe(true);
  expect(screen.getByLabelText("Moodboard canvas")).toBeInTheDocument();
  expect(screen.queryByText("Loading canvas")).toBeNull();
});
