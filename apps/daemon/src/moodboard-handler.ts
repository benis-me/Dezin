import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Moodboard, MoodboardAsset, MoodboardConversation, MoodboardNode, SaveMoodboardNodeInput } from "../../../packages/core/src/index.ts";
import { requestImage, requestImageEdit, type ImageGenerationParams } from "./image-gen.ts";
import {
  buildMoodboardAgentContext,
  buildMoodboardAgentPrompt,
  clippedBlock,
  localMoodboardReply,
  parseMoodboardAgentOutput,
  runMoodboardAgentText,
  type MoodboardAgentCanvasOperation,
} from "./moodboard-agent.ts";
import type { AppDeps } from "./app.ts";
import { readJsonBody, send, sendError, sendJson } from "./http-util.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { providerRuntimeConfig } from "./provider-profile-config.ts";
import { createProviderFetch } from "./provider-fetch.ts";

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

function conversationForBoard(conversation: MoodboardConversation | null, boardId: string): MoodboardConversation | null {
  return conversation && conversation.boardId === boardId ? conversation : null;
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

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function normalizeImageParams(value: unknown): ImageGenerationParams {
  const input = asObject(value);
  const params: ImageGenerationParams = {};
  const quality = enumValue(input.quality, ["auto", "low", "medium", "high"] as const);
  const background = enumValue(input.background, ["auto", "transparent", "opaque"] as const);
  const outputFormat = enumValue(input.outputFormat, ["png", "jpeg", "webp"] as const);
  const moderation = enumValue(input.moderation, ["auto", "low"] as const);
  const size = typeof input.size === "string" && /^\d{2,5}x\d{2,5}$/.test(input.size) ? (input.size as `${number}x${number}`) : undefined;
  const aspectRatio =
    typeof input.aspectRatio === "string" && /^\d{1,2}:\d{1,2}$/.test(input.aspectRatio)
      ? (input.aspectRatio as `${number}:${number}`)
      : undefined;
  const outputCompression =
    typeof input.outputCompression === "number" && Number.isFinite(input.outputCompression)
      ? Math.max(0, Math.min(100, Math.round(input.outputCompression)))
      : undefined;
  const count = typeof input.count === "number" && Number.isFinite(input.count) ? Math.max(1, Math.min(4, Math.round(input.count))) : undefined;
  if (quality) params.quality = quality;
  if (size) params.size = size;
  if (aspectRatio) params.aspectRatio = aspectRatio;
  if (background) params.background = background;
  if (outputFormat) params.outputFormat = outputFormat;
  if (outputCompression !== undefined) params.outputCompression = outputCompression;
  if (moderation) params.moderation = moderation;
  if (count !== undefined) params.count = count;
  return params;
}

function hasImageParams(params: ImageGenerationParams): boolean {
  return Object.keys(params).length > 0;
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

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textValue(value: unknown, fallback: string, max = 2000): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function nodeInput(node: MoodboardNode): SaveMoodboardNodeInput {
  return {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    zIndex: node.zIndex,
    data: node.data,
  };
}

function sized(value: unknown, fallback: number): number {
  return Math.max(40, finiteNumber(value, fallback));
}

function position(value: unknown, fallback: number): number {
  return Math.round(finiteNumber(value, fallback));
}

function applyMoodboardAgentOperations(
  nodes: MoodboardNode[],
  operations: MoodboardAgentCanvasOperation[],
  conversationId?: string,
): SaveMoodboardNodeInput[] {
  if (!operations.length) return nodes.map(nodeInput);
  const inputs = nodes.map(nodeInput);
  const indexById = new Map(inputs.map((node, index) => [node.id, index]));
  const maxZ = Math.max(0, ...nodes.map((node) => node.zIndex ?? 0));
  let addCount = 0;

  for (const operation of operations) {
    const fallbackX = 120 + (nodes.length + addCount) * 24;
    const fallbackY = 120 + (nodes.length + addCount) * 24;
    if (operation.type === "add_note") {
      inputs.push({
        type: "note",
        x: position(operation.x, fallbackX),
        y: position(operation.y, fallbackY),
        width: sized(operation.width, 220),
        height: sized(operation.height, 140),
        zIndex: maxZ + addCount + 1,
        data: { ...(operation.data ?? {}), content: textValue(operation.content, "New note") },
      });
      addCount++;
      continue;
    }
    if (operation.type === "add_section") {
      inputs.push({
        type: "section",
        x: position(operation.x, fallbackX),
        y: position(operation.y, fallbackY),
        width: sized(operation.width, 460),
        height: sized(operation.height, 300),
        zIndex: maxZ + addCount + 1,
        data: { ...(operation.data ?? {}), title: textValue(operation.title, "Section", 400) },
      });
      addCount++;
      continue;
    }
    if (operation.type === "add_image_generator") {
      const prompt = textValue(operation.prompt, "", 2000);
      inputs.push({
        type: "image-generator",
        x: position(operation.x, fallbackX),
        y: position(operation.y, fallbackY),
        width: sized(operation.width, 360),
        height: sized(operation.height, 240),
        zIndex: maxZ + addCount + 1,
        data: {
          ...(conversationId ? { agentConversationId: conversationId } : {}),
          ...(operation.data ?? {}),
          generatorPrompt: prompt,
          generatorStatus: "ready",
        },
      });
      addCount++;
      continue;
    }
    if (operation.type === "update_node") {
      const index = indexById.get(operation.id);
      if (index == null) continue;
      const current = inputs[index]!;
      inputs[index] = {
        ...current,
        x: operation.x === undefined ? current.x : position(operation.x, current.x),
        y: operation.y === undefined ? current.y : position(operation.y, current.y),
        width: operation.width === undefined ? current.width : sized(operation.width, current.width),
        height: operation.height === undefined ? current.height : sized(operation.height, current.height),
        rotation: operation.rotation === undefined ? current.rotation : finiteNumber(operation.rotation, current.rotation ?? 0),
        zIndex: operation.zIndex === undefined ? current.zIndex : finiteNumber(operation.zIndex, current.zIndex ?? 0),
        data: { ...(current.data ?? {}), ...(operation.data ?? {}) },
      };
    }
  }

  return inputs;
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
  const conversations = store.listMoodboardConversations(id!);
  const activeConversationId = conversations[0]?.id ?? store.ensureMoodboardConversation(id!).id;
  sendJson(res, 200, {
    ...withCover(board, assets),
    assets,
    nodes: store.listMoodboardNodes(id!),
    conversations,
    activeConversationId,
    messages: store.listMoodboardMessages(id!, activeConversationId),
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

export async function handleDeleteMoodboard(res: ServerResponse, { id }: Record<string, string>, { store, dataDir }: AppDeps): Promise<void> {
  store.deleteMoodboard(id!);
  await rm(moodboardDir(dataDir, id!), { recursive: true, force: true });
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

export function handleListMoodboardConversations(res: ServerResponse, { id }: Record<string, string>, { store }: AppDeps): void {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  sendJson(res, 200, store.listMoodboardConversations(id!));
}

export async function handleCreateMoodboardConversation(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  { store }: AppDeps,
): Promise<void> {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const body = asObject(await readJsonBody(req));
  sendJson(res, 201, store.createMoodboardConversation(id!, stringValue(body.title) || "Conversation 1"));
}

export async function handleRenameMoodboardConversation(
  req: IncomingMessage,
  res: ServerResponse,
  { id, cid }: Record<string, string>,
  { store }: AppDeps,
): Promise<void> {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const conversation = conversationForBoard(store.getMoodboardConversation(cid!), id!);
  if (!conversation) return sendError(res, 404, "moodboard conversation not found");
  const body = asObject(await readJsonBody(req));
  const title = stringValue(body.title);
  if (!title) return sendError(res, 400, "title is required");
  sendJson(res, 200, store.renameMoodboardConversation(cid!, title));
}

export function handleDeleteMoodboardConversation(res: ServerResponse, { id, cid }: Record<string, string>, { store }: AppDeps): void {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const conversation = conversationForBoard(store.getMoodboardConversation(cid!), id!);
  if (!conversation) return sendError(res, 404, "moodboard conversation not found");
  store.deleteMoodboardConversation(cid!);
  sendJson(res, 200, { ok: true, conversations: store.listMoodboardConversations(id!) });
}

export function handleListMoodboardConversationMessages(res: ServerResponse, { id, cid }: Record<string, string>, { store }: AppDeps): void {
  if (!store.getMoodboard(id!)) return sendError(res, 404, "moodboard not found");
  const conversation = conversationForBoard(store.getMoodboardConversation(cid!), id!);
  if (!conversation) return sendError(res, 404, "moodboard conversation not found");
  sendJson(res, 200, store.listMoodboardMessages(id!, cid!));
}

export async function handlePostMoodboardMessage(
  req: IncomingMessage,
  res: ServerResponse,
  { id, cid }: Record<string, string>,
  { store, dataDir, moodboardAgentText }: AppDeps,
): Promise<void> {
  const board = store.getMoodboard(id!);
  if (!board) return sendError(res, 404, "moodboard not found");
  const body = asObject(await readJsonBody(req));
  const content = stringValue(body.content);
  if (!content) return sendError(res, 400, "content is required");
  const agentCommand = stringValue(body.agentCommand);
  const model = stringValue(body.model) || undefined;
  const conversationId = cid || stringValue(body.conversationId) || store.ensureMoodboardConversation(id!).id;
  const conversation = conversationForBoard(store.getMoodboardConversation(conversationId), id!);
  if (!conversation) return sendError(res, 404, "moodboard conversation not found");
  const previousMessages = store.listMoodboardMessages(id!, conversation.id);
  const user = store.addMoodboardMessage(id!, "user", content, conversation.id);
  const nodes = store.listMoodboardNodes(id!);
  const assets = store.listMoodboardAssets(id!);
  const messages = store.listMoodboardMessages(id!, conversation.id);
  const cwd = moodboardDir(dataDir, id!);
  mkdirSync(cwd, { recursive: true });
  const contextPath = join(cwd, "moodboard-context.json");
  writeFileSync(contextPath, JSON.stringify(buildMoodboardAgentContext({ board, nodes, assets, messages: previousMessages, content }), null, 2));

  let assistantText = localMoodboardReply(nodes, assets);
  if (agentCommand) {
    const prompt = buildMoodboardAgentPrompt({ board, nodes, assets, messages: previousMessages, content, contextPath });
    const env = buildAgentEnv(store.getSettings(), agentCommand);
    try {
      assistantText = await runMoodboardAgentText(
        { board, nodes, assets, messages, content, agentCommand, model, prompt, cwd, env },
        moodboardAgentText,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "request failed";
      assistantText = `${assistantText}\n\nAgent note: ${agentCommand} could not respond (${clippedBlock(reason, 180)}).`;
    }
  }
  const parsed = parseMoodboardAgentOutput(assistantText);
  const savedNodes = parsed.operations.length
    ? store.replaceMoodboardNodes(id!, applyMoodboardAgentOperations(nodes, parsed.operations, conversation.id))
    : undefined;
  const assistant = store.addMoodboardMessage(id!, "assistant", clippedBlock(parsed.text || "Updated the moodboard."), conversation.id);
  sendJson(res, 201, { messages: [user, assistant], ...(savedNodes ? { nodes: savedNodes } : {}) });
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
  const runtime = providerRuntimeConfig(settings, settings.aiProviderId);
  const imageBaseUrl = runtime.baseUrl || settings.imageApiBaseUrl;
  const imageApiKey = runtime.apiKey || settings.imageApiKey;
  if (!imageBaseUrl || !imageApiKey) return sendError(res, 409, "image generation is not configured");
  const body = asObject(await readJsonBody(req));
  const prompt = stringValue(body.prompt);
  if (!prompt) return sendError(res, 400, "prompt is required");
  const generatorId = stringValue(body.generatorId);
  const model = stringValue(body.model) || settings.imageModel;
  const params = normalizeImageParams(body.params);
  const hasParams = hasImageParams(params);
  const conversationId = stringValue(body.conversationId);
  const notifyConversation = conversationId ? conversationForBoard(store.getMoodboardConversation(conversationId), id!) : null;
  if (conversationId && !notifyConversation) return sendError(res, 404, "moodboard conversation not found");
  const sourceAssetId = stringValue(body.sourceAssetId);
  const sourceAsset = sourceAssetId ? store.getMoodboardAsset(sourceAssetId) : null;
  if (sourceAssetId && (!sourceAsset || sourceAsset.boardId !== id)) return sendError(res, 404, "source asset not found");
  const sourceFile =
    sourceAsset != null ? join(moodboardAssetsDir(dataDir, id!), `${sourceAsset.id}${extForMime(sourceAsset.mimeType)}`) : "";
  if (sourceAsset && !existsSync(sourceFile)) return sendError(res, 404, "source asset file not found");

  const imageOpts = {
    baseUrl: imageBaseUrl,
    apiKey: imageApiKey,
    model,
    providerId: settings.aiProviderId,
    apiVersion: runtime.organization || settings.aiProviderOrganization,
    ...(hasParams ? { params } : {}),
  };
  const statusMessages = notifyConversation
    ? [store.addMoodboardMessage(id!, "assistant", `${sourceAsset ? "Editing" : "Generating"} image: ${prompt}`, notifyConversation.id)]
    : [];
  let b64: string;
  try {
    const providerFetch = createProviderFetch();
    b64 = sourceAsset
      ? await requestImageEdit(
          imageOpts,
          prompt,
          { data: readFileSync(sourceFile), mimeType: sourceAsset.mimeType, fileName: sourceAsset.fileName },
          providerFetch,
        )
      : await requestImage(imageOpts, prompt, providerFetch);
  } catch (err) {
    if (notifyConversation) {
      store.addMoodboardMessage(
        id!,
        "assistant",
        `${sourceAsset ? "Image edit" : "Image generation"} failed: ${err instanceof Error ? clippedBlock(err.message, 180) : "request failed"}`,
        notifyConversation.id,
      );
    }
    throw err;
  }
  const asset = store.createMoodboardAsset(id!, {
    kind: "image",
    fileName: sourceAsset ? "edited.png" : "generated.png",
    mimeType: "image/png",
    width: sourceAsset?.width ?? 1024,
    height: sourceAsset?.height ?? 1024,
    source: sourceAsset ? "edited" : "generated",
  });
  const dir = moodboardAssetsDir(dataDir, id!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${asset.id}.png`), Buffer.from(b64, "base64"));

  const nodes = store.listMoodboardNodes(id!);
  const generator = generatorId ? nodes.find((node) => node.id === generatorId && node.type === "image-generator") : null;
  const x = numberValue(body.x, generator ? generator.x + generator.width + 24 : 80 + nodes.length * 24);
  const y = numberValue(body.y, generator ? generator.y : 80 + nodes.length * 24);
  const maxZ = Math.max(0, ...nodes.map((node) => node.zIndex ?? 0));
  const replaceGenerator = Boolean(generator && !sourceAsset);
  const imageData = {
    assetId: asset.id,
    url: assetUrl(id!, asset.id),
    prompt,
    model,
    source: sourceAsset ? "edited" : "generated",
    ...(hasParams ? { generationParams: params } : {}),
    ...(sourceAsset ? { sourceAssetId } : {}),
  };
  const updatedNodes: SaveMoodboardNodeInput[] = generator
    ? nodes.map<SaveMoodboardNodeInput>((node) =>
        node.id === generator.id
          ? replaceGenerator
            ? {
                type: "image",
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
                rotation: node.rotation,
                zIndex: node.zIndex,
                id: node.id,
                data: imageData,
              }
            : {
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
                  generatorModel: model,
                  generatorStatus: "done",
                  resultAssetId: asset.id,
                  resultUrl: assetUrl(id!, asset.id),
                  ...(hasParams ? { generationParams: params } : {}),
                },
              }
          : node,
      )
    : nodes;
  const appendedImageNode: SaveMoodboardNodeInput = {
    type: "image",
    x,
    y,
    width: generator ? Math.max(180, generator.width) : 320,
    height: generator ? Math.max(180, generator.height) : 320,
    zIndex: maxZ + 1,
    data: imageData,
  };
  const saved = store.replaceMoodboardNodes(
    id!,
    replaceGenerator
      ? updatedNodes
      : [...updatedNodes, appendedImageNode],
  );
  if (notifyConversation) {
    statusMessages.push(
      store.addMoodboardMessage(
        id!,
        "assistant",
        sourceAsset ? "Edited the image and placed the result on the canvas." : "Generated an image and placed it on the canvas.",
        notifyConversation.id,
      ),
    );
  }
  sendJson(res, 201, { asset: { ...asset, url: assetUrl(id!, asset.id) }, nodes: saved, messages: statusMessages });
}
