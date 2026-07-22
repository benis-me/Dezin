import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";

import { stableStringify } from "../context/context-types.ts";
import { inspectBoundedPngImage } from "../artifact-thumbnail.ts";

export const SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL = "dezin.sharingan-capture-resource-bundle.v2" as const;
export const SHARINGAN_CAPTURE_RESOURCE_BUNDLE_ROOTS = Object.freeze([
  ".sharingan",
  "public/_assets",
] as const);

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 48 * 1024 * 1024;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_SEMANTIC_PAGES = 8;
const MAX_SEMANTIC_SCREENSHOTS = 64;
const MAX_SEMANTIC_PNG_FILES = 512;
const MAX_DOM_NODES = 2_000;
const MAX_DOM_DEPTH = 128;
const MAX_RENDER_MAP_ELEMENTS = 1_000;
const MIN_USABLE_VIEWPORT_WIDTH = 320;
const MIN_USABLE_VIEWPORT_HEIGHT = 480;

export interface SharinganCaptureBundleScope {
  readonly taskId: string;
  readonly planId: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly parentRevisionId: string | null;
  /** Context Pack of the Resource Task that generated this immutable bundle. */
  readonly contextPackId: string;
  readonly operation: "create" | "revise";
  readonly nodeId: string;
  readonly title: string;
  readonly resourceKind: "sharingan-capture";
}

export interface SharinganCaptureBundleSourceIdentity {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly capturedAt: number;
}

export interface SharinganCaptureBundleExporterIdentity {
  readonly id: string;
  readonly version: 1;
}

export interface SharinganCaptureBundleFileInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly checksum: string;
}

export interface SharinganCaptureResourceBundleFile {
  readonly path: string;
  readonly mode: 0o444;
  readonly byteLength: number;
  readonly checksum: string;
  readonly bytesBase64: string;
}

export interface SharinganCaptureResourceBundle {
  readonly protocol: typeof SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL;
  readonly scope: SharinganCaptureBundleScope;
  readonly source: SharinganCaptureBundleSourceIdentity;
  readonly exporter: SharinganCaptureBundleExporterIdentity;
  readonly roots: typeof SHARINGAN_CAPTURE_RESOURCE_BUNDLE_ROOTS;
  readonly files: readonly SharinganCaptureResourceBundleFile[];
}

export interface DecodedSharinganCaptureResourceBundle
  extends Omit<SharinganCaptureResourceBundle, "files"> {
  readonly files: readonly Readonly<{
    path: string;
    mode: 0o444;
    byteLength: number;
    checksum: string;
    bytes: Uint8Array;
  }>[];
}

export interface SharinganCaptureSemanticReceipt {
  readonly protocol: "dezin.sharingan-capture-semantic-receipt.v1";
  readonly pageCount: number;
  readonly screenshotCount: number;
  readonly viewportCount: number;
}

export class SharinganCaptureResourceBundleError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SharinganCaptureResourceBundleError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function fail(message: string, cause?: unknown): never {
  throw new SharinganCaptureResourceBundleError(message, cause);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    fail(`${label} must be an object`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be plain data`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SharinganCaptureResourceBundleError) throw error;
    return fail(`${label} could not be inspected safely`, error);
  }
}

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label);
  const keys = Reflect.ownKeys(result);
  if (keys.some((key) => typeof key !== "string") || keys.length !== fields.length
    || fields.some((field) => !keys.includes(field))) fail(`${label} fields are not exact`);
  const descriptors = Object.getOwnPropertyDescriptors(result);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${label}.${field} must be an enumerable data field`);
    }
  }
  return result;
}

function enumerableDataField(value: Record<string, unknown>, key: string, label: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch (error) {
    return fail(`${label} could not be inspected safely`, error);
  }
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    fail(`${label} must be an enumerable data field`);
  }
  return descriptor.value;
}

function text(value: unknown, label: string, maxBytes = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) fail(`${label} is invalid`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (!SAFE_ID.test(result)) fail(`${label} is invalid`);
  return result;
}

function httpUrl(value: unknown, label: string): string {
  const raw = text(value, label, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    return fail(`${label} is invalid`, error);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username.length > 0 || parsed.password.length > 0 || parsed.href !== raw) {
    fail(`${label} must be one canonical credential-free HTTP(S) URL`);
  }
  return raw;
}

