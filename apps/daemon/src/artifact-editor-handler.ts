import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { parse as parseJavaScript, type ParserPlugin } from "@babel/parser";
import { parse as parseHtml, type ParserError } from "parse5";
import type { AppDeps, DevServerLease } from "./app.ts";
import {
  applyArtifactMutation,
  ArtifactMutationCandidateError,
  ArtifactMutationConflictError,
  ArtifactMutationValidationError,
  MAX_DIRECT_MUTATION_SOURCE_BYTES,
  parseArtifactMutationRequest,
  type ArtifactMutationCandidateContext,
} from "./artifact-mutation.ts";
import {
  ArtifactThumbnailNotFoundError,
  ArtifactThumbnailValidationError,
  getOrCreateArtifactThumbnail,
  type ArtifactThumbnailRenderer,
  type ArtifactThumbnailRenderTarget,
} from "./artifact-thumbnail.ts";
import {
  captureArtifactThumbnail,
  type ArtifactThumbnailCapture,
} from "./capture-cover.ts";
import { HttpError, readJsonBody, sendJson } from "./http-util.ts";
import type { PreviewLease } from "./preview-lease.ts";
import {
  acquirePreviewTargetLease,
  PreviewTargetConflictError,
  PreviewTargetNotFoundError,
  PreviewTargetValidationError,
  resolvePreviewTarget,
  type ResolvedPreviewTarget,
} from "./preview-target.ts";
import { stablePreviewHash } from "./render-assembly.ts";
import {
  ResourceRevisionPayloadError,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
} from "./resource-revision-payload.ts";
import { projectDir } from "./serve-static.ts";

const MAX_CAPTURED_THUMBNAIL_BYTES = 20 * 1024 * 1024;
const THUMBNAIL_CACHE_CONTROL = "public, max-age=31536000, immutable";
const HTML_VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const HTML_RAW_TEXT_ELEMENTS = new Set([
  "iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp",
]);
const HTML_P_END_FOLLOWERS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu",
  "nav", "ol", "p", "pre", "search", "section", "table", "ul",
]);
const HTML_P_END_FORBIDDEN_PARENTS = new Set([
  "a", "audio", "del", "ins", "map", "noscript", "video",
]);

export class ArtifactThumbnailRendererUnavailableError extends Error {
  constructor(message = "Artifact thumbnail renderer is unavailable") {
    super(message);
    this.name = "ArtifactThumbnailRendererUnavailableError";
  }
}

function boundedQueryValue(value: string, label: string): string {
  if (value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new ArtifactThumbnailValidationError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function parseThumbnailQuery(req: IncomingMessage): {
  requiredFrameId?: string;
  requiredStateKey?: string;
} {
  let url: URL;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    throw new ArtifactThumbnailValidationError("Artifact thumbnail URL is invalid");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "frame" && key !== "state") {
      throw new ArtifactThumbnailValidationError(`Artifact thumbnail query has unexpected field ${key}`);
    }
  }
  const frame = url.searchParams.getAll("frame");
  const state = url.searchParams.getAll("state");
  if (frame.length > 1 || state.length > 1) {
    throw new ArtifactThumbnailValidationError("Artifact thumbnail query fields may occur at most once");
  }
  return {
    ...(frame.length === 0 ? {} : { requiredFrameId: boundedQueryValue(frame[0]!, "thumbnail frame") }),
    ...(state.length === 0 ? {} : { requiredStateKey: boundedQueryValue(state[0]!, "thumbnail state") }),
  };
}

function ownsArtifact(deps: AppDeps, projectId: string, artifactId: string): boolean {
  if (!deps.store.getProject(projectId)) return false;
  const workspace = deps.store.workspace.getWorkspace(projectId);
  const artifact = deps.store.workspace.getArtifact(artifactId);
  return Boolean(
    workspace
    && artifact
    && artifact.workspaceId === workspace.id
    && artifact.archivedAt === null,
  );
}

interface ParsedHtmlNode {
  nodeName?: string;
  tagName?: string;
  sourceCodeLocation?: {
    startOffset?: number;
    endOffset?: number;
    startTag?: { startOffset: number; endOffset: number };
    endTag?: { startOffset: number; endOffset: number };
  } | null;
  childNodes?: ParsedHtmlNode[];
  content?: ParsedHtmlNode;
}

