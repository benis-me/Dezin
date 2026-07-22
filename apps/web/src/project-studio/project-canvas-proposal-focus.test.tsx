import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { WorkspaceGraph, WorkspaceLayout } from "../lib/api.ts";

const flowHarness = vi.hoisted(() => {
  const instance = {
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    setViewport: vi.fn(async () => true),
    fitView: vi.fn(async () => true),
    getNodes: vi.fn(() => []),
  };
  return {
    instance,
    initialize: null as null | (() => void),
  };
});

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Background: () => null,
    ReactFlow: ({
      nodes,
      onInit,
      children,
      "aria-label": ariaLabel,
      tabIndex,
    }: {
      nodes: Array<{ id: string }>;
      onInit?: (instance: typeof flowHarness.instance) => void;
      children?: ReactNode;
      "aria-label"?: string;
      tabIndex?: number;
    }) => {
      flowHarness.initialize = () => onInit?.(flowHarness.instance);
      return (
        <div role="application" aria-label={ariaLabel} tabIndex={tabIndex}>
          {nodes.map((node) => (
            <div
              key={node.id}
              className="react-flow__node"
              data-id={node.id}
              tabIndex={0}
            />
          ))}
          {children}
        </div>
      );
    },
  };
});

import { ProjectCanvas } from "./canvas/ProjectCanvas.tsx";
import { buildProposalDiff } from "./proposal/proposal-diff.ts";

const graph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 1,
  nodes: [{
    id: "page-home",
    workspaceId: "workspace-1",
    kind: "page",
    artifactId: "artifact-home",
    name: "Home",
  }],
  edges: [],
};

const layout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [{ id: "page-home", kind: "node", x: 40, y: 40, parentGroupId: null }],
  viewport: { x: 0, y: 0, zoom: 1 },
  checksum: "layout-1",
};

test("an initially offscreen proposal waits for delayed ReactFlow initialization before fit and focus", async () => {
  flowHarness.initialize = null;
  flowHarness.instance.fitView.mockClear();
  const proposal = {
    id: "proposal-offscreen",
    baseGraphRevision: graph.revision,
    baseSnapshotId: "snapshot-1",
    baseGraph: graph,
    baseLayoutChecksum: layout.checksum,
    baseLayout: layout,
    operations: [{
      id: "add-offscreen-page",
      type: "add-node" as const,
      node: {
        id: "page-offscreen",
        kind: "page" as const,
        artifactId: "artifact-offscreen",
        name: "Offscreen page",
      },
    }],
    layoutOperations: [{
      type: "move" as const,
      objectId: "page-offscreen",
      x: 5_000,
      y: 120,
    }],
  };
  const proposalDiff = buildProposalDiff(proposal, {
    graph,
    activeSnapshotId: "snapshot-1",
    layoutChecksum: layout.checksum,
  });
  const rendered = render(
    <ProjectCanvas
      projectId="project-1"
      projectName="Storefront"
      graph={graph}
      layout={layout}
      artifactRevisionIds={{ "artifact-home": "revision-home" }}
      selectedNodeIds={[]}
      onSelectionChange={() => {}}
      onSaveLayout={async () => layout}
      onApplyGraphCommands={async () => {}}
      onOpenArtifact={() => {}}
      proposal={{ id: proposal.id }}
      proposalDiff={proposalDiff}
      proposalFocus={{ key: "node:page-offscreen", nonce: 1 }}
    />,
  );

  const proposalNodeId = "proposal:proposal-offscreen:node:page-offscreen";
  const target = await waitFor(() => {
    const node = rendered.container.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${proposalNodeId}"]`,
    );
    expect(node).not.toBeNull();
    return node!;
  });
  await act(async () => { await Promise.resolve(); });
  expect(flowHarness.instance.fitView).not.toHaveBeenCalled();

  await act(async () => {
    flowHarness.initialize?.();
    await Promise.resolve();
  });

  await waitFor(() => expect(flowHarness.instance.fitView).toHaveBeenCalledWith(expect.objectContaining({
    nodes: [expect.objectContaining({
      id: proposalNodeId,
      position: { x: 5_000, y: 120 },
    })],
  })));
  await waitFor(() => expect(target).toHaveFocus());
});

test("proposal focus does not repeat for the same proposal and nonce after an authoritative overlay recompute", async () => {
  flowHarness.initialize = null;
  flowHarness.instance.fitView.mockClear();
  const proposal = (name: string) => ({
    id: "proposal-stable-focus",
    baseGraphRevision: graph.revision,
    baseSnapshotId: "snapshot-1",
    baseGraph: graph,
    baseLayoutChecksum: layout.checksum,
    baseLayout: layout,
    operations: [{
      id: "rename-home",
      type: "rename-node" as const,
      nodeId: "page-home",
      name,
    }],
    layoutOperations: [],
  });
  const diff = (name: string) => buildProposalDiff(proposal(name), {
    graph,
    activeSnapshotId: "snapshot-1",
    layoutChecksum: layout.checksum,
  });
  const canvas = (name: string) => (
    <ProjectCanvas
      projectId="project-1"
      projectName="Storefront"
      graph={graph}
      layout={layout}
      artifactRevisionIds={{ "artifact-home": "revision-home" }}
      selectedNodeIds={[]}
      onSelectionChange={() => {}}
      onSaveLayout={async () => layout}
      onApplyGraphCommands={async () => {}}
      onOpenArtifact={() => {}}
      proposal={{ id: "proposal-stable-focus" }}
      proposalDiff={diff(name)}
      proposalFocus={{ key: "node:page-home", nonce: 1 }}
    />
  );
  const rendered = render(
    <>
      <button type="button">Inspector field</button>
      {canvas("Reviewed home")}
    </>,
  );
  const proposalNodeId = "proposal:proposal-stable-focus:node:page-home";
  await waitFor(() => expect(rendered.container.querySelector(
    `.react-flow__node[data-id="${proposalNodeId}"]`,
  )).not.toBeNull());
  await act(async () => {
    flowHarness.initialize?.();
    await Promise.resolve();
  });
  await waitFor(() => expect(rendered.container.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${proposalNodeId}"]`,
  )).toHaveFocus());
  expect(flowHarness.instance.fitView).toHaveBeenCalledTimes(1);

  const inspectorField = screen.getByRole("button", { name: "Inspector field" });
  inspectorField.focus();
  rendered.rerender(
    <>
      <button type="button">Inspector field</button>
      {canvas("Reviewed home revised")}
    </>,
  );
  await act(async () => { await Promise.resolve(); });

  expect(inspectorField).toHaveFocus();
  expect(flowHarness.instance.fitView).toHaveBeenCalledTimes(1);
});
