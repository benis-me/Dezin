import type { ArtifactRevision, WorkspaceSnapshot } from "../../lib/api.ts";

export function flowRevisions(): ArtifactRevision[] {
  const revision = (
    id: string,
    artifactId: string,
    trackId: string,
    renderSpec: Record<string, unknown>,
  ): ArtifactRevision => ({
    id,
    workspaceId: "workspace-flow",
    artifactId,
    trackId,
    sequence: 1,
    parentRevisionId: null,
    sourceCommitHash: `commit-${id}`,
    sourceTreeHash: `tree-${id}`,
    artifactRoot: `artifacts/${artifactId}`,
    kernelRevisionId: "kernel-flow",
    renderSpec,
    quality: {},
    contextPackHash: null,
    producedByRunId: null,
    legacyRunId: null,
    createdAt: 1,
  });
  return [
    revision("revision-a", "page-a", "track-a", {
      frames: [
        { id: "desktop", name: "Desktop", width: 1280, height: 800 },
        { id: "confirmed", name: "Confirmed", width: 1280, height: 800, initialState: "confirmed" },
      ],
    }),
    revision("revision-b", "page-b", "track-b", {
      frames: [
        { id: "desktop", name: "Desktop", width: 1280, height: 800 },
        { id: "receipt", name: "Receipt", width: 1280, height: 800, initialState: "receipt-ready" },
      ],
    }),
  ];
}

export function flowSnapshot(): WorkspaceSnapshot {
  const workspaceId = "workspace-flow";
  return {
    id: "snapshot-exact",
    workspaceId,
    sequence: 4,
    parentSnapshotId: "snapshot-3",
    graphRevision: 4,
    kernelRevisionId: "kernel-flow",
    reason: "flow",
    provenance: { kind: "graph-command", commandIds: ["flow"] },
    createdByRunId: null,
    createdAt: 4,
    graph: {
      workspaceId,
      revision: 4,
      nodes: [
        { id: "node-a", workspaceId, kind: "page", artifactId: "page-a", name: "Alpha" },
        { id: "node-b", workspaceId, kind: "page", artifactId: "page-b", name: "Beta" },
      ],
      edges: [
        {
          id: "edge-click",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-b",
          kind: "prototype",
          prototype: {
            status: "interactive",
            binding: {
              sourceArtifactId: "page-a",
              sourceRevisionId: "revision-a",
              sourceLocator: { designNodeId: "go-next" },
              trigger: "click",
              targetArtifactId: "page-b",
              transition: { type: "fade", durationMs: 180 },
            },
          },
        },
        {
          id: "edge-planned",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-b",
          kind: "prototype",
          prototype: { status: "planned" },
        },
        {
          id: "edge-broken",
          workspaceId,
          sourceNodeId: "node-a",
          targetNodeId: "node-b",
          kind: "prototype",
          prototype: {
            status: "broken",
            brokenReason: "Missing destination binding.",
            binding: {
              sourceArtifactId: "page-a",
              sourceRevisionId: "revision-a",
              sourceLocator: { designNodeId: "broken-action" },
              trigger: "click",
              targetArtifactId: "page-b",
            },
          },
        },
      ],
    },
    artifactTracks: { "page-a": "track-a", "page-b": "track-b" },
    artifactRevisions: { "page-a": "revision-a", "page-b": "revision-b" },
    resourceRevisions: {},
  };
}
