import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify, TextDecoder } from "node:util";
import { parseFragment } from "parse5";
import * as ts from "typescript";
import type {
  ArtifactRevisionDependencyInput,
  ArtifactRevisionRecord,
  DesignNodeLocator,
  Store,
  WorkspaceSnapshotRecord,
} from "../../../packages/core/src/index.ts";
import {
  RESOURCE_REVISION_PAYLOAD_PROTOCOL,
  resourceRevisionMountKey,
  resourceRevisionPublicRoot,
  type ResourceRevisionPayloadDescriptor,
} from "./resource-revision-payload.ts";

const execFileAsync = promisify(execFile);
const SOURCE_PATH_LIMIT = 512;
const TEXT_VALUE_LIMIT = 100_000;
export const MAX_DIRECT_MUTATION_SOURCE_BYTES = 4 * 1024 * 1024;
const RESOURCE_REVISION_MARKER = "data-dezin-resource-revision";
const RESOURCE_REFERENCE_SCAN_CHUNK_BYTES = 256 * 1024;
const MAX_HTML_REFERENCE_NODES = 50_000;
const RESOURCE_USAGE_LEDGER_KEY = "dezinResourceUsageLedger";
const RESOURCE_USAGE_LEDGER_PROTOCOL = "dezin-resource-usage-ledger-v1";
const RESOURCE_USAGE_LEDGER_LIMIT = 512;
const DIRECT_SET_ASSET_STRUCTURALLY_VERIFIED_MIME = new Set([
  "image/png",
  "image/svg+xml",
]);
const GIT_IDENTITY = [
  "-c", "user.name=Dezin",
  "-c", "user.email=daemon@dezin.local",
  "-c", "commit.gpgSign=false",
] as const;
const GIT_NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type ResourceUsageAttribute = "src" | "href";

interface ResourceUsage {
  resourceId: string;
  resourceRevisionId: string;
  sourcePath: string;
  designNodeId: string;
  attribute: ResourceUsageAttribute;
}

interface ResourceUsageLedger {
  protocol: typeof RESOURCE_USAGE_LEDGER_PROTOCOL;
  sourceTreeHash: string;
  usages: ResourceUsage[];
  retainedPins: ResourcePin[];
}

interface ResourcePin {
  resourceId: string;
  resourceRevisionId: string;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export type DirectTokenProperty =
  | "color"
  | "background-color"
  | "border-color"
  | "font-family"
  | "font-size"
  | "border-radius";

export interface SupportedLayoutPatch {
  width?: number | "auto" | "fill";
  height?: number | "auto" | "fill";
  padding?: number;
  gap?: number;
  alignment?: "start" | "center" | "end" | "stretch";
  visibility?: "visible" | "hidden";
}

export type DirectArtifactMutationCommand =
  | { type: "set-text"; locator: DesignNodeLocator; expectedCurrentValue: string; value: string }
  | { type: "set-accessible-label"; locator: DesignNodeLocator; value: string }
  | { type: "set-asset"; locator: DesignNodeLocator; resourceRevisionId: string }
  | { type: "set-token"; locator: DesignNodeLocator; property: DirectTokenProperty; token: string }
  | { type: "set-layout"; locator: DesignNodeLocator; patch: SupportedLayoutPatch };

export interface ArtifactMutationRequest {
  expectedHeadRevisionId: string;
  expectedSnapshotId: string;
  command: DirectArtifactMutationCommand;
}

export interface ArtifactMutationCandidateContext {
  checkoutRoot: string;
  artifactRoot: string;
  sourcePath: string;
  absoluteSourcePath: string;
  source: string;
  command: DirectArtifactMutationCommand;
}

export interface ApplyArtifactMutationInput {
  store: Store;
  projectRoot: string;
  projectId: string;
  artifactId: string;
  expectedHeadRevisionId: string;
  expectedSnapshotId: string;
  command: DirectArtifactMutationCommand;
  signal?: AbortSignal;
  validateCandidateSource: (candidate: ArtifactMutationCandidateContext) => void | Promise<void>;
  resolveAssetSource?: (input: {
    projectId: string;
    workspaceId: string;
    resourceRevisionId: string;
    signal?: AbortSignal;
  }) => ResourceRevisionPayloadDescriptor | Promise<ResourceRevisionPayloadDescriptor>;
}

export interface ArtifactMutationResult {
  revision: ArtifactRevisionRecord;
  snapshot: WorkspaceSnapshotRecord;
}

export class ArtifactMutationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactMutationValidationError";
  }
}

export class ArtifactMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactMutationConflictError";
  }
}

export class ArtifactMutationCandidateError extends Error {
  readonly candidateRevisionId: string;
  readonly candidateRef: string;
  override readonly cause: unknown;

  constructor(candidateRevisionId: string, candidateRef: string, cause: unknown) {
    super(`Artifact mutation candidate ${candidateRevisionId} was retained after publication failed`);
    this.name = "ArtifactMutationCandidateError";
    this.candidateRevisionId = candidateRevisionId;
    this.candidateRef = candidateRef;
    this.cause = cause;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactMutationValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const supported = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !supported.has(key));
  if (unexpected) throw new ArtifactMutationValidationError(`${label} has unexpected field ${unexpected}`);
}

function boundedString(value: unknown, label: string, limit = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || !isWellFormedUtf16(value)) {
    throw new ArtifactMutationValidationError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function parseLocator(value: unknown): DesignNodeLocator {
  const locator = record(value, "mutation locator");
  rejectUnexpectedFields(locator, ["designNodeId", "sourcePath", "selector"], "mutation locator");
  const sourcePath = locator.sourcePath === undefined
    ? undefined
    : boundedString(locator.sourcePath, "mutation locator sourcePath", SOURCE_PATH_LIMIT);
  const selector = locator.selector === undefined
    ? undefined
    : boundedString(locator.selector, "mutation locator selector", 2_048);
  return {
    designNodeId: boundedString(locator.designNodeId, "mutation locator designNodeId"),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(selector === undefined ? {} : { selector }),
  };
}

export function parseArtifactMutationRequest(value: unknown): ArtifactMutationRequest {
  const request = record(value, "Artifact mutation request");
  rejectUnexpectedFields(
    request,
    ["expectedHeadRevisionId", "expectedSnapshotId", "command"],
    "Artifact mutation request",
  );
  const command = record(request.command, "direct mutation command");
  const type = boundedString(command.type, "direct mutation command type", 64);
  const locator = parseLocator(command.locator);
  let parsed: DirectArtifactMutationCommand;
  if (type === "set-text" || type === "set-accessible-label") {
    rejectUnexpectedFields(
      command,
      type === "set-text"
        ? ["type", "locator", "expectedCurrentValue", "value"]
        : ["type", "locator", "value"],
      "direct mutation command",
    );
    const text = type === "set-text"
      ? (() => {
        if (typeof command.value !== "string" || command.value.length > TEXT_VALUE_LIMIT
          || !isWellFormedUtf16(command.value)) {
          throw new ArtifactMutationValidationError("set-text value must be bounded well-formed Unicode text");
        }
        return command.value;
      })()
      : boundedString(command.value, `${type} value`, TEXT_VALUE_LIMIT);
    const expectedCurrentValue = type === "set-text"
      ? (() => {
        if (typeof command.expectedCurrentValue !== "string"
          || command.expectedCurrentValue.length > TEXT_VALUE_LIMIT
          || !isWellFormedUtf16(command.expectedCurrentValue)) {
          throw new ArtifactMutationValidationError(
            "set-text expectedCurrentValue must be bounded well-formed Unicode text",
          );
        }
        return command.expectedCurrentValue;
      })()
      : null;
    parsed = type === "set-text" && expectedCurrentValue !== null
      ? { type: "set-text", locator, expectedCurrentValue, value: text }
      : { type: "set-accessible-label", locator, value: text };
  } else if (type === "set-asset") {
    rejectUnexpectedFields(command, ["type", "locator", "resourceRevisionId"], "direct mutation command");
    parsed = {
      type,
      locator,
      resourceRevisionId: boundedString(command.resourceRevisionId, "set-asset resourceRevisionId"),
    };
  } else if (type === "set-token") {
    rejectUnexpectedFields(command, ["type", "locator", "property", "token"], "direct mutation command");
    const properties = new Set<DirectTokenProperty>([
      "color", "background-color", "border-color", "font-family", "font-size", "border-radius",
    ]);
    if (typeof command.property !== "string" || !properties.has(command.property as DirectTokenProperty)) {
      throw new ArtifactMutationValidationError("set-token property is unsupported");
    }
    const token = boundedString(command.token, "set-token token", 128);
    tokenCssValue(token);
    parsed = { type, locator, property: command.property as DirectTokenProperty, token };
  } else if (type === "set-layout") {
    rejectUnexpectedFields(command, ["type", "locator", "patch"], "direct mutation command");
    const patch = record(command.patch, "set-layout patch") as SupportedLayoutPatch;
    layoutStyleUpdates(patch);
    parsed = { type, locator, patch: { ...patch } };
  } else {
    throw new ArtifactMutationValidationError(`unsupported direct mutation command ${type}`);
  }
  return {
    expectedHeadRevisionId: boundedString(request.expectedHeadRevisionId, "expectedHeadRevisionId"),
    expectedSnapshotId: boundedString(request.expectedSnapshotId, "expectedSnapshotId"),
    command: parsed,
  };
}

async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout.trim();
}

async function gitRaw(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout;
}

async function stageExactSourceBytes(
  cwd: string,
  repositorySourcePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const entry = await gitRaw(cwd, ["ls-files", "--stage", "-z", "--", repositorySourcePath], signal);
  const match = /^(100644|100755) [0-9a-f]{40,64} 0\t([^\0]*)\0$/.exec(entry);
  if (!match || match[2] !== repositorySourcePath) {
    throw new ArtifactMutationValidationError("direct mutation source must be one regular tracked file");
  }
  const blob = await git(cwd, ["hash-object", "-w", "--no-filters", "--", repositorySourcePath], signal);
  if (!/^[0-9a-f]{40,64}$/.test(blob)) {
    throw new ArtifactMutationValidationError("direct mutation source blob could not be written exactly");
  }
  await git(cwd, ["update-index", "--cacheinfo", `${match[1]},${blob},${repositorySourcePath}`], signal);
}

function safeRefSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, child: string): boolean {
  const offset = relative(root, child);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function canonicalSourcePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > SOURCE_PATH_LIMIT || value.includes("\0")) {
    throw new ArtifactMutationValidationError("locator sourcePath must be a bounded non-empty relative path");
  }
  if (isAbsolute(value) || value.includes("\\")) {
    throw new ArtifactMutationValidationError("locator sourcePath must be relative to the Artifact source root");
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ArtifactMutationValidationError("locator sourcePath escapes the Artifact source root");
  }
  return normalized;
}

function resourceUsagePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactMutationValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArtifactMutationValidationError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function resourceUsageString(value: unknown, label: string, limit = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit
    || value.includes("\0") || !isWellFormedUtf16(value)) {
    throw new ArtifactMutationValidationError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function compareResourceUsage(left: ResourceUsage, right: ResourceUsage): number {
  for (const field of [
    "sourcePath",
    "designNodeId",
    "attribute",
    "resourceId",
    "resourceRevisionId",
  ] as const) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

function sortedResourceUsages(usages: readonly ResourceUsage[]): ResourceUsage[] {
  return usages.map((usage) => ({ ...usage })).sort(compareResourceUsage);
}

function compareResourcePin(left: ResourcePin, right: ResourcePin): number {
  if (left.resourceId < right.resourceId) return -1;
  if (left.resourceId > right.resourceId) return 1;
  if (left.resourceRevisionId < right.resourceRevisionId) return -1;
  if (left.resourceRevisionId > right.resourceRevisionId) return 1;
  return 0;
}

function sortedResourcePins(pins: readonly ResourcePin[]): ResourcePin[] {
  return pins.map((pin) => ({ ...pin })).sort(compareResourcePin);
}

function assertResourceUsagePins(
  usages: readonly ResourceUsage[],
  resourcePins: readonly ResourcePin[],
  retainedPins: readonly ResourcePin[] = [],
): void {
  const pinsByResource = new Map<string, string>();
  for (const pin of resourcePins) {
    if (pinsByResource.has(pin.resourceId)) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger cannot be validated against duplicate Resource pins",
      );
    }
    pinsByResource.set(pin.resourceId, pin.resourceRevisionId);
  }
  const accountedResources = new Set<string>();
  for (const usage of usages) {
    if (pinsByResource.get(usage.resourceId) !== usage.resourceRevisionId) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger contains a usage not backed by the Artifact Revision Resource pins",
      );
    }
    accountedResources.add(usage.resourceId);
  }
  for (const retainedPin of retainedPins) {
    if (pinsByResource.get(retainedPin.resourceId) !== retainedPin.resourceRevisionId) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger contains a retained pin not backed by the Artifact Revision Resource pins",
      );
    }
    if (accountedResources.has(retainedPin.resourceId)) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger retained pins must not duplicate Resources with declared usages",
      );
    }
    accountedResources.add(retainedPin.resourceId);
  }
  for (const pin of resourcePins) {
    if (!accountedResources.has(pin.resourceId)) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger is incomplete because it omits an Artifact Revision Resource pin",
      );
    }
  }
}

function parseResourceUsageLedger(
  renderSpec: Readonly<Record<string, unknown>>,
  expectedSourceTreeHash: string,
  resourcePins: readonly ResourcePin[],
): ResourceUsageLedger | null {
  if (!Object.hasOwn(renderSpec, RESOURCE_USAGE_LEDGER_KEY)) return null;
  const ledger = resourceUsagePlainRecord(
    renderSpec[RESOURCE_USAGE_LEDGER_KEY],
    "Resource usage ledger",
  );
  rejectUnexpectedFields(
    ledger,
    ["protocol", "sourceTreeHash", "usages", "retainedPins"],
    "Resource usage ledger",
  );
  if (ledger.protocol !== RESOURCE_USAGE_LEDGER_PROTOCOL) {
    throw new ArtifactMutationValidationError("Resource usage ledger protocol is unsupported");
  }
  if (typeof ledger.sourceTreeHash !== "string" || !/^[0-9a-f]{40,64}$/.test(ledger.sourceTreeHash)) {
    throw new ArtifactMutationValidationError("Resource usage ledger sourceTreeHash is invalid");
  }
  if (ledger.sourceTreeHash !== expectedSourceTreeHash) {
    throw new ArtifactMutationValidationError(
      "Resource usage ledger is stale for the parent Artifact Revision source tree",
    );
  }
  if (!Array.isArray(ledger.usages) || ledger.usages.length > RESOURCE_USAGE_LEDGER_LIMIT) {
    throw new ArtifactMutationValidationError(
      `Resource usage ledger usages must be an array with at most ${RESOURCE_USAGE_LEDGER_LIMIT} entries`,
    );
  }
  const usages = ledger.usages.map((rawUsage, index): ResourceUsage => {
    const label = `Resource usage ledger usage ${index}`;
    const usage = resourceUsagePlainRecord(rawUsage, label);
    rejectUnexpectedFields(
      usage,
      ["resourceId", "resourceRevisionId", "sourcePath", "designNodeId", "attribute"],
      label,
    );
    const sourcePath = resourceUsageString(usage.sourcePath, `${label} sourcePath`, SOURCE_PATH_LIMIT);
    let normalizedSourcePath: string;
    try {
      normalizedSourcePath = canonicalSourcePath(sourcePath);
    } catch {
      throw new ArtifactMutationValidationError(`${label} sourcePath must be canonical`);
    }
    if (normalizedSourcePath !== sourcePath) {
      throw new ArtifactMutationValidationError(`${label} sourcePath must be canonical`);
    }
    if (usage.attribute !== "src" && usage.attribute !== "href") {
      throw new ArtifactMutationValidationError(`${label} attribute must be src or href`);
    }
    return {
      resourceId: resourceUsageString(usage.resourceId, `${label} resourceId`),
      resourceRevisionId: resourceUsageString(
        usage.resourceRevisionId,
        `${label} resourceRevisionId`,
      ),
      sourcePath,
      designNodeId: resourceUsageString(usage.designNodeId, `${label} designNodeId`),
      attribute: usage.attribute,
    };
  });
  const locatorKeys = new Set<string>();
  for (let index = 0; index < usages.length; index += 1) {
    const usage = usages[index]!;
    if (index > 0 && compareResourceUsage(usages[index - 1]!, usage) >= 0) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger usages must be unique and deterministically sorted",
      );
    }
    const locatorKey = JSON.stringify([usage.sourcePath, usage.designNodeId, usage.attribute]);
    if (locatorKeys.has(locatorKey)) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger cannot assign one locator attribute to multiple Resource usages",
      );
    }
    locatorKeys.add(locatorKey);
  }
  const rawRetainedPins = ledger.retainedPins === undefined ? [] : ledger.retainedPins;
  if (!Array.isArray(rawRetainedPins)
    || usages.length + rawRetainedPins.length > RESOURCE_USAGE_LEDGER_LIMIT) {
    throw new ArtifactMutationValidationError(
      `Resource usage ledger retained pins must keep the ledger within ${RESOURCE_USAGE_LEDGER_LIMIT} entries`,
    );
  }
  const retainedPins = rawRetainedPins.map((rawPin, index): ResourcePin => {
    const label = `Resource usage ledger retained pin ${index}`;
    const pin = resourceUsagePlainRecord(rawPin, label);
    rejectUnexpectedFields(pin, ["resourceId", "resourceRevisionId"], label);
    return {
      resourceId: resourceUsageString(pin.resourceId, `${label} resourceId`),
      resourceRevisionId: resourceUsageString(pin.resourceRevisionId, `${label} resourceRevisionId`),
    };
  });
  for (let index = 0; index < retainedPins.length; index += 1) {
    if (index > 0 && compareResourcePin(retainedPins[index - 1]!, retainedPins[index]!) >= 0) {
      throw new ArtifactMutationValidationError(
        "Resource usage ledger retained pins must be unique and deterministically sorted",
      );
    }
  }
  assertResourceUsagePins(usages, resourcePins, retainedPins);
  return {
    protocol: RESOURCE_USAGE_LEDGER_PROTOCOL,
    sourceTreeHash: ledger.sourceTreeHash,
    usages,
    retainedPins,
  };
}

function renderSpecWithResourceUsageLedger(
  renderSpec: Readonly<Record<string, unknown>>,
  sourceTreeHash: string,
  usages: readonly ResourceUsage[],
  retainedPins: readonly ResourcePin[],
): Record<string, unknown> {
  const sortedRetainedPins = sortedResourcePins(retainedPins);
  return {
    ...renderSpec,
    [RESOURCE_USAGE_LEDGER_KEY]: {
      protocol: RESOURCE_USAGE_LEDGER_PROTOCOL,
      sourceTreeHash,
      usages: sortedResourceUsages(usages),
      ...(sortedRetainedPins.length === 0 ? {} : { retainedPins: sortedRetainedPins }),
    },
  };
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

interface LocatedStartTag {
  tagName: string;
  svgContext: boolean;
  start: number;
  end: number;
  source: string;
  selfClosing: boolean;
  contentEnd: number | null;
  markerValues: string[];
  attributes: SourceAttribute[];
  jsxTextOnly?: boolean;
}

interface SourceAttribute {
  name: string;
  start: number;
  end: number;
  valueStart: number | null;
  valueEnd: number | null;
  kind: "boolean" | "quoted" | "unquoted" | "expression" | "spread";
}

interface LocatedElement {
  tagName: string;
  start: number;
  startTagEnd: number;
  contentStart: number;
  contentEnd: number;
  jsxTextOnly?: boolean;
}

interface ParsedSourceTag extends LocatedStartTag {
  closing: boolean;
}

const HTML_VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

function skipQuotedSource(source: string, start: number): number {
  const quote = source[start]!;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return index + 1;
  }
  throw new ArtifactMutationValidationError("stable design locator has an unterminated source string");
}

