import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

import {
  WorkspaceResourceNotFoundError,
  WorkspaceResourceOwnershipError,
} from "../../../packages/core/src/index.ts";
import type {
  Resource,
  ResourceRevision,
  EffectRevisionParameterView,
  EffectResourceRevisionContentView,
  MoodboardResourceRevisionContentView,
  SharinganCaptureResourceRevisionContentView,
  ResourceRevisionPreviewKind,
  ResourceRevisionView,
  Store,
} from "../../../packages/core/src/index.ts";
import { inspectBoundedPngImage } from "./artifact-thumbnail.ts";
import {
  decodeSharinganCaptureResourceBundle,
  SharinganCaptureResourceBundleError,
  validateSharinganCaptureResourceBundleSemantics,
} from "./orchestration/sharingan-capture-resource-bundle.ts";
import {
  ResourceRevisionPayloadError,
  resolveResourceRevisionPayloadDescriptor,
  verifyBoundedResourcePayloadBytes,
  verifyResourceRevisionPayload,
  type ResourceRevisionPayloadDescriptor,
} from "./resource-revision-payload.ts";
import {
  readResearchResourceRevision,
  ResearchResourceRevisionError,
} from "./research-resource-revision.ts";

const MAX_TEXT_PREVIEW_CODE_UNITS = 256 * 1024;
const MAX_MOODBOARD_VIEW_NODES = 256;
const MAX_MOODBOARD_VIEW_ASSETS = 128;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CREDENTIAL_PARAMETER = /(?:^|[_-])(?:access[_-]?token|token|api[_-]?key|secret|signature|sig|auth|authorization|password|credential)(?:$|[_-])/i;

export class ResourceRevisionViewError extends Error {
  readonly status: 404 | 422;

  constructor(status: 404 | 422, message: string) {
    super(message);
    this.name = "ResourceRevisionViewError";
    this.status = status;
  }
}

function fail(status: 404 | 422, message: string): never {
  throw new ResourceRevisionViewError(status, message);
}

function safeLabel(value: unknown, fallback: string, maximum = 1_024): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function requiredText(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value.includes("\0") || value.length > maximum) return fail(422, `${label} is invalid`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const id = requiredText(value, label, 256);
  if (!IDENTIFIER.test(id)) return fail(422, `${label} is not canonical`);
  return id;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(422, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null;
}

function optionalText(value: unknown, maximum = 4_096): string {
  return typeof value === "string" ? safeLabel(value, "", maximum) : "";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resourceRevisionEmbeddedAssetId(path: string): string {
  return createHash("sha256")
    .update("dezin-resource-view-embedded-v1")
    .update("\0")
    .update(path)
    .digest("hex");
}

function frozenHttpUrl(value: unknown, label: string): string {
  const raw = requiredText(value, label, 4_096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(422, `${label} is invalid`);
  }
  const fragmentParameters = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
    || url.href !== raw
    || [...url.searchParams.keys(), ...fragmentParameters.keys()].some((key) => CREDENTIAL_PARAMETER.test(key))) {
    return fail(422, `${label} is not a canonical credential-free HTTP(S) identity`);
  }
  return raw;
}

function effectValue(value: unknown, label: string): string | number | boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000) return value;
  if (typeof value === "string" && value.length <= 4_096 && !value.includes("\0")) return value;
  return fail(422, `${label} is invalid`);
}

