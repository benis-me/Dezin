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
  const fit = screen.getByRole("button", { name: "Fit workspace" });
  await user.hover(fit);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Fit workspace");
  expect(screen.getByRole("tooltip")).toHaveTextContent("⇧1");
});

test("selection actions keep fixed toolbar slots while the current context cannot use them", () => {
  renderToolbar();

  expect(screen.getByRole("group", { name: "Grouping tools" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Group selection/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: /Ungroup selection/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: /Delete group/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: /Delete selected relationship/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: "Relationship filter: Prototype flow" })).toBeInTheDocument();
});

test("the toolbar enables only the grouping actions that apply to the current selection", async () => {
  const user = userEvent.setup();
  const onGroup = vi.fn();
  renderToolbar({ canGroup: true, onGroup });

  const group = screen.getByRole("button", { name: "Group selection" });
  expect(group).toBeEnabled();
  expect(screen.getByRole("button", { name: /Ungroup selection/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: /Delete group/ })).toHaveAttribute("aria-disabled", "true");

  await user.click(group);
  expect(onGroup).toHaveBeenCalledOnce();
});

test("a selected derived relationship stays visible and explains why it cannot be edited", async () => {
  const user = userEvent.setup();
  const reason = "Uses relationships are derived and read-only";
  renderToolbar({
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
  renderToolbar({ canDeleteRelationship: true, onDeleteRelationship });

  const deleteRelationship = screen.getByRole("button", { name: "Delete selected relationship" });
  expect(deleteRelationship).toBeEnabled();
  await user.click(deleteRelationship);
  expect(onDeleteRelationship).toHaveBeenCalledOnce();
});

test("only the active canvas tool uses the primary accent language", () => {
  renderToolbar();

  expect(screen.getByRole("navigation", { name: "Canvas tools" })).toHaveClass("app-no-drag");
  expect(screen.getByRole("button", { name: "Select tool" })).toHaveClass("!bg-primary", "!text-primary-foreground");
  expect(screen.getByRole("button", { name: "Relationship filter: Prototype flow" })).not.toHaveClass("!bg-primary", "!text-primary-foreground");
  expect(screen.getByRole("button", { name: "Hand tool" })).not.toHaveClass("!bg-primary");
});

test("zoom controls expose the current percentage, presets, and direct adjustments", async () => {
  const user = userEvent.setup();
  const onZoomOut = vi.fn();
  const onZoomIn = vi.fn();
  const onSetZoom = vi.fn();
  renderToolbar({ zoom: 0.8, onZoomOut, onZoomIn, onSetZoom });

  await user.click(screen.getByRole("button", { name: "Zoom out" }));
  await user.click(screen.getByRole("button", { name: "Zoom in" }));
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

test("the narrow canvas toolbar remains touch-scrollable without painting a native scrollbar", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/canvas/project-canvas.css`, "utf8");
  const toolbarStart = css.indexOf(".dezin-canvas-toolbar {");
  const toolbarEnd = css.indexOf("}", toolbarStart);
  const toolbarRule = css.slice(toolbarStart, toolbarEnd);

  expect(toolbarRule).toMatch(/overflow-x:\s*auto/);
  expect(toolbarRule).toMatch(/overflow-y:\s*hidden/);
  expect(toolbarRule).toMatch(/scrollbar-width:\s*none/);
  expect(css).toMatch(/\.dezin-canvas-toolbar::?-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
});
