import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectStudioShell } from "./ProjectStudioShell.tsx";

afterEach(() => {
  localStorage.removeItem("dezin.project-studio.agent.width");
  localStorage.removeItem("dezin.project-studio.inspector.width");
  vi.restoreAllMocks();
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

function shellElement(inspectorOpen: boolean, presentation = false) {
  return (
    <ProjectStudioShell
      agent={<div>Agent content</div>}
      main={<div>Main canvas</div>}
      inspector={<div>Inspector content</div>}
      inspectorOpen={inspectorOpen}
      presentation={presentation}
    />
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

function useWideDesktopViewport() {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: query === "(min-width: 1280px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function useNarrowStudioViewport() {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function installPanelDimensions() {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    switch (this.getAttribute("data-testid")) {
      case "dezin-project-studio-layout":
        return 1_600;
      case "workspace-agent":
        return 320;
      case "studio-content":
      case "dezin-project-studio-inspector-layout":
        return 1_280;
      case "studio-surface-panel":
        return 960;
      case "studio-inspector":
        return 320;
      default:
        return this.getAttribute("role") === "separator" ? 0 : 1_280;
    }
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    switch (this.getAttribute("data-testid")) {
      case "workspace-agent":
      case "studio-surface-panel":
        return 0;
      case "studio-content":
        return 320;
      case "studio-inspector-resize":
      case "studio-inspector":
        return 960;
      default:
        return this.getAttribute("aria-label") === "Resize Workspace Agent" ? 320 : 0;
    }
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const left = this.offsetLeft;
    const width = this.getAttribute("aria-label") === "Resize Workspace Agent"
      ? 9
      : this.offsetWidth;
    return {
      x: left,
      y: 0,
      top: 0,
      right: left + width,
      bottom: 800,
      left,
      width,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect;
  });
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

test("a wide desktop docks the open Inspector behind its own accessible resize separator", () => {
  useWideDesktopViewport();
  renderShell(true);

  const shell = screen.getByTestId("project-studio-shell");
  expect(shell).toHaveAttribute("data-inspector-layout", "open");
  expect(screen.getByRole("separator", { name: "Resize Inspector" }))
    .toHaveClass("dezin-resize-separator", "app-no-drag");
  expect(screen.getByRole("complementary", { name: "Inspector" })).toHaveTextContent("Inspector content");
  expect(screen.queryByRole("button", { name: "Hide inspector" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show inspector" })).not.toBeInTheDocument();
});

test("a wide route transition unregisters a closed Inspector without applying a zero-percent panel layout", () => {
  useWideDesktopViewport();
  installPanelDimensions();
  const rendered = render(shellElement(true));

  expect(screen.getByTestId("studio-inspector")).toBeInTheDocument();
  expect(() => rendered.rerender(shellElement(false))).not.toThrow();
  expect(screen.queryByTestId("studio-inspector")).not.toBeInTheDocument();
  expect(Number(screen.getByTestId("studio-surface-panel").style.flexGrow)).toBe(100);

  expect(() => rendered.rerender(shellElement(true))).not.toThrow();
  expect(Number(screen.getByTestId("studio-inspector").style.flexGrow)).toBeCloseTo(25, 2);
});

test("a wide desktop opens the Inspector at approximately 320px by default", async () => {
  useWideDesktopViewport();
  installPanelDimensions();

  renderShell(true);

  await waitFor(() => {
    expect(Number(screen.getByTestId("studio-inspector").style.flexGrow)).toBeCloseTo(25, 2);
    expect(Number(screen.getByTestId("studio-surface-panel").style.flexGrow)).toBeCloseTo(75, 2);
  });
});

test("a wide Inspector resize persists its fraction for the next Shell mount", async () => {
  useWideDesktopViewport();
  installPanelDimensions();
  localStorage.setItem("dezin.project-studio.inspector.width", "0.25");
  const first = renderShell(true);

  const inspectorPanel = screen.getByTestId("studio-inspector");
  expect(Number(inspectorPanel.style.flexGrow)).toBeCloseTo(25, 4);
  const resize = screen.getByRole("separator", { name: "Resize Inspector" });
  await waitFor(() => expect(Number(resize.getAttribute("aria-valuenow"))).toBeGreaterThan(0));
  const initialMainPercent = Number(resize.getAttribute("aria-valuenow"));

  fireEvent.keyDown(resize, { key: "ArrowLeft" });
  await waitFor(() => {
    expect(Number(resize.getAttribute("aria-valuenow"))).toBeLessThan(initialMainPercent);
    expect(Number(localStorage.getItem("dezin.project-studio.inspector.width"))).toBeGreaterThan(0.25);
  });
  const savedFraction = Number(localStorage.getItem("dezin.project-studio.inspector.width"));

  first.unmount();
  renderShell(true);
  expect(Number(screen.getByTestId("studio-inspector").style.flexGrow))
    .toBeCloseTo(savedFraction * 100, 4);
});

test("keyboard resizing the Workspace Agent persists its completed layout for the next Shell mount", async () => {
  installPanelDimensions();
  const first = renderShell(false);
  const resize = screen.getByRole("separator", { name: "Resize Workspace Agent" });
  await waitFor(() => expect(Number(resize.getAttribute("aria-valuenow"))).toBeCloseTo(20, 2));

  fireEvent.keyDown(resize, { key: "ArrowRight" });
  await waitFor(() => {
    expect(Number(resize.getAttribute("aria-valuenow"))).toBeGreaterThan(20);
    expect(Number(localStorage.getItem("dezin.project-studio.agent.width"))).toBeGreaterThan(0.2);
  });
  const savedFraction = Number(localStorage.getItem("dezin.project-studio.agent.width"));

  first.unmount();
  renderShell(false);
  expect(Number(screen.getByTestId("workspace-agent").style.flexGrow))
    .toBeCloseTo(savedFraction * 100, 4);
});

test("pointer dragging the Workspace Agent separator resizes and persists only after release", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  installPanelDimensions();
  renderShell(false);
  const resize = screen.getByRole("separator", { name: "Resize Workspace Agent" });
  await waitFor(() => expect(Number(resize.getAttribute("aria-valuenow"))).toBeCloseTo(20, 2));

  fireEvent.pointerDown(resize, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX: 320,
    clientY: 400,
  });
  fireEvent.pointerMove(document, {
    pointerId: 1,
    pointerType: "mouse",
    buttons: 1,
    clientX: 360,
    clientY: 400,
    movementX: 40,
  });

  await waitFor(() => expect(Number(resize.getAttribute("aria-valuenow"))).toBeGreaterThan(20));
  expect(localStorage.getItem("dezin.project-studio.agent.width")).toBeNull();

  fireEvent.pointerUp(document, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    clientX: 360,
    clientY: 400,
  });
  await waitFor(() => {
    expect(Number(localStorage.getItem("dezin.project-studio.agent.width"))).toBeGreaterThan(0.2);
  });
});

test("a saved wide Inspector is capped at 400px so the design surface keeps priority", async () => {
  useWideDesktopViewport();
  installPanelDimensions();
  localStorage.setItem("dezin.project-studio.inspector.width", "0.38");

  renderShell(true);

  await waitFor(() => {
    expect(Number(screen.getByTestId("studio-inspector").style.flexGrow)).toBeCloseTo(31.25, 2);
    expect(Number(screen.getByTestId("studio-surface-panel").style.flexGrow)).toBeCloseTo(68.75, 2);
  });
  expect(localStorage.getItem("dezin.project-studio.inspector.width")).toBe("0.38");
});

test("a narrower Studio keeps the Inspector as the focus-managed edge overlay", () => {
  useNarrowStudioViewport();
  renderShell(true);

  expect(screen.queryByRole("separator", { name: "Resize Inspector" })).not.toBeInTheDocument();
  expect(Number(screen.getByTestId("studio-surface-panel").style.flexGrow)).toBe(100);
  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  expect(inspector).toHaveClass("absolute", "w-[min(320px,100%)]", "max-w-[320px]");
  fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
  expect(screen.queryByRole("complementary", { name: "Inspector" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show inspector" })).toBeInTheDocument();
});

test("the narrow Inspector moves focus inside on open and restores the trigger on close", () => {
  useNarrowStudioViewport();
  renderShell(true);

  const initialHide = screen.getByRole("button", { name: "Hide inspector" });
  initialHide.focus();
  fireEvent.click(initialHide);
  const show = screen.getByRole("button", { name: "Show inspector" });
  expect(show).toHaveFocus();
  expect(show).toHaveClass("top-1/2");
  expect(show).not.toHaveClass("top-3");

  fireEvent.click(show);
  const hide = screen.getByRole("button", { name: "Hide inspector" });
  expect(hide).toHaveFocus();

  fireEvent.click(hide);
  expect(screen.getByRole("button", { name: "Show inspector" })).toHaveFocus();
});

test("the edge Inspector delegates scrolling to its inner panel", () => {
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

test("an Inspector with its own dismiss action does not receive a competing Shell collapse control", () => {
  useNarrowStudioViewport();
  const onClose = vi.fn();
  render(
    <ProjectStudioShell
      agent={<div>Agent content</div>}
      main={<div>Main canvas</div>}
      inspector={<button type="button" onClick={onClose}>Close build plan</button>}
      inspectorOpen
      inspectorToggleLabel="build plan"
      narrowInspectorContentOwnsClose
    />,
  );

  expect(screen.queryByRole("button", { name: "Hide build plan" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show build plan" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close build plan" }));
  expect(onClose).toHaveBeenCalledTimes(1);
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
  useWideDesktopViewport();
  renderShell(true, true);

  expect(screen.getByTestId("project-studio-shell")).toHaveAttribute("data-presentation", "true");
  expect(screen.getByText("Agent content").closest("aside")).toHaveAttribute("hidden");
  expect(screen.getByText("Inspector content").closest("aside")).toHaveAttribute("hidden");
  expect(screen.queryByRole("separator", { name: "Resize Workspace Agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("separator", { name: "Resize Inspector" })).not.toBeInTheDocument();
  expect(screen.getByTestId("studio-surface-panel")).not.toHaveAttribute("hidden");
  expect(screen.getByTestId("studio-inspector")).toHaveAttribute("hidden");
  expect(screen.getByRole("region", { name: "Studio surface" })).toHaveTextContent("Main canvas");
});