function parseSourceTag(source: string, start: number): ParsedSourceTag | null {
  if (source[start] !== "<") return null;
  let cursor = start + 1;
  const closing = source[cursor] === "/";
  if (closing) cursor += 1;
  const nameStart = cursor;
  if (!/[A-Za-z]/.test(source[cursor] ?? "")) return null;
  cursor += 1;
  while (/[\w:.-]/.test(source[cursor] ?? "")) cursor += 1;
  const tagName = source.slice(nameStart, cursor);
  if (closing) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ">") return null;
    return {
      tagName,
      svgContext: false,
      start,
      end: cursor + 1,
      source: source.slice(start, cursor + 1),
      selfClosing: false,
      contentEnd: null,
      markerValues: [],
      attributes: [],
      closing: true,
    };
  }

  const markerValues: string[] = [];
  const attributes: SourceAttribute[] = [];
  let selfClosing = false;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === ">") {
      cursor += 1;
      break;
    }
    if (source[cursor] === "/" && source[cursor + 1] === ">") {
      selfClosing = true;
      cursor += 2;
      break;
    }
    if (!/[A-Za-z_:]/.test(source[cursor] ?? "")) return null;
    const attributeStart = cursor;
    cursor += 1;
    while (/[\w:.-]/.test(source[cursor] ?? "")) cursor += 1;
    const attributeName = source.slice(attributeStart, cursor).toLowerCase();
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    let literalValue: string | null = null;
    let valueStart: number | null = null;
    let valueEnd: number | null = null;
    let kind: SourceAttribute["kind"] = "boolean";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        valueStart = cursor + 1;
        cursor = skipQuotedSource(source, cursor);
        valueEnd = cursor - 1;
        kind = "quoted";
        literalValue = source.slice(valueStart, cursor - 1);
      } else {
        valueStart = cursor;
        while (cursor < source.length && !/[\s>]/.test(source[cursor]!)
          && !(source[cursor] === "/" && source[cursor + 1] === ">")) cursor += 1;
        if (cursor === valueStart) return null;
        valueEnd = cursor;
        kind = "unquoted";
        literalValue = source.slice(valueStart, cursor);
      }
    }
    attributes.push({ name: attributeName, start: attributeStart, end: cursor, valueStart, valueEnd, kind });
    if (["data-dezin-id", "data-design-node-id", "data-dezin-node-id"].includes(attributeName)
      && literalValue !== null) markerValues.push(literalValue);
  }
  if (cursor > source.length || source[cursor - 1] !== ">") return null;
  return {
    tagName,
    svgContext: false,
    start,
    end: cursor,
    source: source.slice(start, cursor),
    selfClosing,
    contentEnd: null,
    markerValues,
    attributes,
    closing: false,
  };
}

function scanHtmlTags(source: string): ParsedSourceTag[] {
  const tags: ParsedSourceTag[] = [];
  const stack: ParsedSourceTag[] = [];
  for (let index = 0; index < source.length;) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) throw new ArtifactMutationValidationError("stable design locator has an unterminated HTML comment");
      index = end + 3;
      continue;
    }
    if (source[index] !== "<") {
      index += 1;
      continue;
    }
    const tag = parseSourceTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    index = tag.end;
    if (tag.closing) {
      const match = [...stack].reverse().find((candidate) => candidate.tagName.toLowerCase() === tag.tagName.toLowerCase());
      if (match) {
        match.contentEnd = tag.start;
        stack.splice(stack.indexOf(match));
      }
      continue;
    }
    tags.push(tag);
    const lower = tag.tagName.toLowerCase();
    const parent = stack.at(-1);
    tag.svgContext = lower === "svg"
      || Boolean(parent?.svgContext && parent.tagName.toLowerCase() !== "foreignobject");
    if (tag.selfClosing || HTML_VOID_TAGS.has(lower)) continue;
    stack.push(tag);
    if (lower === "script" || lower === "style") {
      const closingStart = source.toLowerCase().indexOf(`</${lower}`, index);
      if (closingStart < 0) continue;
      const closingTag = parseSourceTag(source, closingStart);
      if (closingTag?.closing) {
        tag.contentEnd = closingStart;
        stack.pop();
        index = closingTag.end;
      }
    }
  }
  return tags;
}

function parsedJsxAttributes(
  opening: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
): { attributes: SourceAttribute[]; markerValues: string[] } {
  const attributes: SourceAttribute[] = [];
  const markerValues: string[] = [];
  for (const property of opening.attributes.properties) {
    if (!ts.isJsxAttribute(property)) {
      attributes.push({
        name: "...",
        start: property.getStart(sourceFile),
        end: property.end,
        valueStart: property.getStart(sourceFile),
        valueEnd: property.end,
        kind: "spread",
      });
      continue;
    }
    const name = property.name.getText(sourceFile).toLowerCase();
    const initializer = property.initializer;
    let kind: SourceAttribute["kind"] = "boolean";
    let valueStart: number | null = null;
    let valueEnd: number | null = null;
    let literalValue: string | null = null;
    if (initializer && ts.isStringLiteral(initializer)) {
      kind = "quoted";
      valueStart = initializer.getStart(sourceFile) + 1;
      valueEnd = initializer.end - 1;
      literalValue = sourceFile.text.slice(valueStart, valueEnd);
    } else if (initializer && ts.isJsxExpression(initializer)) {
      kind = "expression";
      valueStart = initializer.getStart(sourceFile);
      valueEnd = initializer.end;
    }
    attributes.push({
      name,
      start: property.getStart(sourceFile),
      end: property.end,
      valueStart,
      valueEnd,
      kind,
    });
    if (["data-dezin-id", "data-design-node-id", "data-dezin-node-id"].includes(name)
      && literalValue !== null) markerValues.push(literalValue);
  }
  return { attributes, markerValues };
}

function isWithinJsxSvg(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isJsxElement(parent)) continue;
    const tagName = parent.openingElement.tagName.getText(sourceFile);
    if (tagName === "svg") return true;
    if (tagName === "foreignObject") return false;
  }
  return false;
}

