import {
  Hand,
  LayoutGrid,
  LocateFixed,
  Minus,
  MousePointer2,
  Plus,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  IconSwap,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { NodeCatalogMenu } from "./NodeCatalogMenu.tsx";
import type { DesignNodeKind } from "./types.ts";

export type DesignCanvasTool = "select" | "hand";

export function CanvasToolButton({
  label,
  active,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={label}
          aria-pressed={active === undefined ? undefined : active}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={5}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function CanvasToolDocks({
  tool,
  addMenuOpen,
  onAddMenuOpenChange,
  onChooseNode,
  onCreateComponentSystem,
  onToolChange,
  arrangeDisabled,
  onArrange,
  onFit,
  onZoomOut,
  onZoomIn,
  zoom,
}: {
  tool: DesignCanvasTool;
  addMenuOpen: boolean;
  onAddMenuOpenChange: (open: boolean) => void;
  onChooseNode: (kind: DesignNodeKind) => void;
  onCreateComponentSystem: () => void;
  onToolChange: (tool: DesignCanvasTool) => void;
  arrangeDisabled: boolean;
  onArrange: () => void;
  onFit: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  zoom: number;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <div className="design-canvas-tools" role="toolbar" aria-label="Canvas tools" onContextMenu={(event) => event.stopPropagation()}>
        <span className="design-canvas-tools__modes">
          <CanvasToolButton label="Select tool" active={tool === "select"} onClick={() => onToolChange("select")}>
            <MousePointer2 aria-hidden />
          </CanvasToolButton>
          <CanvasToolButton label="Hand tool" active={tool === "hand"} onClick={() => onToolChange("hand")}>
            <Hand aria-hidden />
          </CanvasToolButton>
        </span>
        <DropdownMenu open={addMenuOpen} onOpenChange={onAddMenuOpenChange} modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="design-canvas-add-trigger">
                <DropdownMenuTrigger asChild>
                  <Button
                    id="design-canvas-add"
                    variant="default"
                    size="sm"
                    aria-label="Add Design node"
                  >
                    <IconSwap
                      active={addMenuOpen}
                      first={<Plus aria-hidden />}
                      second={<X aria-hidden />}
                    />
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={5}>Add Node</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            side="top"
            align="end"
            sideOffset={9}
            aria-label="Add Design node"
            className="design-node-catalog"
          >
            <NodeCatalogMenu
              menuType="dropdown"
              onChoose={onChooseNode}
              onCreateComponentSystem={onCreateComponentSystem}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="design-canvas-zoom" role="toolbar" aria-label="Canvas view controls" onContextMenu={(event) => event.stopPropagation()}>
        <CanvasToolButton label="Arrange nodes" disabled={arrangeDisabled} onClick={onArrange}>
          <LayoutGrid aria-hidden />
        </CanvasToolButton>
        <CanvasToolButton label="Fit canvas" onClick={onFit}>
          <LocateFixed aria-hidden />
        </CanvasToolButton>
        <span className="design-canvas-tools__divider" aria-hidden />
        <CanvasToolButton label="Zoom out" onClick={onZoomOut}>
          <Minus aria-hidden />
        </CanvasToolButton>
        <output aria-label="Canvas zoom">{Math.round(zoom * 100)}%</output>
        <CanvasToolButton label="Zoom in" onClick={onZoomIn}>
          <Plus aria-hidden />
        </CanvasToolButton>
      </div>
    </TooltipProvider>
  );
}
