import { createHash } from "node:crypto";

import {
  transform as transformCss,
  transformStyleAttribute,
  type Image,
  type Url,
} from "lightningcss";
import {
  parse as parseHtml,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";
import { isPassiveDesignAssetMimeType } from "./design-data-url-policy.ts";
import { designHtmlUrlContext } from "./design-html-url-context.ts";
import {
  collectDesignJavaScriptUrlSinks,
  designHtmlJavaScriptSourceType,
} from "./design-static-validation.ts";

/** A single-file preview is intentionally bounded: base64 expands immutable
 * assets by roughly one third and the result is assembled in memory once. */
export const MAX_PORTABLE_DESIGN_HTML_BYTES = 384 * 1024 * 1024;

const PORTABLE_ASSET_PLACEHOLDER_PREFIX = "__DEZIN_PORTABLE_ASSET_";

export interface PortableDesignAssetDescriptor {
  readonly assetId: string;
  readonly checksum: string;
  readonly mimeType: string;
  readonly canonicalUrl: string;
  readonly byteLength: number;
}

export interface PortableDesignAsset extends Omit<PortableDesignAssetDescriptor, "byteLength"> {
  readonly bytes: Uint8Array;
}

interface PlannedPortableDesignAsset extends PortableDesignAssetDescriptor {
  readonly placeholder: string;
  readonly references: number;
}

export interface PortableDesignHtmlPlan {
  readonly template: string;
  readonly assets: readonly PlannedPortableDesignAsset[];
  readonly projectedBytes: number;
}

export class PortableDesignHtmlError extends Error {
  readonly code: "corrupt" | "limit";

  constructor(code: "corrupt" | "limit", message: string) {
    super(message);
    this.name = "PortableDesignHtmlError";
    this.code = code;
  }
}

function assertMediaType(assetId: string, mimeType: string): void {
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9!#$&^_.+\-=]+)*$/i.test(mimeType)) {
    throw new PortableDesignHtmlError("corrupt", `Design Asset ${assetId} has an invalid media type`);
  }
  if (!isPassiveDesignAssetMimeType(mimeType)) {
    throw new PortableDesignHtmlError(
      "corrupt",
      `Design Asset ${assetId} has an active or unsafe portable media type`,
    );
  }
}

function verifiedAssetDataUrl(asset: PortableDesignAssetDescriptor, payload: Uint8Array): string {
  const bytes = Buffer.from(payload);
  if (bytes.length !== asset.byteLength
    || bytes.length === 0
    || createHash("sha256").update(bytes).digest("hex") !== asset.checksum) {
    throw new PortableDesignHtmlError("corrupt", `Design Asset ${asset.assetId} failed portable export integrity verification`);
  }
  assertMediaType(asset.assetId, asset.mimeType);
  return `data:${asset.mimeType};base64,${bytes.toString("base64")}`;
}

function decodeVerifiedUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML source is not valid UTF-8");
  }
}

function htmlElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node && typeof node.tagName === "string" && Array.isArray(node.attrs);
}

function htmlChildren(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.ChildNode[] {
  const children = "childNodes" in node && Array.isArray(node.childNodes) ? [...node.childNodes] : [];
  if (htmlElement(node) && node.tagName === "template" && "content" in node
    && node.content !== null && typeof node.content === "object" && Array.isArray(node.content.childNodes)) {
    children.push(...node.content.childNodes);
  }
  return children;
}

function htmlAttributeName(source: string, fallback: string): string {
  return /^\s*([^\s=/>]+)/.exec(source)?.[1] ?? fallback;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function dezinOwnedUrl(value: string): boolean {
  const raw = value.trim();
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Invalid percent escapes cannot become an authorized exact pin.
  }
  return /^dezin-asset:\/\//i.test(decoded)
    || /^\/api\/projects\/[^/?#]+\/design-canvas\/assets\//i.test(decoded);
}

function cssUrlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\t\n\f\r ,]/.test(value[position]!)) position += 1;
    if (position >= value.length) break;
    const urlStart = position;
    while (position < value.length && !/[\t\n\f\r ]/.test(value[position]!)) position += 1;
    let url = value.slice(urlStart, position);
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      if (url) candidates.push({ url, descriptor: "" });
      continue;
    }
    while (position < value.length && /[\t\n\f\r ]/.test(value[position]!)) position += 1;
    const descriptorStart = position;
    let parentheses = 0;
    while (position < value.length) {
      const character = value[position]!;
      if (character === "(") parentheses += 1;
      else if (character === ")" && parentheses > 0) parentheses -= 1;
      else if (character === "," && parentheses === 0) break;
      position += 1;
    }
    const descriptor = value.slice(descriptorStart, position).trim();
    if (position < value.length && value[position] === ",") position += 1;
    if (url) candidates.push({ url, descriptor });
  }
  return candidates;
}

