import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceCanvasToolbar } from "./WorkspaceCanvasToolbar.tsx";

afterEach(cleanup);

function renderToolbar(overrides: Partial<ComponentProps<typeof WorkspaceCanvasToolbar>> = {}) {
  return render(
    <WorkspaceCanvasToolbar
      tool="select"
      edgeFilter="flow"
      outlineOpen
      canGroup={false}
      canUngroup={false}
      canDeleteGroup={false}
      canDeleteRelationship={false}
      hasRelationshipSelection={false}
      relationshipDeleteLabel="Delete selected relationship"
      zoom={0.8}
      onToolChange={vi.fn()}
      onEdgeFilterChange={vi.fn()}
      onToggleOutline={vi.fn()}
      onFitView={vi.fn()}
      onZoomOut={vi.fn()}
      onZoomIn={vi.fn()}
      onSetZoom={vi.fn()}
      onGroup={vi.fn()}
      onUngroup={vi.fn()}
      onDeleteGroup={vi.fn()}
      onDeleteRelationship={vi.fn()}
      {...overrides}
    />,
  );
}

test("canvas tools expose Dezin tooltips instead of browser title attributes", async () => {
  const user = userEvent.setup();
  renderToolbar();

  const select = screen.getByRole("button", { name: "Select tool" });
  expect(select).not.toHaveAttribute("title");
  await user.hover(select);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Select");
  expect(screen.getByRole("tooltip")).toHaveTextContent("V");

  await user.unhover(select);
  await user.click(screen.getByRole("button", { name: "Canvas zoom: 80%" }));
  expect(screen.getByRole("menuitem", { name: /Fit workspace/ })).toHaveTextContent("⇧1");
});

test("selection actions stay out of the toolbar until the canvas context can use them", () => {
  const { container } = renderToolbar();

  expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Group selection/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Ungroup selection/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Delete group/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Delete selected relationship/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Relationship filter: Prototype flow" })).toBeInTheDocument();
  expect(container.querySelector(".dezin-canvas-toolbar--context")).toBeNull();
  expect(container.querySelectorAll(".dezin-canvas-toolbar")).toHaveLength(3);
});

test("the toolbar enables only the grouping actions that apply to the current selection", async () => {
  const user = userEvent.setup();
  const onGroup = vi.fn();
  renderToolbar({ canGroup: true, onGroup });

  const group = screen.getByRole("button", { name: "Group selection" });
  expect(group).toBeEnabled();
  expect(screen.queryByRole("button", { name: /Ungroup selection/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Delete group/ })).toBeNull();

  await user.click(group);
  expect(onGroup).toHaveBeenCalledOnce();
});

test("a selected derived relationship stays visible and explains why it cannot be edited", async () => {
  const user = userEvent.setup();
  const reason = "Uses relationships are derived and read-only";
  renderToolbar({
    hasRelationshipSelection: true,
    relationshipDeleteLabel: reason,
    relationshipDeleteDisabledReason: reason,
  });

  const relationshipAction = screen.getByRole("button", { name: reason });
  expect(relationshipAction).toHaveAttribute("aria-disabled", "true");
  expect(relationshipAction).toHaveAttribute("tabindex", "0");
  expect(screen.getAllByRole("button", { name: reason })).toHaveLength(1);

  await user.hover(relationshipAction);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
});

test("an editable selected relationship exposes its delete action", async () => {
  const user = userEvent.setup();
  const onDeleteRelationship = vi.fn();
  renderToolbar({
    canDeleteRelationship: true,
    hasRelationshipSelection: true,
    onDeleteRelationship,
  });

  const deleteRelationship = screen.getByRole("button", { name: "Delete selected relationship" });
  expect(deleteRelationship).toBeEnabled();
  await user.click(deleteRelationship);
  expect(onDeleteRelationship).toHaveBeenCalledOnce();
});

test("select and hand share Dezin's quiet centered interaction bar", async () => {
  const user = userEvent.setup();
  const onToolChange = vi.fn();
  renderToolbar({ onToolChange });

  const interactionMode = screen.getByRole("navigation", { name: "Canvas tools" });
  expect(interactionMode).toHaveClass("dezin-canvas-toolbar--tools");
  expect(interactionMode.parentElement).toHaveClass("app-no-drag");

  const select = screen.getByRole("button", { name: "Select tool" });
  const hand = screen.getByRole("button", { name: "Hand tool" });
  expect(select).toHaveAttribute("aria-pressed", "true");
  expect(hand).toHaveAttribute("aria-pressed", "false");
  expect(select).toHaveAttribute("data-active", "true");
  expect(select).not.toHaveClass("!bg-primary", "!text-primary-foreground");
  expect(hand).not.toHaveClass("!bg-primary", "!text-primary-foreground");
  expect(screen.getByRole("button", { name: "Toggle workspace outline" })).not.toHaveClass(
    "!bg-primary",
    "!text-primary-foreground",
  );

  await user.click(hand);
  expect(onToolChange).toHaveBeenCalledWith("hand");
});

test("zoom controls expose the current percentage, presets, and direct adjustments", async () => {
  const user = userEvent.setup();
  const onZoomOut = vi.fn();
  const onZoomIn = vi.fn();
  const onSetZoom = vi.fn();
  renderToolbar({ zoom: 0.8, onZoomOut, onZoomIn, onSetZoom });

  const zoomOut = screen.getByRole("button", { name: "Zoom out" });
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });
  expect(zoomOut).not.toHaveAttribute("aria-pressed");
  expect(zoomIn).not.toHaveAttribute("aria-pressed");
  await user.click(zoomOut);
  await user.click(zoomIn);
  expect(onZoomOut).toHaveBeenCalledOnce();
  expect(onZoomIn).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "Canvas zoom: 80%" }));
  expect(screen.getByRole("menuitem", { name: "50%" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "100%" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "200%" })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "100%" }));
  expect(onSetZoom).toHaveBeenCalledWith(1);
});

test("relationship visibility uses one compact menu instead of three competing tools", async () => {
  const user = userEvent.setup();
  const onEdgeFilterChange = vi.fn();
  renderToolbar({ onEdgeFilterChange });

  await user.click(screen.getByRole("button", { name: "Relationship filter: Prototype flow" }));
  const options = screen.getAllByRole("menuitemradio");
  expect(options).toHaveLength(3);
  expect(screen.getByRole("menuitemradio", { name: "Prototype flow" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "Semantic relations" })).toHaveAttribute("aria-checked", "false");
  await user.click(screen.getByRole("menuitemradio", { name: "Semantic relations" }));

  expect(onEdgeFilterChange).toHaveBeenCalledWith("relations");
  expect(screen.queryByRole("button", { name: "Show semantic relations" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Show all relations" })).toBeNull();
});

test("the canvas toolbar islands stay clipped inside the surface without native scrollbars", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/canvas/project-canvas.css`, "utf8");
  const layerStart = css.indexOf(".dezin-canvas-toolbar-layer {");
  const layerEnd = css.indexOf("}", layerStart);
  const layerRule = css.slice(layerStart, layerEnd);

  expect(layerRule).toMatch(/position:\s*absolute/);
  expect(layerRule).toMatch(/overflow:\s*hidden/);
  expect(layerRule).toMatch(/pointer-events:\s*none/);
  expect(css).not.toMatch(/\.dezin-canvas-toolbar\s*\{[^}]*overflow-[xy]:\s*auto/s);
});