function decodeEffectContent(bytes: Buffer): EffectResourceRevisionContentView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(422, "Effect Revision payload is not valid UTF-8 JSON");
  }
  const payload = record(parsed, "Effect Revision payload");
  if (payload.format !== "dezin-effect-resource" || payload.version !== 1) {
    return fail(422, "Effect Revision payload protocol is unsupported");
  }
  const definition = record(payload.definition, "Effect definition");
  if ((definition.origin !== "built-in" && definition.origin !== "custom")
    || !Array.isArray(definition.parameters) || definition.parameters.length > 128
    || !Array.isArray(definition.presets) || definition.presets.length > 64) {
    return fail(422, "Effect definition is invalid or unbounded");
  }
  const parameterIds = new Set<string>();
  const parameters = definition.parameters.map((raw, index): EffectRevisionParameterView => {
    const parameter = record(raw, `Effect parameter ${index}`);
    const id = identifier(parameter.id, `Effect parameter ${index} id`);
    if (parameterIds.has(id)) return fail(422, `Effect parameter ${id} is duplicated`);
    parameterIds.add(id);
    if (parameter.type !== "number" && parameter.type !== "color" && parameter.type !== "select"
      && parameter.type !== "boolean" && parameter.type !== "image") {
      return fail(422, `Effect parameter ${id} type is unsupported`);
    }
    const type = parameter.type;
    const options = parameter.options === undefined ? [] : parameter.options;
    if (!Array.isArray(options) || options.length > 64) return fail(422, `Effect parameter ${id} options are unbounded`);
    const min = parameter.min === undefined ? undefined : finite(parameter.min);
    const max = parameter.max === undefined ? undefined : finite(parameter.max);
    const step = parameter.step === undefined ? undefined : finite(parameter.step);
    if ((parameter.min !== undefined && min === null) || (parameter.max !== undefined && max === null)
      || (parameter.step !== undefined && (typeof step !== "number" || step <= 0))
      || (typeof min === "number" && typeof max === "number" && min > max)) {
      return fail(422, `Effect parameter ${id} numeric bounds are invalid`);
    }
    const defaultValue = effectValue(parameter.defaultValue, `Effect parameter ${id} default`);
    return {
      id,
      label: safeLabel(parameter.label, id, 512),
      type,
      defaultValue,
      ...(typeof min === "number" ? { min } : {}),
      ...(typeof max === "number" ? { max } : {}),
      ...(typeof step === "number" ? { step } : {}),
      options: options.map((rawOption, optionIndex) => {
        const option = record(rawOption, `Effect parameter ${id} option ${optionIndex}`);
        return {
          label: safeLabel(option.label, `Option ${optionIndex + 1}`, 512),
          value: requiredText(option.value, `Effect parameter ${id} option ${optionIndex} value`, 4_096),
        };
      }),
      description: optionalText(parameter.description, 2_048),
    };
  });
  const presetIds = new Set<string>();
  const presets = definition.presets.map((raw, index) => {
    const preset = record(raw, `Effect preset ${index}`);
    const id = identifier(preset.id, `Effect preset ${index} id`);
    if (presetIds.has(id)) return fail(422, `Effect preset ${id} is duplicated`);
    presetIds.add(id);
    const values = record(preset.values, `Effect preset ${id} values`);
    if (Object.keys(values).length > parameterIds.size
      || Object.keys(values).some((key) => !parameterIds.has(key))) {
      return fail(422, `Effect preset ${id} references an unknown parameter`);
    }
    return {
      id,
      name: safeLabel(preset.name, id, 512),
      values: Object.fromEntries(Object.entries(values).map(([key, value]) => [
        key,
        effectValue(value, `Effect preset ${id} value ${key}`),
      ])),
    };
  });
  const code = requiredText(definition.code, "Effect definition code", 512 * 1024);
  const defaultValues = Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.defaultValue]));
  return {
    definition: {
      id: identifier(definition.id, "Effect definition id"),
      name: safeLabel(definition.name, "Untitled effect", 1_024),
      origin: definition.origin,
      category: safeLabel(definition.category, "effect", 512),
      summary: safeLabel(definition.summary, "Frozen visual effect", 4_096),
      parameters,
      presets,
      code,
    },
    fixture: {
      width: 640,
      height: 360,
      timesMs: [0, 500, 1_000],
      values: defaultValues,
    },
  };
}

function decodedJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(422, `${label} is not valid UTF-8 JSON`);
  }
}

function sharinganDomSummary(value: unknown): { nodeCount: number; tags: string[] } {
  if (!Array.isArray(value)) return fail(422, "Sharingan DOM roots are invalid");
  const pending = [...value];
  const tags = new Set<string>();
  let nodeCount = 0;
  while (pending.length > 0) {
    const node = record(pending.pop(), `Sharingan DOM node ${nodeCount}`);
    nodeCount += 1;
    if (nodeCount > 2_000) return fail(422, "Sharingan DOM summary exceeds its bound");
    tags.add(requiredText(node.tag, `Sharingan DOM node ${nodeCount} tag`, 64).toLowerCase());
    if (!Array.isArray(node.children) || node.children.length > 2_000) {
      return fail(422, `Sharingan DOM node ${nodeCount} children are invalid`);
    }
    pending.push(...node.children);
  }
  return { nodeCount, tags: [...tags].sort().slice(0, 64) };
}

