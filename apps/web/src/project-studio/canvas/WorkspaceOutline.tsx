import { Component, Frame, PanelTop, Paperclip, X } from "lucide-react";
import { Link } from "../../router.tsx";
import type { WorkspaceFlowNode } from "./workspace-graph-adapter.ts";

function kindLabel(node: WorkspaceFlowNode): string {
  if (node.data.kind === "group") return "Group";
  if (node.data.kind === "page") return "Page";
  if (node.data.kind === "component") return "Component";
  return "Resource";
}

function KindIcon({ kind }: { kind: WorkspaceFlowNode["data"]["kind"] }) {
  if (kind === "group") return <Frame size={12} />;
  if (kind === "page") return <PanelTop size={12} />;
  if (kind === "component") return <Component size={12} />;
  return <Paperclip size={12} />;
}

function accessibleNodeName(node: WorkspaceFlowNode): string {
  const data = node.data;
  return [
    `Select ${kindLabel(node)} ${data.name}`,
    `outgoing ${data.outgoingCount}`,
    `incoming ${data.incomingCount}`,
    `quality ${data.qualityState}`,
    `generation ${data.generationState}`,
  ].join(", ");
}

function OutlineBranch({ projectId, node, childrenByParent, onSelect, onToggleCollapsed }: {
  projectId: string;
  node: WorkspaceFlowNode;
  childrenByParent: ReadonlyMap<string | null, WorkspaceFlowNode[]>;
  onSelect: (id: string, additive: boolean) => void;
  onToggleCollapsed: (groupId: string, collapsed: boolean) => void;
}) {
  const children = childrenByParent.get(node.id) ?? [];
  const stopCanvasShortcuts = (event: React.KeyboardEvent) => event.stopPropagation();
  return (
    <li>
      <div className="dezin-workspace-outline__row">
        <button
          type="button"
          aria-pressed={node.selected ?? false}
          aria-label={accessibleNodeName(node)}
          className="dezin-workspace-outline__item"
          data-selected={node.selected || undefined}
          onClick={(event) => onSelect(node.id, event.metaKey || event.ctrlKey || event.shiftKey)}
          onKeyDown={stopCanvasShortcuts}
        >
          <span aria-hidden><KindIcon kind={node.data.kind} /></span>
          <span className="dezin-workspace-outline__name">{node.data.name}</span>
          {node.data.kind !== "group" && <span className="dezin-workspace-outline__count">{node.data.incomingCount + node.data.outgoingCount}</span>}
        </button>
        {node.data.artifactId ? (
          <Link
            to={`/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(node.data.artifactId)}`}
            className="dezin-workspace-outline__action"
            aria-label={`Open ${node.data.name}`}
            onKeyDown={stopCanvasShortcuts}
          >
            Open
          </Link>
        ) : node.data.resourceId ? (
          <Link
            to={`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(node.data.resourceId)}${
              node.data.revisionId === null
                ? ""
                : `/revisions/${encodeURIComponent(node.data.revisionId)}`
            }`}
            className="dezin-workspace-outline__action"
            aria-label={`Open ${node.data.name}`}
            onKeyDown={stopCanvasShortcuts}
          >
            Open
          </Link>
        ) : node.data.kind === "group" ? (
          <button
            type="button"
            className="dezin-workspace-outline__action"
            aria-label={`${node.data.collapsed ? "Expand" : "Collapse"} group ${node.data.name}`}
            aria-expanded={!node.data.collapsed}
            onClick={() => onToggleCollapsed(node.id, !node.data.collapsed)}
            onKeyDown={stopCanvasShortcuts}
          >
            {node.data.collapsed ? "Expand" : "Collapse"}
          </button>
        ) : null}
      </div>
      {children.length > 0 && !(node.data.kind === "group" && node.data.collapsed) && (
        <ul>
          {children.map((child) => (
            <OutlineBranch
              key={child.id}
              projectId={projectId}
              node={child}
              childrenByParent={childrenByParent}
              onSelect={onSelect}
              onToggleCollapsed={onToggleCollapsed}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function WorkspaceOutline({ projectId, nodes, onSelect, onToggleCollapsed, onClose }: {
  projectId: string;
  nodes: readonly WorkspaceFlowNode[];
  onSelect: (id: string, additive: boolean) => void;
  onToggleCollapsed: (groupId: string, collapsed: boolean) => void;
  onClose: () => void;
}) {
  const childrenByParent = new Map<string | null, WorkspaceFlowNode[]>();
  for (const node of nodes) {
    const parent = node.parentId ?? null;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(node);
    childrenByParent.set(parent, siblings);
  }
  const roots = childrenByParent.get(null) ?? [];
  return (
    <aside className="dezin-workspace-outline" aria-label="Workspace structure">
      <header>
        <div><span className="label-mono">Outline</span><strong>{nodes.length} objects</strong></div>
        <button type="button" aria-label="Close workspace outline" onClick={onClose}><X size={13} /></button>
      </header>
      <ul aria-label="Workspace outline">
        {roots.map((node) => (
          <OutlineBranch
            key={node.id}
            projectId={projectId}
            node={node}
            childrenByParent={childrenByParent}
            onSelect={onSelect}
            onToggleCollapsed={onToggleCollapsed}
          />
        ))}
      </ul>
    </aside>
  );
}
