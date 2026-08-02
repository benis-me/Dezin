import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import type { Project, Store } from "../../../packages/core/src/index.ts";
import { projectDir } from "./serve-static.ts";
import { immutableProbeCliScript } from "./sharingan-probe-cli.ts";
import {
  ProductionCaptureFdReadError,
  readProductionCaptureFilesFdRelative,
  type ProductionCaptureFileIdentity,
} from "./orchestration/production-resource-runtime-fd-reader.ts";
import {
  encodeSharinganCaptureResourceBundle,
  normalizeSharinganCaptureBundlePath,
  SharinganCaptureResourceBundleError,
  validateSharinganCaptureResourceBundleSemantics,
  type SharinganCaptureBundleFileInput,
  type SharinganCaptureBundleScope,
} from "./sharingan-capture-resource-bundle.ts";

const MAX_CAPTURE_OUTPUT_BYTES = 48 * 1024 * 1024;
const MAX_CAPTURE_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_FILE_BYTES = MAX_CAPTURE_OUTPUT_BYTES;
const MAX_CAPTURE_FILES = 20_000;
const CAPTURE_MANIFEST_PATH = ".sharingan/pages.json";
const CAPTURE_PROBE_PATH = ".sharingan/probe.mjs";

export type SharinganExactCaptureExportErrorCode =
  | "SHARINGAN_CAPTURE_REQUEST_INVALID"
  | "SHARINGAN_CAPTURE_REQUEST_OWNERSHIP_INVALID"
  | "SHARINGAN_CAPTURE_OWNER_INVALID"
  | "SHARINGAN_CAPTURE_SOURCE_UNAVAILABLE"
  | "SHARINGAN_CAPTURE_SOURCE_UNSAFE"
  | "SHARINGAN_CAPTURE_SOURCE_INVALID"
  | "SHARINGAN_CAPTURE_SOURCE_DRIFTED"
  | "SHARINGAN_CAPTURE_OUTPUT_BUDGET_EXCEEDED";

export type SharinganExactCaptureFailureClass = "adapter" | "context" | "storage";

export class SharinganExactCaptureExportError extends Error {
  readonly code: SharinganExactCaptureExportErrorCode;
  readonly failureClass: SharinganExactCaptureFailureClass;

  constructor(
    code: SharinganExactCaptureExportErrorCode,
    message: string,
    failureClass: SharinganExactCaptureFailureClass,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SharinganExactCaptureExportError";
    this.code = code;
    this.failureClass = failureClass;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function fail(
  code: SharinganExactCaptureExportErrorCode,
  message: string,
  failureClass: SharinganExactCaptureFailureClass,
  cause?: unknown,
): never {
  throw new SharinganExactCaptureExportError(code, message, failureClass, cause);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Sharingan exact capture export aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function validSignal(value: unknown): value is AbortSignal {
  return Boolean(value && typeof value === "object"
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function");
}

function exactHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
    || value !== value.trim() || value.includes("\0")) {
    return fail("SHARINGAN_CAPTURE_SOURCE_INVALID", `${label} is invalid`, "context");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    return fail("SHARINGAN_CAPTURE_SOURCE_INVALID", `${label} is invalid`, "context", error);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0 || url.password.length > 0 || url.href !== value) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      `${label} must be one canonical credential-free HTTP(S) URL`,
      "context",
    );
  }
  return value;
}

function redirectIdentity(url: URL): string {
  const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  const routeHash = /^#[!/]/.test(url.hash) ? url.hash : "";
  return `${url.origin}${pathname}${url.search}${routeHash}`;
}

