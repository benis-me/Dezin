import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MoodboardCanvasTopbar } from "../moodboard/MoodboardCanvasTopbar.tsx";

test("MoodboardCanvasTopbar mirrors the project artifact bar shape", () => {
  const onOpenModelSettings = vi.fn();

  render(<MoodboardCanvasTopbar nodeCount={3} selectedCount={2} onOpenModelSettings={onOpenModelSettings} />);

  expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("3 items · 2 selected")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
  expect(onOpenModelSettings).toHaveBeenCalledOnce();
});
