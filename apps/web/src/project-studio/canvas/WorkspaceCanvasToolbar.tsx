import {
  BoxSelect,
  ChevronsDownUp,
  Eye,
  Focus,
  Frame,
  GitBranch,
  Hand,
  ListTree,
  MousePointer2,
  Network,
  Trash2,
} from "lucide-react";
import type { WorkspaceEdgeFilter } from "./workspace-graph-adapter.ts";

export type CanvasTool = "select" | "hand";

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="dezin-canvas-toolbar__button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      {children}
    </button>
  );
}

export function WorkspaceCanvasToolbar({
  tool,
  edgeFilter,
  outlineOpen,
  canGroup,
  canUngroup,
  canDeleteGroup,
  onToolChange,
  onEdgeFilterChange,
  onToggleOutline,
  onFitView,
  onGroup,
  onUngroup,
  onDeleteGroup,
}: {
  tool: CanvasTool;
  edgeFilter: WorkspaceEdgeFilter;
  outlineOpen: boolean;
  canGroup: boolean;
  canUngroup: boolean;
  canDeleteGroup: boolean;
  onToolChange: (tool: CanvasTool) => void;
  onEdgeFilterChange: (filter: WorkspaceEdgeFilter) => void;
  onToggleOutline: () => void;
  onFitView: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onDeleteGroup: () => void;
}) {
  return (
    <nav className="dezin-canvas-toolbar" aria-label="Canvas tools">
      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Navigation tools">
        <ToolButton label="Select tool" active={tool === "select"} onClick={() => onToolChange("select")}>
          <MousePointer2 size={14} /><kbd>V</kbd>
        </ToolButton>
        <ToolButton label="Hand tool" active={tool === "hand"} onClick={() => onToolChange("hand")}>
          <Hand size={14} /><kbd>H</kbd>
        </ToolButton>
        <ToolButton label="Fit workspace" onClick={onFitView}>
          <Focus size={14} /><kbd>⇧1</kbd>
        </ToolButton>
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Grouping tools">
        <ToolButton label="Group selection" disabled={!canGroup} onClick={onGroup}>
          <Frame size={14} />
        </ToolButton>
        <ToolButton label="Ungroup selection" disabled={!canUngroup} onClick={onUngroup}>
          <ChevronsDownUp size={14} />
        </ToolButton>
        <ToolButton label="Delete group" disabled={!canDeleteGroup} onClick={onDeleteGroup}>
          <Trash2 size={14} />
        </ToolButton>
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Relationship visibility">
        <ToolButton label="Show prototype flow" active={edgeFilter === "flow"} onClick={() => onEdgeFilterChange("flow")}>
          <GitBranch size={14} />
        </ToolButton>
        <ToolButton label="Show semantic relations" active={edgeFilter === "relations"} onClick={() => onEdgeFilterChange("relations")}>
          <Network size={14} />
        </ToolButton>
        <ToolButton label="Show all relations" active={edgeFilter === "all"} onClick={() => onEdgeFilterChange("all")}>
          <Eye size={14} />
        </ToolButton>
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <ToolButton label="Toggle workspace outline" active={outlineOpen} onClick={onToggleOutline}>
        {outlineOpen ? <ListTree size={14} /> : <BoxSelect size={14} />}
      </ToolButton>
    </nav>
  );
}