function htmlEndTagMayBeOmitted(
  node: ParsedHtmlNode,
  parent: ParsedHtmlNode | null,
  next: ParsedHtmlNode | undefined,
): boolean {
  const tag = node.tagName;
  const nextTag = next?.tagName;
  switch (tag) {
    case "html":
    case "body":
      return next?.nodeName !== "#comment";
    case "head":
      return next === undefined || (next.nodeName !== "#comment" && next.nodeName !== "#text");
    case "li":
      return nextTag === "li" || next === undefined;
    case "dt":
      return nextTag === "dt" || nextTag === "dd";
    case "dd":
      return nextTag === "dt" || nextTag === "dd" || next === undefined;
    case "p":
      return (nextTag !== undefined && HTML_P_END_FOLLOWERS.has(nextTag))
        || (next === undefined && !HTML_P_END_FORBIDDEN_PARENTS.has(parent?.tagName ?? ""));
    case "rt":
    case "rp":
      return nextTag === "rt" || nextTag === "rp" || next === undefined;
    case "optgroup":
      return nextTag === "optgroup" || nextTag === "hr" || next === undefined;
    case "option":
      return nextTag === "option" || nextTag === "optgroup" || nextTag === "hr" || next === undefined;
    case "colgroup":
      return next?.nodeName !== "#comment" && next?.nodeName !== "#text";
    case "caption":
      return next?.nodeName !== "#comment" && next?.nodeName !== "#text";
    case "thead":
      return nextTag === "tbody" || nextTag === "tfoot";
    case "tbody":
      return nextTag === "tbody" || nextTag === "tfoot" || next === undefined;
    case "tfoot":
      return next === undefined;
    case "tr":
      return nextTag === "tr" || next === undefined;
    case "td":
    case "th":
      return nextTag === "td" || nextTag === "th" || next === undefined;
    default:
      return false;
  }
}

function validateMarkupSyntax(source: string): void {
  const errors: ParserError[] = [];
  const document = parseHtml(source, {
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code !== "missing-doctype") errors.push(error);
    },
  }) as unknown as ParsedHtmlNode;
  if (errors[0]) {
    throw new ArtifactMutationValidationError(`candidate HTML syntax validation failed: ${errors[0].code}`);
  }
  const explicitEndTags = new Set<number>();
  const ignoredClosingTagRanges: Array<{ start: number; end: number }> = [];
  const pendingNodes: Array<{
    node: ParsedHtmlNode;
    parent: ParsedHtmlNode | null;
    next: ParsedHtmlNode | undefined;
  }> = [{ node: document, parent: null, next: undefined }];
  while (pendingNodes.length > 0) {
    const { node, parent, next } = pendingNodes.pop()!;
    const location = node.sourceCodeLocation;
    if (location?.endTag) explicitEndTags.add(location.endTag.startOffset);
    if (location?.startTag) {
      ignoredClosingTagRanges.push({ start: location.startTag.startOffset + 1, end: location.startTag.endOffset });
      if (node.tagName && HTML_RAW_TEXT_ELEMENTS.has(node.tagName) && location.endTag) {
        ignoredClosingTagRanges.push({ start: location.startTag.endOffset, end: location.endTag.startOffset });
      }
    } else if (
      node.nodeName === "#comment"
      && location
      && location.startOffset !== undefined
      && location.endOffset !== undefined
    ) {
      ignoredClosingTagRanges.push({ start: location.startOffset, end: location.endOffset });
    } else if (
      node.nodeName === "#text"
      && location
      && location.startOffset !== undefined
      && location.endOffset !== undefined
      && source.startsWith("<![CDATA[", location.startOffset)
      && source.slice(location.endOffset - 3, location.endOffset) === "]]>"
    ) {
      ignoredClosingTagRanges.push({ start: location.startOffset, end: location.endOffset });
    }
    if (node.tagName && location?.startTag && !location.endTag && !HTML_VOID_ELEMENTS.has(node.tagName)) {
      const startTag = source.slice(location.startTag.startOffset, location.startTag.endOffset);
      if (!/\/\s*>$/.test(startTag) && !htmlEndTagMayBeOmitted(node, parent, next)) {
        throw new ArtifactMutationValidationError(
          `candidate HTML structure has an invalid omitted closing tag for <${node.tagName}>`,
        );
      }
    }
    const children = node.childNodes ?? [];
    if (node.content) {
      pendingNodes.push({ node: node.content, parent: node, next: undefined });
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pendingNodes.push({ node: children[index]!, parent: node, next: children[index + 1] });
    }
  }
  ignoredClosingTagRanges.sort((left, right) => left.start - right.start);
  const isIgnored = (offset: number): boolean => {
    let low = 0;
    let high = ignoredClosingTagRanges.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (ignoredClosingTagRanges[middle]!.start <= offset) low = middle + 1;
      else high = middle - 1;
    }
    const range = ignoredClosingTagRanges[high];
    return Boolean(range && offset < range.end);
  };
  const closingTag = /<\/\s*[A-Za-z][A-Za-z0-9:_-]*(?:\s[^>]*)?>/g;
  for (let match = closingTag.exec(source); match; match = closingTag.exec(source)) {
    if (!isIgnored(match.index) && !explicitEndTags.has(match.index)) {
      throw new ArtifactMutationValidationError("candidate HTML structure has an unmatched closing end tag");
    }
  }
}

