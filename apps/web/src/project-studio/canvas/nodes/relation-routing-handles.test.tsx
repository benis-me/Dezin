import { render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiProvider } from "../../../lib/api-context.tsx";
import { makeFakeApi } from "../../../test/fake-api.ts";
import type { WorkspaceFlowNode, WorkspaceFlowNodeData } from "../workspace-graph-adapter.ts";
import { ComponentNode } from "./ComponentNode.tsx";
import { ResourceNode } from "./ResourceNode.tsx";

vi.mock("@xyflow/react", () => ({
  Handle: ({
    id,
    className,
    position,
  }: {
    id: string;
    className?: string;
    position: string;
  }) => <span data-testid={`handle-${id}`} data-class={className} data-position={position} />,
  Position: {
    Left: "left",
    Right: "right",
    Top: "top",
    Bottom: "bottom",
  },
}));

vi.mock("./ArtifactNodePreview.tsx", () => ({
  ArtifactNodePreview: () => <div data-testid="artifact-preview" />,
}));

const baseData: WorkspaceFlowNodeData = {
  objectId: "node-1",
  kind: "component",
  name: "Navigation",
  projectId: "project-1",
  artifactId: "artifact-1",
  resourceId: null,
  revisionId: null,
  zoomLevel: "compact",
  incomingCount: 1,
  outgoingCount: 0,
  qualityState: "unassessed",
  qualityScore: null,
  generationState: "idle",
  collapsed: false,
  parentGroupId: null,
  groupRole: null,
  memberCount: 0,
  minimumGroupWidth: 0,
  minimumGroupHeight: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function expectSideRoutingHandles(kind: "component" | "resource") {
  for (const side of ["left", "right"] as const) {
    expect(screen.getByTestId(`handle-${kind}-source-${side}`)).toHaveAttribute("data-position", side);
    expect(screen.getByTestId(`handle-${kind}-target-${side}`)).toHaveAttribute(
      "data-class",
      expect.stringContaining("dezin-flow-handle--routing"),
    );
  }
  for (const side of ["top", "bottom"] as const) {
    expect(screen.queryByTestId(`handle-${kind}-source-${side}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`handle-${kind}-target-${side}`)).not.toBeInTheDocument();
  }
}

describe("semantic relation routing handles", () => {
  test("component nodes expose only left and right source and target anchors", () => {
    render(<ComponentNode {...{
      data: baseData,
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expectSideRoutingHandles("component");
  });

  test("resource nodes expose only left and right source and target anchors", () => {
    render(<ResourceNode {...{
      data: {
        ...baseData,
        kind: "resource",
        artifactId: null,
        resourceId: "resource-1",
      },
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expectSideRoutingHandles("resource");
  });

  test("a published Resource shows its Revision quality instead of a stale completed generation state", () => {
    render(<ResourceNode {...{
      data: {
        ...baseData,
        kind: "resource",
        artifactId: null,
        resourceId: "resource-1",
        revisionId: "revision-1",
        resourceQualityState: "grounded",
        generationState: "complete",
      },
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(screen.getByText("Grounded")).toBeInTheDocument();
    expect(screen.queryByText("Finalizing revision")).not.toBeInTheDocument();
  });

  test("Research nodes render a compact decision-brief preview from the exact Revision", () => {
    render(<ResourceNode {...{
      data: {
        ...baseData,
        kind: "resource",
        artifactId: null,
        resourceId: "research-1",
        revisionId: "research-revision-1",
        resourceKind: "research",
        resourcePreview: {
          kind: "research",
          executiveSummary: "Festival audiences need a strong first-glance programming hierarchy.",
          findingCount: 4,
          evidenceDirectionCount: 2,
          hypothesisDirectionCount: 1,
        },
      },
      selected: false,
    } as unknown as NodeProps<WorkspaceFlowNode>} />);

    expect(screen.getByRole("group", { name: "Research decision brief preview" })).toBeInTheDocument();
    expect(screen.getByText("Festival audiences need a strong first-glance programming hierarchy.")).toBeInTheDocument();
    expect(screen.getByText("4 findings · 3 directions")).toBeInTheDocument();
  });

  test("Moodboard nodes load the exact authenticated cover Asset as a blob image", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:moodboard-cover");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const getResourceRevisionBlob = vi.fn(async () => new Blob(["cover"], { type: "image/webp" }));
    const client = makeFakeApi({ getResourceRevisionBlob });

    render(
      <ApiProvider client={client}>
        <ResourceNode {...{
          data: {
            ...baseData,
            kind: "resource",
            name: "Festival moodboard",
            artifactId: null,
            resourceId: "moodboard-1",
            revisionId: "moodboard-revision-1",
            resourceKind: "moodboard",
            resourcePreview: {
              kind: "moodboard",
              boardName: "KITE / Direction A",
              cover: {
                assetId: "asset-cover",
                path: "/api/projects/project-1/resources/moodboard-1/revisions/moodboard-revision-1/assets/asset-cover",
                alt: "KITE / Direction A cover",
                width: 1600,
                height: 900,
              },
              assetCount: 7,
            },
          },
          selected: false,
        } as unknown as NodeProps<WorkspaceFlowNode>} />
      </ApiProvider>,
    );

    const cover = await screen.findByRole("img", { name: "KITE / Direction A cover" });
    expect(cover).toHaveAttribute("src", "blob:moodboard-cover");
    expect(getResourceRevisionBlob).toHaveBeenCalledWith(
      "/api/projects/project-1/resources/moodboard-1/revisions/moodboard-revision-1/assets/asset-cover",
      expect.any(AbortSignal),
    );
  });
});