function scanJsxAst(source: string, sourcePath: string): ParsedSourceTag[] {
  const extension = extname(sourcePath).toLowerCase();
  const scriptKind = extension === ".tsx"
    ? ts.ScriptKind.TSX
    : extension === ".ts"
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ");
    throw new ArtifactMutationValidationError(`stable design locator requires parseable JSX/TSX source: ${detail}`);
  }
  const tags: ParsedSourceTag[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const parsed = parsedJsxAttributes(opening, sourceFile);
      tags.push({
        tagName: opening.tagName.getText(sourceFile),
        svgContext: isWithinJsxSvg(node, sourceFile),
        start: opening.getStart(sourceFile),
        end: opening.end,
        source: source.slice(opening.getStart(sourceFile), opening.end),
        selfClosing: false,
        contentEnd: node.closingElement.getStart(sourceFile),
        markerValues: parsed.markerValues,
        attributes: parsed.attributes,
        jsxTextOnly: node.children.every((child) => ts.isJsxText(child)),
        closing: false,
      });
    } else if (ts.isJsxSelfClosingElement(node)) {
      const parsed = parsedJsxAttributes(node, sourceFile);
      tags.push({
        tagName: node.tagName.getText(sourceFile),
        svgContext: isWithinJsxSvg(node, sourceFile),
        start: node.getStart(sourceFile),
        end: node.end,
        source: source.slice(node.getStart(sourceFile), node.end),
        selfClosing: true,
        contentEnd: null,
        markerValues: parsed.markerValues,
        attributes: parsed.attributes,
        closing: false,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return tags;
}

function sourceTags(source: string, sourcePath: string): ParsedSourceTag[] {
  const extension = extname(sourcePath).toLowerCase();
  if (![".jsx", ".tsx", ".js", ".ts"].includes(extension)) return scanHtmlTags(source);
  return scanJsxAst(source, sourcePath);
}

/**
 * Lists only statically-authored design markers from a bounded immutable source
 * blob. Dynamic JSX expressions are deliberately excluded because they cannot
 * prove one stable design-node identity without executing mutable application
 * code.
 */
export function listStaticDesignNodeLocators(
  source: string,
  sourcePathInput: string,
): DesignNodeLocator[] {
  if (Buffer.byteLength(source, "utf8") === 0
    || Buffer.byteLength(source, "utf8") > MAX_DIRECT_MUTATION_SOURCE_BYTES
    || source.includes("\0")) {
    throw new ArtifactMutationValidationError(
      "design-node selection source must be bounded non-empty UTF-8 text without NUL bytes",
    );
  }
  const sourcePath = boundedString(sourcePathInput, "design-node selection sourcePath", SOURCE_PATH_LIMIT);
  return sourceTags(source, sourcePath).flatMap((tag) => tag.markerValues.map((designNodeId) => ({
    designNodeId: boundedString(designNodeId, "design-node selection marker"),
    sourcePath,
  })));
}

function locateStartTag(source: string, sourcePath: string, locator: DesignNodeLocator): LocatedStartTag {
  if (typeof locator.designNodeId !== "string" || locator.designNodeId.length === 0 || locator.designNodeId.length > 256) {
    throw new ArtifactMutationValidationError("locator designNodeId must be a bounded non-empty string");
  }
  const matches = sourceTags(source, sourcePath).flatMap((tag) => (
    tag.markerValues.filter((value) => value === locator.designNodeId).map(() => tag)
  ));
  if (matches.length !== 1) {
    throw new ArtifactMutationValidationError(
      `stable design locator ${locator.designNodeId} must resolve to exactly one source element`,
    );
  }
  return matches[0]!;
}

function locateSimpleElement(source: string, sourcePath: string, locator: DesignNodeLocator): LocatedElement {
  const startTag = locateStartTag(source, sourcePath, locator);
  if (startTag.selfClosing) {
    throw new ArtifactMutationValidationError("stable design locator must target a non-void source element");
  }
  if (startTag.contentEnd === null) throw new ArtifactMutationValidationError("stable design locator target has no paired closing tag");
  return {
    tagName: startTag.tagName,
    start: startTag.start,
    startTagEnd: startTag.end - 1,
    contentStart: startTag.end,
    contentEnd: startTag.contentEnd,
    jsxTextOnly: startTag.jsxTextOnly,
  };
}

function applyTextMutation(
  source: string,
  sourcePath: string,
  locator: DesignNodeLocator,
  expectedCurrentValue: string,
  value: string,
): string {
  if (typeof value !== "string" || value.length > TEXT_VALUE_LIMIT || !isWellFormedUtf16(value)) {
    throw new ArtifactMutationValidationError("set-text value must be bounded well-formed Unicode text");
  }
  if (typeof expectedCurrentValue !== "string" || expectedCurrentValue.length > TEXT_VALUE_LIMIT
    || !isWellFormedUtf16(expectedCurrentValue)) {
    throw new ArtifactMutationValidationError(
      "set-text expectedCurrentValue must be bounded well-formed Unicode text",
    );
  }
  const element = locateSimpleElement(source, sourcePath, locator);
  const tag = element.tagName.toLowerCase();
  const textTargets = new Set([
    "a", "abbr", "address", "b", "bdi", "bdo", "blockquote", "button", "caption", "cite", "code",
    "dd", "del", "details", "dfn", "div", "dt", "em", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6",
    "ins", "kbd", "label", "legend", "li", "mark", "option", "p", "pre", "q", "s", "samp", "small", "span",
    "strong", "sub", "summary", "sup", "td", "textarea", "th", "time", "u", "var",
  ]);
  const jsxComponent = [".jsx", ".tsx", ".js", ".ts"].includes(extname(sourcePath).toLowerCase())
    && /^[A-Z]/.test(element.tagName);
  if (!textTargets.has(tag) && !jsxComponent) {
    throw new ArtifactMutationValidationError(`set-text target tag ${tag} is unsupported`);
  }
  const current = source.slice(element.contentStart, element.contentEnd);
  if (current.includes("<")) {
    throw new ArtifactMutationValidationError("set-text only supports leaf source elements and will not remove child structure");
  }
  const extension = extname(sourcePath).toLowerCase();
  if ([".jsx", ".tsx", ".js", ".ts"].includes(extension) && element.jsxTextOnly !== true) {
    throw new ArtifactMutationValidationError("set-text only supports pure static JSX text");
  }
  const expectedEscaped = escapeText(expectedCurrentValue);
  const expectedSourceText = [".jsx", ".tsx", ".js", ".ts"].includes(extension)
    ? expectedEscaped.replaceAll("{", "&#123;").replaceAll("}", "&#125;")
    : expectedEscaped;
  if (current !== expectedCurrentValue && current !== expectedSourceText) {
    throw new ArtifactMutationConflictError("Selected text changed before direct mutation");
  }
  const escaped = escapeText(value);
  const safeText = [".jsx", ".tsx", ".js", ".ts"].includes(extension)
    ? escaped.replaceAll("{", "&#123;").replaceAll("}", "&#125;")
    : escaped;
  return source.slice(0, element.contentStart) + safeText + source.slice(element.contentEnd);
}

const ACCESSIBLE_ATTRIBUTE_TAGS = new Set([
  "a", "area", "article", "aside", "audio", "button", "canvas", "details", "dialog", "div", "fieldset",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "img", "input", "label",
  "legend", "li", "main", "nav", "ol", "option", "p", "progress", "section", "select", "span", "summary",
  "svg", "table", "td", "textarea", "th", "ul", "video",
]);
const STYLE_TARGET_TAGS = new Set([
  ...ACCESSIBLE_ATTRIBUTE_TAGS,
  "abbr", "address", "b", "blockquote", "caption", "circle", "cite", "code", "dd", "del", "dfn", "dl",
  "dt", "ellipse", "em", "figcaption", "g", "hr", "image", "ins", "kbd", "line", "mark", "path",
  "picture", "polygon", "polyline", "pre", "q", "rect", "s", "samp", "small", "source", "strong", "sub",
  "sup", "tbody", "tfoot", "thead", "time", "tr", "track", "tspan", "u", "use", "var",
]);

function assertSafeAttributeTarget(source: string, sourcePath: string, locator: DesignNodeLocator, command: string): void {
  const target = locateStartTag(source, sourcePath, locator);
  const tag = target.tagName.toLowerCase();
  const jsxComponent = [".jsx", ".tsx", ".js", ".ts"].includes(extname(sourcePath).toLowerCase())
    && /^[A-Z]/.test(target.tagName);
  const supported = command === "set-accessible-label" ? ACCESSIBLE_ATTRIBUTE_TAGS : STYLE_TARGET_TAGS;
  if (!jsxComponent && !supported.has(tag)) {
    throw new ArtifactMutationValidationError(`${command} target tag ${tag} is unsupported`);
  }
}

interface OwnedAssetRevision {
  resource_id: string;
  kind: "asset" | "file";
  metadata_json: string;
  manifest_path: string;
  checksum: string;
}

interface ResolvedAssetSource {
  source: string;
  mimeType: string;
  descriptor: ResourceRevisionPayloadDescriptor;
}

const RESOURCE_PAYLOAD_DESCRIPTOR_FIELDS = [
  "protocol",
  "workspaceId",
  "resourceId",
  "resourceRevisionId",
  "resourceKind",
  "manifestPath",
  "manifestChecksum",
  "payloadPath",
  "payloadChecksum",
  "byteLength",
  "mimeType",
  "mountPath",
  "publicUrl",
] as const;

function validateAssetDescriptor(
  value: unknown,
  expected: {
    workspaceId: string;
    resourceRevisionId: string;
    owned: OwnedAssetRevision;
    mimeType: string;
  },
): ResourceRevisionPayloadDescriptor {
  const descriptor = record(value, "immutable asset descriptor");
  rejectUnexpectedFields(descriptor, RESOURCE_PAYLOAD_DESCRIPTOR_FIELDS, "immutable asset descriptor");
  for (const field of RESOURCE_PAYLOAD_DESCRIPTOR_FIELDS) {
    if (!Object.hasOwn(descriptor, field)) {
      throw new ArtifactMutationValidationError(`immutable asset descriptor is missing field ${field}`);
    }
  }
  const stringField = (field: Exclude<(typeof RESOURCE_PAYLOAD_DESCRIPTOR_FIELDS)[number], "byteLength">): string => {
    const candidate = descriptor[field];
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4_096
      || !isWellFormedUtf16(candidate) || candidate.includes("\0") || /[\r\n]/.test(candidate)) {
      throw new ArtifactMutationValidationError(`immutable asset descriptor field ${field} is invalid`);
    }
    return candidate;
  };
  const parsed = {
    protocol: stringField("protocol"),
    workspaceId: stringField("workspaceId"),
    resourceId: stringField("resourceId"),
    resourceRevisionId: stringField("resourceRevisionId"),
    resourceKind: stringField("resourceKind"),
    manifestPath: stringField("manifestPath"),
    manifestChecksum: stringField("manifestChecksum"),
    payloadPath: stringField("payloadPath"),
    payloadChecksum: stringField("payloadChecksum"),
    byteLength: descriptor.byteLength,
    mimeType: stringField("mimeType"),
    mountPath: stringField("mountPath"),
    publicUrl: stringField("publicUrl"),
  };
  if (parsed.protocol !== RESOURCE_REVISION_PAYLOAD_PROTOCOL
    || parsed.workspaceId !== expected.workspaceId
    || parsed.resourceId !== expected.owned.resource_id
    || parsed.resourceRevisionId !== expected.resourceRevisionId
    || parsed.resourceKind !== expected.owned.kind
    || parsed.manifestPath !== expected.owned.manifest_path
    || parsed.manifestChecksum !== expected.owned.checksum
    || parsed.mimeType !== expected.mimeType) {
    throw new ArtifactMutationValidationError(
      "immutable asset descriptor does not match the exact owned Resource Revision",
    );
  }
  if (!Number.isSafeInteger(parsed.byteLength) || (parsed.byteLength as number) < 0
    || (parsed.byteLength as number) > 64 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(parsed.payloadChecksum)) {
    throw new ArtifactMutationValidationError("immutable asset descriptor content identity is invalid");
  }
  const expectedPayloadPath = posix.join(posix.dirname(parsed.manifestPath), "payload.bin");
  if (parsed.payloadPath !== expectedPayloadPath
    || parsed.mountPath.startsWith("/")
    || parsed.mountPath.includes("\\")
    || posix.normalize(parsed.mountPath) !== parsed.mountPath
    || parsed.mountPath.split("/").includes("..")
    || parsed.publicUrl !== `/${parsed.mountPath}`
    || /^\s*(?:javascript|vbscript):/i.test(parsed.publicUrl)) {
    throw new ArtifactMutationValidationError("immutable asset descriptor returned an unsafe or invalid source");
  }
  return parsed as ResourceRevisionPayloadDescriptor;
}

function sameAssetDescriptor(
  left: ResourceRevisionPayloadDescriptor,
  right: ResourceRevisionPayloadDescriptor,
): boolean {
  return RESOURCE_PAYLOAD_DESCRIPTOR_FIELDS.every((field) => left[field] === right[field]);
}

function assetTargetAttribute(
  source: string,
  sourcePath: string,
  locator: DesignNodeLocator,
  mimeType: string,
): "src" | "href" {
  const target = locateStartTag(source, sourcePath, locator);
  const tag = target.tagName.toLowerCase();
  const jsxComponent = [".jsx", ".tsx", ".js", ".ts"].includes(extname(sourcePath).toLowerCase())
    && /^[A-Z]/.test(target.tagName);
  if (jsxComponent) {
    throw new ArtifactMutationValidationError(`set-asset target component ${target.tagName} has unknown media semantics`);
  }
  if (tag === "source") {
    throw new ArtifactMutationValidationError("set-asset target tag source requires parent context and is unsupported");
  }
  if (mimeType.startsWith("image/") && tag === "img" && !target.svgContext) {
    if (directAttribute(target, "srcset") || directAttribute(target, "sizes")) {
      throw new ArtifactMutationValidationError(
        "set-asset cannot safely mutate a responsive img with srcset or sizes",
      );
    }
    const pictureAncestor = sourceTags(source, sourcePath).some((candidate) => (
      candidate.tagName.toLowerCase() === "picture"
      && candidate.start < target.start
      && candidate.contentEnd !== null
      && target.end <= candidate.contentEnd
    ));
    if (pictureAncestor) {
      throw new ArtifactMutationValidationError(
        "set-asset cannot safely mutate an img whose source is controlled by a picture ancestor",
      );
    }
    return "src";
  }
  if (mimeType.startsWith("image/") && target.tagName === "image" && target.svgContext) return "href";
  if (mimeType.startsWith("audio/") && tag === "audio" && !target.svgContext) return "src";
  if (mimeType.startsWith("video/") && tag === "video" && !target.svgContext) return "src";
  throw new ArtifactMutationValidationError(`set-asset target tag ${tag} is incompatible with ${mimeType}`);
}

function directAttribute(target: LocatedStartTag, name: string): SourceAttribute | null {
  if (target.attributes.some((attribute) => attribute.kind === "spread")) {
    throw new ArtifactMutationValidationError("target JSX attributes must not contain spread props for bounded mutation");
  }
  const matches = target.attributes.filter((attribute) => attribute.name === name.toLowerCase());
  if (matches.length > 1) {
    throw new ArtifactMutationValidationError(`${name} must occur at most once on the target element`);
  }
  return matches[0] ?? null;
}

function replaceOrInsertAttribute(
  source: string,
  target: LocatedStartTag,
  attribute: SourceAttribute | null,
  serialized: string,
): string {
  if (attribute) return source.slice(0, attribute.start) + serialized + source.slice(attribute.end);
  const insertion = target.selfClosing ? target.end - 2 : target.end - 1;
  return source.slice(0, insertion) + ` ${serialized}` + source.slice(insertion);
}

function sourceAttributeValue(source: string, attribute: SourceAttribute): string {
  if (attribute.valueStart === null || attribute.valueEnd === null) {
    throw new ArtifactMutationValidationError(`${attribute.name} must have a direct value`);
  }
  return source.slice(attribute.valueStart, attribute.valueEnd);
}

function directStringAttributeValue(
  source: string,
  sourcePath: string,
  locator: DesignNodeLocator,
  name: string,
): string | null {
  const attribute = directAttribute(locateStartTag(source, sourcePath, locator), name);
  if (attribute === null) return null;
  if (attribute.kind !== "quoted") {
    throw new ArtifactMutationValidationError(`${name} must be a direct string literal for bounded mutation`);
  }
  return sourceAttributeValue(source, attribute);
}

function setStringAttribute(
  source: string,
  sourcePath: string,
  locator: DesignNodeLocator,
  name: string,
  value: string,
): string {
  if (!isWellFormedUtf16(value) || value.length === 0 || value.length > 4_096) {
    throw new ArtifactMutationValidationError(`${name} must be bounded non-empty well-formed Unicode text`);
  }
  const target = locateStartTag(source, sourcePath, locator);
  const attribute = directAttribute(target, name);
  if (attribute && attribute.kind !== "quoted") {
    throw new ArtifactMutationValidationError(`${name} must be a direct string literal for bounded mutation`);
  }
  return replaceOrInsertAttribute(source, target, attribute, `${name}="${escapeAttribute(value)}"`);
}

function parseInlineStyle(value: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const declaration of value.split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    if (colon <= 0) throw new ArtifactMutationValidationError("target has an unsupported inline style declaration");
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const propertyValue = declaration.slice(colon + 1).trim();
    if (!/^-?[a-z][a-z0-9-]*$/.test(property) || propertyValue.length === 0) {
      throw new ArtifactMutationValidationError("target has an unsupported inline style declaration");
    }
    properties.set(property, propertyValue);
  }
  return properties;
}

