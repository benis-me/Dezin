import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { CanvasToolDocks } from "./CanvasToolDocks.tsx";
import { DesignCanvasHeader } from "./DesignCanvasHeader.tsx";
import { FocusedNodeChrome } from "./FocusedNodeChrome.tsx";

test("Design Canvas header keeps one named Project-actions toolbar", () => {
  const onToggleMainAgent = vi.fn();
  render(
    <DesignCanvasHeader
      projectName="Afterlight"
      canvasAvailable
      mainAgentOpen={false}
      onToggleMainAgent={onToggleMainAgent}
    />,
  );

  expect(screen.getByRole("heading", { level: 1, name: "Afterlight" })).toBeInTheDocument();
  const actions = screen.getByRole("toolbar", { name: "Project actions" });
  expect(within(actions).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
    .toEqual(["Main Agent", "Settings"]);
  expect(within(actions).getByRole("button", { name: "Settings" })).toBeDisabled();
  fireEvent.click(within(actions).getByRole("button", { name: "Main Agent" }));
  expect(onToggleMainAgent).toHaveBeenCalledOnce();
});

test("focused Node chrome exposes one back action and a labelled preview toolbar", () => {
  const onClose = vi.fn();
  const onChooseDevice = vi.fn();
  const onExport = vi.fn();
  const onSetAgentVisible = vi.fn();
  render(
    <FocusedNodeChrome
      transition={{ nodeId: "page-1", phase: "opening" }}
      motionAllowed={false}
      durationMs={420}
      previewToolsVisible
      previewDevice="tablet"
      previewExporting={false}
      agentVisible={false}
      onClose={onClose}
      onChooseDevice={onChooseDevice}
      onExport={onExport}
      onSetAgentVisible={onSetAgentVisible}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Close Node focus" }));
  expect(onClose).toHaveBeenCalledOnce();
  const tools = screen.getByRole("toolbar", { name: "Focused preview tools" });
  expect(within(tools).getByRole("group", { name: "Preview device" })).toBeInTheDocument();
  expect(within(tools).getByRole("button", { name: "Tablet preview" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(tools).getByRole("button", { name: "Mobile preview" }));
  fireEvent.click(within(tools).getByRole("button", { name: "Export" }));
  fireEvent.click(within(tools).getByRole("button", { name: "Show Node Agent" }));
  expect(onChooseDevice).toHaveBeenCalledWith("mobile");
  expect(onExport).toHaveBeenCalledOnce();
  expect(onSetAgentVisible).toHaveBeenCalledWith(true);
});

test("Canvas tool docks retain separate named editing and view toolbars", () => {
  const onToolChange = vi.fn();
  const onArrange = vi.fn();
  const onFit = vi.fn();
  render(
    <CanvasToolDocks
      tool="select"
      addMenuOpen={false}
      onAddMenuOpenChange={() => {}}
      onChooseNode={() => {}}
      onCreateComponentSystem={() => {}}
      onToolChange={onToolChange}
      arrangeDisabled={false}
      onArrange={onArrange}
      onFit={onFit}
      onZoomOut={() => {}}
      onZoomIn={() => {}}
      zoom={1.25}
    />,
  );

  const tools = screen.getByRole("toolbar", { name: "Canvas tools" });
  expect(within(tools).getByRole("button", { name: "Select tool" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(tools).getByRole("button", { name: "Hand tool" }));
  expect(onToolChange).toHaveBeenCalledWith("hand");
  const view = screen.getByRole("toolbar", { name: "Canvas view controls" });
  expect(within(view).getByLabelText("Canvas zoom")).toHaveTextContent("125%");
  fireEvent.click(within(view).getByRole("button", { name: "Arrange nodes" }));
  fireEvent.click(within(view).getByRole("button", { name: "Fit canvas" }));
  expect(onArrange).toHaveBeenCalledOnce();
  expect(onFit).toHaveBeenCalledOnce();
});