export function normalizeSharinganCaptureBundlePath(value: unknown): string {
  const path = text(value, "Sharingan Capture bundle path", MAX_PATH_BYTES);
  if (!/^[A-Za-z0-9._/-]+$/.test(path)
    || path.startsWith("/") || path.includes("\\") || path.endsWith("/") || path.includes("//")) {
    fail("Sharingan Capture bundle path is unsafe");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."
    || segment.toLowerCase() === ".git")) fail("Sharingan Capture bundle path is unsafe");
  return path;
}

function scope(value: unknown): SharinganCaptureBundleScope {
  const item = exact(value, [
    "taskId", "planId", "attempt", "inputHash", "workspaceId", "resourceId",
    "parentRevisionId", "contextPackId", "operation", "nodeId", "title", "resourceKind",
  ], "Sharingan Capture bundle scope");
  if (!Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1
    || typeof item.inputHash !== "string" || !SHA256.test(item.inputHash)
    || (item.parentRevisionId !== null && typeof item.parentRevisionId !== "string")
    || (item.operation !== "create" && item.operation !== "revise")
    || item.resourceKind !== "sharingan-capture") fail("Sharingan Capture bundle scope is invalid");
  return Object.freeze({
    taskId: identifier(item.taskId, "Sharingan Capture Task id"),
    planId: identifier(item.planId, "Sharingan Capture Plan id"),
    attempt: Number(item.attempt),
    inputHash: item.inputHash,
    workspaceId: identifier(item.workspaceId, "Sharingan Capture Workspace id"),
    resourceId: identifier(item.resourceId, "Sharingan Capture Resource id"),
    parentRevisionId: item.parentRevisionId === null
      ? null
      : identifier(item.parentRevisionId, "Sharingan Capture parent Revision id"),
    contextPackId: identifier(item.contextPackId, "Sharingan Capture Context Pack id"),
    operation: item.operation,
    nodeId: identifier(item.nodeId, "Sharingan Capture node id"),
    title: text(item.title, "Sharingan Capture title", 4_096),
    resourceKind: "sharingan-capture",
  });
}

function source(value: unknown): SharinganCaptureBundleSourceIdentity {
  const item = exact(value, ["requestedUrl", "finalUrl", "capturedAt"], "Sharingan Capture source");
  if (!Number.isSafeInteger(item.capturedAt) || Number(item.capturedAt) < 0) {
    fail("Sharingan Capture timestamp is invalid");
  }
  return Object.freeze({
    requestedUrl: httpUrl(item.requestedUrl, "Sharingan Capture requested URL"),
    finalUrl: httpUrl(item.finalUrl, "Sharingan Capture final URL"),
    capturedAt: Number(item.capturedAt),
  });
}

function exporter(value: unknown): SharinganCaptureBundleExporterIdentity {
  const item = exact(value, ["id", "version"], "Sharingan Capture exporter");
  if (item.version !== 1) fail("Sharingan Capture exporter version is unsupported");
  return Object.freeze({ id: identifier(item.id, "Sharingan Capture exporter id"), version: 1 });
}

function denseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) fail(`${label} is invalid or unbounded`);
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch (error) {
    return fail(`${label} could not be inspected safely`, error);
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > maximum) {
    fail(`${label} is invalid or unbounded`);
  }
  const expected = new Set(["length", ...Array.from({ length: Number(length) }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(`${label} is sparse or extended`);
  }
  return Array.from({ length: Number(length) }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(`${label}[${index}] must be an enumerable data field`);
    }
    return descriptor.value;
  });
}

function denseArrayAllowEmpty(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) fail(`${label} is invalid or unbounded`);
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch (error) {
    return fail(`${label} could not be inspected safely`, error);
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum) {
    fail(`${label} is invalid or unbounded`);
  }
  const expected = new Set(["length", ...Array.from({ length: Number(length) }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(`${label} is sparse or extended`);
  }
  return Array.from({ length: Number(length) }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(`${label}[${index}] must be an enumerable data field`);
    }
    return descriptor.value;
  });
}

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function rootedBundlePath(value: unknown): string {
  const path = normalizeSharinganCaptureBundlePath(value);
  if (!path.startsWith(".sharingan/") && !path.startsWith("public/_assets/")) {
    fail("Sharingan Capture bundle file is outside its declared immutable roots");
  }
  return path;
}

