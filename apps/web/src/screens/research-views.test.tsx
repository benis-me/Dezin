import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DirectionCard, ResearchCard, ResearchPanel, type ResearchCardData } from "./ResearchViews.tsx";
import type { ResearchDetail } from "../lib/api.ts";

afterEach(cleanup);

const doneResearch: ResearchCardData = {
  status: "done",
  activities: [],
  report: true,
  sources: 4,
  assets: 6,
  directions: [
    { slug: "bold", title: "Bold terminal" },
    { slug: "calm", title: "Calm editorial" },
  ],
};

const directions = [
  { slug: "bold", title: "Bold terminal", markdown: "# Bold terminal\n\nBig monospace type." },
  { slug: "calm", title: "Calm editorial", markdown: "# Calm editorial\n\nQuiet whitespace." },
];

test("ResearchCard opens the Research tab when clicked", () => {
  const onOpen = vi.fn();
  render(<ResearchCard research={doneResearch} chosenSlug="bold" onOpen={onOpen} />);
  fireEvent.click(screen.getByTestId("research-card"));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("ResearchCard highlights the chosen direction and leaves the others unselected", () => {
  render(<ResearchCard research={doneResearch} chosenSlug="calm" onOpen={() => {}} />);
  const chips = screen.getAllByTestId("research-card-direction");
  const calm = chips.find((c) => c.textContent?.includes("Calm editorial"))!;
  const bold = chips.find((c) => c.textContent?.includes("Bold terminal"))!;
  expect(calm.getAttribute("data-selected")).toBe("true");
  expect(bold.getAttribute("data-selected")).toBe("false");
});

test("ResearchCard is not interactive while research is still running", () => {
  const onOpen = vi.fn();
  const running: ResearchCardData = { status: "running", activities: [{ kind: "search", text: "searching" }] };
  render(<ResearchCard research={running} onOpen={onOpen} />);
  const card = screen.getByTestId("research-card");
  expect(card.getAttribute("role")).toBe(null);
  fireEvent.click(card);
  expect(onOpen).not.toHaveBeenCalled();
});

test("ResearchCard header shows plain-text status after the title, an open arrow, and no 'Open' label", () => {
  render(<ResearchCard research={doneResearch} chosenSlug="bold" onOpen={() => {}} />);
  // Status is plain text (no rounded tag), placed after the title.
  expect(screen.getByTestId("research-status").textContent).toContain("grounded");
  // An open affordance is a right-arrow at the far end — the word "Open" is gone.
  expect(screen.getByTestId("research-open-arrow")).toBeTruthy();
  expect(screen.getByTestId("research-card").textContent).not.toContain("Open");
});

test("ResearchCard renders directions as cards carrying a one-line summary", () => {
  const research: ResearchCardData = {
    ...doneResearch,
    directions: [
      { slug: "bold", title: "Bold terminal", summary: "Big monospace type with one loud accent." },
      { slug: "calm", title: "Calm editorial", summary: "Quiet whitespace and a serif display face." },
    ],
  };
  render(<ResearchCard research={research} chosenSlug="bold" onOpen={() => {}} />);
  const cards = screen.getAllByTestId("research-card-direction");
  const bold = cards.find((c) => c.textContent?.includes("Bold terminal"))!;
  expect(bold.textContent).toContain("Big monospace type");
  expect(bold.getAttribute("data-selected")).toBe("true");
  expect(cards.find((c) => c.textContent?.includes("Calm editorial"))!.getAttribute("data-selected")).toBe("false");
});

test("ResearchCard's search icon reflects the running state (animated while researching)", () => {
  const running: ResearchCardData = { status: "running", activities: [] };
  const { rerender } = render(<ResearchCard research={running} />);
  expect(screen.getByTestId("research-search-icon").getAttribute("data-running")).toBe("true");
  rerender(<ResearchCard research={doneResearch} chosenSlug="bold" onOpen={() => {}} />);
  expect(screen.getByTestId("research-search-icon").getAttribute("data-running")).toBe("false");
});

test("DirectionCard picks a direction, marks it selected, and locks further picks (one-shot)", () => {
  const onPick = vi.fn();
  render(<DirectionCard directions={directions} onPick={onPick} />);
  const options = screen.getAllByTestId("direction-option");
  fireEvent.click(options[0]!);
  expect(onPick).toHaveBeenCalledWith("bold");

  const after = screen.getAllByTestId("direction-option");
  expect(after[0]!.getAttribute("data-selected")).toBe("true");
  expect(after[1]!.getAttribute("data-selected")).toBe("false");
  // Picking commits the build; a second click must not re-trigger a run.
  fireEvent.click(after[1]!);
  expect(onPick).toHaveBeenCalledTimes(1);
});

test("DirectionCard reflects a previously chosen direction on reload and stays locked", () => {
  const onPick = vi.fn();
  render(<DirectionCard directions={directions} chosenSlug="calm" onPick={onPick} />);
  const options = screen.getAllByTestId("direction-option");
  const calm = options.find((o) => o.textContent?.includes("Calm editorial"))!;
  expect(calm.getAttribute("data-selected")).toBe("true");
  fireEvent.click(options.find((o) => o.textContent?.includes("Bold terminal"))!);
  expect(onPick).not.toHaveBeenCalled();
});

test("ResearchPanel lays directions out one-per-row (not a 2-col grid) and marks the chosen one", () => {
  const research: ResearchDetail = {
    exists: true,
    report: "",
    directions,
    chosenSlug: "bold",
  };
  render(<ResearchPanel research={research} assetUrl={(p) => `/a/${p}`} />);
  const rows = screen.getAllByTestId("panel-direction");
  expect(rows.length).toBe(2);

  const container = rows[0]!.parentElement!;
  expect(container.className).toContain("space-y-2");
  expect(container.className).not.toContain("grid-cols-2");

  const bold = rows.find((r) => r.textContent?.includes("Bold terminal"))!;
  const calm = rows.find((r) => r.textContent?.includes("Calm editorial"))!;
  expect(bold.getAttribute("data-selected")).toBe("true");
  expect(calm.getAttribute("data-selected")).toBe("false");
});

test("ResearchPanel puts each expanded direction body in a bounded scroll container", () => {
  const research: ResearchDetail = { exists: true, report: "", directions, chosenSlug: "bold" };
  render(<ResearchPanel research={research} assetUrl={(p) => `/a/${p}`} />);
  const bold = screen.getAllByTestId("panel-direction").find((r) => r.textContent?.includes("Bold terminal"))!;
  const scroller = bold.querySelector(".overflow-auto");
  expect(scroller).toBeTruthy();
  expect(scroller!.className).toMatch(/max-h-/);
});
