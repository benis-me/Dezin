import { fireEvent, render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceFlowNode, WorkspaceFlowNodeData } from "../workspace-graph-adapter.ts";
import { LayoutGroupNode } from "./LayoutGroupNode.tsx";

vi.mock("@xyflow/react", () => ({
  NodeResizer: ({ isVisible }: { isVisible: boolean }) => (
    <span data-testid="group-resizer" data-visible={String(isVisible)} />
  ),
  NodeToolbar: ({
    children,
    isVisible,
    position,
    align,
    offset,
    role,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    isVisible?: boolean;
    position?: string;
    align?: string;
    offset?: number;
    role?: string;
    "aria-label"?: string;
  }) => isVisible ? (
    <div
      data-testid="group-toolbar"
      data-position={position}
      data-align={align}
      data-offset={offset}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  ) : null,
  Position: { Top: "top" },
}));

const data: WorkspaceFlowNodeData = {
  objectId: "group-1",
  kind: "group",
  name: "Components",
  projectId: "project-1",
  artifactId: null,
  resourceId: null,
  revisionId: null,
  zoomLevel: "compact",
  incomingCount: 0,
  outgoingCount: 0,
  qualityState: "not-applicable",
  qualityScore: null,
  generationState: "idle",
  collapsed: true,
  parentGroupId: null,
  groupRole: "component-library",
  memberCount: 3,
  minimumGroupWidth: 976,
  minimumGroupHeight: 300,
};

describe("layout group node", () => {
  test("keeps collapsed system-group actions in a screen-space toolbar without exposing rename", () => {
    const onRenameGroup = vi.fn();
    const onToggleCollapsed = vi.fn();
    render(<LayoutGroupNode {...{
      data: { ...data, onRenameGroup, onToggleCollapsed },
      selected: true,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(screen.getByTestId("group-resizer")).toHaveAttribute("data-visible", "false");
    expect(screen.getByRole("toolbar", { name: "Group actions for Components" })).toMatchObject({
      dataset: expect.objectContaining({
        position: "top",
        align: "start",
        offset: "10",
      }),
    });
    expect(screen.queryByRole("button", { name: "Rename group Components" })).not.toBeInTheDocument();
    expect(screen.getByText("Shared components")).toBeInTheDocument();
    expect(screen.getByText("3 components")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).toBeNull();

    const expand = screen.getByRole("button", { name: "Expand group Components" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);

    expect(onToggleCollapsed).toHaveBeenCalledWith("group-1", false);
    expect(onRenameGroup).not.toHaveBeenCalled();
  });

  test("uses the selected freeform group's screen-space toolbar for rename and collapse", () => {
    const onRenameGroup = vi.fn();
    const onToggleCollapsed = vi.fn();
    render(<LayoutGroupNode {...{
      data: {
        ...data,
        name: "Purchase journey",
        collapsed: false,
        groupRole: "freeform",
        onRenameGroup,
        onToggleCollapsed,
      },
      selected: true,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename group Purchase journey" }));
    const input = screen.getByRole("textbox", { name: "Rename group Purchase journey" });
    fireEvent.change(input, { target: { value: "Checkout journey" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRenameGroup).toHaveBeenCalledWith("group-1", "Checkout journey");

    fireEvent.click(screen.getByRole("button", { name: "Collapse group Purchase journey" }));
    expect(onToggleCollapsed).toHaveBeenCalledWith("group-1", true);
  });
});