function validateJavaScriptSyntax(candidate: ArtifactMutationCandidateContext, extension: string): void {
  const plugins: ParserPlugin[] = [];
  if (extension === ".ts" || extension === ".tsx") plugins.push("typescript");
  if (extension === ".js" || extension === ".jsx" || extension === ".tsx") plugins.push("jsx");
  try {
    parseJavaScript(candidate.source, {
      sourceFilename: candidate.sourcePath,
      sourceType: "module",
      plugins,
    });
  } catch (error) {
    throw new ArtifactMutationValidationError(
      `candidate source syntax validation failed: ${error instanceof Error ? error.message : "parse error"}`,
    );
  }
}

export async function validateArtifactMutationCandidate(candidate: ArtifactMutationCandidateContext): Promise<void> {
  const bytes = Buffer.byteLength(candidate.source, "utf8");
  if (bytes === 0 || bytes > MAX_DIRECT_MUTATION_SOURCE_BYTES || candidate.source.includes("\0")) {
    throw new ArtifactMutationValidationError("candidate source must be bounded non-empty text without NUL bytes");
  }
  const extension = extname(candidate.sourcePath).toLowerCase();
  if ([".js", ".jsx", ".ts", ".tsx"].includes(extension)) {
    validateJavaScriptSyntax(candidate, extension);
    return;
  }
  if ([".html", ".htm"].includes(extension)) {
    validateMarkupSyntax(candidate.source);
    return;
  }
  if (extension === ".vue" || extension === ".svelte") {
    throw new ArtifactMutationValidationError(
      `candidate source extension ${extension} is unsupported without its official compiler`,
    );
  }
  if (extension === ".json") {
    try {
      JSON.parse(candidate.source);
    } catch {
      throw new ArtifactMutationValidationError("candidate JSON source syntax is invalid");
    }
    return;
  }
  throw new ArtifactMutationValidationError(`candidate source extension ${extension || "(none)"} is unsupported`);
}

async function validateCandidate(
  deps: AppDeps,
  candidate: ArtifactMutationCandidateContext,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await validateArtifactMutationCandidate(candidate);
  if (deps.artifactMutationValidator) {
    try {
      await deps.artifactMutationValidator(candidate);
    } catch (error) {
      if (error instanceof ArtifactMutationValidationError) throw error;
      throw new ArtifactMutationValidationError(
        error instanceof Error ? error.message : "project-specific candidate validation failed",
      );
    }
  }
  signal?.throwIfAborted();
}

function sendMutationError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof ArtifactMutationCandidateError) {
    sendJson(res, 409, {
      error: error.message,
      code: "artifact_mutation_candidate_retained",
      candidateRevisionId: error.candidateRevisionId,
      candidateRef: error.candidateRef,
    });
    return true;
  }
  if (error instanceof ArtifactMutationConflictError) {
    sendJson(res, 409, { error: error.message, code: "artifact_mutation_conflict" });
    return true;
  }
  if (error instanceof ArtifactMutationValidationError) {
    sendJson(res, 422, { error: error.message, code: "artifact_mutation_invalid" });
    return true;
  }
  return false;
}

