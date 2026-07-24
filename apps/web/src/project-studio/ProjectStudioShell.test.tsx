import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectStudioShell } from "./ProjectStudioShell.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderShell(inspectorOpen: boolean, presentation = false) {
  return render(
    <ProjectStudioShell
      agent={<div>Agent content</div>}
      main={<div>Main canvas</div>}
      inspector={<div>Inspector content</div>}
      inspectorOpen={inspectorOpen}
      presentation={presentation}
    />,
  );
}

function useMobileViewport() {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 639px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

test("a closed inspector leaves a true two-column Studio without mounting hidden inspector work", () => {
  renderShell(false);

  const shell = screen.getByTestId("project-studio-shell");
  expect(shell).toHaveAttribute("data-inspector-layout", "closed");
  expect(screen.getByRole("separator", { name: "Resize Workspace Agent" })).toHaveClass("dezin-resize-separator");
  expect(screen.getByRole("complementary", { name: "Workspace Agent" })).toHaveTextContent("Agent content");
  expect(screen.getByRole("region", { name: "Studio surface" })).toHaveTextContent("Main canvas");
  expect(screen.queryByRole("complementary", { name: "Inspector" })).not.toBeInTheDocument();
  expect(screen.queryByText("Inspector content")).not.toBeInTheDocument();
});

test("desktop panels do not introduce nested horizontal or vertical scroll containers", () => {
  renderShell(false);

  const agentPanelContent = screen.getByRole("complementary", { name: "Workspace Agent" }).parentElement;
  const studioPanelContent = screen.getByTestId("project-studio-content").parentElement;

  expect(agentPanelContent).toHaveStyle({ overflow: "hidden" });
  expect(studioPanelContent).toHaveStyle({ overflow: "hidden" });
});

test("an open inspector docks only when the middle surface can retain its minimum working width", () => {
  renderShell(true);

  const shell = screen.getByTestId("project-studio-shell");
  expect(shell).toHaveAttribute("data-inspector-layout", "open");
  expect(screen.getByTestId("project-studio-content").className)
    .toContain("xl:grid-cols-[minmax(640px,1fr)_minmax(224px,18vw)]");
  expect(screen.getByRole("complementary", { name: "Inspector" })).toHaveTextContent("Inspector content");

  fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
  expect(screen.getByRole("complementary", { name: "Inspector" })).not.toHaveAttribute("data-narrow-reachable");
  expect(screen.getByRole("button", { name: "Show inspector" })).toBeInTheDocument();
});

test("the narrow Inspector moves focus inside on open and restores the trigger on close", () => {
  renderShell(true);

  const initialHide = screen.getByRole("button", { name: "Hide inspector" });
  initialHide.focus();
  fireEvent.click(initialHide);
  const show = screen.getByRole("button", { name: "Show inspector" });
  expect(show).toHaveFocus();

  fireEvent.click(show);
  const hide = screen.getByRole("button", { name: "Hide inspector" });
  expect(hide).toHaveFocus();

  fireEvent.click(hide);
  expect(screen.getByRole("button", { name: "Show inspector" })).toHaveFocus();
});

test("the floating Inspector delegates scrolling to its inner panel", () => {
  render(
    <ProjectStudioShell
      agent={<div>Agent content</div>}
      main={<div>Main canvas</div>}
      inspector={<div data-testid="scrolling-inspector-content" className="h-full overflow-y-auto">Inspector content</div>}
      inspectorOpen
    />,
  );

  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  expect(inspector).toHaveClass("overflow-hidden");
  expect(inspector).not.toHaveClass("overflow-auto");
  expect(screen.getByTestId("scrolling-inspector-content")).toHaveClass("overflow-y-auto");
});

test("mobile keeps the stacked Agent-over-canvas layout without a desktop resize handle", () => {
  useMobileViewport();
  renderShell(false);

  const shell = screen.getByTestId("project-studio-shell");
  expect(shell).toHaveAttribute("data-studio-layout", "mobile");
  expect(shell.firstElementChild).toHaveClass(
    "grid-rows-[minmax(156px,36%)_minmax(0,1fr)]",
  );
  expect(screen.queryByRole("separator", { name: "Resize Workspace Agent" })).not.toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Workspace Agent" })).toHaveTextContent("Agent content");
  expect(screen.getByRole("region", { name: "Studio surface" })).toHaveTextContent("Main canvas");
});

test("presentation keeps side panel state mounted but gives the design surface the full workspace", () => {
  renderShell(true, true);

  expect(screen.getByTestId("project-studio-shell")).toHaveAttribute("data-presentation", "true");
  expect(screen.getByText("Agent content").closest("aside")).toHaveAttribute("hidden");
  expect(screen.getByText("Inspector content").closest("aside")).toHaveAttribute("hidden");
  expect(screen.queryByRole("separator", { name: "Resize Workspace Agent" })).not.toBeInTheDocument();
  expect(screen.getByTestId("project-studio-content").className)
    .not.toContain("xl:grid-cols-[minmax(640px,1fr)_minmax(224px,18vw)]");
  expect(screen.getByRole("region", { name: "Studio surface" })).toHaveTextContent("Main canvas");
});
