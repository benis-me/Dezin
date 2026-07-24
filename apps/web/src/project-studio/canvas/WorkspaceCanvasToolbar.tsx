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
import {
  IconButton,
  Kbd,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/index.ts";
import type { WorkspaceEdgeFilter } from "./workspace-graph-adapter.ts";

export type CanvasTool = "select" | "hand";

function ToolButton({
  label,
  active,
  disabled,
  disabledReason,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const button = (
    <IconButton
      type="button"
      className="dezin-canvas-toolbar__button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={disabled ? "inline-flex cursor-help" : "inline-flex"}
          tabIndex={disabled ? 0 : undefined}
          aria-label={disabled && disabledReason ? `${label}. ${disabledReason}` : undefined}
        >
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-2">
        <span>{disabled && disabledReason ? disabledReason : label.replace(/ tool$/, "")}</span>
        {!disabled && shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceCanvasToolbar({
  tool,
  edgeFilter,
  outlineOpen,
  canGroup,
  canUngroup,
  canDeleteGroup,
  canDeleteRelationship,
  relationshipDeleteLabel,
  onToolChange,
  onEdgeFilterChange,
  onToggleOutline,
  onFitView,
  onGroup,
  onUngroup,
  onDeleteGroup,
  onDeleteRelationship,
}: {
  tool: CanvasTool;
  edgeFilter: WorkspaceEdgeFilter;
  outlineOpen: boolean;
  canGroup: boolean;
  canUngroup: boolean;
  canDeleteGroup: boolean;
  canDeleteRelationship: boolean;
  relationshipDeleteLabel: string;
  onToolChange: (tool: CanvasTool) => void;
  onEdgeFilterChange: (filter: WorkspaceEdgeFilter) => void;
  onToggleOutline: () => void;
  onFitView: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onDeleteGroup: () => void;
  onDeleteRelationship: () => void;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <nav className="dezin-canvas-toolbar" aria-label="Canvas tools">
      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Navigation tools">
        <ToolButton label="Select tool" shortcut="V" active={tool === "select"} onClick={() => onToolChange("select")}>
          <MousePointer2 size={14} />
        </ToolButton>
        <ToolButton label="Hand tool" shortcut="H" active={tool === "hand"} onClick={() => onToolChange("hand")}>
          <Hand size={14} />
        </ToolButton>
        <ToolButton label="Fit workspace" shortcut="⇧1" onClick={onFitView}>
          <Focus size={14} />
        </ToolButton>
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Grouping tools">
        <ToolButton label="Group selection" disabled={!canGroup} disabledReason="Select one or more objects to group" onClick={onGroup}>
          <Frame size={14} />
        </ToolButton>
        <ToolButton label="Ungroup selection" disabled={!canUngroup} disabledReason="Select a group to ungroup" onClick={onUngroup}>
          <ChevronsDownUp size={14} />
        </ToolButton>
        <ToolButton label="Delete group" disabled={!canDeleteGroup} disabledReason="Select a group to delete" onClick={onDeleteGroup}>
          <Trash2 size={14} />
        </ToolButton>
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Relationship tools">
        <ToolButton
          label={relationshipDeleteLabel}
          disabled={!canDeleteRelationship}
          disabledReason="Select a relationship to delete"
          onClick={onDeleteRelationship}
        >
          <Trash2 size={14} />
        </ToolButton>
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
    </TooltipProvider>
  );
}