function sharinganStyleTokens(value: unknown): SharinganCaptureResourceRevisionContentView["pages"][number]["styleTokens"] {
  const styles = record(value, "Sharingan style tokens");
  const result = {} as SharinganCaptureResourceRevisionContentView["pages"][number]["styleTokens"];
  for (const field of ["colors", "fontFamilies", "fontSizes", "radii", "shadows"] as const) {
    const values = styles[field];
    if (!Array.isArray(values) || values.length > 128) return fail(422, `Sharingan style token ${field} is invalid`);
    result[field] = values.map((item, index) => requiredText(
      item,
      `Sharingan style token ${field} ${index}`,
      2_048,
    ));
  }
  return result;
}

function sharinganDimensions(value: unknown, label: string): { width: number; height: number } {
  const item = record(value, label);
  const width = finite(item.width);
  const height = finite(item.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return fail(422, `${label} dimensions are invalid`);
  }
  return { width, height };
}

function sharinganLinkSummaries(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) return fail(422, "Sharingan links are invalid or unbounded");
  const summaries: string[] = [];
  for (const raw of value) {
    const candidate = typeof raw === "string"
      ? raw
      : raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? ((raw as Record<string, unknown>).href ?? (raw as Record<string, unknown>).url ?? (raw as Record<string, unknown>).text)
        : null;
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) continue;
    let summary = candidate;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") summary = `${url.hostname}${url.pathname}`;
    } catch {
      // Relative captured links stay inert summaries; they are never navigation capabilities.
    }
    const safe = safeLabel(summary, "", 512);
    if (safe && !summaries.includes(safe)) summaries.push(safe);
    if (summaries.length >= 64) break;
  }
  return summaries;
}

