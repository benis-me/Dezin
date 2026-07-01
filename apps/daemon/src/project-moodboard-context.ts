import { join } from "node:path";
import type { MoodboardAsset, Store } from "../../../packages/core/src/index.ts";
import { buildMoodboardAgentContext } from "./moodboard-agent.ts";

export interface ProjectMoodboardRef {
  id: string;
  name?: string;
}

export interface ProjectMoodboardContext {
  promptBlock: string;
  labels: ProjectMoodboardRef[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clipped(value: string, max = 80_000): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

export function normalizeProjectMoodboardRefs(value: unknown): ProjectMoodboardRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const refs: ProjectMoodboardRef[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const id = stringValue(record?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({ id, name: stringValue(record?.name) || undefined });
    if (refs.length >= 3) break;
  }
  return refs;
}

export function moodboardAssetPath(dataDir: string, boardId: string, asset: MoodboardAsset): string {
  return join(dataDir, "moodboards", boardId, "assets", `${asset.id}${extForMime(asset.mimeType)}`);
}

export function moodboardReferenceLine(refs: ProjectMoodboardRef[]): string {
  if (!refs.length) return "";
  return `\n\nMoodboard references (available to the Agent at run time): ${refs
    .map((ref) => `${ref.name?.trim() || "Untitled moodboard"} (${ref.id})`)
    .join(", ")}`;
}

export function appendMoodboardReferenceLine(brief: string, refs: ProjectMoodboardRef[]): string {
  if (!refs.length || /Moodboard references/i.test(brief)) return brief;
  return `${brief}${moodboardReferenceLine(refs)}`;
}

export function buildProjectMoodboardContext(input: {
  store: Store;
  dataDir: string;
  refs: ProjectMoodboardRef[];
  request: string;
}): ProjectMoodboardContext {
  const blocks: string[] = [];
  const labels: ProjectMoodboardRef[] = [];

  for (const ref of input.refs) {
    const board = input.store.getMoodboard(ref.id);
    if (!board || board.archivedAt) continue;
    const nodes = input.store.listMoodboardNodes(board.id);
    const assets = input.store.listMoodboardAssets(board.id);
    const messages = input.store.listMoodboardMessages(board.id);
    labels.push({ id: board.id, name: board.name });

    const context = buildMoodboardAgentContext({ board, nodes, assets, messages, content: input.request });
    const assetLines = assets
      .slice(0, 24)
      .map((asset) => {
        const size = asset.width && asset.height ? `${asset.width}x${asset.height}` : "unknown size";
        return `- ${asset.fileName}; id=${asset.id}; ${asset.kind}; ${asset.source}; ${size}; path=${moodboardAssetPath(input.dataDir, board.id, asset)}`;
      })
      .join("\n");

    blocks.push(
      [
        `### ${board.name} (${board.id})`,
        "Budgeted board context:",
        "```json",
        clipped(JSON.stringify(context, null, 2), 60_000),
        "```",
        "Asset files:",
        assetLines || "- No uploaded or generated assets with local files.",
      ].join("\n"),
    );
  }

  if (!blocks.length) return { promptBlock: "", labels: [] };

  return {
    labels,
    promptBlock: [
      "## Referenced Moodboards",
      "The user selected these Moodboards as project references. Treat their nodes, notes, generated prompts, and asset files as design direction and usable source material.",
      "Use local asset file paths when copying, adapting, or inspecting media. Do not fake photographic or product imagery with SVG/DOM drawings when a referenced asset exists.",
      "",
      blocks.join("\n\n"),
    ].join("\n"),
  };
}

function extForMime(mime: string): string {
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("quicktime")) return ".mov";
  return ".png";
}