function applyEdits(
  source: string,
  edits: readonly { start: number; end: number; replacement: string }[],
): string {
  if (edits.length === 0) return source;
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > source.length) {
      throw new PortableDesignHtmlError("corrupt", "Portable Design HTML has overlapping source locations");
    }
    chunks.push(source.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

interface CssSemanticUrl {
  readonly line: number;
  readonly column: number;
  readonly value: string;
}

function cssSourceOffset(css: string, line: number, column: number): number {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an invalid CSS source location");
  }
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < css.length) {
    const character = css[offset++]!;
    if (character === "\r") {
      if (css[offset] === "\n") offset += 1;
      currentLine += 1;
    } else if (character === "\n" || character === "\f") {
      currentLine += 1;
    }
  }
  const result = offset + column - 1;
  if (currentLine !== line || result < offset || result >= css.length) {
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an invalid CSS source location");
  }
  return result;
}

function cssStringContentRange(css: string, quoteOffset: number): { start: number; end: number } {
  const quote = css[quoteOffset];
  if (quote !== '"' && quote !== "'") {
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an invalid CSS URL location");
  }
  let cursor = quoteOffset + 1;
  while (cursor < css.length) {
    const character = css[cursor]!;
    if (character === "\\") {
      const escaped = css[cursor + 1];
      cursor += 2;
      if (escaped === "\r" && css[cursor] === "\n") cursor += 1;
      continue;
    }
    if (character === quote) return { start: quoteOffset + 1, end: cursor };
    cursor += 1;
  }
  throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an unterminated CSS URL");
}

function cssUrlContentRange(css: string, urlOffset: number): { start: number; end: number } {
  if (css.slice(urlOffset, urlOffset + 3).toLowerCase() !== "url") {
    return cssStringContentRange(css, urlOffset);
  }
  let cursor = urlOffset + 3;
  while (/\s/.test(css[cursor] ?? "")) cursor += 1;
  if (css[cursor] !== "(") {
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an invalid CSS URL location");
  }
  cursor += 1;
  while (/\s/.test(css[cursor] ?? "")) cursor += 1;
  if (css[cursor] === '"' || css[cursor] === "'") {
    const range = cssStringContentRange(css, cursor);
    let close = range.end + 1;
    while (/\s/.test(css[close] ?? "")) close += 1;
    if (css[close] !== ")") {
      throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an invalid CSS URL location");
    }
    return range;
  }
  const start = cursor;
  while (cursor < css.length) {
    const character = css[cursor]!;
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "/" && css[cursor + 1] === "*") {
      const commentEnd = css.indexOf("*/", cursor + 2);
      if (commentEnd === -1) {
        throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an invalid CSS URL location");
      }
      cursor = commentEnd + 2;
      continue;
    }
    if (character === ")") {
      let end = cursor;
      while (end > start && /\s/.test(css[end - 1]!)) end -= 1;
      return { start, end };
    }
    cursor += 1;
  }
  throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an unterminated CSS URL");
}