function exactRedirect(requestedUrl: string, finalUrl: string, label: string): void {
  const requested = new URL(requestedUrl);
  const final = new URL(finalUrl);
  if (requested.origin !== final.origin || redirectIdentity(requested) !== redirectIdentity(final)) {
    fail("SHARINGAN_CAPTURE_SOURCE_INVALID", `${label} changed capture identity`, "context");
  }
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

type FileIdentity = ProductionCaptureFileIdentity;

interface SecureFile {
  readonly bytes: Buffer;
  readonly checksum: string;
  readonly identity: FileIdentity;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function canonicalDirectory(path: string, parent?: string): Promise<string> {
  let metadata;
  let canonical: string;
  try {
    metadata = await lstat(path, { bigint: true });
    canonical = await realpath(path);
  } catch (error) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_UNAVAILABLE",
      "Sharingan Capture directory is unavailable",
      "storage",
      error,
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (parent !== undefined && !inside(parent, canonical))) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_UNSAFE",
      "Sharingan Capture directory is not a confined real directory",
      "storage",
    );
  }
  return canonical;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail("SHARINGAN_CAPTURE_SOURCE_INVALID", `${label} must be one plain object`, "context");
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum
    || Object.keys(value).length !== value.length) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      `${label} is empty, sparse, or unbounded`,
      "context",
    );
  }
  return value;
}

function captureReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith(".sharingan/")) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      `${label} is not an owned Sharingan capture reference`,
      "context",
    );
  }
  let normalized: string;
  try {
    normalized = normalizeSharinganCaptureBundlePath(value);
  } catch (error) {
    return fail("SHARINGAN_CAPTURE_SOURCE_UNSAFE", `${label} is unsafe`, "context", error);
  }
  if (normalized === CAPTURE_MANIFEST_PATH || normalized === CAPTURE_PROBE_PATH) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      `${label} cannot alias the capture manifest`,
      "context",
    );
  }
  return normalized;
}

interface CaptureManifest {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly references: readonly string[];
  readonly assetManifests: readonly string[];
}

function parseCaptureManifest(bytes: Buffer, project: Project): CaptureManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      "Sharingan Capture pages.json is not valid UTF-8 JSON",
      "context",
      error,
    );
  }
  const manifest = record(parsed, "Sharingan Capture pages.json");
  if (manifest.schemaVersion !== 2) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      "Sharingan Capture pages.json schema is unsupported",
      "context",
    );
  }
  const requestedUrl = exactHttpUrl(
    manifest.requestedSourceUrl,
    "Sharingan Capture requested source URL",
  );
  const finalUrl = exactHttpUrl(manifest.sourceUrl, "Sharingan Capture final source URL");
  exactRedirect(requestedUrl, finalUrl, "Sharingan Capture source redirect");
  if (project.sourceUrl !== requestedUrl) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      "Sharingan Capture manifest substituted its owning Project source URL",
      "context",
    );
  }
  const references = new Set<string>();
  const assetManifests = new Set<string>();
  let hasEntry = false;
  for (const [index, raw] of denseArray(manifest.pages, "Sharingan Capture pages", 256).entries()) {
    const page = record(raw, `Sharingan Capture page ${index}`);
    const pageRequested = exactHttpUrl(
      page.requestedUrl,
      `Sharingan Capture page ${index} requested URL`,
    );
    const pageFinal = exactHttpUrl(page.url, `Sharingan Capture page ${index} final URL`);
    exactRedirect(pageRequested, pageFinal, `Sharingan Capture page ${index} redirect`);
    hasEntry ||= pageRequested === requestedUrl && pageFinal === finalUrl;
    const screenshots = record(page.screenshots, `Sharingan Capture page ${index} screenshots`);
    const screenshotPaths = Object.values(screenshots);
    if (screenshotPaths.length === 0 || screenshotPaths.length > 16) {
      return fail(
        "SHARINGAN_CAPTURE_SOURCE_INVALID",
        `Sharingan Capture page ${index} screenshot set is invalid`,
        "context",
      );
    }
    for (const [viewport, path] of Object.entries(screenshots)) {
      if (!viewport || viewport.length > 128) {
        return fail(
          "SHARINGAN_CAPTURE_SOURCE_INVALID",
          `Sharingan Capture page ${index} viewport is invalid`,
          "context",
        );
      }
      references.add(captureReference(path, `Sharingan Capture page ${index} screenshot`));
    }
    references.add(captureReference(page.dom, `Sharingan Capture page ${index} DOM`));
    references.add(captureReference(page.styles, `Sharingan Capture page ${index} styles`));
    const assets = captureReference(page.assets, `Sharingan Capture page ${index} Assets`);
    references.add(assets);
    assetManifests.add(assets);
    references.add(captureReference(page.renderMap, `Sharingan Capture page ${index} render map`));
  }
  if (!hasEntry || references.size === 0 || references.size + 1 > MAX_CAPTURE_FILES) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      "Sharingan Capture entry identity or file set is invalid",
      "context",
    );
  }
  return Object.freeze({
    requestedUrl,
    finalUrl,
    references: Object.freeze([...references].sort(compareBinary)),
    assetManifests: Object.freeze([...assetManifests].sort(compareBinary)),
  });
}

function captureAssetReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/_assets/")) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      `${label} is not an owned local capture Asset`,
      "context",
    );
  }
  try {
    const suffix = normalizeSharinganCaptureBundlePath(value.slice("/_assets/".length));
    return normalizeSharinganCaptureBundlePath(`public/_assets/${suffix}`);
  } catch (error) {
    return fail("SHARINGAN_CAPTURE_SOURCE_UNSAFE", `${label} is unsafe`, "context", error);
  }
}

function parseCaptureAssetReferences(
  files: ReadonlyMap<string, SecureFile>,
  manifest: CaptureManifest,
): readonly string[] {
  const references = new Set<string>();
  for (const path of manifest.assetManifests) {
    const file = files.get(path);
    if (!file) {
      return fail(
        "SHARINGAN_CAPTURE_SOURCE_INVALID",
        `Sharingan Capture is missing Assets manifest ${path}`,
        "context",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    } catch (error) {
      return fail(
        "SHARINGAN_CAPTURE_SOURCE_INVALID",
        `Sharingan Capture Assets manifest ${path} is invalid`,
        "context",
        error,
      );
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_CAPTURE_FILES
      || Object.keys(parsed).length !== parsed.length) {
      return fail(
        "SHARINGAN_CAPTURE_SOURCE_INVALID",
        `Sharingan Capture Assets manifest ${path} is sparse or unbounded`,
        "context",
      );
    }
    for (const [index, raw] of parsed.entries()) {
      const asset = record(raw, `Sharingan Capture Asset ${path}[${index}]`);
      if (!Object.hasOwn(asset, "local")) continue;
      references.add(captureAssetReference(
        asset.local,
        `Sharingan Capture Asset ${path}[${index}] local`,
      ));
      if (references.size + manifest.references.length + 2 > MAX_CAPTURE_FILES) {
        return fail(
          "SHARINGAN_CAPTURE_SOURCE_INVALID",
          "Sharingan Capture file set is unbounded",
          "context",
        );
      }
    }
  }
  return Object.freeze([...references].sort(compareBinary));
}

interface CaptureSnapshot {
  readonly manifest: CaptureManifest;
  readonly files: ReadonlyMap<string, SecureFile>;
}

async function readCaptureSnapshot(input: {
  projectRoot: string;
  canonicalProjectRoot: string;
  project: Project;
  maxOutputBytes: number;
  signal: AbortSignal;
  afterPathFence?: (paths: readonly string[]) => void | Promise<void>;
  afterManifestDiscovery?: () => void | Promise<void>;
}): Promise<CaptureSnapshot> {
  const read = async (
    specs: readonly { path: string; hardMaximumBytes: number }[],
    budget: number,
  ) => {
    try {
      return await readProductionCaptureFilesFdRelative({
        rootPath: input.projectRoot,
        canonicalRoot: input.canonicalProjectRoot,
        specs,
        totalBudgetBytes: budget,
        signal: input.signal,
        afterPathFence: input.afterPathFence,
      });
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof ProductionCaptureFdReadError) {
        if (error.code === "unsafe") {
          return fail(
            "SHARINGAN_CAPTURE_SOURCE_UNSAFE",
            "Sharingan Capture fd-relative path fence failed",
            "storage",
            error,
          );
        }
        if (error.code === "drifted") {
          return fail(
            "SHARINGAN_CAPTURE_SOURCE_DRIFTED",
            "Sharingan Capture changed during fd-relative read",
            "storage",
            error,
          );
        }
        if (error.code === "budget") {
          return fail(
            "SHARINGAN_CAPTURE_OUTPUT_BUDGET_EXCEEDED",
            "Sharingan Capture exceeds its immutable output budget",
            "storage",
            error,
          );
        }
      }
      return fail(
        "SHARINGAN_CAPTURE_SOURCE_UNAVAILABLE",
        "Sharingan Capture fd-relative read failed",
        "storage",
        error,
      );
    }
  };
  const discoveryFiles = await read(
    [{ path: CAPTURE_MANIFEST_PATH, hardMaximumBytes: MAX_CAPTURE_MANIFEST_BYTES }],
    input.maxOutputBytes,
  );
  const discoveryManifestFile = discoveryFiles.get(CAPTURE_MANIFEST_PATH)!;
  const discoveryManifest = parseCaptureManifest(discoveryManifestFile.bytes, input.project);
  await input.afterManifestDiscovery?.();
  checkAbort(input.signal);
  const captureFiles = await read(
    [
      { path: CAPTURE_MANIFEST_PATH, hardMaximumBytes: MAX_CAPTURE_MANIFEST_BYTES },
      ...discoveryManifest.references.map((path) => ({
        path,
        hardMaximumBytes: MAX_CAPTURE_FILE_BYTES,
      })),
    ],
    input.maxOutputBytes,
  );
  const captureManifestFile = captureFiles.get(CAPTURE_MANIFEST_PATH)!;
  if (captureManifestFile.checksum !== discoveryManifestFile.checksum
    || !sameIdentity(captureManifestFile.identity, discoveryManifestFile.identity)) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_DRIFTED",
      "Sharingan Capture root or manifest changed after reference discovery",
      "storage",
    );
  }
  const captureManifest = parseCaptureManifest(captureManifestFile.bytes, input.project);
  if (captureManifest.references.length !== discoveryManifest.references.length
    || captureManifest.references.some((path, index) => path !== discoveryManifest.references[index])) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_DRIFTED",
      "Sharingan Capture references changed after manifest discovery",
      "storage",
    );
  }
  const assetReferences = parseCaptureAssetReferences(captureFiles, captureManifest);
  const files = await read(
    [
      { path: CAPTURE_MANIFEST_PATH, hardMaximumBytes: MAX_CAPTURE_MANIFEST_BYTES },
      ...captureManifest.references.map((path) => ({
        path,
        hardMaximumBytes: MAX_CAPTURE_FILE_BYTES,
      })),
      ...assetReferences.map((path) => ({ path, hardMaximumBytes: MAX_CAPTURE_FILE_BYTES })),
    ],
    input.maxOutputBytes,
  );
  for (const [path, captured] of captureFiles) {
    const final = files.get(path);
    if (!final || final.checksum !== captured.checksum
      || !sameIdentity(final.identity, captured.identity)) {
      return fail(
        "SHARINGAN_CAPTURE_SOURCE_DRIFTED",
        `Sharingan Capture file ${path} changed after Asset discovery`,
        "storage",
      );
    }
  }
  const manifest = parseCaptureManifest(files.get(CAPTURE_MANIFEST_PATH)!.bytes, input.project);
  const finalAssets = parseCaptureAssetReferences(files, manifest);
  if (finalAssets.length !== assetReferences.length
    || finalAssets.some((path, index) => path !== assetReferences[index])) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_DRIFTED",
      "Sharingan Capture local Asset references changed during read",
      "storage",
    );
  }
  return Object.freeze({ manifest, files });
}