function referencedBundlePath(value: unknown, label: string): string {
  const reference = text(value, label, MAX_PATH_BYTES);
  if (!reference.startsWith(".sharingan/")) {
    fail(`${label} must point inside the immutable .sharingan bundle`);
  }
  const path = rootedBundlePath(reference);
  if (path === ".sharingan/pages.json" || path === ".sharingan/probe.mjs") {
    fail(`${label} cannot alias a bundle control file`);
  }
  return path;
}

function decodedJson(bytes: Uint8Array, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return fail(`${label} is invalid UTF-8 JSON`, error);
  }
  return parsed;
}

function publicAssetBundlePath(value: unknown, label: string): string {
  const reference = text(value, label, MAX_PATH_BYTES);
  if (!reference.startsWith("/_assets/")) {
    fail(`${label} must point inside the immutable public/_assets bundle`);
  }
  const suffix = normalizeSharinganCaptureBundlePath(reference.slice("/_assets/".length));
  return rootedBundlePath(`public/_assets/${suffix}`);
}

function finiteNumber(value: unknown, label: string, options: { positive?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000
    || (options.positive === true && value <= 0)) fail(`${label} is not a bounded finite number`);
  return value;
}

function dimensions(value: unknown, label: string): { width: number; height: number } {
  const item = record(value, label);
  return {
    width: finiteNumber(item.width, `${label} width`, { positive: true }),
    height: finiteNumber(item.height, `${label} height`, { positive: true }),
  };
}

function semanticBox(value: unknown, label: string): { x: number; y: number; w: number; h: number } {
  const item = record(value, label);
  return {
    x: finiteNumber(item.x, `${label} x`),
    y: finiteNumber(item.y, `${label} y`),
    w: finiteNumber(item.w, `${label} width`, { positive: true }),
    h: finiteNumber(item.h, `${label} height`, { positive: true }),
  };
}

function meaningfulStringRecord(value: unknown, label: string): Record<string, unknown> {
  const item = record(value, label);
  const values = Object.values(item);
  if (values.length === 0 || !values.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    fail(`${label} has no useful captured values`);
  }
  for (const [key, entry] of Object.entries(item)) {
    text(key, `${label} key`, 256);
    if (typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 8_192) {
      fail(`${label}.${key} is invalid`);
    }
  }
  return item;
}

function validateDomTree(value: unknown, label: string): ReadonlySet<string> {
  const roots = denseArray(value, `${label} roots`, 8);
  const stack = roots.map((node) => ({ node, depth: 1 }));
  const tags = new Set<string>();
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_DOM_DEPTH || ++count > MAX_DOM_NODES) {
      fail(`${label} is too deep or contains too many nodes`);
    }
    const node = record(current.node, `${label} node ${count}`);
    const tag = text(node.tag, `${label} node ${count} tag`, 64).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) fail(`${label} node ${count} tag is invalid`);
    tags.add(tag);
    semanticBox(node.box, `${label} node ${count} box`);
    meaningfulStringRecord(node.style, `${label} node ${count} style`);
    const children = denseArrayAllowEmpty(node.children, `${label} node ${count} children`, MAX_DOM_NODES);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], depth: current.depth + 1 });
    }
  }
  if (!tags.has("body")) fail(`${label} has no captured body root`);
  return tags;
}

function validateStyleTokens(value: unknown, label: string): void {
  const item = exact(
    value,
    ["colors", "fontFamilies", "fontSizes", "radii", "shadows"],
    label,
  );
  let useful = 0;
  for (const field of ["colors", "fontFamilies", "fontSizes", "radii", "shadows"] as const) {
    const values = denseArrayAllowEmpty(item[field], `${label}.${field}`, 128);
    for (const [index, value] of values.entries()) {
      text(value, `${label}.${field}[${index}]`, 2_048);
      useful += 1;
    }
  }
  if (useful === 0) fail(`${label} contains no useful captured design tokens`);
}

