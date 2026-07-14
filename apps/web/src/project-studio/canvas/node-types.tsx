import { memo } from "react";
import { ComponentNode } from "./nodes/ComponentNode.tsx";
import { LayoutGroupNode } from "./nodes/LayoutGroupNode.tsx";
import { PageNode } from "./nodes/PageNode.tsx";
import { ResourceNode } from "./nodes/ResourceNode.tsx";

export const workspaceNodeTypes = {
  page: memo(PageNode),
  component: memo(ComponentNode),
  resource: memo(ResourceNode),
  group: memo(LayoutGroupNode),
};
