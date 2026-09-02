import { FileUp, LocateFixed, Sparkles, Trash2 } from "lucide-react";

import { ContextMenuItem, ContextMenuSeparator } from "../components/ui/index.ts";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import type { DesignNode } from "./types.ts";

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
      <ContextMenuItem onSelect={onOpenAgent}>
        <Sparkles aria-hidden />
        {material
          ? `Inspect ${item.label.toLocaleLowerCase()} with Agent`
          : node.versionCount > 0
            ? `Create new ${item.label.toLocaleLowerCase()} version`
            : `Create ${item.label.toLocaleLowerCase()} with Agent`}
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
      <ContextMenuSeparator />
      <ContextMenuItem className="design-node-context-menu__danger" onSelect={onDelete}>
        <Trash2 aria-hidden />
        Delete {item.label.toLocaleLowerCase()}
      </ContextMenuItem>
    </>
  );
}
