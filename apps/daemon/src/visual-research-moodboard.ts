import { copyFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { SaveMoodboardNodeInput, Store } from "../../../packages/core/src/index.ts";
import {
  listVisualAssets, readVisualSources, readVisualMoodboardId, writeVisualMoodboardId,
} from "../../../packages/research/src/index.ts";
import { moodboardAssetPath } from "./project-moodboard-context.ts";

const BOARD_NAME = "Visual research";
const COLS = 4, W = 280, H = 180, GAP = 24, X0 = 80, Y0 = 80;

function mimeForExt(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

export async function syncVisualResearchMoodboard(deps: { store: Store; dataDir: string; projectDir: string }): Promise<{ boardId: string; nodes: number }> {
  const { store, dataDir, projectDir } = deps;
  const assets = await listVisualAssets(projectDir);           // ["visual/assets/a.png", ...]
  if (!assets.length) return { boardId: "", nodes: 0 };
  const sources = await readVisualSources(projectDir);

  // Resolve (or create) the single per-project board via the pointer file.
  const pointerId = await readVisualMoodboardId(projectDir);
  const board = (pointerId && store.getMoodboard(pointerId)) || store.createMoodboard({ name: BOARD_NAME });
  if (board.id !== pointerId) await writeVisualMoodboardId(projectDir, board.id);

  const existingByName = new Map(store.listMoodboardAssets(board.id).map((a) => [a.fileName, a]));
  const nodes: SaveMoodboardNodeInput[] = [];
  assets.forEach((rel, i) => {
    const fileName = basename(rel);                             // "a.png"
    const mimeType = mimeForExt(fileName);
    const asset = existingByName.get(fileName) ?? store.createMoodboardAsset(board.id, {
      kind: "image", fileName, mimeType, width: null, height: null, source: "upload",
    });
    // Copy the downloaded file into the board's on-disk asset store (path keyed by asset id + ext).
    const dest = moodboardAssetPath(dataDir, board.id, asset);
    mkdirSync(join(dataDir, "moodboards", board.id, "assets"), { recursive: true });
    copyFileSync(join(projectDir, ".research", rel), dest);
    const src = sources.find((s) => (s.assets ?? []).some((a) => basename(a) === fileName));
    const col = i % COLS, row = Math.floor(i / COLS);
    nodes.push({
      type: "image",
      x: X0 + col * (W + GAP), y: Y0 + row * (H + GAP), width: W, height: H, zIndex: i,
      data: {
        assetId: asset.id, url: `/api/moodboards/${board.id}/assets/${asset.id}`, fileName, source: "upload",
        ...(src?.url ? { sourceUrl: src.url } : {}),
        ...(src?.designer ? { designer: src.designer } : {}),
        ...(src?.platform ? { platform: src.platform } : {}),
      },
    });
  });
  store.replaceMoodboardNodes(board.id, nodes);
  return { boardId: board.id, nodes: nodes.length };
}