async function decodeSharinganContent(
  bytes: Buffer,
  identity: { workspaceId: string; resourceId: string },
  route: (assetId: string) => string,
  signal?: AbortSignal,
): Promise<SharinganCaptureResourceRevisionContentView> {
  let bundle: ReturnType<typeof decodeSharinganCaptureResourceBundle>;
  try {
    bundle = decodeSharinganCaptureResourceBundle(bytes);
    if (bundle.scope.workspaceId !== identity.workspaceId || bundle.scope.resourceId !== identity.resourceId) {
      return fail(422, "Sharingan Capture scope does not match its exact immutable owner");
    }
    await validateSharinganCaptureResourceBundleSemantics({
      source: bundle.source,
      files: bundle.files,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof SharinganCaptureResourceBundleError) {
      return fail(422, `Sharingan Capture semantic validation failed: ${error.message}`);
    }
    throw error;
  }
  const files = new Map(bundle.files.map((file) => [file.path, file]));
  const pagesManifestFile = files.get(".sharingan/pages.json");
  if (!pagesManifestFile) return fail(422, "Sharingan Capture pages manifest is unavailable");
  const manifest = record(decodedJson(pagesManifestFile.bytes, "Sharingan pages manifest"), "Sharingan pages manifest");
  if (!Array.isArray(manifest.pages) || manifest.pages.length < 1 || manifest.pages.length > 8) {
    return fail(422, "Sharingan pages are invalid or unbounded");
  }
  const pages = [] as SharinganCaptureResourceRevisionContentView["pages"];
  for (const [pageIndex, raw] of manifest.pages.entries()) {
    const page = record(raw, `Sharingan page ${pageIndex}`);
    const domPath = requiredText(page.dom, `Sharingan page ${pageIndex} DOM path`, 8_192);
    const stylesPath = requiredText(page.styles, `Sharingan page ${pageIndex} styles path`, 8_192);
    const renderMapPath = requiredText(page.renderMap, `Sharingan page ${pageIndex} render map path`, 8_192);
    const domFile = files.get(domPath);
    const stylesFile = files.get(stylesPath);
    const renderMapFile = files.get(renderMapPath);
    if (!domFile || !stylesFile || !renderMapFile) {
      return fail(422, `Sharingan page ${pageIndex} semantic evidence is unavailable`);
    }
    const renderMap = record(decodedJson(renderMapFile.bytes, `Sharingan page ${pageIndex} render map`), `Sharingan page ${pageIndex} render map`);
    const rawScreenshots = record(page.screenshots, `Sharingan page ${pageIndex} screenshots`);
    const screenshots = [] as SharinganCaptureResourceRevisionContentView["pages"][number]["screenshots"];
    for (const [label, rawPath] of Object.entries(rawScreenshots)) {
      if (screenshots.length >= 16) return fail(422, `Sharingan page ${pageIndex} screenshots are unbounded`);
      const path = requiredText(rawPath, `Sharingan page ${pageIndex} screenshot path`, 8_192);
      const file = files.get(path);
      if (!file) return fail(422, `Sharingan page ${pageIndex} screenshot is unavailable`);
      let dimensions: { width: number; height: number };
      try {
        dimensions = await inspectBoundedPngImage(file.bytes, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return fail(422, `Sharingan page ${pageIndex} screenshot is invalid`);
      }
      const id = resourceRevisionEmbeddedAssetId(path);
      const assetRoute = route(id);
      screenshots.push({
        id,
        label: safeLabel(label, `Viewport ${screenshots.length + 1}`, 128),
        ...dimensions,
        url: assetRoute,
        downloadUrl: `${assetRoute}?download=1`,
      });
    }
    pages.push({
      title: safeLabel(page.title, `Page ${pageIndex + 1}`, 4_096),
      requestedUrl: frozenHttpUrl(page.requestedUrl, `Sharingan page ${pageIndex} requested URL`),
      finalUrl: frozenHttpUrl(page.url, `Sharingan page ${pageIndex} final URL`),
      viewport: sharinganDimensions(renderMap.viewport, `Sharingan page ${pageIndex} viewport`),
      document: sharinganDimensions(renderMap.document, `Sharingan page ${pageIndex} document`),
      screenshots,
      dom: sharinganDomSummary(decodedJson(domFile.bytes, `Sharingan page ${pageIndex} DOM`)),
      styleTokens: sharinganStyleTokens(decodedJson(stylesFile.bytes, `Sharingan page ${pageIndex} styles`)),
      links: sharinganLinkSummaries(page.links),
    });
  }
  return {
    source: { ...bundle.source },
    exporter: { ...bundle.exporter },
    pages,
  };
}

async function decodeMoodboardContent(
  bytes: Buffer,
  route: (assetId: string) => string,
  signal?: AbortSignal,
): Promise<MoodboardResourceRevisionContentView> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(422, "Moodboard Revision payload is not valid UTF-8 JSON");
  }
  const bundle = record(parsed, "Moodboard Revision payload");
  if (bundle.format !== "dezin-moodboard-resource-bundle"
    || (bundle.version !== 1 && bundle.version !== 2)
    || !Array.isArray(bundle.nodes) || bundle.nodes.length > 100_000
    || !Array.isArray(bundle.assets) || bundle.assets.length > 1_024) {
    return fail(422, "Moodboard Revision payload protocol is unsupported or unbounded");
  }
  const board = record(bundle.board, "Moodboard board");
  const assetIds = new Set<string>();
  let totalAssetBytes = 0;
  const assets = [] as MoodboardResourceRevisionContentView["assets"];
  for (const [index, raw] of bundle.assets.entries()) {
    const asset = record(raw, `Moodboard Asset ${index}`);
    const id = identifier(asset.id, `Moodboard Asset ${index} id`);
    if (assetIds.has(id)) return fail(422, `Moodboard Asset ${id} is duplicated`);
    assetIds.add(id);
    const metadata = record(asset.metadata, `Moodboard Asset ${id} metadata`);
    if (typeof asset.bytesBase64 !== "string" || asset.bytesBase64.length > 12 * 1024 * 1024
      || !Number.isSafeInteger(asset.byteLength) || Number(asset.byteLength) < 0 || Number(asset.byteLength) > 6 * 1024 * 1024
      || typeof asset.checksum !== "string" || !SHA256.test(asset.checksum)) {
      return fail(422, `Moodboard Asset ${id} immutable metadata is invalid`);
    }
    const assetBytes = Buffer.from(asset.bytesBase64, "base64");
    if (assetBytes.toString("base64") !== asset.bytesBase64
      || assetBytes.byteLength !== asset.byteLength || sha256(assetBytes) !== asset.checksum) {
      return fail(422, `Moodboard Asset ${id} checksum or bytes are invalid`);
    }
    totalAssetBytes += assetBytes.byteLength;
    if (totalAssetBytes > 6 * 1024 * 1024) return fail(422, "Moodboard embedded Asset bytes exceed their bound");
    const mimeType = requiredText(metadata.mimeType, `Moodboard Asset ${id} MIME`, 127).toLowerCase();
    try {
      await verifyBoundedResourcePayloadBytes(assetBytes, mimeType, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof ResourceRevisionPayloadError) {
        return fail(422, `Moodboard Asset ${id} bytes are invalid: ${error.message}`);
      }
      throw error;
    }
    const inline = resourceRevisionPreviewKind(mimeType) === "image";
    if (assets.length < MAX_MOODBOARD_VIEW_ASSETS) {
      const assetRoute = route(id);
      assets.push({
        id,
        kind: safeLabel(metadata.kind, "asset", 128),
        fileName: safeLabel(metadata.fileName, id, 255),
        mimeType,
        width: finite(metadata.width),
        height: finite(metadata.height),
        byteLength: assetBytes.byteLength,
        checksum: asset.checksum,
        url: inline ? assetRoute : null,
        downloadUrl: `${assetRoute}?download=1`,
      });
    }
  }
  const nodes = [] as MoodboardResourceRevisionContentView["nodes"];
  const nodeIds = new Set<string>();
  for (const [index, raw] of bundle.nodes.entries()) {
    const node = record(raw, `Moodboard node ${index}`);
    const id = identifier(node.id, `Moodboard node ${index} id`);
    if (nodeIds.has(id)) return fail(422, `Moodboard node ${id} is duplicated`);
    nodeIds.add(id);
    const data = node.data === undefined ? {} : record(node.data, `Moodboard node ${id} data`);
    const assetIdValue = typeof data.assetId === "string"
      ? data.assetId
      : typeof node.assetId === "string" ? node.assetId : null;
    const assetId = assetIdValue === null ? null : identifier(assetIdValue, `Moodboard node ${id} Asset id`);
    if (assetId !== null && !assetIds.has(assetId)) {
      return fail(422, `Moodboard node ${id} references an unavailable immutable Asset`);
    }
    const x = finite(node.x);
    const y = finite(node.y);
    const width = finite(node.width);
    const height = finite(node.height);
    const hasGeometry = node.x !== undefined || node.y !== undefined
      || node.width !== undefined || node.height !== undefined;
    if (hasGeometry && (x === null || y === null || width === null || height === null
      || width <= 0 || height <= 0)) {
      return fail(422, `Moodboard node ${id} spatial geometry is invalid`);
    }
    if (nodes.length < MAX_MOODBOARD_VIEW_NODES) {
      nodes.push({
        id,
        type: safeLabel(node.type, "node", 128),
        label: optionalText(data.label ?? data.title ?? node.name, 1_024),
        text: optionalText(data.text ?? data.content ?? data.caption, 8_192),
        x,
        y,
        width,
        height,
        assetId,
      });
    }
  }
  const coverAssetId = board.coverAssetId === null || board.coverAssetId === undefined
    ? null
    : identifier(board.coverAssetId, "Moodboard cover Asset id");
  if (coverAssetId !== null && !assetIds.has(coverAssetId)) {
    return fail(422, "Moodboard cover Asset is unavailable");
  }
  return {
    board: {
      id: identifier(board.id, "Moodboard board id"),
      name: safeLabel(board.name, "Untitled moodboard", 1_024),
      coverAssetId,
    },
    nodes,
    assets,
    totalNodeCount: bundle.nodes.length,
    totalAssetCount: bundle.assets.length,
    nodesTruncated: bundle.nodes.length > nodes.length,
    assetsTruncated: bundle.assets.length > assets.length,
  };
}

