import { ChevronRight, Component, Frame, PanelTop, Paperclip, SquareArrowOutUpRight, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "../../components/ui/Button.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.tsx";
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
  const stopCanvasShortcuts = (event: KeyboardEvent) => event.stopPropagation();
  const openTooltip = `Open ${kindLabel(node)} ${node.data.name}`;
  const groupActionLabel = `${node.data.collapsed ? "Expand" : "Collapse"} group ${node.data.name}`;
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
          <span className="dezin-workspace-outline__name" title={node.data.name}>{node.data.name}</span>
          {node.data.kind !== "group" && (
            <span
              className="dezin-workspace-outline__count"
              aria-label={`${node.data.incomingCount + node.data.outgoingCount} connections`}
            >
              {node.data.incomingCount + node.data.outgoingCount}
            </span>
          )}
        </button>
        {node.data.artifactId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-xs" className="dezin-workspace-outline__action">
                <Link
                  to={`/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(node.data.artifactId)}`}
                  aria-label={openTooltip}
                  onKeyDown={stopCanvasShortcuts}
                >
                  <SquareArrowOutUpRight aria-hidden />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>{openTooltip}</TooltipContent>
          </Tooltip>
        ) : node.data.resourceId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-xs" className="dezin-workspace-outline__action">
                <Link
                  to={`/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(node.data.resourceId)}${
                    node.data.revisionId === null
                      ? ""
                      : `/revisions/${encodeURIComponent(node.data.revisionId)}`
                  }`}
                  aria-label={openTooltip}
                  onKeyDown={stopCanvasShortcuts}
                >
                  <SquareArrowOutUpRight aria-hidden />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>{openTooltip}</TooltipContent>
          </Tooltip>
        ) : node.data.kind === "group" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                className="dezin-workspace-outline__action"
                aria-label={groupActionLabel}
                aria-expanded={!node.data.collapsed}
                onClick={() => onToggleCollapsed(node.id, !node.data.collapsed)}
                onKeyDown={stopCanvasShortcuts}
              >
                <ChevronRight
                  aria-hidden
                  className="dezin-workspace-outline__disclosure"
                  data-expanded={!node.data.collapsed || undefined}
                />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>{groupActionLabel}</TooltipContent>
          </Tooltip>
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
    <TooltipProvider delayDuration={300}>
      <aside className="dezin-workspace-outline" aria-label="Workspace structure">
        <header>
          <div className="dezin-workspace-outline__heading">
            <strong>Outline</strong>
            <span>{nodes.length} {nodes.length === 1 ? "object" : "objects"}</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                className="dezin-workspace-outline__close"
                aria-label="Close workspace outline"
                onClick={onClose}
              >
                <X aria-hidden />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>Close outline</TooltipContent>
          </Tooltip>
        </header>
        {roots.length > 0 ? (
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
        ) : (
          <p className="dezin-workspace-outline__empty">Objects will appear here as the workspace takes shape.</p>
        )}
      </aside>
    </TooltipProvider>
  );
}