function validateRenderMap(
  value: unknown,
  label: string,
  domTags: ReadonlySet<string>,
): { viewport: { width: number; height: number }; document: { width: number; height: number } } {
  const item = record(value, label);
  const viewport = dimensions(item.viewport, `${label} viewport`);
  const document = dimensions(item.document, `${label} document`);
  if (viewport.width < MIN_USABLE_VIEWPORT_WIDTH || viewport.height < MIN_USABLE_VIEWPORT_HEIGHT) {
    fail(`${label} viewport is too small to be usable design evidence`);
  }
  if (document.width < viewport.width || document.height < viewport.height) {
    fail(`${label} document is smaller than its captured viewport`);
  }
  const elements = denseArray(item.elements, `${label} elements`, MAX_RENDER_MAP_ELEMENTS);
  let overlapsDom = false;
  for (const [index, rawElement] of elements.entries()) {
    const element = record(rawElement, `${label} element ${index}`);
    text(element.selector, `${label} element ${index} selector`, 8_192);
    const tag = text(element.tag, `${label} element ${index} tag`, 64).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) fail(`${label} element ${index} tag is invalid`);
    overlapsDom ||= domTags.has(tag);
    semanticBox(element.box, `${label} element ${index} box`);
    record(element.style, `${label} element ${index} style`);
  }
  if (!overlapsDom) fail(`${label} has no element corresponding to the captured DOM tree`);
  return { viewport, document };
}

/**
 * Validates the captured evidence itself, not only its manifest/checksums.
 * Production calls this both before publication and after immutable Revision
 * readback so empty JSON or non-image placeholder bytes cannot become source
 * truth for a high-fidelity Sharingan build.
 */