function setHtmlStyleProperties(
  source: string,
  sourcePath: string,
  locator: DesignNodeLocator,
  updates: Readonly<Record<string, string>>,
): string {
  const target = locateStartTag(source, sourcePath, locator);
  const styleAttribute = directAttribute(target, "style");
  if (styleAttribute && styleAttribute.kind !== "quoted") {
    throw new ArtifactMutationValidationError("target HTML style must be a direct string literal for bounded mutation");
  }
  const styles = parseInlineStyle(styleAttribute ? sourceAttributeValue(source, styleAttribute) : "");
  for (const [property, value] of Object.entries(updates)) styles.set(property, value);
  const serializedValue = [...styles].map(([property, value]) => `${property}: ${value}`).join("; ");
  return replaceOrInsertAttribute(
    source,
    target,
    styleAttribute,
    `style="${escapeAttribute(serializedValue)}"`,
  );
}

function splitJsxStyleEntries(value: string): string[] {
  const entries: string[] = [];
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quote) {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ",") {
      entries.push(value.slice(start, index));
      start = index + 1;
    } else if (character === "{" || character === "}" || character === "[") {
      throw new ArtifactMutationValidationError("target has an unsupported nested JSX style expression");
    }
  }
  if (quote || escaped) throw new ArtifactMutationValidationError("target has an unterminated JSX style value");
  entries.push(value.slice(start));
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function jsxStyleKey(property: string): string {
  return property.replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
}

function setJsxStyleProperties(
  source: string,
  sourcePath: string,
  locator: DesignNodeLocator,
  updates: Readonly<Record<string, string>>,
): string {
  const target = locateStartTag(source, sourcePath, locator);
  const styleAttribute = directAttribute(target, "style");
  if (styleAttribute && styleAttribute.kind !== "expression") {
    throw new ArtifactMutationValidationError("target JSX style must be a direct object literal for bounded mutation");
  }
  const styleExpression = styleAttribute ? sourceAttributeValue(source, styleAttribute) : "";
  const styleObject = styleAttribute ? /^\{\{([\s\S]*)\}\}$/.exec(styleExpression) : null;
  if (styleAttribute && !styleObject) {
    throw new ArtifactMutationValidationError("target JSX style must be a direct object literal for bounded mutation");
  }
  const styles = new Map<string, string>();
  for (const entry of splitJsxStyleEntries(styleObject?.[1] ?? "")) {
    const match = /^([A-Za-z_$][\w$]*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?)$/.exec(entry);
    if (!match) throw new ArtifactMutationValidationError("target has an unsupported JSX style entry");
    styles.set(match[1]!, match[2]!);
  }
  for (const [property, value] of Object.entries(updates)) styles.set(jsxStyleKey(property), JSON.stringify(value));
  return replaceOrInsertAttribute(
    source,
    target,
    styleAttribute,
    `style={{ ${[...styles].map(([property, value]) => `${property}: ${value}`).join(", ")} }}`,
  );
}

function setStyleProperties(
  source: string,
  locator: DesignNodeLocator,
  sourcePath: string,
  updates: Readonly<Record<string, string>>,
): string {
  const extension = extname(sourcePath).toLowerCase();
  if ([".jsx", ".tsx", ".js", ".ts"].includes(extension)) {
    return setJsxStyleProperties(source, sourcePath, locator, updates);
  }
  if ([".html", ".htm", ".vue", ".svelte"].includes(extension)) {
    return setHtmlStyleProperties(source, sourcePath, locator, updates);
  }
  throw new ArtifactMutationValidationError("set-token and set-layout require an HTML or JSX source file");
}

function tokenCssValue(token: string): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(token)) {
    throw new ArtifactMutationValidationError("set-token token must be a bounded design-token name");
  }
  return `var(--${token.replace(/[._]+/g, "-")})`;
}

function boundedPixels(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new ArtifactMutationValidationError(`${label} must be a finite number between 0 and 100000`);
  }
  return `${value}px`;
}

function layoutStyleUpdates(patch: SupportedLayoutPatch): Record<string, string> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ArtifactMutationValidationError("set-layout patch must be an object");
  }
  const supported = new Set(["width", "height", "padding", "gap", "alignment", "visibility"]);
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !supported.has(key))) {
    throw new ArtifactMutationValidationError("set-layout patch must contain only supported layout properties");
  }
  const result: Record<string, string> = {};
  const size = (value: unknown, label: string): string => {
    if (value === "auto") return "auto";
    if (value === "fill") return "100%";
    return boundedPixels(value, label);
  };
  if (patch.width !== undefined) result.width = size(patch.width, "layout width");
  if (patch.height !== undefined) result.height = size(patch.height, "layout height");
  if (patch.padding !== undefined) result.padding = boundedPixels(patch.padding, "layout padding");
  if (patch.gap !== undefined) result.gap = boundedPixels(patch.gap, "layout gap");
  if (patch.alignment !== undefined) {
    const alignments = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;
    if (!Object.hasOwn(alignments, patch.alignment)) {
      throw new ArtifactMutationValidationError("layout alignment is unsupported");
    }
    result["align-items"] = alignments[patch.alignment];
  }
  if (patch.visibility !== undefined) {
    if (patch.visibility !== "visible" && patch.visibility !== "hidden") {
      throw new ArtifactMutationValidationError("layout visibility is unsupported");
    }
    result.visibility = patch.visibility;
  }
  return result;
}

function applyCommandToSource(
  source: string,
  sourcePath: string,
  command: DirectArtifactMutationCommand,
  asset: ResolvedAssetSource | null,
): string {
  switch (command.type) {
    case "set-text":
      return applyTextMutation(
        source,
        sourcePath,
        command.locator,
        command.expectedCurrentValue,
        command.value,
      );
    case "set-accessible-label":
      assertSafeAttributeTarget(source, sourcePath, command.locator, command.type);
      return setStringAttribute(source, sourcePath, command.locator, "aria-label", command.value);
    case "set-token":
      assertSafeAttributeTarget(source, sourcePath, command.locator, command.type);
      return setStyleProperties(source, command.locator, sourcePath, {
        [command.property]: tokenCssValue(command.token),
      });
    case "set-layout":
      assertSafeAttributeTarget(source, sourcePath, command.locator, command.type);
      return setStyleProperties(source, command.locator, sourcePath, layoutStyleUpdates(command.patch));
    case "set-asset":
      if (asset === null) throw new ArtifactMutationValidationError("set-asset source was not resolved");
      const attribute = assetTargetAttribute(source, sourcePath, command.locator, asset.mimeType);
      return setStringAttribute(
        setStringAttribute(source, sourcePath, command.locator, attribute, asset.source),
        sourcePath,
        command.locator,
        "data-dezin-resource-revision",
        command.resourceRevisionId,
      );
  }
}