function decodeCssEscapes(value: string): string {
  let decoded = "";
  let cursor = 0;
  while (cursor < value.length) {
    const character = value[cursor]!;
    if (character !== "\\") {
      decoded += character;
      cursor += 1;
      continue;
    }
    cursor += 1;
    if (cursor >= value.length) break;
    const escaped = value[cursor]!;
    if (escaped === "\r" || escaped === "\n" || escaped === "\f") {
      cursor += escaped === "\r" && value[cursor + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (/[0-9a-f]/i.test(escaped)) {
      const start = cursor;
      while (cursor < value.length && cursor - start < 6 && /[0-9a-f]/i.test(value[cursor]!)) cursor += 1;
      const codePoint = Number.parseInt(value.slice(start, cursor), 16);
      decoded += codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(codePoint);
      if (/[\t\n\f\r ]/.test(value[cursor] ?? "")) {
        if (value[cursor] === "\r" && value[cursor + 1] === "\n") cursor += 2;
        else cursor += 1;
      }
      continue;
    }
    decoded += escaped;
    cursor += 1;
  }
  return decoded;
}

function rewriteCssUrls(
  css: string,
  mode: "stylesheet" | "attribute",
  rewriteUrl: (url: string) => string,
): string {
  try {
    const urlsByLocation = new Map<string, CssSemanticUrl>();
    const collectUrl = (url: Url): void => {
      const semantic = {
        line: url.loc.line,
        column: url.loc.column,
        value: cssUrlValue(String(url.url)),
      };
      const key = `${semantic.line}:${semantic.column}`;
      const existing = urlsByLocation.get(key);
      if (existing && existing.value !== semantic.value) {
        throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains ambiguous CSS URL locations");
      }
      urlsByLocation.set(key, semantic);
    };
    const collectImage = (image: Image): void => {
      if (image.type === "url") {
        collectUrl(image.value);
        return;
      }
      if (image.type !== "image-set") return;
      for (const option of image.value.options) collectImage(option.image);
    };
    const visitor = {
      Image(image: Image) {
        collectImage(image);
      },
      Url(url: Url) {
        collectUrl(url);
      },
    };
    const result = mode === "attribute"
      ? transformStyleAttribute({
        filename: "portable-design-style.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
        visitor,
      })
      : transformCss({
        filename: "portable-design.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
        visitor,
      });
    if (result.dependencies?.some((dependency) => dependency.type === "import")) {
      throw new PortableDesignHtmlError("corrupt", "Portable Design HTML cannot import another stylesheet");
    }
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    for (const semantic of urlsByLocation.values()) {
      const rewritten = rewriteUrl(semantic.value);
      if (rewritten === semantic.value) continue;
      const offset = cssSourceOffset(css, semantic.line, semantic.column);
      const range = cssUrlContentRange(css, offset);
      if (decodeCssEscapes(css.slice(range.start, range.end)).trim() !== semantic.value) {
        throw new PortableDesignHtmlError("corrupt", "Portable Design HTML CSS URL did not match its source location");
      }
      edits.push({ ...range, replacement: rewritten });
    }
    return applyEdits(css, edits);
  } catch (error) {
    if (error instanceof PortableDesignHtmlError) throw error;
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains invalid CSS");
  }
}

/**
 * One source-location-preserving semantic rewrite for every browser URL
 * context understood by Design HTML validation. Callers supply policy; this
 * function supplies parse5 entity decoding, Lightning CSS escape decoding,
 * and exact source edits. Script raw text is opt-in because JavaScript URL
 * provenance is validated separately by design-static-validation.
 */
export function rewriteDesignHtmlUrlReferences(input: {
  readonly html: string;
  readonly rewriteUrl: (url: string) => string;
  readonly rewriteScriptText?: (
    script: string,
    sourceType: "script" | "module" | null,
  ) => string;
}): string {
  const parseErrors: ParserError[] = [];
  const document = parseHtml(input.html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.some((error) => error.code !== "missing-doctype")) {
    throw new PortableDesignHtmlError("corrupt", "Design HTML source is not valid HTML");
  }
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (!htmlElement(node)) {
      for (const child of htmlChildren(node)) visit(child);
      return;
    }
    const tagName = node.tagName.toLowerCase();
    const locations = node.sourceCodeLocation?.attrs;
    for (const attribute of node.attrs) {
      const context = designHtmlUrlContext(node, attribute);
      if (context === null) continue;
      if (context.kind === "unsupported") {
        throw new PortableDesignHtmlError(
          "corrupt",
          `Design HTML contains an unsupported URL-bearing attribute ${context.sourceAttributeName}`,
        );
      }
      const location = locations?.[context.sourceAttributeName];
      if (!location) {
        throw new PortableDesignHtmlError("corrupt", "Design HTML is missing a URL attribute source location");
      }
      let value: string | null = null;
      if (context.kind === "single") {
        value = input.rewriteUrl(attribute.value);
      } else if (context.kind === "responsive") {
        const candidates = parseSrcset(attribute.value);
        if (candidates.length === 0) {
          throw new PortableDesignHtmlError("corrupt", "Design HTML contains an invalid responsive-image URL");
        }
        value = candidates.map((candidate) => {
          const url = input.rewriteUrl(candidate.url);
          return candidate.descriptor ? `${url} ${candidate.descriptor}` : url;
        }).join(", ");
      } else if (context.kind === "space-separated") {
        const targets = attribute.value.trim().split(/\s+/).filter(Boolean);
        value = targets.map(input.rewriteUrl).join(" ");
      } else if (context.kind === "style") {
        value = rewriteCssUrls(attribute.value, "attribute", input.rewriteUrl);
      } else if (context.kind === "style-value") {
        const prefix = `${context.cssPropertyName}:`;
        value = rewriteCssUrls(`${prefix}${attribute.value}`, "attribute", input.rewriteUrl).slice(prefix.length);
      }
      if (value !== null && value !== attribute.value) {
        const rawAttribute = input.html.slice(location.startOffset, location.endOffset);
        const sourceName = htmlAttributeName(rawAttribute, context.sourceAttributeName);
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          replacement: `${sourceName}="${escapeHtmlAttribute(value)}"`,
        });
      }
    }
    if (tagName === "style" && node.sourceCodeLocation?.startTag && node.sourceCodeLocation.endTag) {
      const start = node.sourceCodeLocation.startTag.endOffset;
      const end = node.sourceCodeLocation.endTag.startOffset;
      const css = input.html.slice(start, end);
      const rewritten = rewriteCssUrls(css, "stylesheet", input.rewriteUrl);
      if (rewritten !== css) edits.push({ start, end, replacement: rewritten });
    }
    if (tagName === "script") {
      if (input.rewriteScriptText !== undefined) {
        const startTag = node.sourceCodeLocation?.startTag;
        const endTag = node.sourceCodeLocation?.endTag;
        if (!startTag || !endTag) {
          throw new PortableDesignHtmlError("corrupt", "Design HTML is missing a script source location");
        }
        const start = startTag.endOffset;
        const end = endTag.startOffset;
        const script = input.html.slice(start, end);
        const rawType = node.attrs.find((attribute) => attribute.name.toLowerCase() === "type")?.value ?? "";
        const rewritten = input.rewriteScriptText(
          script,
          designHtmlJavaScriptSourceType(rawType),
        );
        if (rewritten !== script) edits.push({ start, end, replacement: rewritten });
      }
      return;
    }
    for (const child of htmlChildren(node)) visit(child);
  };
  visit(document);
  return applyEdits(input.html, edits);
}