export async function validateSharinganCaptureResourceBundleSemantics(input: {
  readonly source: SharinganCaptureBundleSourceIdentity;
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  readonly signal?: AbortSignal;
}): Promise<SharinganCaptureSemanticReceipt> {
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Sharingan semantic validation aborted", "AbortError");
  const normalizedSource = source(input.source);
  const files = new Map<string, Uint8Array>();
  for (const [index, rawFile] of denseArray(input.files, "Sharingan semantic files", MAX_FILES).entries()) {
    const file = record(rawFile, `Sharingan semantic file ${index}`);
    const path = rootedBundlePath(enumerableDataField(file, "path", `Sharingan semantic file ${index}.path`));
    const rawBytes = enumerableDataField(file, "bytes", `Sharingan semantic file ${index}.bytes`);
    if (!(rawBytes instanceof Uint8Array) || nodeUtilTypes.isProxy(rawBytes) || rawBytes.byteLength === 0
      || rawBytes.byteLength > MAX_FILE_BYTES || files.has(path)) {
      fail(`Sharingan semantic file ${path} is invalid`);
    }
    files.set(path, new Uint8Array(rawBytes));
  }
  validatePagesManifest(files, normalizedSource);
  const pngImages = new Map<string, Readonly<{ width: number; height: number }>>();
  for (const [path, bytes] of files) {
    if (!path.toLowerCase().endsWith(".png")) continue;
    if (pngImages.size >= MAX_SEMANTIC_PNG_FILES) {
      fail("Sharingan semantic PNG set is unbounded");
    }
    try {
      pngImages.set(path, await inspectBoundedPngImage(bytes, input.signal));
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      return fail(`Sharingan semantic PNG ${path} is not a bounded fully decodable image`, error);
    }
  }
  const manifest = record(
    decodedJson(files.get(".sharingan/pages.json")!, "Sharingan semantic pages.json"),
    "Sharingan semantic pages manifest",
  );
  const pages = denseArray(manifest.pages, "Sharingan semantic pages", MAX_SEMANTIC_PAGES);
  let screenshotCount = 0;
  const viewports = new Set<string>();
  let hasExactEntry = false;
  for (const [pageIndex, rawPage] of pages.entries()) {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Sharingan semantic validation aborted", "AbortError");
    const page = record(rawPage, `Sharingan semantic page ${pageIndex}`);
    const requestedUrl = httpUrl(page.requestedUrl, `Sharingan semantic page ${pageIndex} requested URL`);
    const finalUrl = httpUrl(page.url, `Sharingan semantic page ${pageIndex} final URL`);
    hasExactEntry ||= requestedUrl === normalizedSource.requestedUrl && finalUrl === normalizedSource.finalUrl;
    const domPath = referencedBundlePath(page.dom, `Sharingan semantic page ${pageIndex} DOM`);
    const stylesPath = referencedBundlePath(page.styles, `Sharingan semantic page ${pageIndex} styles`);
    const renderMapPath = referencedBundlePath(page.renderMap, `Sharingan semantic page ${pageIndex} render map`);
    const domTags = validateDomTree(
      decodedJson(files.get(domPath)!, `Sharingan semantic page ${pageIndex} DOM`),
      `Sharingan semantic page ${pageIndex} DOM`,
    );
    validateStyleTokens(
      decodedJson(files.get(stylesPath)!, `Sharingan semantic page ${pageIndex} styles`),
      `Sharingan semantic page ${pageIndex} styles`,
    );
    const renderMap = validateRenderMap(
      decodedJson(files.get(renderMapPath)!, `Sharingan semantic page ${pageIndex} render map`),
      `Sharingan semantic page ${pageIndex} render map`,
      domTags,
    );
    const screenshots = record(page.screenshots, `Sharingan semantic page ${pageIndex} screenshots`);
    let hasMatchingViewport = false;
    for (const [viewportName, rawPath] of Object.entries(screenshots)) {
      if (++screenshotCount > MAX_SEMANTIC_SCREENSHOTS) fail("Sharingan semantic screenshot set is unbounded");
      text(viewportName, `Sharingan semantic page ${pageIndex} viewport name`, 128);
      const screenshotPath = referencedBundlePath(rawPath, `Sharingan semantic page ${pageIndex} screenshot`);
      let image = pngImages.get(screenshotPath);
      if (image === undefined) {
        try {
          image = await inspectBoundedPngImage(files.get(screenshotPath)!, input.signal);
        } catch (error) {
          if (input.signal?.aborted) throw input.signal.reason ?? error;
          return fail(`Sharingan semantic screenshot ${screenshotPath} is not a bounded fully decodable PNG`, error);
        }
      }
      viewports.add(`${image.width}x${image.height}`);
      hasMatchingViewport ||= image.width === renderMap.viewport.width
        && image.height >= renderMap.viewport.height
        && image.height >= renderMap.document.height;
    }
    if (!hasMatchingViewport) {
      fail(`Sharingan semantic page ${pageIndex} has no screenshot matching its measured viewport`);
    }
  }
  if (!hasExactEntry) fail("Sharingan semantic pages do not contain the exact captured entry identity");
  return Object.freeze({
    protocol: "dezin.sharingan-capture-semantic-receipt.v1",
    pageCount: pages.length,
    screenshotCount,
    viewportCount: viewports.size,
  });
}