function assertSameSnapshot(first: CaptureSnapshot, second: CaptureSnapshot): void {
  if (first.manifest.requestedUrl !== second.manifest.requestedUrl
    || first.manifest.finalUrl !== second.manifest.finalUrl
    || first.manifest.references.length !== second.manifest.references.length
    || first.manifest.references.some((path, index) => second.manifest.references[index] !== path)
    || first.files.size !== second.files.size) {
    fail(
      "SHARINGAN_CAPTURE_SOURCE_DRIFTED",
      "Sharingan Capture manifest changed between verification passes",
      "storage",
    );
  }
  for (const [path, firstFile] of first.files) {
    const secondFile = second.files.get(path);
    if (!secondFile || firstFile.checksum !== secondFile.checksum
      || !sameIdentity(firstFile.identity, secondFile.identity)) {
      fail(
        "SHARINGAN_CAPTURE_SOURCE_DRIFTED",
        `Sharingan Capture file ${path} changed between verification passes`,
        "storage",
      );
    }
  }
}

export interface ExactSharinganProjectCaptureExportRequest {
  readonly store: Store;
  readonly dataDir: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly scope: SharinganCaptureBundleScope;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
  readonly afterReadPass?: (pass: 1 | 2) => void | Promise<void>;
  readonly afterPathFence?: (paths: readonly string[]) => void | Promise<void>;
  readonly afterManifestDiscovery?: () => void | Promise<void>;
}

