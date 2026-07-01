import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MoodboardAsset, Store } from "../../../packages/core/src/index.ts";
import { buildMoodboardAgentContext } from "./moodboard-agent.ts";

export interface ProjectMoodboardRef {
  id: string;
  name?: string;
}

export interface ProjectMoodboardContext {
  promptBlock: string;
  labels: ProjectMoodboardRef[];
  bundleRoot: string;
  manifestPath: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  runId: string;
  refs: ProjectMoodboardRef[];
  request: string;
}): ProjectMoodboardContext {
  const bundleRoot = join(input.dataDir, ".runs", input.runId, "moodboards");
  const manifestPath = join(bundleRoot, "manifest.json");
  const labels: ProjectMoodboardRef[] = [];
  const promptSummaries: string[] = [];
  const manifest: {
    format: string;
    version: number;
    runId: string;
    createdAt: number;
    latestUserRequest: string;
    boards: Array<{
      id: string;
      name: string;
      createdAt: number;
      updatedAt: number;
      coverAssetId: string | null;
      files: { board: string; nodes: string; assets: string; messages: string; assetFiles: string; summary: string };
      summary: unknown;
      omitted: unknown;
    }>;
    skipped: ProjectMoodboardRef[];
  } = {
    format: "dezin-moodboard-run-bundle",
    version: 1,
    runId: input.runId,
    createdAt: Date.now(),
    latestUserRequest: input.request,
    boards: [],
    skipped: [],
  };

  for (const ref of input.refs) {
    const board = input.store.getMoodboard(ref.id);
    if (!board || board.archivedAt) {
      manifest.skipped.push(ref);
      continue;
    }
    const nodes = input.store.listMoodboardNodes(board.id);
    const assets = input.store.listMoodboardAssets(board.id);
    const messages = input.store.listMoodboardMessages(board.id);
    labels.push({ id: board.id, name: board.name });

    const context = buildMoodboardAgentContext({ board, nodes, assets, messages, content: input.request });
    const boardDir = join(bundleRoot, "boards", board.id);
    const rel = (file: string): string => `boards/${board.id}/${file}`;
    const assetFiles = assets.map((asset) => {
      const sourcePath = moodboardAssetPath(input.dataDir, board.id, asset);
      const snapshotRel = `asset-files/${asset.id}${extForMime(asset.mimeType)}`;
      const snapshotPath = join(boardDir, snapshotRel);
      const hasSnapshot = existsSync(sourcePath);
      if (hasSnapshot) {
        mkdirSync(dirname(snapshotPath), { recursive: true });
        copyFileSync(sourcePath, snapshotPath);
      }
      return {
        id: asset.id,
        fileName: asset.fileName,
        kind: asset.kind,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        source: asset.source,
        path: hasSnapshot ? snapshotPath : sourcePath,
        sourcePath,
        snapshotPath: hasSnapshot ? rel(snapshotRel) : null,
      };
    });
    const boardSnapshot = {
      id: board.id,
      name: board.name,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      archivedAt: board.archivedAt,
      coverAssetId: board.coverAssetId ?? null,
    };

    writeJson(join(boardDir, "board.json"), boardSnapshot);
    writeJson(join(boardDir, "nodes.json"), nodes);
    writeJson(join(boardDir, "assets.json"), assets);
    writeJson(join(boardDir, "messages.json"), messages);
    writeJson(join(boardDir, "asset-files.json"), assetFiles);
    writeJson(join(boardDir, "summary.json"), context);

    manifest.boards.push({
      id: board.id,
      name: board.name,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      coverAssetId: board.coverAssetId ?? null,
      files: {
        board: rel("board.json"),
        nodes: rel("nodes.json"),
        assets: rel("assets.json"),
        messages: rel("messages.json"),
        assetFiles: rel("asset-files.json"),
        summary: rel("summary.json"),
      },
      summary: context.summary,
      omitted: context.omitted,
    });
    promptSummaries.push(
      `- ${board.name} (${board.id}): ${nodes.length} nodes, ${assets.length} assets, ${messages.length} messages.`,
    );
  }

  if (!manifest.boards.length) return { promptBlock: "", labels: [], bundleRoot, manifestPath };
  mkdirSync(bundleRoot, { recursive: true });
  writeJson(manifestPath, manifest);

  return {
    labels,
    bundleRoot,
    manifestPath,
    promptBlock: [
      "## Referenced Moodboards",
      "The user selected Moodboards for this run. A read-only snapshot bundle has been written for you.",
      `Manifest: ${manifestPath}`,
      "",
      "Read the moodboard files you need from the manifest. Use nodes, messages, and asset file paths as design direction and source material. Do not fake photographic/product/video imagery with SVG or DOM drawings when usable moodboard assets exist.",
      "",
      "Available boards:",
      promptSummaries.join("\n"),
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