function validatePagesManifest(files: ReadonlyMap<string, Uint8Array>, expectedSource: SharinganCaptureBundleSourceIdentity): void {
  const bytes = files.get(".sharingan/pages.json");
  if (!bytes) fail("Sharingan Capture bundle is missing .sharingan/pages.json");
  const probe = files.get(".sharingan/probe.mjs");
  if (!probe || probe.byteLength === 0) fail("Sharingan Capture bundle is missing .sharingan/probe.mjs");
  const parsed = decodedJson(bytes, "Sharingan Capture pages.json");
  const manifest = record(parsed, "Sharingan Capture pages manifest");
  if (manifest.schemaVersion !== 2
    || manifest.requestedSourceUrl !== expectedSource.requestedUrl
    || manifest.sourceUrl !== expectedSource.finalUrl) {
    fail("Sharingan Capture pages manifest substituted its exact source identity");
  }
  const pages = denseArray(manifest.pages, "Sharingan Capture pages", 256);
  const expectedFiles = new Set<string>([".sharingan/pages.json", ".sharingan/probe.mjs"]);
  const assetManifests = new Set<string>();
  for (const [index, rawPage] of pages.entries()) {
    const page = record(rawPage, `Sharingan Capture page ${index}`);
    httpUrl(page.requestedUrl, `Sharingan Capture page ${index} requested URL`);
    httpUrl(page.url, `Sharingan Capture page ${index} URL`);
    text(page.title, `Sharingan Capture page ${index} title`, 4_096);
    const screenshots = record(page.screenshots, `Sharingan Capture page ${index} screenshots`);
    const screenshotPaths = Object.values(screenshots);
    if (screenshotPaths.length === 0 || screenshotPaths.length > 16) {
      fail(`Sharingan Capture page ${index} screenshots are invalid`);
    }
    const assetsPath = referencedBundlePath(page.assets, `Sharingan Capture page ${index} Assets`);
    assetManifests.add(assetsPath);
    const referenced = [
      ...screenshotPaths.map((path) => referencedBundlePath(path, `Sharingan Capture page ${index} screenshot`)),
      referencedBundlePath(page.dom, `Sharingan Capture page ${index} DOM`),
      referencedBundlePath(page.styles, `Sharingan Capture page ${index} styles`),
      assetsPath,
      referencedBundlePath(page.renderMap, `Sharingan Capture page ${index} render map`),
    ];
    for (const path of referenced) {
      if (!files.has(path)) fail(`Sharingan Capture pages manifest references missing file ${path}`);
      expectedFiles.add(path);
    }
  }
  for (const path of assetManifests) {
    const assetBytes = files.get(path);
    if (!assetBytes) fail(`Sharingan Capture bundle is missing Assets manifest ${path}`);
    const assets = denseArrayAllowEmpty(
      decodedJson(assetBytes, `Sharingan Capture Assets manifest ${path}`),
      `Sharingan Capture Assets manifest ${path}`,
      20_000,
    );
    for (const [index, rawAsset] of assets.entries()) {
      const asset = record(rawAsset, `Sharingan Capture Asset ${path}[${index}]`);
      if (!Object.hasOwn(asset, "local")) continue;
      const local = publicAssetBundlePath(asset.local, `Sharingan Capture Asset ${path}[${index}] local`);
      if (!files.has(local)) fail(`Sharingan Capture Assets manifest references missing file ${local}`);
      expectedFiles.add(local);
    }
  }
  if (files.size !== expectedFiles.size
    || [...files.keys()].some((path) => !expectedFiles.has(path))) {
    fail("Sharingan Capture bundle contains files not referenced by its canonical capture manifests");
  }
}

function validatePathSet(paths: readonly string[]): void {
  const unique = new Set(paths);
  if (unique.size !== paths.length) fail("Sharingan Capture bundle contains duplicate paths");
  for (const path of paths) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      if (unique.has(segments.slice(0, length).join("/"))) {
        fail("Sharingan Capture bundle contains a file/directory path collision");
      }
    }
  }
}

