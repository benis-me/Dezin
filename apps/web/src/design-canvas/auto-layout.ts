import type { DesignNode, DesignNodeGeometry } from "./types.ts";

export interface ArrangedDesignNode {
  nodeId: string;
  geometry: DesignNodeGeometry;
}
/** Stable shelf-packing for heterogeneous nodes; repeat runs are deterministic. */
export function arrangeDesignNodes(
  nodes: readonly DesignNode[],
  nodeOrder: readonly string[],
  options: { originX?: number; originY?: number; gap?: number; targetWidth?: number } = {},
): ArrangedDesignNode[] {
  const originX = options.originX ?? 80;
  const originY = options.originY ?? 80;
  const gap = options.gap ?? 88;
  const ordered = stableNodeOrder(nodes, nodeOrder);
  if (ordered.length === 0) return [];

  const totalArea = ordered.reduce((sum, node) => sum + node.geometry.width * node.geometry.height, 0);
  const widest = Math.max(...ordered.map((node) => node.geometry.width));
  const targetWidth = Math.max(widest, options.targetWidth ?? Math.min(1_880, Math.max(980, Math.sqrt(totalArea * 1.55))));
  let x = originX;
  let y = originY;
  let rowHeight = 0;

  return ordered.map((node) => {
    const { width, height } = node.geometry;
    if (x > originX && x + width > originX + targetWidth) {
      x = originX;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    const geometry = { x, y, width, height };
    x += width + gap;
    rowHeight = Math.max(rowHeight, height);
    return { nodeId: node.id, geometry };
  });
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