function projectedDataUrlBytes(asset: PortableDesignAssetDescriptor): number {
  return Buffer.byteLength(`data:${asset.mimeType};base64,`, "utf8")
    + 4 * Math.ceil(asset.byteLength / 3);
}

/**
 * Parses URL-bearing HTML/CSS contexts, authorizes exact immutable pins, and
 * builds a placeholder template. No Asset payload is read in this phase.
 */
export function buildPortableDesignHtmlPlan(input: {
  readonly html: Uint8Array;
  readonly assets: readonly PortableDesignAssetDescriptor[];
}): PortableDesignHtmlPlan {
  const html = decodeVerifiedUtf8(input.html);
  if (Buffer.byteLength(html, "utf8") > MAX_PORTABLE_DESIGN_HTML_BYTES) {
    throw new PortableDesignHtmlError("limit", "Portable Design HTML exceeds the single-file export limit");
  }
  if (html.includes(PORTABLE_ASSET_PLACEHOLDER_PREFIX)) {
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains a reserved export placeholder");
  }

  const assetsByUrl = new Map<string, PlannedPortableDesignAsset>();
  const assetsById = new Set<string>();
  const references = new Map<string, number>();
  const plannedAssets = input.assets.map((asset, index): PlannedPortableDesignAsset => {
    if (assetsById.has(asset.assetId)) {
      throw new PortableDesignHtmlError("corrupt", `Design Asset ${asset.assetId} is pinned more than once`);
    }
    if (assetsByUrl.has(asset.canonicalUrl)) {
      throw new PortableDesignHtmlError("corrupt", `Design Asset URL ${asset.canonicalUrl} is pinned more than once`);
    }
    if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0) {
      throw new PortableDesignHtmlError("corrupt", `Design Asset ${asset.assetId} has an invalid byte length`);
    }
    assertMediaType(asset.assetId, asset.mimeType);
    assetsById.add(asset.assetId);
    const planned = {
      ...asset,
      placeholder: `${PORTABLE_ASSET_PLACEHOLDER_PREFIX}${index}__`,
      references: 0,
    };
    assetsByUrl.set(asset.canonicalUrl, planned);
    references.set(asset.assetId, 0);
    return planned;
  });

  const rewriteUrl = (rawUrl: string): string => {
    const url = rawUrl.trim();
    const asset = assetsByUrl.get(url);
    if (asset) {
      references.set(asset.assetId, (references.get(asset.assetId) ?? 0) + 1);
      return asset.placeholder;
    }
    if (dezinOwnedUrl(url)) {
      throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains a Dezin Asset URL not authorized by its Version pins");
    }
    return rawUrl;
  };

  // Script is raw text. Portable export never rewrites executable source, but
  // it uses the validator's AST authority so split/escaped/aliased internal
  // URL sinks cannot bypass the raw residual guard.
  const inspectScript = (
    script: string,
    sourceType: "script" | "module" | null,
  ): string => {
    if (sourceType === null) return script;
    let sinks: ReturnType<typeof collectDesignJavaScriptUrlSinks>;
    try {
      sinks = collectDesignJavaScriptUrlSinks(script, sourceType);
    } catch {
      throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains invalid JavaScript");
    }
    const edits = new Map<string, {
      start: number;
      end: number;
      asset: PlannedPortableDesignAsset;
    }>();
    for (const { url, sourceRange } of sinks) {
      if (!dezinOwnedUrl(url)) continue;
      const asset = assetsByUrl.get(url.trim());
      if (!asset) {
        throw new PortableDesignHtmlError(
          "corrupt",
          "Portable Design HTML JavaScript references a Dezin Asset URL not authorized by its Version pins",
        );
      }
      if (sourceRange === null) {
        throw new PortableDesignHtmlError(
          "corrupt",
          "Portable Design HTML JavaScript Asset URL has no exact source token",
        );
      }
      const key = `${sourceRange.start}:${sourceRange.end}`;
      const existing = edits.get(key);
      if (existing && existing.asset.assetId !== asset.assetId) {
        throw new PortableDesignHtmlError(
          "corrupt",
          "Portable Design HTML JavaScript Asset URL has an ambiguous exact source token",
        );
      }
      edits.set(key, { ...sourceRange, asset });
    }
    let rewritten = script;
    for (const edit of [...edits.values()].sort((left, right) => right.start - left.start)) {
      if (rewritten.slice(edit.start, edit.end) !== script.slice(edit.start, edit.end)) {
        throw new PortableDesignHtmlError(
          "corrupt",
          "Portable Design HTML JavaScript Asset URL source locations overlap",
        );
      }
      rewritten = `${rewritten.slice(0, edit.start)}${edit.asset.placeholder}${rewritten.slice(edit.end)}`;
      references.set(edit.asset.assetId, (references.get(edit.asset.assetId) ?? 0) + 1);
    }
    return rewritten;
  };
  const template = rewriteDesignHtmlUrlReferences({
    html,
    rewriteUrl,
    rewriteScriptText: inspectScript,
  });
  if (/dezin-asset:\/\//i.test(template)
    || /\/api\/projects\/[A-Za-z0-9._-]+\/design-canvas\/assets\//i.test(template)) {
    throw new PortableDesignHtmlError("corrupt", "Portable Design HTML still references Dezin-owned assets");
  }

  let projectedBytes = Buffer.byteLength(template, "utf8");
  const finalizedAssets = plannedAssets.map((asset): PlannedPortableDesignAsset => {
    const count = references.get(asset.assetId) ?? 0;
    if (count === 0) {
      throw new PortableDesignHtmlError("corrupt", `Design Asset ${asset.assetId} is pinned but not referenced by its HTML Version`);
    }
    projectedBytes += count * (
      projectedDataUrlBytes(asset) - Buffer.byteLength(asset.placeholder, "utf8")
    );
    if (projectedBytes > MAX_PORTABLE_DESIGN_HTML_BYTES) {
      throw new PortableDesignHtmlError("limit", "Portable Design HTML exceeds the single-file export limit");
    }
    return { ...asset, references: count };
  });
  return { template, assets: finalizedAssets, projectedBytes };
}

