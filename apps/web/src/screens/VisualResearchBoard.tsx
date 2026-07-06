import { useCallback, useEffect, useRef, useState } from "react";
import type { MoodboardAsset, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { MoodboardCanvas } from "../moodboard/MoodboardCanvas.tsx";
import { toInput } from "../moodboard/canvas-utils.ts";
import { materializeInputs } from "../moodboard/moodboard-board-utils.ts";

const noop = () => {};

/**
 * Mounts the interactive moodboard for the "Visual research" board inside the Research
 * Visual tab. Curate/rearrange only — no authoring (note/section/image-generator/upload)
 * since re-running research replaces the board's nodes (documented v1 behavior).
 */
export function VisualResearchBoard({ boardId }: { boardId: string }) {
  const api = useApi();
  const [nodes, setNodes] = useState<MoodboardNode[]>([]);
  const [assets, setAssets] = useState<MoodboardAsset[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const saveTimer = useRef<number | null>(null);
  const pendingSaveInputs = useRef<SaveMoodboardNodeInput[] | null>(null);

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

  const flushPendingNodes = useCallback(() => {
    const inputs = pendingSaveInputs.current;
    if (!inputs) return;
    pendingSaveInputs.current = null;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    api
      .saveMoodboardNodes(boardId, inputs)
      .then((saved) => setNodes(saved))
      .catch(() => {});
  }, [api, boardId]);

  useEffect(() => {
    return () => {
      // A rearrange made <350ms before unmount (or a boardId change) would otherwise be lost:
      // the debounce timer is still pending, so flush it (fire-and-forget — nothing to set state
      // on once torn down) BEFORE clearing it. flushPendingNodes is stable per boardId, so this
      // re-registers (and correctly flushes the OLD board's pending save) if boardId ever changes.
      if (saveTimer.current) flushPendingNodes();
    };
  }, [flushPendingNodes]);

  const persistNodes = useCallback(
    (inputs: SaveMoodboardNodeInput[]) => {
      pendingSaveInputs.current = inputs;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        flushPendingNodes();
      }, 350);
    },
    [flushPendingNodes],
  );

  const onNodesChange = useCallback(
    (inputs: SaveMoodboardNodeInput[]) => {
      setNodes((prev) => {
        const next = materializeInputs(boardId, prev, inputs);
        persistNodes(next.map(toInput));
        return next;
      });
    },
    [boardId, persistNodes],
  );

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-lg border border-border bg-surface">
      <MoodboardCanvas
        viewKey={boardId}
        nodes={nodes}
        selectedIds={selectedIds}
        moodboardAssets={assets}
        onSelectIds={setSelectedIds}
        onNodesChange={onNodesChange}
        onAddNote={noop}
        onAddSection={noop}
        onAddImageGenerator={noop}
        onUploadFiles={noop}
        onGenerateImage={async () => {}}
      />
    </div>
  );
}