export async function handleArtifactMutation(
  req: IncomingMessage,
  res: ServerResponse,
  { id, artifactId }: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (!ownsArtifact(deps, id!, artifactId!)) {
      sendJson(res, 404, { error: "Artifact was not found", code: "artifact_mutation_not_found" });
      return;
    }
    const request = parseArtifactMutationRequest(await readJsonBody(req, undefined, signal));
    signal?.throwIfAborted();
    const resolveAssetSource = deps.artifactMutationAssetResolver ?? (async (input: {
      workspaceId: string;
      resourceRevisionId: string;
      signal?: AbortSignal;
    }) => {
      try {
        input.signal?.throwIfAborted();
        const payload = resolveResourceRevisionPayloadDescriptor({
          store: deps.store,
          dataDir: deps.dataDir,
          workspaceId: input.workspaceId,
          resourceRevisionId: input.resourceRevisionId,
        });
        await verifyResourceRevisionPayload(deps.dataDir, payload, { signal: input.signal });
        return payload;
      } catch (error) {
        if (error instanceof ResourceRevisionPayloadError) {
          throw new ArtifactMutationValidationError(error.message);
        }
        throw error;
      }
    });
    const result = await applyArtifactMutation({
      store: deps.store,
      projectRoot: projectDir(deps.dataDir, id!),
      projectId: id!,
      artifactId: artifactId!,
      expectedHeadRevisionId: request.expectedHeadRevisionId,
      expectedSnapshotId: request.expectedSnapshotId,
      command: request.command,
      signal,
      validateCandidateSource: (candidate) => validateCandidate(deps, candidate, signal),
      resolveAssetSource,
    });
    signal?.throwIfAborted();
    sendJson(res, 201, result);
  } catch (error) {
    if (error instanceof HttpError || !sendMutationError(res, error)) throw error;
  }
}

function requirePreviewLease(lease: DevServerLease): PreviewLease {
  if (
    typeof lease.leaseId !== "string"
    || lease.leaseId.length === 0
    || typeof lease.url !== "string"
    || !/^https?:\/\//i.test(lease.url)
    || typeof lease.expiresAt !== "number"
    || !Number.isFinite(lease.expiresAt)
    || typeof lease.release !== "function"
  ) {
    throw new ArtifactThumbnailRendererUnavailableError("Artifact preview did not return a renewable lease");
  }
  return lease as PreviewLease;
}

function targetDescriptorChecksum(target: ArtifactThumbnailRenderTarget): string {
  const { targetChecksum: _targetChecksum, ...descriptor } = target;
  return stablePreviewHash("dezin-artifact-thumbnail-target-v1", descriptor);
}

function requireExactResolvedTarget(
  target: ArtifactThumbnailRenderTarget,
  resolved: ResolvedPreviewTarget,
): void {
  const exact = resolved.projectId === target.projectId
    && resolved.workspaceId === target.workspaceId
    && resolved.artifactId === target.artifactId
    && resolved.revisionId === target.revisionId
    && resolved.trackId === target.trackId
    && resolved.sourceCommitHash === target.sourceCommitHash
    && resolved.sourceTreeHash === target.sourceTreeHash
    && resolved.artifactRoot === target.artifactRoot
    && stablePreviewHash("dezin-render-spec-v1", resolved.renderSpec) === target.renderSpecChecksum
    && targetDescriptorChecksum(target) === target.targetChecksum;
  if (!exact) {
    throw new ArtifactThumbnailValidationError("Artifact thumbnail target identity changed before rendering");
  }
}

function requireExactPngDimensions(bytes: Buffer, width: number, height: number): void {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length < 24
    || !bytes.subarray(0, 8).equals(png)
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    || bytes.readUInt32BE(16) !== width
    || bytes.readUInt32BE(20) !== height
  ) {
    throw new ArtifactThumbnailValidationError("captured PNG dimensions do not match the required RenderSpec frame");
  }
}