export function encodeSharinganCaptureResourceBundle(input: {
  scope: SharinganCaptureBundleScope;
  source: SharinganCaptureBundleSourceIdentity;
  exporter: SharinganCaptureBundleExporterIdentity;
  files: readonly SharinganCaptureBundleFileInput[];
  maxOutputBytes: number;
}): { bytes: Uint8Array; bundle: SharinganCaptureResourceBundle } {
  const normalizedScope = scope(input.scope);
  const normalizedSource = source(input.source);
  const normalizedExporter = exporter(input.exporter);
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) {
    fail("Sharingan Capture output budget is invalid");
  }
  const files = denseArray(input.files, "Sharingan Capture exported files", MAX_FILES).map((raw, index) => {
    const item = exact(raw, ["path", "bytes", "checksum"], `Sharingan Capture exported file ${index}`);
    const path = rootedBundlePath(item.path);
    if (!(item.bytes instanceof Uint8Array) || item.bytes.byteLength > MAX_FILE_BYTES
      || typeof item.checksum !== "string" || !SHA256.test(item.checksum)
      || checksum(item.bytes) !== item.checksum) fail(`Sharingan Capture exported file ${path} is invalid`);
    const bytes = new Uint8Array(item.bytes);
    return {
      path,
      mode: 0o444 as const,
      byteLength: bytes.byteLength,
      checksum: item.checksum,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      decoded: bytes,
    };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  validatePathSet(files.map((file) => file.path));
  const total = files.reduce((sum, file) => sum + file.byteLength, 0);
  if (total <= 0 || total > MAX_TOTAL_FILE_BYTES) fail("Sharingan Capture bundle file bytes exceed their limit");
  validatePagesManifest(new Map(files.map((file) => [file.path, file.decoded])), normalizedSource);
  const bundle: SharinganCaptureResourceBundle = Object.freeze({
    protocol: SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL,
    scope: normalizedScope,
    source: normalizedSource,
    exporter: normalizedExporter,
    roots: SHARINGAN_CAPTURE_RESOURCE_BUNDLE_ROOTS,
    files: Object.freeze(files.map(({ decoded: _decoded, ...file }) => Object.freeze(file))),
  });
  const bytes = Buffer.from(`${stableStringify(bundle)}\n`, "utf8");
  if (bytes.byteLength > input.maxOutputBytes) fail("Sharingan Capture bundle exceeds its output budget");
  return { bytes, bundle };
}

export function decodeSharinganCaptureResourceBundle(value: Uint8Array): DecodedSharinganCaptureResourceBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch (error) {
    return fail("Sharingan Capture Resource payload is invalid UTF-8 JSON", error);
  }
  const canonical = Buffer.from(`${stableStringify(parsed)}\n`, "utf8");
  if (!Buffer.from(value).equals(canonical)) {
    fail("Sharingan Capture Resource payload is not in canonical byte form");
  }
  const bundle = exact(parsed, ["protocol", "scope", "source", "exporter", "roots", "files"], "Sharingan Capture Resource bundle");
  if (bundle.protocol !== SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL) {
    fail("Sharingan Capture Resource bundle protocol is unsupported");
  }
  const normalizedScope = scope(bundle.scope);
  const normalizedSource = source(bundle.source);
  const normalizedExporter = exporter(bundle.exporter);
  const normalizedRoots = denseArray(bundle.roots, "Sharingan Capture Resource roots", 2);
  if (!isDeepStrictEqual(normalizedRoots, SHARINGAN_CAPTURE_RESOURCE_BUNDLE_ROOTS)) {
    fail("Sharingan Capture Resource roots are not canonical");
  }
  let total = 0;
  const files = denseArray(bundle.files, "Sharingan Capture Resource files", MAX_FILES).map((raw, index) => {
    const item = exact(raw, ["path", "mode", "byteLength", "checksum", "bytesBase64"], `Sharingan Capture Resource file ${index}`);
    const path = rootedBundlePath(item.path);
    if (item.mode !== 0o444 || !Number.isSafeInteger(item.byteLength) || Number(item.byteLength) < 0
      || Number(item.byteLength) > MAX_FILE_BYTES || typeof item.checksum !== "string" || !SHA256.test(item.checksum)
      || typeof item.bytesBase64 !== "string" || item.bytesBase64.length > MAX_FILE_BYTES * 2) {
      fail(`Sharingan Capture Resource file ${path} metadata is invalid`);
    }
    const bytes = Buffer.from(item.bytesBase64, "base64");
    if (bytes.toString("base64") !== item.bytesBase64 || bytes.byteLength !== item.byteLength
      || checksum(bytes) !== item.checksum) fail(`Sharingan Capture Resource file ${path} bytes are invalid`);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_FILE_BYTES) fail("Sharingan Capture Resource files exceed their total limit");
    return Object.freeze({ path, mode: 0o444 as const, byteLength: bytes.byteLength, checksum: item.checksum, bytes: new Uint8Array(bytes) });
  });
  validatePathSet(files.map((file) => file.path));
  const sorted = [...files].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (!isDeepStrictEqual(files.map((file) => file.path), sorted.map((file) => file.path))) {
    fail("Sharingan Capture Resource files are not in canonical order");
  }
  validatePagesManifest(new Map(files.map((file) => [file.path, file.bytes])), normalizedSource);
  return Object.freeze({
    protocol: SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL,
    scope: normalizedScope,
    source: normalizedSource,
    exporter: normalizedExporter,
    roots: SHARINGAN_CAPTURE_RESOURCE_BUNDLE_ROOTS,
    files: Object.freeze(files),
  });
}
