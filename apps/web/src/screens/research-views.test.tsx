import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ResearchCard, ResearchPanel, type ResearchCardData } from "./ResearchViews.tsx";
import type { ResearchDetail } from "../lib/api.ts";

vi.mock("../moodboard/MoodboardCanvas.tsx", () => ({
  MoodboardCanvas: (props: { nodes: unknown[] }) => <div data-testid="visual-moodboard" data-nodes={props.nodes.length} />,
}));

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

test("ResearchCard long direction titles truncate instead of overflowing the card (min-w-0)", () => {
  const research: ResearchCardData = {
    ...doneResearch,
    directions: [{ slug: "b", title: "Direction B — Workbench (the convention-breaker)", summary: "A calm chat that knows it is a coding tool." }],
  };
  render(<ResearchCard research={research} onOpen={() => {}} />);
  const title = screen.getByText("Direction B — Workbench (the convention-breaker)");
  // `truncate` only clips-with-ellipsis when the flex child can shrink below its content width,
  // which requires min-w-0 — otherwise the title overflows and the card's overflow-hidden slices it.
  expect(title.className).toContain("truncate");
  expect(title.className).toContain("min-w-0");
});

test("ResearchCard's search icon reflects the running state (animated while researching)", () => {
  const running: ResearchCardData = { status: "running", activities: [] };
  const { rerender } = render(<ResearchCard research={running} />);
  expect(screen.getByTestId("research-search-icon").getAttribute("data-running")).toBe("true");
  rerender(<ResearchCard research={doneResearch} chosenSlug="bold" onOpen={() => {}} />);
  expect(screen.getByTestId("research-search-icon").getAttribute("data-running")).toBe("false");
});

const gateResearch: ResearchCardData = {
  ...doneResearch,
  directions: [
    { slug: "bold", title: "Bold terminal", summary: "Big monospace type." },
    { slug: "calm", title: "Calm editorial", summary: "Quiet whitespace." },
  ],
};

test("ResearchCard hosts the direction gate inline: click selects, only Submit commits the pick", () => {
  const onPick = vi.fn();
  render(<ResearchCard research={gateResearch} onPick={onPick} onOpen={() => {}} />);
  const options = screen.getAllByTestId("research-card-direction");
  // Selecting a direction must NOT submit — nothing runs until Submit.
  fireEvent.click(options[0]!);
  expect(onPick).not.toHaveBeenCalled();
  expect(options[0]!.getAttribute("data-selected")).toBe("true");
  fireEvent.click(screen.getByTestId("research-submit-direction"));
  expect(onPick).toHaveBeenCalledWith("bold");
});

test("ResearchCard Submit is disabled until a direction is selected", () => {
  render(<ResearchCard research={gateResearch} onPick={() => {}} onOpen={() => {}} />);
  const submit = screen.getByTestId("research-submit-direction") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getAllByTestId("research-card-direction")[0]!);
  expect(submit.disabled).toBe(false);
});

test("ResearchCard: a chosen direction locks the gate (no Submit) and carries no outer shadow ring", () => {
  render(<ResearchCard research={gateResearch} chosenSlug="bold" onPick={() => {}} onOpen={() => {}} />);
  // Once chosen, there is no Submit and the directions are display-only.
  expect(screen.queryByTestId("research-submit-direction")).toBeNull();
  const bold = screen.getAllByTestId("research-card-direction").find((c) => c.textContent?.includes("Bold terminal"))!;
  expect(bold.getAttribute("data-selected")).toBe("true");
  expect(bold.className).not.toMatch(/\bring-/);
});

test("ResearchCard locks the picker immediately on Submit (optimistic — before chosenSlug round-trips)", () => {
  const onPick = vi.fn();
  // NO chosenSlug prop: the lock here comes purely from the optimistic pending state, not the server.
  render(<ResearchCard research={gateResearch} onPick={onPick} onOpen={() => {}} />);
  fireEvent.click(screen.getAllByTestId("research-card-direction").find((c) => c.textContent?.includes("Bold terminal"))!);
  fireEvent.click(screen.getByTestId("research-submit-direction"));
  expect(onPick).toHaveBeenCalledWith("bold");
  // Locked instantly: Submit gone, options are display-only (divs, not buttons), the pick is marked.
  expect(screen.queryByTestId("research-submit-direction")).toBeNull();
  const options = screen.getAllByTestId("research-card-direction");
  const bold = options.find((c) => c.textContent?.includes("Bold terminal"))!;
  const calm = options.find((c) => c.textContent?.includes("Calm editorial"))!;
  expect(bold.tagName).toBe("DIV");
  expect(bold.getAttribute("data-selected")).toBe("true");
  expect(calm.getAttribute("data-selected")).toBe("false");
  // Options can no longer be changed — clicking another does not re-pick.
  fireEvent.click(calm);
  expect(onPick).toHaveBeenCalledTimes(1);
});

test("ResearchPanel Visual tab renders the moodboard mount at the TOP, before the report", async () => {
  const research = {
    exists: true, report: "# Product", sources: [], directions: [], assets: [],
    visual: { exists: true, report: "# Visual\n\nMono palette.", sources: [], assets: [], boardId: "board-1" },
  };
  render(<ResearchPanel research={research as any} assetUrl={(p) => `/a/${p}`} visualAssetUrl={(p) => `/v/${p}`} />);
  screen.getByRole("tab", { name: /visual/i }).click();
  const mount = await screen.findByTestId("visual-moodboard-mount");
  const report = screen.getByText(/Mono palette/).closest("section")!;
  // mount precedes the report section → the report is DOCUMENT_POSITION_FOLLOWING relative to the mount.
  expect(mount.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

test("ResearchPanel shows Product and Visual sub-tabs; Visual renders the collected imagery + sources", async () => {
  const research = {
    exists: true, report: "# Product\n\nUsers skim.", sources: [], directions: [], assets: [],
    visual: {
      exists: true, report: "# Visual\n\n![hero](assets/hero.png)\n\nMono palette.",
      sources: [{ id: "s1", title: "Shot", url: "https://dribbble.com/shots/1", platform: "dribbble", designer: "Jane", reached: true }],
      assets: ["visual/assets/hero.png"], boardId: "board-1",
    },
  };
  const { getByRole, findByText, getByText } = render(
    <ResearchPanel research={research as any} assetUrl={(p) => `/a/${p}`} visualAssetUrl={(p) => `/v/${p}`} />,
  );
  getByText(/Users skim/);                         // Product visible by default
  getByRole("tab", { name: /visual/i }).click();   // switch to Visual
  await findByText(/Mono palette/);
  getByText(/dribbble/i);
  getByText(/Jane/);
});

test("ResearchCard splits activities into product and visual lanes", () => {
  const { getByText } = render(
    <ResearchCard
      research={{
        status: "running",
        activities: [
          { kind: "search", text: "scanning rival landing pages", track: "product" },
          { kind: "search", text: "dribbble shots", track: "visual" },
        ] as any,
      }}
    />,
  );
  getByText(/rival landing pages/);
  getByText(/dribbble shots/);
  getByText(/visual/i); // a lane label
});