function finalizePortableDesignHtml(
  plan: PortableDesignHtmlPlan,
  dataUrls: ReadonlyMap<string, string>,
): Buffer {
  const result = Buffer.from(plan.template.replace(
    /__DEZIN_PORTABLE_ASSET_(\d+)__/g,
    (placeholder, rawIndex: string) => {
      const asset = plan.assets[Number(rawIndex)];
      if (!asset || asset.placeholder !== placeholder) {
        throw new PortableDesignHtmlError("corrupt", "Portable Design HTML contains an invalid export placeholder");
      }
      const dataUrl = dataUrls.get(asset.assetId);
      if (!dataUrl) {
        throw new PortableDesignHtmlError("corrupt", `Design Asset ${asset.assetId} has no portable payload`);
      }
      return dataUrl;
    },
  ), "utf8");
  if (result.length !== plan.projectedBytes || result.length > MAX_PORTABLE_DESIGN_HTML_BYTES) {
    throw new PortableDesignHtmlError(
      result.length > MAX_PORTABLE_DESIGN_HTML_BYTES ? "limit" : "corrupt",
      result.length > MAX_PORTABLE_DESIGN_HTML_BYTES
        ? "Portable Design HTML exceeds the single-file export limit"
        : "Portable Design HTML output did not match its projected byte identity",
    );
  }
  return result;
}

