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

  render(<MoodboardCanvasTopbar nodeCount={3} selectedCount={2} onOpenModelSettings={onOpenModelSettings} />);

  expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("3 items · 2 selected")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
  expect(onOpenModelSettings).toHaveBeenCalledOnce();
});

test("MoodboardScreen loading state keeps the project-style board shell", () => {
  render(<MoodboardScreen boardId="board-1" onBack={() => {}} onOpenSettings={() => {}} />);

  expect(screen.getByLabelText("Back to moodboards")).toBeInTheDocument();
  expect(screen.getAllByRole("status").some((status) => status.textContent === "Loading moodboard")).toBe(true);
  expect(screen.getByLabelText("Moodboard canvas")).toBeInTheDocument();
  expect(screen.queryByText("Loading canvas")).toBeNull();
});
