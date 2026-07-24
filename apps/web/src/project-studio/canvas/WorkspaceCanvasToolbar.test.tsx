import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceCanvasToolbar } from "./WorkspaceCanvasToolbar.tsx";

afterEach(cleanup);

function renderToolbar() {
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
      onToolChange={vi.fn()}
      onEdgeFilterChange={vi.fn()}
      onToggleOutline={vi.fn()}
      onFitView={vi.fn()}
      onGroup={vi.fn()}
      onUngroup={vi.fn()}
      onDeleteGroup={vi.fn()}
      onDeleteRelationship={vi.fn()}
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

test("disabled canvas actions still explain themselves through a tooltip", async () => {
  const user = userEvent.setup();
  renderToolbar();

  const group = screen.getByRole("button", { name: "Group selection" });
  expect(group).toBeDisabled();
  expect(group.parentElement).toHaveAccessibleName(
    "Group selection. Select one or more objects to group",
  );
  await user.hover(group.parentElement!);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Select one or more objects to group");
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