export interface ExactSharinganProjectCaptureExport {
  readonly exporter: Readonly<{ id: "dezin-sharingan-capture"; version: 1 }>;
  readonly source: Readonly<{
    requestedUrl: string;
    finalUrl: string;
    capturedAt: number;
  }>;
  readonly files: readonly SharinganCaptureBundleFileInput[];
}

function exactSharinganProjectCaptureOwner(
  request: ExactSharinganProjectCaptureExportRequest,
  revalidation = false,
): Project {
  const project = request.store.getProject(request.projectId);
  const workspace = request.store.workspace.getWorkspace(request.projectId);
  const resource = request.store.workspace.getResourceForProject(
    request.projectId,
    request.resourceId,
  );
  if (!project || !workspace || workspace.id !== request.workspaceId
    || project.mode !== "standard" || !project.sharingan || project.archivedAt !== null
    || typeof project.sourceUrl !== "string" || project.sourceUrl.length === 0
    || !resource || resource.workspaceId !== workspace.id
    || resource.kind !== "sharingan-capture" || resource.archivedAt !== null
    || request.scope.projectId !== request.projectId
    || request.scope.workspaceId !== workspace.id
    || request.scope.resourceId !== resource.id
    || request.scope.resourceKind !== "sharingan-capture") {
    return fail(
      revalidation
        ? "SHARINGAN_CAPTURE_REQUEST_OWNERSHIP_INVALID"
        : "SHARINGAN_CAPTURE_OWNER_INVALID",
      revalidation
        ? "Sharingan Capture owner changed during exact export"
        : "Sharingan Capture owner is not one active Standard Sharingan Project and Resource",
      "context",
    );
  }
  try {
    exactHttpUrl(project.sourceUrl, "Sharingan owning Project source URL");
  } catch (error) {
    if (!revalidation) throw error;
    return fail(
      "SHARINGAN_CAPTURE_REQUEST_OWNERSHIP_INVALID",
      "Sharingan Capture owner changed during exact export",
      "context",
      error,
    );
  }
  return project;
}

/**
 * Reads a Sharingan capture twice through fd-relative path fences, then returns
 * the immutable files only after ownership, identity and bundle validation all
 * agree. This module intentionally has no dependency on Design generation.
 */
