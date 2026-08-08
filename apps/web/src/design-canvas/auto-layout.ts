import type { DesignNode, DesignNodeGeometry, DesignNodeKind } from "./types.ts";

export interface ArrangedDesignNode {
  nodeId: string;
  geometry: DesignNodeGeometry;
}

const CONTEXT_KINDS = new Set<DesignNodeKind>(["image", "video", "document", "file", "research", "knowledge"]);
const SYSTEM_KINDS = new Set<DesignNodeKind>(["design-tokens", "design-document", "design-system", "layout"]);

/**
 * Deterministic semantic lanes: evidence and imported context lead, system
 * foundations follow, and rendered Components/Pages sit downstream. Nodes are
 * shelf-packed inside each lane so heterogeneous sizes never overlap.
 */
export function arrangeDesignNodes(
  nodes: readonly DesignNode[],
  nodeOrder: readonly string[],
  options: { originX?: number; originY?: number; gap?: number; targetWidth?: number } = {},
): ArrangedDesignNode[] {
  const originX = options.originX ?? 96;
  const originY = options.originY ?? 96;
  const gap = options.gap ?? 72;
  const ordered = stableNodeOrder(nodes, nodeOrder);
  if (ordered.length === 0) return [];

  const totalArea = ordered.reduce((sum, node) => sum + node.geometry.width * node.geometry.height, 0);
  const widest = Math.max(...ordered.map((node) => node.geometry.width));
  const calculatedWidth = Math.min(1_560, Math.max(840, Math.sqrt(totalArea * 1.45)));
  const laneTargetWidth = Math.max(widest, options.targetWidth ?? calculatedWidth);
  const lanes = [0, 1, 2]
    .map((rank) => ordered.filter((node) => semanticRank(node.kind) === rank))
    .filter((lane) => lane.length > 0);

  const arranged: ArrangedDesignNode[] = [];
  let laneX = originX;
  for (const lane of lanes) {
    let x = laneX;
    let y = originY;
    let rowHeight = 0;
    let laneRight = laneX;

    for (const node of lane) {
      const { width, height } = node.geometry;
      if (x > laneX && x + width > laneX + laneTargetWidth) {
        x = laneX;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      arranged.push({ nodeId: node.id, geometry: { x, y, width, height } });
      laneRight = Math.max(laneRight, x + width);
      x += width + gap;
      rowHeight = Math.max(rowHeight, height);
    }

    // A larger inter-lane beat makes the context → system → output reading
    // order visible without adding stored Group or connector concepts.
    laneX = laneRight + Math.max(120, Math.round(gap * 1.75));
  }
  return arranged;
}

function semanticRank(kind: DesignNodeKind): 0 | 1 | 2 {
  if (CONTEXT_KINDS.has(kind)) return 0;
  if (SYSTEM_KINDS.has(kind)) return 1;
  return 2;
}

function stableNodeOrder(nodes: readonly DesignNode[], nodeOrder: readonly string[]): DesignNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = nodeOrder.flatMap((id) => {
    const node = byId.get(id);
    if (!node) return [];
    byId.delete(id);
    return [node];
  });
  return [...ordered, ...[...byId.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))];
}
