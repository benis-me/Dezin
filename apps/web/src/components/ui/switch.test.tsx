import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Switch } from "./switch.tsx";

test("Switch uses an inset thumb with even visual margins", () => {
  render(<Switch aria-label="Enable provider" checked onCheckedChange={() => {}} />);

  const track = screen.getByRole("switch");
  const thumb = track.querySelector("span");
  expect(track).toHaveClass("p-[3px]");
  expect(thumb).toHaveClass("size-[18px]");
  expect(thumb).toHaveClass("translate-x-4");
});

test("Switch toggles through the checked change callback", () => {
  const onCheckedChange = vi.fn();
  render(<Switch aria-label="Enable provider" checked={false} onCheckedChange={onCheckedChange} />);

  fireEvent.click(screen.getByRole("switch"));
  expect(onCheckedChange).toHaveBeenCalledWith(true);
});
