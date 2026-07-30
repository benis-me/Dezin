import type { NodeProps } from "@xyflow/react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";
import { ArtifactFlowNode } from "./ArtifactFlowNode.tsx";

export function PageNode(props: NodeProps<WorkspaceFlowNode>) {
  return <ArtifactFlowNode {...props} />;
}
