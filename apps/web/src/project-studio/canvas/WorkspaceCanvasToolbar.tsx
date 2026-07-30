import {
  Frame,
  GitBranch,
  Hand,
  Minus,
  MousePointer2,
  Plus,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  StudioToolButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/index.ts";
import type { WorkspaceEdgeFilter } from "./workspace-graph-adapter.ts";

export type CanvasTool = "select" | "hand";

const ZOOM_PRESETS = [0.5, 1, 2] as const;
const EDGE_FILTER_OPTIONS = [
  { value: "flow", label: "Prototype flow" },
  { value: "relations", label: "Semantic relations" },
  { value: "all", label: "All relations" },
] as const;

function RelationshipFilterMenu({
  value,
  onChange,
}: {
  value: WorkspaceEdgeFilter;
  onChange: (value: WorkspaceEdgeFilter) => void;
}) {
  const active = EDGE_FILTER_OPTIONS.find((option) => option.value === value) ?? EDGE_FILTER_OPTIONS[0];
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
              <GitBranch size={15} strokeWidth={1.75} />
            </IconButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Relationship visibility</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(nextValue) => onChange(nextValue as WorkspaceEdgeFilter)}
        >
          {EDGE_FILTER_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <span className="flex-1">{option.label}</span>
              </DropdownMenuRadioItem>
          ))}
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
      <div className="dezin-canvas-toolbar-layer app-no-drag">
        <nav
          className="dezin-canvas-toolbar dezin-canvas-toolbar--view"
          aria-label="Canvas view tools"
        >
          <StudioToolButton label="Toggle workspace outline" active={outlineOpen} tone="quiet" className="dezin-canvas-toolbar__button" onClick={onToggleOutline}>
            <Frame size={15} strokeWidth={1.75} />
          </StudioToolButton>
          <span className="dezin-canvas-toolbar__rule" aria-hidden />
          <RelationshipFilterMenu value={edgeFilter} onChange={onEdgeFilterChange} />
        </nav>

        {hasContextActions ? (
          <div
            className="dezin-canvas-toolbar dezin-canvas-toolbar--context"
            role="toolbar"
            aria-label="Selection actions"
          >
            {canGroup ? (
              <span data-canvas-context-slot="group-create">
                <StudioToolButton label="Group selection" tone="quiet" className="dezin-canvas-toolbar__button" onClick={onGroup}>
                  <Frame size={15} strokeWidth={1.75} />
                </StudioToolButton>
              </span>
            ) : null}
            {canUngroup ? (
              <span data-canvas-context-slot="group-ungroup">
                <StudioToolButton label="Ungroup selection" tone="quiet" className="dezin-canvas-toolbar__button" onClick={onUngroup}>
                  <Frame size={15} strokeWidth={1.75} />
                </StudioToolButton>
              </span>
            ) : null}
            {canDeleteGroup ? (
              <span data-canvas-context-slot="group-delete">
                <StudioToolButton label="Delete group" tone="quiet" className="dezin-canvas-toolbar__button" onClick={onDeleteGroup}>
                  <Trash2 size={15} strokeWidth={1.75} />
                </StudioToolButton>
              </span>
            ) : null}
            {hasRelationshipSelection ? (
              <span data-canvas-context-slot="relationship-delete">
                <StudioToolButton
                  label={relationshipDeleteLabel}
                  disabled={!canDeleteRelationship}
                  disabledReason={relationshipDeleteDisabledReason}
                  tone="quiet"
                  className="dezin-canvas-toolbar__button"
                  onClick={onDeleteRelationship}
                >
                  <Trash2 size={15} strokeWidth={1.75} />
                </StudioToolButton>
              </span>
            ) : null}
          </div>
        ) : null}

        <nav
          className="dezin-canvas-toolbar dezin-canvas-toolbar--tools"
          aria-label="Canvas tools"
        >
          <StudioToolButton
            label="Select tool"
            shortcut="V"
            active={tool === "select"}
            tone="quiet"
            className="dezin-canvas-toolbar__button"
            onClick={() => onToolChange("select")}
          >
            <MousePointer2 size={15} strokeWidth={1.75} />
          </StudioToolButton>
          <StudioToolButton
            label="Hand tool"
            shortcut="H"
            active={tool === "hand"}
            tone="quiet"
            className="dezin-canvas-toolbar__button"
            onClick={() => onToolChange("hand")}
          >
            <Hand size={15} strokeWidth={1.75} />
          </StudioToolButton>
        </nav>

        <nav
          className="dezin-canvas-toolbar dezin-canvas-toolbar--zoom"
          aria-label="Canvas zoom tools"
        >
          <StudioToolButton label="Zoom out" tone="quiet" className="dezin-canvas-toolbar__button" onClick={onZoomOut}>
            <Minus size={15} strokeWidth={1.75} />
          </StudioToolButton>
          <DropdownMenu>
            <DropdownMenuTrigger
              type="button"
              className="dezin-canvas-toolbar__zoom-value"
              aria-label={`Canvas zoom: ${Math.round(zoom * 100)}%`}
            >
              {Math.round(zoom * 100)}%
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" className="w-36">
              <DropdownMenuItem onClick={onFitView}>
                Fit workspace
                <span className="ml-auto text-[10px] text-muted-foreground">⇧1</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {ZOOM_PRESETS.map((preset) => (
                <DropdownMenuItem key={preset} onClick={() => onSetZoom(preset)}>
                  {Math.round(preset * 100)}%
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <StudioToolButton label="Zoom in" tone="quiet" className="dezin-canvas-toolbar__button" onClick={onZoomIn}>
            <Plus size={15} strokeWidth={1.75} />
          </StudioToolButton>
        </nav>
      </div>
    </TooltipProvider>
  );
}
