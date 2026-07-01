import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Moodboard, MoodboardAsset, SaveMoodboardNodeInput } from "../../../packages/core/src/index.ts";
import { requestImage } from "./image-gen.ts";
import type { AppDeps } from "./app.ts";
import { readJsonBody, send, sendError, sendJson } from "./http-util.ts";

type JsonObject = Record<string, unknown>;

function moodboardDir(dataDir: string, boardId: string): string {
  return join(dataDir, "moodboards", boardId);
}

function moodboardAssetsDir(dataDir: string, boardId: string): string {
  return join(moodboardDir(dataDir, boardId), "assets");
}

function assetUrl(boardId: string, assetId: string): string {
  return `/api/moodboards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}`;
}

function withCover(board: Moodboard, assets: MoodboardAsset[] = []): Moodboard & { coverUrl: string | null } {
  const cover = board.coverAssetId ? assets.find((a) => a.id === board.coverAssetId) : null;
  return { ...board, coverUrl: cover ? assetUrl(board.id, cover.id) : null };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function extForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "video/mp4") return ".mp4";
  return ".png";
}

function mimeForFile(fileName: string, fallback: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  return fallback || "image/png";
}

function validNode(input: unknown): SaveMoodboardNodeInput | null {
  const node = asObject(input);
  const type =
    node.type === "note" || node.type === "section" || node.type === "video" || node.type === "image-generator"
      ? node.type
      : node.type === "image"
        ? "image"
        : null;
  if (!type) return null;
  return {
    id: typeof node.id === "string" && node.id.trim() ? node.id.trim() : undefined,
    type,
    x: numberValue(node.x, 0),
    y: numberValue(node.y, 0),
    width: Math.max(32, numberValue(node.width, type === "note" ? 220 : type === "image-generator" ? 360 : 260)),
    height: Math.max(32, numberValue(node.height, type === "note" ? 140 : type === "image-generator" ? 240 : 180)),
    rotation: numberValue(node.rotation, 0),
    zIndex: numberValue(node.zIndex, 0),
    data: asObject(node.data),
  };
}

export function handleListMoodboards(res: ServerResponse, { store }: AppDeps): void {
  const boards = store.listMoodboards().map((board) => withCover(board, store.listMoodboardAssets(board.id)));
  sendJson(res, 200, boards);
}

export async function handleCreateMoodboard(req: IncomingMessage, res: ServerResponse, { store }: AppDeps): Promise<void> {
  const body = asObject(await readJsonBody(req));
  const name = stringValue(body.name);
  if (!name) return sendError(res, 400, "name is required");
  sendJson(res, 201, withCover(store.createMoodboard({ name })));
}

export function handleGetMoodboard(res: ServerResponse, { id }: Record<string, string>, { store }: AppDeps): void {
  const board = store.getMoodboard(id!);
  if (!board) return sendError(res, 404, "moodboard not found");
  const assets = store.listMoodboardAssets(id!);
  sendJson(res, 200, {
    ...withCover(board, assets),
    assets,
    nodes: store.listMoodboardNodes(id!),
    messages: store.listMoodboardMessages(id!),
  });
}

export async function handlePatchMoodboard(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  { store }: AppDeps,
): Promise<void> {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const body = asObject(await readJsonBody(req, 64 * 1024 * 1024));
  if (typeof body.archived === "boolean") {
    const board = store.setMoodboardArchived(id!, body.archived);
    return board ? sendJson(res, 200, withCover(board, store.listMoodboardAssets(id!))) : sendError(res, 404, "moodboard not found");
  }
  const patch: Partial<Pick<Moodboard, "name" | "coverAssetId">> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if ("coverAssetId" in body) patch.coverAssetId = typeof body.coverAssetId === "string" ? body.coverAssetId : null;
  sendJson(res, 200, withCover(store.updateMoodboard(id!, patch), store.listMoodboardAssets(id!)));
}

export function handleDeleteMoodboard(res: ServerResponse, { id }: Record<string, string>, { store }: AppDeps): void {
  store.deleteMoodboard(id!);
  res.writeHead(204);
  res.end();
}

export function handleListMoodboardNodes(res: ServerResponse, { id }: Record<string, string>, { store }: AppDeps): void {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  sendJson(res, 200, store.listMoodboardNodes(id!));
}

export async function handlePutMoodboardNodes(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  { store }: AppDeps,
): Promise<void> {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const body = asObject(await readJsonBody(req));
  const rawNodes = Array.isArray(body.nodes) ? body.nodes : null;
  if (!rawNodes) return sendError(res, 400, "nodes must be an array");
  const nodes = rawNodes.map(validNode);
  if (nodes.some((n) => n === null)) return sendError(res, 400, "invalid node");
  sendJson(res, 200, store.replaceMoodboardNodes(id!, nodes as SaveMoodboardNodeInput[]));
}

export function handleListMoodboardMessages(res: ServerResponse, { id }: Record<string, string>, { store }: AppDeps): void {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  sendJson(res, 200, store.listMoodboardMessages(id!));
}