async function confinedSourceFile(checkoutRoot: string, artifactRoot: string, sourcePath: string): Promise<string> {
  const checkout = await realpath(checkoutRoot);
  const root = await realpath(resolve(checkout, artifactRoot));
  if (!isWithin(checkout, root)) throw new ArtifactMutationValidationError("Artifact source root escapes the checkout");
  const candidate = resolve(root, sourcePath);
  if (!isWithin(root, candidate)) throw new ArtifactMutationValidationError("locator sourcePath escapes the Artifact source root");
  const stats = await lstat(candidate).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new ArtifactMutationValidationError("locator sourcePath must resolve to a regular source file");
  }
  const exact = await realpath(candidate);
  if (!isWithin(root, exact)) throw new ArtifactMutationValidationError("locator sourcePath resolves outside the Artifact source root");
  return exact;
}

async function gitGrepTrackedPaths(
  checkoutRoot: string,
  repositoryRoot: string,
  patterns: readonly string[],
  signal?: AbortSignal,
  cached = false,
): Promise<string[]> {
  const args = ["grep", ...(cached ? ["--cached"] : []), "-l", "-z", "-a", "-F"];
  for (const pattern of patterns) args.push("-e", pattern);
  args.push("--", repositoryRoot);
  try {
    return (await gitRaw(checkoutRoot, args, signal)).split("\0").filter(Boolean);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const code = error && typeof error === "object" && "code" in error
      ? Number((error as { code?: unknown }).code)
      : Number.NaN;
    if (code === 1) return [];
    throw error;
  }
}

async function fileContainsResourceReference(input: {
  absolutePath: string;
  resourceRevisionId: string;
  directReferences: readonly string[];
  signal?: AbortSignal;
}): Promise<boolean> {
  const marker = Buffer.from(RESOURCE_REVISION_MARKER, "utf8");
  const revisionValues = [input.resourceRevisionId, escapeAttribute(input.resourceRevisionId)]
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((value) => Buffer.from(value, "utf8"));
  const directReferences = input.directReferences.map((value) => Buffer.from(value, "utf8"));
  const patterns = [marker, ...revisionValues, ...directReferences];
  const overlapBytes = Math.max(...patterns.map((pattern) => pattern.byteLength)) - 1;
  const handle = await open(input.absolutePath, "r");
  let trailing = Buffer.alloc(0);
  let sawMarker = false;
  const sawRevisionValue = new Array<boolean>(revisionValues.length).fill(false);
  try {
    const buffer = Buffer.allocUnsafe(RESOURCE_REFERENCE_SCAN_CHUNK_BYTES);
    while (true) {
      input.signal?.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      const bytes = trailing.byteLength === 0
        ? buffer.subarray(0, read.bytesRead)
        : Buffer.concat([trailing, buffer.subarray(0, read.bytesRead)]);
      if (!sawMarker && bytes.includes(marker)) sawMarker = true;
      revisionValues.forEach((value, index) => {
        if (!sawRevisionValue[index] && bytes.includes(value)) sawRevisionValue[index] = true;
      });
      if (directReferences.some((reference) => bytes.includes(reference))) return true;
      if (sawMarker && sawRevisionValue.some(Boolean)) return true;
      trailing = overlapBytes <= 0
        ? Buffer.alloc(0)
        : Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - overlapBytes)));
    }
    return sawMarker && sawRevisionValue.some(Boolean);
  } finally {
    await handle.close().catch(() => {});
  }
}

const RESOURCE_CLOSURE_SAFE_EXTENSIONS = new Set([
  ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".mp3", ".mp4", ".ogg", ".otf", ".pdf",
  ".png", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2",
]);

function canProveResourceReferenceClosure(
  repositorySourcePath: string,
  mutatedSource: string,
  trackedPaths: readonly string[],
): boolean {
  const sourceExtension = extname(repositorySourcePath).toLowerCase();
  if (sourceExtension !== ".html" && sourceExtension !== ".htm") return false;
  if (/<(?:script|style)\b|\b(?:style|on[a-z]+)\s*=/i.test(mutatedSource)) return false;
  return trackedPaths.every((path) => {
    if (path === repositorySourcePath) return true;
    const base = posix.basename(path);
    if (base === ".gitattributes" || base === ".gitignore") return true;
    return RESOURCE_CLOSURE_SAFE_EXTENSIONS.has(extname(path).toLowerCase());
  });
}

interface HtmlReferenceNode {
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlReferenceNode[];
  content?: { childNodes?: HtmlReferenceNode[] };
}

function decodedUrlVariants(value: string): string[] {
  const variants = new Set([value]);
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      variants.add(next);
      decoded = next;
    } catch {
      break;
    }
  }
  for (const candidate of [...variants]) {
    try {
      const parsed = new URL(candidate, "http://dezin.invalid/");
      variants.add(parsed.href);
      variants.add(parsed.pathname);
      try {
        variants.add(decodeURIComponent(parsed.pathname));
      } catch {
        // A malformed percent escape cannot hide a proven canonical Resource URL.
      }
    } catch {
      // Non-URL attributes are still checked as decoded strings above.
    }
  }
  return [...variants];
}

function inspectHtmlResourceReferences(
  source: string,
  directReferences: readonly string[],
): { referenced: boolean; proven: boolean } {
  let tagOpeners = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 60 && ++tagOpeners > MAX_HTML_REFERENCE_NODES) {
      return { referenced: false, proven: false };
    }
  }
  let fragment: HtmlReferenceNode;
  try {
    fragment = parseFragment(source) as unknown as HtmlReferenceNode;
  } catch {
    return { referenced: false, proven: false };
  }
  const pending = [...(fragment.childNodes ?? [])];
  let visited = 0;
  let proven = true;
  while (pending.length > 0) {
    if (++visited > MAX_HTML_REFERENCE_NODES) return { referenced: false, proven: false };
    const node = pending.pop()!;
    for (const attribute of node.attrs ?? []) {
      if (attribute.name.toLowerCase() === "srcdoc") proven = false;
      const variants = decodedUrlVariants(attribute.value);
      if (directReferences.some((reference) => variants.some((variant) => variant.includes(reference)))) {
        return { referenced: true, proven };
      }
    }
    pending.push(...(node.childNodes ?? []));
    pending.push(...(node.content?.childNodes ?? []));
  }
  return { referenced: false, proven };
}

