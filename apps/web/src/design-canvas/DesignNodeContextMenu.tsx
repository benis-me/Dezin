import { FileUp, LocateFixed, Maximize2, Minus, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";

import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut } from "../components/ui/index.ts";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import type { DesignNode } from "./types.ts";

export interface CanvasViewMenuActions {
  onFitView: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
}

/** The shared "View" section both canvas context menus end with. */
export function CanvasViewMenuItems({ onFitView, onZoomIn, onZoomOut, onResetZoom }: CanvasViewMenuActions) {
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuLabel>View</ContextMenuLabel>
      <ContextMenuItem onSelect={onFitView}><Maximize2 aria-hidden />Fit view<ContextMenuShortcut>Shift 1</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem onSelect={onZoomIn}><Plus aria-hidden />Zoom in<ContextMenuShortcut>Cmd +</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem onSelect={onZoomOut}><Minus aria-hidden />Zoom out<ContextMenuShortcut>Cmd -</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem onSelect={onResetZoom}><RotateCcw aria-hidden />Reset zoom<ContextMenuShortcut>Cmd 0</ContextMenuShortcut></ContextMenuItem>
    </>
  );
}

/** Context-menu items for one canvas Node: Agent, revision, fit, delete. */
export function DesignNodeContextMenu({
  node,
  onOpenAgent,
  onAddRevision,
  fitDisabled,
  onFit,
  onDelete,
}: {
  node: DesignNode;
  onOpenAgent: () => void;
  onAddRevision: () => void;
  fitDisabled: boolean;
  onFit: () => void;
  onDelete: () => void;
}) {
  const item = catalogItem(node.kind);
  const material = isMaterialNodeKind(node.kind);
  return (
    <>
      <ContextMenuLabel>Selection</ContextMenuLabel>
      <ContextMenuItem onSelect={onOpenAgent}>
        <Sparkles aria-hidden />
        {material
          ? `Inspect ${item.label.toLocaleLowerCase()} with Agent`
          : node.versionCount > 0
            ? `Create new ${item.label.toLocaleLowerCase()} version`
            : `Create ${item.label.toLocaleLowerCase()} with Agent`}
        <ContextMenuShortcut>Enter</ContextMenuShortcut>
      </ContextMenuItem>
      {material ? (
        <ContextMenuItem onSelect={onAddRevision}>
          <FileUp aria-hidden />
          Add {item.label.toLocaleLowerCase()} revision…
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem disabled={fitDisabled} onSelect={onFit}>
        <LocateFixed aria-hidden />
        Fit this Node
      </ContextMenuItem>
      <ContextMenuItem className="design-node-context-menu__danger" onSelect={onDelete}>
        <Trash2 aria-hidden />
        Delete {item.label.toLocaleLowerCase()}
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}