export async function handlePostMoodboardMessage(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  { store }: AppDeps,
): Promise<void> {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const body = asObject(await readJsonBody(req));
  const content = stringValue(body.content);
  if (!content) return sendError(res, 400, "content is required");
  const user = store.addMoodboardMessage(id!, "user", content);
  const nodes = store.listMoodboardNodes(id!);
  const assistant = store.addMoodboardMessage(
    id!,
    "assistant",
    `Canvas context: ${nodes.length} item${nodes.length === 1 ? "" : "s"}. Use an image generator node to place new visual material on the board.`,
  );
  sendJson(res, 201, { messages: [user, assistant] });
}

export async function handleUploadMoodboardAsset(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  { store, dataDir }: AppDeps,
): Promise<void> {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const body = asObject(await readJsonBody(req));
  const contentBase64 = stringValue(body.contentBase64);
  if (!contentBase64) return sendError(res, 400, "contentBase64 is required");
  const originalName = stringValue(body.name) || "asset.png";
  const mimeType = mimeForFile(originalName, stringValue(body.mimeType) || "image/png");
  const kind = mimeType.startsWith("video/") ? "video" : "image";
  const asset = store.createMoodboardAsset(id!, {
    kind,
    fileName: originalName,
    mimeType,
    width: typeof body.width === "number" ? Math.round(body.width) : null,
    height: typeof body.height === "number" ? Math.round(body.height) : null,
    source: "upload",
  });
  const dir = moodboardAssetsDir(dataDir, id!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${asset.id}${extForMime(mimeType)}`), Buffer.from(contentBase64, "base64"));
  sendJson(res, 201, { ...asset, url: assetUrl(id!, asset.id) });
}

export function handleServeMoodboardAsset(
  res: ServerResponse,
  { id, assetId }: Record<string, string>,
  { store, dataDir }: AppDeps,
): void {
  const board = store.getMoodboard(id!);
  const asset = store.getMoodboardAsset(assetId!);
  if (!board || !asset || asset.boardId !== id) return sendError(res, 404, "asset not found");
  const file = join(moodboardAssetsDir(dataDir, id!), `${asset.id}${extForMime(asset.mimeType)}`);
  if (!existsSync(file)) return sendError(res, 404, "asset file not found");
  send(res, 200, readFileSync(file), asset.mimeType);
}

export async function handleGenerateMoodboardImage(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  { store, dataDir }: AppDeps,
): Promise<void> {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const settings = store.getSettings();
  if (!settings.imageApiBaseUrl || !settings.imageApiKey) return sendError(res, 409, "image generation is not configured");
  const body = asObject(await readJsonBody(req));
  const prompt = stringValue(body.prompt);
  if (!prompt) return sendError(res, 400, "prompt is required");
  const generatorId = stringValue(body.generatorId);

  const b64 = await requestImage(
    { baseUrl: settings.imageApiBaseUrl, apiKey: settings.imageApiKey, model: settings.imageModel },
    prompt,
    fetch,
  );
  const asset = store.createMoodboardAsset(id!, {
    kind: "image",
    fileName: "generated.png",
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    source: "generated",
  });
  const dir = moodboardAssetsDir(dataDir, id!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${asset.id}.png`), Buffer.from(b64, "base64"));

  const nodes = store.listMoodboardNodes(id!);
  const generator = generatorId ? nodes.find((node) => node.id === generatorId && node.type === "image-generator") : null;
  const x = numberValue(body.x, generator ? generator.x + generator.width + 24 : 80 + nodes.length * 24);
  const y = numberValue(body.y, generator ? generator.y : 80 + nodes.length * 24);
  const maxZ = Math.max(0, ...nodes.map((node) => node.zIndex ?? 0));
  const updatedNodes = generator
    ? nodes.map((node) =>
        node.id === generator.id
          ? {
              type: node.type,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              rotation: node.rotation,
              zIndex: node.zIndex,
              id: node.id,
              data: {
                ...node.data,
                generatorPrompt: prompt,
                generatorStatus: "done",
                resultAssetId: asset.id,
                resultUrl: assetUrl(id!, asset.id),
              },
            }
          : node,
      )
    : nodes;
  const saved = store.replaceMoodboardNodes(id!, [
    ...updatedNodes,
    {
      type: "image",
      x,
      y,
      width: generator ? Math.max(180, generator.width) : 320,
      height: generator ? Math.max(180, generator.height) : 320,
      zIndex: maxZ + 1,
      data: { assetId: asset.id, url: assetUrl(id!, asset.id), prompt, source: "generated" },
    },
  ]);
  const user = store.addMoodboardMessage(id!, "user", `Generate image: ${prompt}`);
  const assistant = store.addMoodboardMessage(id!, "assistant", "Generated an image and placed it on the canvas.");
  sendJson(res, 201, { asset: { ...asset, url: assetUrl(id!, asset.id) }, nodes: saved, messages: [user, assistant] });
}