async function artifactSourceResourceReferenceClosure(input: {
  checkoutRoot: string;
  artifactRoot: string;
  absoluteSourcePath: string;
  repositorySourcePath: string;
  mutatedSource: string;
  resourceRevisionId: string;
  previousAssetSource: string | null;
  signal?: AbortSignal;
}): Promise<{ referenced: boolean; proven: boolean }> {
  const checkout = await realpath(input.checkoutRoot);
  const root = await realpath(resolve(checkout, input.artifactRoot));
  if (!isWithin(checkout, root)) throw new ArtifactMutationValidationError("Artifact source root escapes the checkout");
  const repositoryRoot = relative(checkout, root) || ".";
  const trackedPaths = (await gitRaw(
    checkout,
    ["ls-files", "-z", "--", repositoryRoot],
    input.signal,
  )).split("\0").filter(Boolean);
  const proven = canProveResourceReferenceClosure(
    input.repositorySourcePath,
    input.mutatedSource,
    trackedPaths,
  );
  if (input.previousAssetSource?.includes("\0") || /[\r\n]/.test(input.previousAssetSource ?? "")) {
    throw new ArtifactMutationValidationError(
      "existing set-asset source is ambiguous and cannot be reconciled safely",
    );
  }
  const directReferences = [
    resourceRevisionPublicRoot(input.resourceRevisionId),
    resourceRevisionMountKey(input.resourceRevisionId),
    ...(input.previousAssetSource ? [input.previousAssetSource] : []),
    ...(input.previousAssetSource?.includes(input.resourceRevisionId) ? [input.resourceRevisionId] : []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const semanticHtmlInspection = extname(input.repositorySourcePath).toLowerCase() === ".html"
    || extname(input.repositorySourcePath).toLowerCase() === ".htm"
    ? inspectHtmlResourceReferences(input.mutatedSource, directReferences)
    : { referenced: false, proven: false };
  if (semanticHtmlInspection.referenced) return { referenced: true, proven };
  if (!semanticHtmlInspection.proven) {
    return { referenced: false, proven: false };
  }
  if (await fileContainsResourceReference({
    absolutePath: input.absoluteSourcePath,
    resourceRevisionId: input.resourceRevisionId,
    directReferences,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })) return { referenced: true, proven };
  const withoutMutatedSource = (paths: readonly string[]): string[] => (
    paths.filter((path) => path !== input.repositorySourcePath)
  );
  const directPaths = withoutMutatedSource(await gitGrepTrackedPaths(
    checkout,
    repositoryRoot,
    directReferences,
    input.signal,
    true,
  ));
  if (directPaths.length > 0) return { referenced: true, proven };
  const [markerPaths, revisionPaths] = await Promise.all([
    gitGrepTrackedPaths(checkout, repositoryRoot, [RESOURCE_REVISION_MARKER], input.signal, true),
    gitGrepTrackedPaths(
      checkout,
      repositoryRoot,
      [input.resourceRevisionId, escapeAttribute(input.resourceRevisionId)]
        .filter((value, index, values) => values.indexOf(value) === index),
      input.signal,
      true,
    ),
  ]);
  const revisionPathSet = new Set(withoutMutatedSource(revisionPaths));
  return {
    referenced: withoutMutatedSource(markerPaths).some((path) => revisionPathSet.has(path)),
    proven,
  };
}

function dependencyInput(dependency: ReturnType<Store["workspace"]["listArtifactRevisionDependencies"]>[number]): ArtifactRevisionDependencyInput {
  return {
    instanceId: dependency.instanceId,
    componentArtifactId: dependency.componentArtifactId,
    componentRevisionId: dependency.componentRevisionId,
    ...(dependency.variantKey === null ? {} : { variantKey: dependency.variantKey }),
    ...(dependency.stateKey === null ? {} : { stateKey: dependency.stateKey }),
    sourceLocator: dependency.sourceLocator,
    overrides: dependency.overrides,
    status: dependency.status,
  };
}

export async function applyArtifactMutation(input: ApplyArtifactMutationInput): Promise<ArtifactMutationResult> {
  input.signal?.throwIfAborted();
  if (typeof input.validateCandidateSource !== "function") {
    throw new ArtifactMutationValidationError("direct source mutation requires a candidate source validator");
  }
  const workspace = input.store.workspace.getWorkspace(input.projectId);
  const artifact = input.store.workspace.getArtifact(input.artifactId);
  if (!workspace || !artifact || artifact.workspaceId !== workspace.id || artifact.archivedAt !== null) {
    throw new ArtifactMutationValidationError("Artifact does not belong to the requested Project Workspace");
  }
  if (artifact.activeTrackId === null) throw new ArtifactMutationValidationError("Artifact has no active Track");
  const track = input.store.workspace.getTrack(artifact.activeTrackId);
  const parent = input.store.workspace.getArtifactRevision(input.expectedHeadRevisionId);
  if (!track || track.artifactId !== artifact.id || !parent
    || parent.artifactId !== artifact.id || parent.trackId !== track.id || parent.workspaceId !== workspace.id) {
    throw new ArtifactMutationValidationError("expected Head Revision does not belong to the Artifact active Track");
  }
  if (track.headRevisionId !== input.expectedHeadRevisionId) {
    throw new ArtifactMutationConflictError("Artifact Head changed before direct mutation");
  }
  if (workspace.activeSnapshotId !== input.expectedSnapshotId) {
    throw new ArtifactMutationConflictError("Workspace Snapshot changed before direct mutation");
  }
  if (input.command.locator.sourcePath === undefined) {
    throw new ArtifactMutationValidationError("direct source mutation requires a stable locator sourcePath");
  }
  const sourcePath = canonicalSourcePath(input.command.locator.sourcePath);
  const resourcePins = input.store.workspace.listArtifactRevisionResourcePins(parent.id)
    .map((pin) => ({ resourceId: pin.resourceId, resourceRevisionId: pin.resourceRevisionId }));
  const parentResourceUsageLedger = parseResourceUsageLedger(
    parent.renderSpec,
    parent.sourceTreeHash,
    resourcePins,
  );
  if (parentResourceUsageLedger === null && resourcePins.length > 0) {
    throw new ArtifactMutationValidationError(
      "Resource usage ledger is required when the parent Artifact Revision has Resource pins",
    );
  }
  let resourceUsages = parentResourceUsageLedger === null
    ? null
    : parentResourceUsageLedger.usages.map((usage) => ({ ...usage }));
  let retainedResourcePins = parentResourceUsageLedger === null
    ? null
    : parentResourceUsageLedger.retainedPins.map((pin) => ({ ...pin }));
  let assetPin: { resourceId: string; resourceRevisionId: string } | null = null;
  let asset: ResolvedAssetSource | null = null;
  let assetOwned: OwnedAssetRevision | null = null;
  let resolveAssetDescriptor: (() => Promise<ResourceRevisionPayloadDescriptor>) | null = null;
  if (input.command.type === "set-asset") {
    if (typeof input.command.resourceRevisionId !== "string" || input.command.resourceRevisionId.length === 0
      || input.command.resourceRevisionId.length > 256 || !input.resolveAssetSource) {
      throw new ArtifactMutationValidationError(
        "set-asset requires a bounded owned Resource Revision and an explicit immutable asset resolver",
      );
    }
    const owned = input.store.db.prepare(
      `SELECT revision.resource_id, resource.kind, revision.metadata_json,
              revision.manifest_path, revision.checksum
       FROM resource_revisions revision
       JOIN resources resource
         ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
       WHERE revision.id = ? AND revision.workspace_id = ? AND resource.archived_at IS NULL`,
    ).get(input.command.resourceRevisionId, workspace.id) as OwnedAssetRevision | undefined;
    if (!owned || (owned.kind !== "asset" && owned.kind !== "file")) {
      throw new ArtifactMutationValidationError("set-asset Resource Revision is missing, foreign, archived, or not an asset");
    }
    assetOwned = owned;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(owned.metadata_json) as Record<string, unknown>;
    } catch {
      throw new ArtifactMutationValidationError("set-asset Resource Revision metadata is invalid");
    }
    const mimeType = typeof metadata.mimeType === "string"
      ? metadata.mimeType.split(";", 1)[0]!.trim().toLowerCase()
      : "";
    if (!/^(?:image|audio|video)\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType)) {
      throw new ArtifactMutationValidationError("set-asset requires an image, audio, or video Resource MIME");
    }
    if (!DIRECT_SET_ASSET_STRUCTURALLY_VERIFIED_MIME.has(mimeType)) {
      throw new ArtifactMutationValidationError(
        `set-asset bounded structural validation is unavailable for ${mimeType}`,
      );
    }
    resolveAssetDescriptor = async (): Promise<ResourceRevisionPayloadDescriptor> => {
      input.signal?.throwIfAborted();
      let descriptor: unknown;
      try {
        descriptor = await input.resolveAssetSource!({
          projectId: input.projectId,
          workspaceId: workspace.id,
          resourceRevisionId: input.command.type === "set-asset" ? input.command.resourceRevisionId : "",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? error;
        if (error instanceof ArtifactMutationValidationError
          || (error instanceof Error && error.name === "AbortError")) throw error;
        throw new ArtifactMutationValidationError(
          error instanceof Error ? error.message : "immutable asset resolver failed",
        );
      }
      return validateAssetDescriptor(descriptor, {
        workspaceId: workspace.id,
        resourceRevisionId: input.command.type === "set-asset" ? input.command.resourceRevisionId : "",
        owned,
        mimeType,
      });
    };
    const descriptor = await resolveAssetDescriptor();
    asset = { source: descriptor.publicUrl, mimeType, descriptor };
    assetPin = { resourceId: owned.resource_id, resourceRevisionId: input.command.resourceRevisionId };
    input.signal?.throwIfAborted();
  }
  const expectedTree = await git(
    input.projectRoot,
    ["rev-parse", `${parent.sourceCommitHash}^{tree}`],
    input.signal,
  );
  if (expectedTree !== parent.sourceTreeHash) {
    throw new ArtifactMutationValidationError("expected Artifact Revision source tree does not match its immutable commit");
  }

  const checkoutRoot = await mkdtemp(join(tmpdir(), "dezin-artifact-mutation-"));
  let worktreeAdded = false;
  let candidateRef: string | null = null;
  let revisionRef: string | null = null;
  let revision: ArtifactRevisionRecord | null = null;
  try {
    worktreeAdded = true;
    await git(
      input.projectRoot,
      [...GIT_NO_HOOKS, "worktree", "add", "--detach", checkoutRoot, parent.sourceCommitHash],
      input.signal,
    );
    const absoluteSourcePath = await confinedSourceFile(checkoutRoot, artifact.sourceRoot, sourcePath);
    const checkoutRealPath = await realpath(checkoutRoot);
    const repositorySourcePath = relative(checkoutRealPath, absoluteSourcePath);
    const sourceMetadata = await lstat(absoluteSourcePath);
    if (sourceMetadata.size <= 0 || sourceMetadata.size > MAX_DIRECT_MUTATION_SOURCE_BYTES) {
      throw new ArtifactMutationValidationError("direct mutation source size is out of bounds");
    }
    const sourceBytes = await readFile(absoluteSourcePath);
    let source: string;
    try {
      source = FATAL_UTF8_DECODER.decode(sourceBytes);
    } catch {
      throw new ArtifactMutationValidationError("direct mutation source must contain valid UTF-8 bytes");
    }
    const replacedAssetRevisionId = input.command.type === "set-asset"
      ? directStringAttributeValue(
        source,
        sourcePath,
        input.command.locator,
        "data-dezin-resource-revision",
      )
      : null;
    if (replacedAssetRevisionId !== null) {
      boundedString(replacedAssetRevisionId, "existing set-asset Resource Revision id");
    }
    let assetAttribute: ResourceUsageAttribute | null = null;
    let replacedAssetSource: string | null = null;
    if (input.command.type === "set-asset" && asset !== null && assetOwned !== null) {
      assetAttribute = assetTargetAttribute(source, sourcePath, input.command.locator, asset.mimeType);
      replacedAssetSource = directStringAttributeValue(
        source,
        sourcePath,
        input.command.locator,
        assetAttribute,
      );
    }
    const mutated = applyCommandToSource(source, sourcePath, input.command, asset);
    if (mutated === source) throw new ArtifactMutationValidationError("direct mutation did not change the target source");
    await writeFile(absoluteSourcePath, mutated, "utf8");
    if (assetPin !== null) {
      if (assetAttribute === null) {
        throw new ArtifactMutationValidationError("set-asset could not determine its Resource usage attribute");
      }
      const usageMatchesLocator = (usage: ResourceUsage): boolean => (
        usage.sourcePath === sourcePath
        && usage.designNodeId === input.command.locator.designNodeId
        && usage.attribute === assetAttribute
      );
      if (replacedAssetRevisionId !== null) {
        const replacedPin = resourcePins.find((pin) => pin.resourceRevisionId === replacedAssetRevisionId);
        if (!replacedPin) {
          throw new ArtifactMutationValidationError(
            "existing set-asset marker is not backed by the parent Artifact Revision Resource pins",
          );
        }
        if (resourceUsages === null) {
          throw new ArtifactMutationValidationError(
            "set-asset cannot prove unique ownership: another element still requires the old revision unless the parent Resource usage ledger identifies this exact locator",
          );
        }
        const selectedUsages = resourceUsages.filter(usageMatchesLocator);
        if (selectedUsages.length !== 1
          || selectedUsages[0]!.resourceId !== replacedPin.resourceId
          || selectedUsages[0]!.resourceRevisionId !== replacedAssetRevisionId) {
          throw new ArtifactMutationValidationError(
            "parent Resource usage ledger does not bind the selected locator to its exact Resource pin",
          );
        }
        const selectedUsage = selectedUsages[0]!;
        if (replacedAssetRevisionId !== assetPin.resourceRevisionId) {
          const oldUsages = resourceUsages.filter((usage) => (
            usage.resourceId === replacedPin.resourceId
            && usage.resourceRevisionId === replacedAssetRevisionId
          ));
          const replacingSameResource = replacedPin.resourceId === assetPin.resourceId;
          if (oldUsages.length > 1 && replacingSameResource) {
            throw new ArtifactMutationValidationError(
              "set-asset cannot pin two revisions of one Resource while another element still requires the old revision",
            );
          }
          if (oldUsages.length === 1) {
            const closure = await artifactSourceResourceReferenceClosure({
              checkoutRoot,
              artifactRoot: artifact.sourceRoot,
              absoluteSourcePath,
              repositorySourcePath,
              mutatedSource: mutated,
              resourceRevisionId: replacedAssetRevisionId,
              previousAssetSource: replacedAssetSource,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            if (replacingSameResource) {
              if (closure.referenced) {
                throw new ArtifactMutationValidationError(
                  "set-asset cannot remove the old Resource pin because source outside its declared usage still directly references it",
                );
              }
              if (!closure.proven) {
                throw new ArtifactMutationValidationError(
                  "set-asset cannot prove the dynamic Resource reference closure for a same Resource revision replacement",
                );
              }
              resourcePins.splice(resourcePins.indexOf(replacedPin), 1);
            } else if (!closure.referenced && closure.proven) {
              resourcePins.splice(resourcePins.indexOf(replacedPin), 1);
            } else {
              retainedResourcePins ??= [];
              if (!retainedResourcePins.some((pin) => (
                pin.resourceId === replacedPin.resourceId
                && pin.resourceRevisionId === replacedPin.resourceRevisionId
              ))) retainedResourcePins.push({ ...replacedPin });
            }
          }
        }
        resourceUsages.splice(resourceUsages.indexOf(selectedUsage), 1);
      } else {
        const priorUsages = resourceUsages ?? [];
        if (priorUsages.some(usageMatchesLocator)) {
          throw new ArtifactMutationValidationError(
            "Resource usage ledger claims the selected locator even though its source marker is missing",
          );
        }
        const existingPin = resourcePins.find((pin) => (
          pin.resourceId === assetPin.resourceId
          && pin.resourceRevisionId === assetPin.resourceRevisionId
        ));
        if (existingPin && !priorUsages.some((usage) => (
          usage.resourceId === assetPin.resourceId
          && usage.resourceRevisionId === assetPin.resourceRevisionId
        ))) {
          throw new ArtifactMutationValidationError(
            "set-asset cannot establish unique ownership for an existing Resource pin without a parent Resource usage ledger entry",
          );
        }
        resourceUsages ??= [];
        retainedResourcePins ??= [];
      }
      const conflictingPin = resourcePins.find((pin) => (
        pin.resourceId === assetPin.resourceId
        && pin.resourceRevisionId !== assetPin.resourceRevisionId
      ));
      if (conflictingPin) {
        throw new ArtifactMutationValidationError(
          "set-asset cannot replace an unrelated existing pin for the same Resource",
        );
      }
      if (!resourcePins.some((pin) => (
        pin.resourceId === assetPin.resourceId
        && pin.resourceRevisionId === assetPin.resourceRevisionId
      ))) resourcePins.push(assetPin);
      if (resourceUsages === null) {
        throw new ArtifactMutationValidationError("set-asset could not establish a Resource usage ledger");
      }
      retainedResourcePins ??= [];
      retainedResourcePins = retainedResourcePins.filter((pin) => pin.resourceId !== assetPin.resourceId);
      resourceUsages.push({
        resourceId: assetPin.resourceId,
        resourceRevisionId: assetPin.resourceRevisionId,
        sourcePath,
        designNodeId: input.command.locator.designNodeId,
        attribute: assetAttribute,
      });
      if (resourceUsages.length + retainedResourcePins.length > RESOURCE_USAGE_LEDGER_LIMIT) {
        throw new ArtifactMutationValidationError(
          `Resource usage ledger cannot exceed ${RESOURCE_USAGE_LEDGER_LIMIT} entries`,
        );
      }
      resourceUsages = sortedResourceUsages(resourceUsages);
      retainedResourcePins = sortedResourcePins(retainedResourcePins);
      assertResourceUsagePins(resourceUsages, resourcePins, retainedResourcePins);
    }
    await git(checkoutRoot, ["diff", "--check", "--", repositorySourcePath], input.signal);
    await input.validateCandidateSource({
      checkoutRoot,
      artifactRoot: artifact.sourceRoot,
      sourcePath,
      absoluteSourcePath,
      source: mutated,
      command: input.command,
    });
    input.signal?.throwIfAborted();
    await stageExactSourceBytes(checkoutRoot, repositorySourcePath, input.signal);
    await git(checkoutRoot, [
      ...GIT_NO_HOOKS,
      ...GIT_IDENTITY,
      "commit",
      "-q",
      "-m",
      `Direct ${input.command.type} on ${input.command.locator.designNodeId}`.slice(0, 72),
    ], input.signal);
    const sourceCommitHash = await git(checkoutRoot, ["rev-parse", "HEAD"], input.signal);
    const sourceTreeHash = await git(checkoutRoot, ["rev-parse", "HEAD^{tree}"], input.signal);
    const changedPaths = (await gitRaw(checkoutRoot, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", parent.sourceCommitHash, "HEAD",
    ], input.signal)).split("\0").filter(Boolean);
    if (changedPaths.length !== 1 || changedPaths[0] !== repositorySourcePath) {
      throw new ArtifactMutationValidationError("committed candidate tree changed files outside the exact source path");
    }
    const committedSource = await gitRaw(checkoutRoot, ["show", `HEAD:${repositorySourcePath}`], input.signal);
    if (committedSource !== mutated) {
      throw new ArtifactMutationValidationError("committed source differs from validated bytes");
    }
    const renderSpec = resourceUsages === null
      ? parent.renderSpec
      : renderSpecWithResourceUsageLedger(
        parent.renderSpec,
        sourceTreeHash,
        resourceUsages,
        retainedResourcePins ?? [],
      );
    const dependencies = input.store.workspace.listArtifactRevisionDependencies(parent.id).map(dependencyInput);
    candidateRef = `refs/dezin/artifact-candidates/${safeRefSegment(sourceCommitHash)}`;
    await git(
      input.projectRoot,
      [...GIT_NO_HOOKS, "update-ref", candidateRef, sourceCommitHash],
      input.signal,
    );
    input.signal?.throwIfAborted();
    if (input.command.type === "set-asset" && resolveAssetDescriptor !== null && asset !== null) {
      const revalidatedDescriptor = await resolveAssetDescriptor();
      if (!sameAssetDescriptor(revalidatedDescriptor, asset.descriptor)) {
        throw new ArtifactMutationValidationError(
          "immutable asset descriptor changed before candidate insertion",
        );
      }
    }
    input.signal?.throwIfAborted();
    const latestTrack = input.store.workspace.getTrack(track.id);
    const latestWorkspace = input.store.workspace.getWorkspace(input.projectId);
    if (latestTrack?.headRevisionId !== input.expectedHeadRevisionId) {
      throw new ArtifactMutationConflictError("Artifact Head changed after candidate validation");
    }
    if (latestWorkspace?.activeSnapshotId !== input.expectedSnapshotId) {
      throw new ArtifactMutationConflictError("Workspace Snapshot changed after candidate validation");
    }
    if (input.command.type === "set-asset") {
      if (asset === null || assetOwned === null) {
        throw new ArtifactMutationValidationError("set-asset ownership descriptor was not retained");
      }
      const exactOwned = input.store.db.prepare(
        `SELECT 1 AS owned
           FROM resource_revisions revision
           JOIN resources resource
             ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
          WHERE revision.id = ? AND revision.workspace_id = ?
            AND revision.resource_id = ? AND resource.kind = ?
            AND revision.manifest_path = ? AND revision.checksum = ?
            AND revision.metadata_json = ? AND resource.archived_at IS NULL`,
      ).get(
        asset.descriptor.resourceRevisionId,
        asset.descriptor.workspaceId,
        asset.descriptor.resourceId,
        asset.descriptor.resourceKind,
        asset.descriptor.manifestPath,
        asset.descriptor.manifestChecksum,
        assetOwned.metadata_json,
      ) as { owned: number } | undefined;
      if (!exactOwned) {
        throw new ArtifactMutationValidationError(
          "set-asset Resource Revision is missing, foreign, archived, or not an asset before candidate insertion",
        );
      }
    }
    revision = input.store.workspace.createArtifactRevision({
      artifactId: artifact.id,
      trackId: track.id,
      parentRevisionId: parent.id,
      sourceCommitHash,
      sourceTreeHash,
      kernelRevisionId: parent.kernelRevisionId,
      renderSpec,
      quality: { state: "unassessed", score: null, findings: [], reason: "direct-mutation" },
      contextPackHash: parent.contextPackHash,
      dependencies,
      resourcePins,
    });
    input.signal?.throwIfAborted();
    const confirmedRevisionRef = `refs/dezin/artifact-revisions/${safeRefSegment(revision.id)}`;
    await git(
      input.projectRoot,
      [...GIT_NO_HOOKS, "update-ref", confirmedRevisionRef, sourceCommitHash],
      input.signal,
    );
    revisionRef = confirmedRevisionRef;
    await git(input.projectRoot, [...GIT_NO_HOOKS, "update-ref", "-d", candidateRef], input.signal);
    candidateRef = null;
    input.signal?.throwIfAborted();
    const snapshot = input.store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: input.expectedHeadRevisionId,
      expectedSnapshotId: input.expectedSnapshotId,
    });
    return { revision, snapshot };
  } catch (error) {
    if (revision !== null) {
      const retainedRef = revisionRef ?? candidateRef;
      if (retainedRef !== null) {
        throw new ArtifactMutationCandidateError(revision.id, retainedRef, error);
      }
    }
    if (candidateRef !== null && revision === null) {
      await git(input.projectRoot, [...GIT_NO_HOOKS, "update-ref", "-d", candidateRef]).catch(() => {});
    }
    throw error;
  } finally {
    if (worktreeAdded) {
      await git(input.projectRoot, ["worktree", "remove", "--force", checkoutRoot]).catch(() => {});
      await git(input.projectRoot, ["worktree", "prune"]).catch(() => {});
    }
    await rm(checkoutRoot, { recursive: true, force: true }).catch(() => {});
  }
}