export function resourceRevisionPreviewKind(mimeType: string): ResourceRevisionPreviewKind {
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "download";
}

function exactRoute(
  projectId: string,
  resourceId: string,
  revisionId: string,
  suffix: string,
): string {
  return `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`
    + `/revisions/${encodeURIComponent(revisionId)}/${suffix}`;
}

function textPreview(bytes: Buffer): { text: string; textTruncated: boolean } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(422, "Resource Revision text payload is not valid UTF-8");
  }
  if (text.length <= MAX_TEXT_PREVIEW_CODE_UNITS) return { text, textTruncated: false };
  let end = MAX_TEXT_PREVIEW_CODE_UNITS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end)}…`, textTruncated: true };
}

export interface VerifiedExactResourceRevisionPayload {
  resource: Resource;
  revision: ResourceRevision;
  observed: { headRevisionId: string | null; snapshotId: string };
  descriptor: ResourceRevisionPayloadDescriptor;
  bytes: Buffer;
}

export interface VerifiedResourceRevisionEmbeddedAsset {
  bytes: Buffer;
  mimeType: string;
  checksum: string;
  fileName: string;
}

/**
 * Resolve ownership first, then re-verify manifest and payload while copying to
 * a private readback file. Callers only receive bytes from that verified copy,
 * never from a second mutable-path read.
 */
export async function readVerifiedExactResourceRevisionPayload(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  resourceId: string;
  revisionId: string;
  signal?: AbortSignal;
}): Promise<VerifiedExactResourceRevisionPayload> {
  input.signal?.throwIfAborted();
  if (!input.store.getProject(input.projectId) || !input.store.workspace.getWorkspace(input.projectId)) {
    return fail(404, "Resource Revision was not found");
  }
  let facts: ReturnType<Store["workspace"]["getResourceRevisionViewFactsForProject"]>;
  try {
    facts = input.store.workspace.getResourceRevisionViewFactsForProject(
      input.projectId,
      input.resourceId,
      input.revisionId,
    );
  } catch (error) {
    if (error instanceof WorkspaceResourceNotFoundError || error instanceof WorkspaceResourceOwnershipError) {
      return fail(404, "Resource Revision was not found");
    }
    throw error;
  }
  if (facts === null) return fail(404, "Resource Revision was not found");
  const { resource, revision } = facts;
  if (revision.workspaceId !== resource.workspaceId || revision.resourceId !== resource.id) {
    return fail(404, "Resource Revision was not found");
  }

  let descriptor: ResourceRevisionPayloadDescriptor;
  try {
    descriptor = resolveResourceRevisionPayloadDescriptor({
      store: input.store,
      dataDir: input.dataDir,
      workspaceId: resource.workspaceId,
      resourceRevisionId: revision.id,
      expectedResourceId: resource.id,
    });
  } catch (error) {
    if (error instanceof ResourceRevisionPayloadError) {
      return fail(422, `Resource Revision payload is unavailable: ${error.message}`);
    }
    throw error;
  }
  if (descriptor.resourceKind !== resource.kind
    || descriptor.resourceRevisionId !== revision.id
    || descriptor.manifestPath !== revision.manifestPath
    || descriptor.manifestChecksum !== revision.checksum) {
    return fail(422, "Resource Revision payload identity is invalid");
  }

  const verificationRoot = await mkdtemp(join(input.dataDir, ".resource-view-"));
  const destination = join(verificationRoot, "payload.bin");
  try {
    try {
      await verifyResourceRevisionPayload(input.dataDir, descriptor, {
        destination,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (error instanceof ResourceRevisionPayloadError) {
        return fail(422, `Resource Revision payload failed integrity verification: ${error.message}`);
      }
      throw error;
    }
    input.signal?.throwIfAborted();
    const bytes = await readFile(destination);
    if (bytes.byteLength !== descriptor.byteLength) {
      return fail(422, "Resource Revision verified payload length changed");
    }
    return {
      resource,
      revision,
      observed: { headRevisionId: resource.headRevisionId, snapshotId: facts.snapshotId },
      descriptor,
      bytes,
    };
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
}

export async function readResourceRevisionView(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  resourceId: string;
  revisionId: string;
  signal?: AbortSignal;
}): Promise<ResourceRevisionView> {
  const exact = await readVerifiedExactResourceRevisionPayload(input);
  const previewKind = resourceRevisionPreviewKind(exact.descriptor.mimeType);
  const payloadRoute = exactRoute(input.projectId, exact.resource.id, exact.revision.id, "payload");
  const common = {
    protocol: "dezin.resource-revision-view.v1" as const,
    resource: exact.resource,
    revision: {
      id: exact.revision.id,
      workspaceId: exact.revision.workspaceId,
      resourceId: exact.revision.resourceId,
      sequence: exact.revision.sequence,
      parentRevisionId: exact.revision.parentRevisionId,
      summary: safeLabel(exact.revision.summary, "Immutable Resource Revision", 4_096),
      checksum: exact.revision.checksum,
      createdAt: exact.revision.createdAt,
    },
    observed: exact.observed,
    payload: {
      mimeType: exact.descriptor.mimeType,
      byteLength: exact.descriptor.byteLength,
      checksum: exact.descriptor.payloadChecksum,
      previewKind,
      url: previewKind === "image" || previewKind === "pdf" || previewKind === "video" || previewKind === "audio"
        ? payloadRoute
        : null,
      downloadUrl: `${payloadRoute}?download=1`,
    },
  };

  if (exact.resource.kind === "file") {
    const sourceId = exact.revision.provenance.sourceId;
    const fileName = safeLabel(
      typeof sourceId === "string" ? basename(sourceId) : exact.resource.title,
      "resource-file",
      255,
    );
    const preview = previewKind === "text"
      ? textPreview(exact.bytes)
      : { text: null, textTruncated: false };
    return {
      ...common,
      kind: "file",
      content: {
        fileName,
        previewKind,
        ...preview,
      },
    };
  }

  if (exact.resource.kind === "moodboard") {
    const embeddedRoute = (assetId: string) => exactRoute(
      input.projectId,
      exact.resource.id,
      exact.revision.id,
      `embedded-assets/${encodeURIComponent(assetId)}`,
    );
    return {
      ...common,
      kind: "moodboard",
      content: await decodeMoodboardContent(exact.bytes, embeddedRoute, input.signal),
    };
  }

  if (exact.resource.kind === "effect") {
    return {
      ...common,
      kind: "effect",
      content: decodeEffectContent(exact.bytes),
    };
  }

  if (exact.resource.kind === "asset") {
    let width = finite(exact.revision.metadata.width);
    let height = finite(exact.revision.metadata.height);
    if (exact.descriptor.mimeType === "image/png") {
      let inspected: { width: number; height: number };
      try {
        inspected = await inspectBoundedPngImage(exact.bytes, input.signal);
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? error;
        return fail(422, "Asset Revision image bytes are invalid");
      }
      if ((width !== null && width !== inspected.width) || (height !== null && height !== inspected.height)) {
        return fail(422, "Asset Revision dimensions do not match its immutable media");
      }
      width = inspected.width;
      height = inspected.height;
    }
    const sourceType = safeLabel(exact.revision.provenance.sourceType, "immutable", 128);
    const sourceId = safeLabel(exact.revision.provenance.sourceId, exact.resource.id, 1_024);
    const rawFileName = exact.revision.metadata.fileName;
    const preview = previewKind === "text"
      ? textPreview(exact.bytes)
      : { text: null, textTruncated: false };
    return {
      ...common,
      kind: "asset",
      content: {
        fileName: safeLabel(
          typeof rawFileName === "string" ? rawFileName : basename(sourceId),
          "resource-asset",
          255,
        ),
        mediaKind: previewKind,
        ...preview,
        width,
        height,
        sourceType,
        sourceId,
      },
    };
  }

  if (exact.resource.kind === "external-reference") {
    const status = exact.revision.provenance.status;
    if (!Number.isSafeInteger(status) || Number(status) < 100 || Number(status) > 599) {
      return fail(422, "External Reference frozen response status is invalid");
    }
    const preview = previewKind === "text"
      ? textPreview(exact.bytes)
      : { text: null, textTruncated: false };
    return {
      ...common,
      kind: "external-reference",
      content: {
        sourceUrl: frozenHttpUrl(exact.revision.provenance.sourceUrl, "External Reference source URL"),
        finalUrl: frozenHttpUrl(exact.revision.provenance.finalUrl, "External Reference final URL"),
        status: Number(status),
        previewKind,
        ...preview,
      },
    };
  }

  if (exact.resource.kind === "sharingan-capture") {
    const embeddedRoute = (assetId: string) => exactRoute(
      input.projectId,
      exact.resource.id,
      exact.revision.id,
      `embedded-assets/${encodeURIComponent(assetId)}`,
    );
    return {
      ...common,
      kind: "sharingan-capture",
      content: await decodeSharinganContent(
        exact.bytes,
        { workspaceId: exact.resource.workspaceId, resourceId: exact.resource.id },
        embeddedRoute,
        input.signal,
      ),
    };
  }

  if (exact.resource.kind === "research") {
    try {
      const research = await readResearchResourceRevision({
        store: input.store,
        dataDir: input.dataDir,
        projectId: input.projectId,
        resourceId: exact.resource.id,
        revisionId: exact.revision.id,
        signal: input.signal,
      });
      const {
        protocol: _protocol,
        resource: _resource,
        revision: _revision,
        observed: _observed,
        ...content
      } = research;
      return { ...common, kind: "research", content };
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (error instanceof ResearchResourceRevisionError) {
        return fail(422, `Research Revision projection failed: ${error.message}`);
      }
      throw error;
    }
  }

  return fail(422, `Resource Revision kind ${exact.resource.kind} has no safe Viewer projection`);
}

/** Resolve an opaque embedded capability after re-verifying its exact parent Revision bytes. */
export async function readResourceRevisionEmbeddedAsset(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  resourceId: string;
  revisionId: string;
  assetId: string;
  signal?: AbortSignal;
}): Promise<VerifiedResourceRevisionEmbeddedAsset> {
  const exact = await readVerifiedExactResourceRevisionPayload(input);
  if (exact.resource.kind === "moodboard") {
    await decodeMoodboardContent(exact.bytes, () => "/", input.signal);
    const bundle = record(decodedJson(exact.bytes, "Moodboard Revision payload"), "Moodboard Revision payload");
    if (!Array.isArray(bundle.assets)) return fail(422, "Moodboard Assets are unavailable");
    const matches = bundle.assets.filter((raw) => {
      const asset = record(raw, "Moodboard embedded Asset");
      return asset.id === input.assetId;
    });
    if (matches.length !== 1) return fail(404, "Resource Revision embedded Asset was not found");
    const asset = record(matches[0], "Moodboard embedded Asset");
    const metadata = record(asset.metadata, "Moodboard embedded Asset metadata");
    const mimeType = requiredText(metadata.mimeType, "Moodboard embedded Asset MIME", 127).toLowerCase();
    if (typeof asset.bytesBase64 !== "string" || typeof asset.checksum !== "string" || !SHA256.test(asset.checksum)) {
      return fail(422, "Moodboard embedded Asset metadata is invalid");
    }
    const bytes = Buffer.from(asset.bytesBase64, "base64");
    if (bytes.toString("base64") !== asset.bytesBase64 || sha256(bytes) !== asset.checksum) {
      return fail(422, "Moodboard embedded Asset checksum is invalid");
    }
    try {
      await verifyBoundedResourcePayloadBytes(bytes, mimeType, input.signal);
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (error instanceof ResourceRevisionPayloadError) {
        return fail(422, `Moodboard embedded Asset failed MIME verification: ${error.message}`);
      }
      throw error;
    }
    return {
      bytes,
      mimeType,
      checksum: asset.checksum,
      fileName: safeLabel(metadata.fileName, input.assetId, 255),
    };
  }

  if (exact.resource.kind === "sharingan-capture") {
    await decodeSharinganContent(
      exact.bytes,
      { workspaceId: exact.resource.workspaceId, resourceId: exact.resource.id },
      () => "/",
      input.signal,
    );
    let bundle: ReturnType<typeof decodeSharinganCaptureResourceBundle>;
    try {
      bundle = decodeSharinganCaptureResourceBundle(exact.bytes);
    } catch (error) {
      if (error instanceof SharinganCaptureResourceBundleError) {
        return fail(422, `Sharingan embedded Asset bundle is invalid: ${error.message}`);
      }
      throw error;
    }
    const matches = bundle.files.filter((file) => (
      file.path.toLowerCase().endsWith(".png")
      && resourceRevisionEmbeddedAssetId(file.path) === input.assetId
    ));
    if (matches.length !== 1) return fail(404, "Resource Revision embedded Asset was not found");
    const file = matches[0]!;
    try {
      await inspectBoundedPngImage(file.bytes, input.signal);
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      return fail(422, "Sharingan embedded screenshot is invalid");
    }
    return {
      bytes: Buffer.from(file.bytes),
      mimeType: "image/png",
      checksum: file.checksum,
      fileName: `${input.assetId}.png`,
    };
  }

  return fail(404, "Resource Revision embedded Asset was not found");
}
