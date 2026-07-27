import {
  BoxSelect,
  ChevronsDownUp,
  Eye,
  Focus,
  Frame,
  GitBranch,
  Hand,
  ListTree,
  Minus,
  MousePointer2,
  Network,
  Plus,
  Trash2,
} from "lucide-react";
import {
  IconButton,
  Kbd,
  Segmented,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/index.ts";
import { cn } from "../../lib/utils.ts";
import type { WorkspaceEdgeFilter } from "./workspace-graph-adapter.ts";

export type CanvasTool = "select" | "hand";

const ACTIVE_TOOL_BUTTON_CLASS = "bg-surface-2 text-foreground hover:bg-surface-2 hover:text-foreground";
const ZOOM_PRESETS = [0.5, 1, 2] as const;

const EDGE_FILTER_OPTIONS: ReadonlyArray<{
  value: WorkspaceEdgeFilter;
  label: string;
  icon: typeof GitBranch;
}> = [
  { value: "flow", label: "Prototype flow", icon: GitBranch },
  { value: "relations", label: "Semantic relations", icon: Network },
  { value: "all", label: "All relations", icon: Eye },
];

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
      className={cn("dezin-canvas-toolbar__button", active && ACTIVE_TOOL_BUTTON_CLASS)}
      aria-label={disabled ? undefined : label}
      aria-pressed={disabled ? undefined : active}
      aria-hidden={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
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
          role={disabled ? "button" : undefined}
          aria-disabled={disabled || undefined}
          aria-label={disabled && disabledReason
            ? label === disabledReason ? label : `${label}. ${disabledReason}`
            : undefined}
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

function RelationshipFilterMenu({
  value,
  onChange,
}: {
  value: WorkspaceEdgeFilter;
  onChange: (value: WorkspaceEdgeFilter) => void;
}) {
  const active = EDGE_FILTER_OPTIONS.find((option) => option.value === value) ?? EDGE_FILTER_OPTIONS[0]!;
  const ActiveIcon = active.icon;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <IconButton
              type="button"
              className="dezin-canvas-toolbar__button"
              aria-label={`Relationship filter: ${active.label}`}
            >
              <ActiveIcon size={14} />
            </IconButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Relationship visibility</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="center" className="w-48">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(nextValue) => onChange(nextValue as WorkspaceEdgeFilter)}
        >
          {EDGE_FILTER_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            return (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <OptionIcon size={14} />
                <span className="flex-1">{option.label}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  hasRelationshipSelection,
  relationshipDeleteLabel,
  relationshipDeleteDisabledReason = "Select a relationship to delete",
  zoom,
  onToolChange,
  onEdgeFilterChange,
  onToggleOutline,
  onFitView,
  onZoomOut,
  onZoomIn,
  onSetZoom,
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
  hasRelationshipSelection: boolean;
  relationshipDeleteLabel: string;
  relationshipDeleteDisabledReason?: string;
  zoom: number;
  onToolChange: (tool: CanvasTool) => void;
  onEdgeFilterChange: (filter: WorkspaceEdgeFilter) => void;
  onToggleOutline: () => void;
  onFitView: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onSetZoom: (zoom: number) => void;
  onGroup: () => void;
  onUngroup: () => void;
  onDeleteGroup: () => void;
  onDeleteRelationship: () => void;
}) {
  const hasGroupingActions = canGroup || canUngroup || canDeleteGroup;
  const hasContextActions = hasGroupingActions || hasRelationshipSelection;
  return (
    <TooltipProvider delayDuration={120}>
      <div className="dezin-canvas-toolbar-frame app-no-drag">
      <div
        className="dezin-canvas-toolbar__context"
        data-active={hasContextActions || undefined}
        aria-hidden={hasContextActions ? undefined : true}
      >
        <div
          className="dezin-canvas-toolbar__cluster"
          role={hasGroupingActions ? "group" : undefined}
          aria-label={hasGroupingActions ? "Grouping tools" : undefined}
        >
          <span
            className="dezin-canvas-toolbar__context-slot"
            data-canvas-context-slot="group-create"
          >
            {canGroup ? (
              <ToolButton label="Group selection" onClick={onGroup}>
                <Frame size={14} />
              </ToolButton>
            ) : null}
          </span>
          <span
            className="dezin-canvas-toolbar__context-slot"
            data-canvas-context-slot="group-ungroup"
          >
            {canUngroup ? (
              <ToolButton label="Ungroup selection" onClick={onUngroup}>
                <ChevronsDownUp size={14} />
              </ToolButton>
            ) : null}
          </span>
          <span
            className="dezin-canvas-toolbar__context-slot"
            data-canvas-context-slot="group-delete"
          >
            {canDeleteGroup ? (
              <ToolButton label="Delete group" onClick={onDeleteGroup}>
                <Trash2 size={14} />
              </ToolButton>
            ) : null}
          </span>
        </div>
        <span
          className="dezin-canvas-toolbar__context-slot"
          data-canvas-context-slot="relationship-delete"
        >
          {hasRelationshipSelection ? (
            <ToolButton
              label={relationshipDeleteLabel}
              disabled={!canDeleteRelationship}
              disabledReason={relationshipDeleteDisabledReason}
              onClick={onDeleteRelationship}
            >
              <Trash2 size={14} />
            </ToolButton>
          ) : null}
        </span>
      </div>

      <nav className="dezin-canvas-toolbar app-no-drag" aria-label="Canvas tools">
      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Navigation tools">
        <Segmented<CanvasTool>
          ariaLabel="Canvas interaction mode"
          size="sm"
          value={tool}
          onChange={onToolChange}
          options={[
            {
              value: "select",
              title: "Select tool",
              icon: <MousePointer2 size={14} />,
              tooltip: (
                <span className="flex items-center gap-2">
                  <span>Select</span>
                  <Kbd>V</Kbd>
                </span>
              ),
            },
            {
              value: "hand",
              title: "Hand tool",
              icon: <Hand size={14} />,
              tooltip: (
                <span className="flex items-center gap-2">
                  <span>Hand</span>
                  <Kbd>H</Kbd>
                </span>
              ),
            },
          ]}
        />
        <ToolButton label="Fit workspace" shortcut="⇧1" onClick={onFitView}>
          <Focus size={14} />
        </ToolButton>
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Zoom tools">
        <ToolButton label="Zoom out" onClick={onZoomOut}>
          <Minus size={14} />
        </ToolButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            type="button"
            className="dezin-canvas-toolbar__zoom-value"
            aria-label={`Canvas zoom: ${Math.round(zoom * 100)}%`}
          >
            {Math.round(zoom * 100)}%
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="center" className="w-28">
            {ZOOM_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset} onClick={() => onSetZoom(preset)}>
                {Math.round(preset * 100)}%
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton label="Zoom in" onClick={onZoomIn}>
          <Plus size={14} />
        </ToolButton>
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <div className="dezin-canvas-toolbar__cluster" role="group" aria-label="Relationship tools">
        <RelationshipFilterMenu value={edgeFilter} onChange={onEdgeFilterChange} />
      </div>

      <span className="dezin-canvas-toolbar__rule" aria-hidden />

      <ToolButton label="Toggle workspace outline" active={outlineOpen} onClick={onToggleOutline}>
        {outlineOpen ? <ListTree size={14} /> : <BoxSelect size={14} />}
      </ToolButton>
      </nav>
      </div>
    </TooltipProvider>
  );
}
