import { useEffect, useState } from "react";
import type { MoodboardAsset, MoodboardNode } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { MoodboardCanvas } from "../moodboard/MoodboardCanvas.tsx";
import { MOODBOARD_REVIEW_CAPABILITIES } from "../moodboard/canvas-utils.ts";

/**
 * Mounts a review-only moodboard inside the Research Visual tab. Re-running
 * research owns this board, so this surface deliberately exposes only fit/pan/zoom.
 */
export function VisualResearchBoard({ boardId }: { boardId: string }) {
  const api = useApi();
  const [nodes, setNodes] = useState<MoodboardNode[]>([]);
  const [assets, setAssets] = useState<MoodboardAsset[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .getMoodboard(boardId)
      .then((detail) => {
        if (!alive) return;
        setNodes(detail.nodes);
        setAssets(detail.assets ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, boardId]);

  return (
    <div className="flex h-[440px] w-full flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <MoodboardCanvas
        // viewKey flips from `<id>` (empty) to `<id>:ready` once nodes load, so the controller's
        // fit-view fires AFTER the async load (not on the empty canvas) → the 12 shots fit into view.
        viewKey={nodes.length > 0 ? `${boardId}:ready` : boardId}
        nodes={nodes}
        selectedIds={[]}
        moodboardAssets={assets}
        capabilities={MOODBOARD_REVIEW_CAPABILITIES}
      />
    </div>
  );
}
