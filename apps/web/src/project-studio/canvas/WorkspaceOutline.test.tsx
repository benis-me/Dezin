import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceOutline } from "./WorkspaceOutline.tsx";
import type { WorkspaceFlowNode } from "./workspace-graph-adapter.ts";

function node(overrides: {
  id: string;
  kind: WorkspaceFlowNode["data"]["kind"];
  name: string;
  parentId?: string;
  artifactId?: string;
  resourceId?: string;
  revisionId?: string | null;
  collapsed?: boolean;
  selected?: boolean;
}): WorkspaceFlowNode {
  return {
    id: overrides.id,
    type: overrides.kind,
    position: { x: 0, y: 0 },
    parentId: overrides.parentId,
    selected: overrides.selected,
    data: {
      objectId: overrides.id,
      kind: overrides.kind,
      name: overrides.name,
      projectId: "project one",
      artifactId: overrides.artifactId ?? null,
      resourceId: overrides.resourceId ?? null,
      revisionId: overrides.revisionId ?? null,
      zoomLevel: "full",
      incomingCount: 1,
      outgoingCount: 2,
      qualityState: "unassessed",
      qualityScore: null,
      generationState: "idle",
      collapsed: overrides.collapsed ?? false,
      parentGroupId: overrides.parentId ?? null,
      groupRole: overrides.kind === "group" ? "freeform" : null,
      memberCount: 0,
      minimumGroupWidth: 240,
      minimumGroupHeight: 144,
    },
  };
}

describe("WorkspaceOutline", () => {
  it("uses accessible shared controls for open, collapse, and close actions", async () => {
    const user = userEvent.setup();
    const onToggleCollapsed = vi.fn();
    const onClose = vi.fn();
    const nodes = [
      node({ id: "group", kind: "group", name: "Checkout flow" }),
      node({
        id: "page",
        kind: "page",
        name: "Order review",
        parentId: "group",
        artifactId: "artifact/one",
        selected: true,
      }),
      node({
        id: "research",
        kind: "resource",
        name: "Field research",
        resourceId: "resource/one",
        revisionId: "revision/one",
      }),
    ];

    render(
      <WorkspaceOutline
        projectId="project one"
        nodes={nodes}
        onSelect={vi.fn()}
        onToggleCollapsed={onToggleCollapsed}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("3 objects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select Page Order review/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Open Page Order review" })).toHaveAttribute(
      "href",
      "/projects/project%20one/artifacts/artifact%2Fone",
    );
    expect(screen.getByRole("link", { name: "Open Resource Field research" })).toHaveAttribute(
      "href",
      "/projects/project%20one/resources/resource%2Fone/revisions/revision%2Fone",
    );

    const collapse = screen.getByRole("button", { name: "Collapse group Checkout flow" });
    expect(collapse).toHaveAttribute("data-slot", "tooltip-trigger");
    await user.hover(collapse);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Collapse group Checkout flow");
    await user.click(collapse);
    expect(onToggleCollapsed).toHaveBeenCalledWith("group", true);

    await user.click(screen.getByRole("button", { name: "Close workspace outline" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("preserves additive canvas selection and contains keyboard shortcuts", () => {
    const onSelect = vi.fn();
    const nodes = [node({ id: "page", kind: "page", name: "Home", artifactId: "home" })];

    render(
      <WorkspaceOutline
        projectId="project"
        nodes={nodes}
        onSelect={onSelect}
        onToggleCollapsed={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const item = screen.getByRole("button", { name: /Select Page Home/ });
    fireEvent.click(item, { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("page", true);

    const keyDown = new KeyboardEvent("keydown", { key: "Delete", bubbles: true });
    const stopPropagation = vi.spyOn(keyDown, "stopPropagation");
    item.dispatchEvent(keyDown);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("shows a calm empty state instead of a blank floating panel", () => {
    render(
      <WorkspaceOutline
        projectId="project"
        nodes={[]}
        onSelect={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("0 objects")).toBeInTheDocument();
    expect(screen.getByText("Objects will appear here as the workspace takes shape.")).toBeInTheDocument();
  });
});