export function createArtifactThumbnailRenderer(
  deps: AppDeps,
  capture: ArtifactThumbnailCapture = deps.artifactThumbnailCapture ?? captureArtifactThumbnail,
): ArtifactThumbnailRenderer {
  return async (target, { signal }) => {
    signal?.throwIfAborted();
    if (target.stateKey !== null && target.frame.initialState !== target.stateKey) {
      throw new ArtifactThumbnailValidationError(
        `required thumbnail state ${target.stateKey} does not match the immutable RenderSpec frame state`,
      );
    }
    const resolved = await resolvePreviewTarget(deps, {
      kind: "artifact-revision",
      projectId: target.projectId,
      revisionId: target.revisionId,
    });
    requireExactResolvedTarget(target, resolved);
    const injectedEnsure = deps.ensureDevServer
      ? async (...args: Parameters<NonNullable<AppDeps["ensureDevServer"]>>): Promise<PreviewLease> =>
        requirePreviewLease(await deps.ensureDevServer!(...args))
      : undefined;
    const lease = await acquirePreviewTargetLease({
      store: deps.store,
      dataDir: deps.dataDir,
      ...(deps.previewLeaseManager ? { previewLeaseManager: deps.previewLeaseManager } : {}),
      ...(injectedEnsure ? { ensureDevServer: injectedEnsure } : {}),
    }, resolved, signal);
    let primaryError: unknown;
    let temporaryRoot: string | null = null;
    try {
      requireExactResolvedTarget(target, lease.resolved);
      temporaryRoot = await mkdtemp(join(tmpdir(), "dezin-artifact-thumbnail-render-"));
      const outPath = join(temporaryRoot, "thumbnail.png");
      const frame = {
        width: target.frame.width,
        height: target.frame.height,
        frameId: target.frame.id,
        frameAttemptId: `thumbnail-${target.revisionId.slice(0, 118)}`,
        ...(target.stateKey === null && target.frame.initialState === undefined
          ? {}
          : { initialState: target.stateKey ?? target.frame.initialState }),
        ...(target.frame.fixture === undefined
          ? {}
          : { fixture: structuredClone(target.frame.fixture) }),
        ...(target.frame.background === undefined ? {} : { background: target.frame.background }),
      };
      const captured = await capture(lease.url, outPath, frame, signal);
      signal?.throwIfAborted();
      if (!captured) throw new ArtifactThumbnailRendererUnavailableError();
      const metadata = await stat(outPath);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CAPTURED_THUMBNAIL_BYTES) {
        throw new ArtifactThumbnailValidationError("captured PNG has an invalid byte length");
      }
      const bytes = await readFile(outPath);
      signal?.throwIfAborted();
      requireExactPngDimensions(bytes, frame.width, frame.height);
      return { bytes, contentType: "image/png", targetChecksum: target.targetChecksum };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
      try {
        await lease.release();
      } catch (releaseError) {
        if (primaryError === undefined) {
          throw new ArtifactThumbnailRendererUnavailableError(
            releaseError instanceof Error ? releaseError.message : "Artifact preview lease release failed",
          );
        }
      }
    }
  };
}

function matchesIfNoneMatch(req: IncomingMessage, etag: string): boolean {
  const header = req.headers["if-none-match"];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  const normalize = (candidate: string): string => candidate.trim().replace(/^W\//i, "");
  return value.split(",").some((candidate) => candidate.trim() === "*" || normalize(candidate) === etag);
}

function sendImmutablePng(
  req: IncomingMessage,
  res: ServerResponse,
  result: Awaited<ReturnType<typeof getOrCreateArtifactThumbnail>>,
): void {
  res.setHeader("ETag", result.etag);
  res.setHeader("Cache-Control", THUMBNAIL_CACHE_CONTROL);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (matchesIfNoneMatch(req, result.etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Content-Length", String(result.bytes.length));
  res.end(result.bytes);
}

function sendThumbnailError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof ArtifactThumbnailNotFoundError
    || error instanceof PreviewTargetNotFoundError) {
    sendJson(res, 404, { error: "Artifact Revision thumbnail was not found", code: "artifact_thumbnail_not_found" });
    return true;
  }
  if (error instanceof ArtifactThumbnailValidationError
    || error instanceof PreviewTargetValidationError
    || error instanceof PreviewTargetConflictError) {
    sendJson(res, 422, {
      error: error instanceof Error ? error.message : "Artifact thumbnail target is invalid",
      code: "artifact_thumbnail_invalid",
    });
    return true;
  }
  if (error instanceof ArtifactThumbnailRendererUnavailableError) {
    sendJson(res, 503, { error: error.message, code: "artifact_thumbnail_renderer_unavailable" });
    return true;
  }
  return false;
}

export async function handleArtifactThumbnail(
  req: IncomingMessage,
  res: ServerResponse,
  { id, artifactId, revisionId }: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (!ownsArtifact(deps, id!, artifactId!)) {
      sendJson(res, 404, { error: "Artifact Revision thumbnail was not found", code: "artifact_thumbnail_not_found" });
      return;
    }
    const query = parseThumbnailQuery(req);
    if (deps.artifactThumbnailRenderer === null) {
      throw new ArtifactThumbnailRendererUnavailableError();
    }
    const renderer = deps.artifactThumbnailRenderer ?? createArtifactThumbnailRenderer(deps);
    const result = await getOrCreateArtifactThumbnail({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId: id!,
      artifactId: artifactId!,
      revisionId: revisionId!,
      ...query,
      ...(signal ? { signal } : {}),
    }, renderer);
    signal?.throwIfAborted();
    sendImmutablePng(req, res, result);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!sendThumbnailError(res, error)) {
      sendJson(res, 503, {
        error: "Artifact thumbnail renderer is unavailable",
        code: "artifact_thumbnail_renderer_unavailable",
      });
    }
  }
}