export async function exportExactSharinganProjectCapture(
  request: ExactSharinganProjectCaptureExportRequest,
): Promise<ExactSharinganProjectCaptureExport> {
  if (!request || !Number.isSafeInteger(request.maxOutputBytes)
    || request.maxOutputBytes < 1 || request.maxOutputBytes > MAX_CAPTURE_OUTPUT_BYTES
    || !validSignal(request.signal)) {
    return fail(
      "SHARINGAN_CAPTURE_REQUEST_INVALID",
      "Sharingan Capture project export request is invalid",
      "adapter",
    );
  }
  checkAbort(request.signal);
  const project = exactSharinganProjectCaptureOwner(request);
  const canonicalDataRoot = await canonicalDirectory(request.dataDir);
  const projectsRoot = join(request.dataDir, "projects");
  const canonicalProjectsRoot = await canonicalDirectory(projectsRoot, canonicalDataRoot);
  const rootPath = projectDir(request.dataDir, project.id);
  const canonicalProjectRoot = await canonicalDirectory(rootPath, canonicalProjectsRoot);
  const captureRoot = join(rootPath, ".sharingan");
  await canonicalDirectory(captureRoot, canonicalProjectRoot);
  const first = await readCaptureSnapshot({
    projectRoot: rootPath,
    canonicalProjectRoot,
    project,
    maxOutputBytes: request.maxOutputBytes,
    signal: request.signal,
    afterPathFence: request.afterPathFence,
    afterManifestDiscovery: request.afterManifestDiscovery,
  });
  await request.afterReadPass?.(1);
  checkAbort(request.signal);
  const second = await readCaptureSnapshot({
    projectRoot: rootPath,
    canonicalProjectRoot,
    project,
    maxOutputBytes: request.maxOutputBytes,
    signal: request.signal,
    afterPathFence: request.afterPathFence,
    afterManifestDiscovery: request.afterManifestDiscovery,
  });
  await request.afterReadPass?.(2);
  checkAbort(request.signal);
  assertSameSnapshot(first, second);

  const capturedAt = Number(second.files.get(CAPTURE_MANIFEST_PATH)!.identity.mtimeNs / 1_000_000n);
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      "Sharingan Capture timestamp is invalid",
      "storage",
    );
  }
  const source = Object.freeze({
    requestedUrl: second.manifest.requestedUrl,
    finalUrl: second.manifest.finalUrl,
    capturedAt,
  });
  const exporter = Object.freeze({ id: "dezin-sharingan-capture" as const, version: 1 as const });
  const probeBytes = Buffer.from(immutableProbeCliScript(), "utf8");
  const files: SharinganCaptureBundleFileInput[] = [
    ...[...second.files.entries()].map(([path, file]) => ({ path, file })),
    {
      path: CAPTURE_PROBE_PATH,
      file: {
        bytes: probeBytes,
        checksum: createHash("sha256").update(probeBytes).digest("hex"),
      },
    },
  ]
    .sort((left, right) => compareBinary(left.path, right.path))
    .map(({ path, file }) => Object.freeze({
      path,
      bytes: new Uint8Array(file.bytes),
      checksum: file.checksum,
    }));
  try {
    await validateSharinganCaptureResourceBundleSemantics({
      source,
      files,
      signal: request.signal,
    });
    encodeSharinganCaptureResourceBundle({
      scope: request.scope,
      source,
      exporter,
      files,
      maxOutputBytes: request.maxOutputBytes,
    });
  } catch (error) {
    if (request.signal.aborted) throw abortReason(request.signal);
    if (error instanceof SharinganCaptureResourceBundleError
      && /output budget|exceeds/i.test(error.message)) {
      return fail(
        "SHARINGAN_CAPTURE_OUTPUT_BUDGET_EXCEEDED",
        error.message,
        "storage",
        error,
      );
    }
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_INVALID",
      "Sharingan Capture exact export failed bundle validation",
      "context",
      error,
    );
  }
  const current = exactSharinganProjectCaptureOwner(request, true);
  if (current.sourceUrl !== project.sourceUrl) {
    return fail(
      "SHARINGAN_CAPTURE_REQUEST_OWNERSHIP_INVALID",
      "Sharingan Capture owning Project changed during exact export",
      "context",
    );
  }
  return Object.freeze({
    exporter,
    source,
    files: Object.freeze(files),
  });
}