/** Reads and verifies payloads one at a time so a large pin set never creates
 * an unbounded Promise.all of Asset buffers. */
export async function materializePortableDesignHtml(
  plan: PortableDesignHtmlPlan,
  loadAsset: (asset: PortableDesignAssetDescriptor) => Promise<Uint8Array>,
): Promise<Buffer> {
  const dataUrls = new Map<string, string>();
  for (const asset of plan.assets) {
    const payload = await loadAsset(asset);
    dataUrls.set(asset.assetId, verifiedAssetDataUrl(asset, payload));
  }
  return finalizePortableDesignHtml(plan, dataUrls);
}

export async function buildPortableDesignHtmlFromAssetLoader(
  input: {
    readonly html: Uint8Array;
    readonly assets: readonly PortableDesignAssetDescriptor[];
  },
  loadAsset: (asset: PortableDesignAssetDescriptor) => Promise<Uint8Array>,
): Promise<Buffer> {
  const plan = buildPortableDesignHtmlPlan(input);
  return materializePortableDesignHtml(plan, loadAsset);
}

/** Convenience entry point for callers that already hold verified payloads. */
export function buildPortableDesignHtml(input: {
  readonly html: Uint8Array;
  readonly assets: readonly PortableDesignAsset[];
}): Buffer {
  const plan = buildPortableDesignHtmlPlan({
    html: input.html,
    assets: input.assets.map((asset) => ({
      assetId: asset.assetId,
      checksum: asset.checksum,
      mimeType: asset.mimeType,
      canonicalUrl: asset.canonicalUrl,
      byteLength: asset.bytes.byteLength,
    })),
  });
  const dataUrls = new Map(input.assets.map((asset) => [
    asset.assetId,
    verifiedAssetDataUrl({ ...asset, byteLength: asset.bytes.byteLength }, asset.bytes),
  ]));
  return finalizePortableDesignHtml(plan, dataUrls);
}
