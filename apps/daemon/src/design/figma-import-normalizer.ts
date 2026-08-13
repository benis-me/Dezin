import { createHash } from "node:crypto";

import type { ParsedFigmaUrl } from "./figma-url.ts";
import {
  projectFigmaVisualLayout,
  type FigmaVisualCandidate,
} from "./figma-visual-projection.ts";

const MAX_RAW_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RAW_VARIABLE_BYTES = 8 * 1024 * 1024;
const MAX_DERIVED_BYTES = 8 * 1024 * 1024;
const MAX_STRUCTURE_DEPTH = 64;
const MAX_CONTAINER_WIDTH = 50_000;
const MAX_STRUCTURE_ENTRIES = 1_000_000;
const MAX_STRUCTURE_STRING_BYTES = 16 * 1024 * 1024;
const EPHEMERAL_REMOTE_KEY = /(?:thumbnail|image|render|download|preview).*(?:url|uri)|(?:url|uri).*(?:thumbnail|image|render|download|preview)/i;

export type FigmaVariablesResult =
  | { kind: "available"; body: unknown }
  | { kind: "unavailable"; status: 403 | 404; reason: string };

export interface FigmaNormalizedPayload {
  bytes: Buffer;
  sha256: string;
}

export interface NormalizedFigmaImport {
  fileName: string;
  resolvedVersion: string;
  editorType: string | null;
  role: string | null;
  linkAccess: string | null;
  lastModified: string | null;
  incomplete: string[];
  warnings: string[];
  tokenAuthority: "figma-variables-exact" | "style-values-inferred" | "not-applicable";
  rawFile: FigmaNormalizedPayload;
  rawVariables: FigmaNormalizedPayload | null;
  designMarkdown: FigmaNormalizedPayload;
  tokensJson: FigmaNormalizedPayload;
  componentsJson: FigmaNormalizedPayload;
  layoutJson: FigmaNormalizedPayload;
  visualLayout: Record<string, unknown>;
  visualCandidates: FigmaVisualCandidate[];
  referenceRenders: Array<{
    nodeId: string;
    candidateIndex: number;
    referencePath: string;
    width: number;
    height: number;
    payload: FigmaNormalizedPayload;
  }>;
}

export function finalizeFigmaVisualReferences(
  normalized: NormalizedFigmaImport,
  availableNodeIds: ReadonlySet<string>,
  unavailableNodeIds: ReadonlySet<string>,
): void {
  const candidates = normalized.visualCandidates.map((candidate): FigmaVisualCandidate => ({
    ...candidate,
    referenceAvailability: availableNodeIds.has(candidate.nodeId) ? "available"
      : unavailableNodeIds.has(candidate.nodeId) ? "unavailable"
        : "pending",
  }));
  if (candidates.some((candidate) => candidate.referenceAvailability === "pending")) {
    fail("Figma visual reference availability is incomplete");
  }
  normalized.visualCandidates = candidates;
  normalized.visualLayout = { ...normalized.visualLayout, candidates };
  normalized.layoutJson = payload(normalized.visualLayout, "Derived layout.json", MAX_DERIVED_BYTES);
}

export class FigmaNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaNormalizationError";
  }
}

function fail(message: string): never {
  throw new FigmaNormalizationError(message);
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > maxBytes) {
    fail(`${label} is invalid`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string, maxBytes: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return string(value, label, maxBytes);
}

function signedRemoteUrl(candidate: string): boolean {
  const normalized = candidate.trim();
  if (!/^https?:\/\//i.test(normalized)) return false;
  try {
    const url = new URL(normalized);
    const signed = [...url.searchParams.keys()].some((key) =>
      /^(?:x-amz-|signature$|sig$|expires?$|expiry$|policy$|key-pair-id$)/i.test(key));
    const ephemeralHost = /(?:^|\.)(?:amazonaws\.com|figmausercontent\.com|s3-alpha-sig\.figma\.com)$/i.test(url.hostname)
      || /(?:^|\.)s3[.-]/i.test(url.hostname);
    return signed || ephemeralHost;
  } catch {
    return false;
  }
}

const EMBEDDED_HTTP_URL = /https?:\/\/[^\s<>"'`]+/gi;

export function containsEphemeralRemoteResourceUrl(value: string): boolean {
  for (const match of value.matchAll(EMBEDDED_HTTP_URL)) {
    if (signedRemoteUrl(match[0])) return true;
  }
  return false;
}

export function containsEphemeralRemoteResourceBytes(value: Uint8Array): boolean {
  const ascii = Buffer.from(value).toString("latin1").replace(/[^\x20-\x7e]+/g, " ");
  return containsEphemeralRemoteResourceUrl(ascii);
}

function redactRemoteResourceUrls(value: string, allRemoteUrls: boolean): { value: string; omitted: number } {
  let omitted = 0;
  const redacted = value.replace(EMBEDDED_HTTP_URL, (candidate) => {
    if (!allRemoteUrls && !signedRemoteUrl(candidate)) return candidate;
    omitted += 1;
    const digest = createHash("sha256").update(candidate).digest("hex");
    return `[omitted-ephemeral-remote-resource:${digest}]`;
  });
  return { value: redacted, omitted };
}

function requiredSemanticString(value: unknown, label: string, maxBytes: number, fallback: string): string {
  const result = string(value, label, maxBytes);
  return containsEphemeralRemoteResourceUrl(result) ? fallback : result;
}

function optionalSemanticString(value: unknown, label: string, maxBytes: number): string | null {
  const result = optionalString(value, label, maxBytes);
  return result !== null && containsEphemeralRemoteResourceUrl(result) ? null : result;
}

function optionalSemanticPreview(
  value: unknown,
  label: string,
  maxBytes: number,
): { value: string | null; truncated: boolean } {
  if (value === undefined || value === null || value === "") return { value: null, truncated: false };
  if (typeof value !== "string" || !value.trim()) fail(`${label} is invalid`);
  const result = value.trim();
  if (containsEphemeralRemoteResourceUrl(result)) return { value: null, truncated: false };
  const bytes = Buffer.from(result, "utf8");
  if (bytes.length <= maxBytes) return { value: result, truncated: false };
  const suffix = "…";
  let end = maxBytes - Buffer.byteLength(suffix, "utf8");
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { value: `${bytes.subarray(0, end).toString("utf8")}${suffix}`, truncated: true };
}

function canonicalValue(value: unknown, label: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${label}[${index}]`));
  if (typeof value !== "object") fail(`${label} contains an unsupported value`);
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort(lexical)) {
    if (input[key] === undefined) fail(`${label}.${key} is undefined`);
    output[key] = canonicalValue(input[key], `${label}.${key}`);
  }
  return output;
}

function assertStructuralBudget(value: unknown, label: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let entries = 0;
  let stringBytes = 0;
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.depth > MAX_STRUCTURE_DEPTH) fail(`${label} exceeds the structural budget (depth)`);
    if (typeof next.value === "string") {
      stringBytes += Buffer.byteLength(next.value, "utf8");
      if (stringBytes > MAX_STRUCTURE_STRING_BYTES) fail(`${label} exceeds the structural budget (strings)`);
      continue;
    }
    if (next.value === null || typeof next.value !== "object") continue;
    if (seen.has(next.value)) fail(`${label} exceeds the structural budget (cycle)`);
    seen.add(next.value);
    const children = Array.isArray(next.value)
      ? next.value
      : Object.values(next.value as Record<string, unknown>);
    if (children.length > MAX_CONTAINER_WIDTH) fail(`${label} exceeds the structural budget (width)`);
    entries += children.length;
    if (entries > MAX_STRUCTURE_ENTRIES) fail(`${label} exceeds the structural budget (entries)`);
    for (const child of children) pending.push({ value: child, depth: next.depth + 1 });
  }
}

function sanitizedRemoteResources(value: unknown): { value: unknown; omitted: number } {
  let omitted = 0;
  const visit = (current: unknown, key: string | null, forced = false): unknown => {
    const ephemeralField = forced || (key !== null && EPHEMERAL_REMOTE_KEY.test(key));
    if (typeof current === "string") {
      const redacted = redactRemoteResourceUrls(current, ephemeralField);
      omitted += redacted.omitted;
      return redacted.value;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, null, ephemeralField));
    if (current !== null && typeof current === "object") {
      const result: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(current as Record<string, unknown>)) {
        const safeKey = containsEphemeralRemoteResourceUrl(childKey)
          ? `omitted-ephemeral-key-${createHash("sha256").update(childKey.trim()).digest("hex")}`
          : childKey;
        if (safeKey !== childKey) omitted += 1;
        if (Object.hasOwn(result, safeKey)) fail("Figma response remote-resource key normalization collided");
        result[safeKey] = visit(child, childKey, ephemeralField);
      }
      return result;
    }
    return current;
  };
  return { value: visit(value, null), omitted };
}

function payload(value: unknown, label: string, maxBytes: number): FigmaNormalizedPayload {
  const sanitized = sanitizedRemoteResources(value).value;
  const bytes = Buffer.from(`${JSON.stringify(canonicalValue(sanitized, label))}\n`, "utf8");
  if (bytes.length > maxBytes) fail(`${label} exceeds the import byte budget`);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function textPayload(value: string, label: string): FigmaNormalizedPayload {
  const bytes = Buffer.from(value.endsWith("\n") ? value : `${value}\n`, "utf8");
  if (bytes.length > MAX_DERIVED_BYTES) fail(`${label} exceeds the import byte budget`);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function keyedFacts(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  const source = record(value, label);
  return Object.keys(source).sort(lexical).map((id) => {
    const fact = record(source[id], `${label}.${id}`);
    return { id, ...canonicalValue(fact, `${label}.${id}`) as Record<string, unknown> };
  });
}

function markdown(value: unknown): string {
  return String(value)
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replace(/([\\`*_[\]{}()#+.!|<>~-])/g, "\\$1")
    .trim();
}

function documentOutline(document: Record<string, unknown>): {
  lines: string[];
  truncated: boolean;
  truncatedNames: number;
} {
  const lines: string[] = [];
  let visited = 0;
  let truncatedNames = 0;
  const visit = (node: unknown, depth: number) => {
    if (visited >= 500 || depth > 6) return;
    const current = record(node, "Figma document Node");
    visited += 1;
    const namePreview = optionalSemanticPreview(current.name, "Figma document Node name", 1_024);
    if (namePreview.truncated) truncatedNames += 1;
    const name = namePreview.value ?? "Untitled";
    const type = optionalSemanticString(current.type, "Figma document Node type", 128) ?? "UNKNOWN";
    if (depth > 0) lines.push(`${"  ".repeat(depth - 1)}- ${markdown(name)} \`${markdown(type)}\``);
    if (current.children === undefined) return;
    if (!Array.isArray(current.children)) fail("Figma document Node children is invalid");
    for (const child of current.children) visit(child, depth + 1);
  };
  visit(document, 0);
  const truncated = visited >= 500;
  if (truncated) lines.push("- Outline truncated at the deterministic 500 Node budget.");
  return { lines, truncated, truncatedNames };
}

function componentNames(components: Array<Record<string, unknown>>): string[] {
  return components
    .map((component) => optionalSemanticString(component.name, "Figma component name", 1_024))
    .filter((name): name is string => name !== null);
}

type FigmaSurface = "design" | "board" | "slides";

function figmaSurface(source: ParsedFigmaUrl, editorType: string | null): FigmaSurface {
  const actual = editorType?.toLowerCase();
  const fromApi = actual === "figma" ? "design" : actual === "figjam" ? "board" : actual === "slides" ? "slides" : null;
  if (fromApi === null) fail("Figma File editorType is unsupported");
  if (source.fileType !== "file" && source.fileType !== fromApi) {
    fail(`Figma URL ${source.fileType} adapter does not match API editorType ${editorType}`);
  }
  return fromApi;
}

export function normalizeFigmaImport(input: {
  source: ParsedFigmaUrl;
  file: unknown;
  variables: FigmaVariablesResult;
  depthLimited?: boolean;
}): NormalizedFigmaImport {
  assertStructuralBudget(input.file, "Figma File response");
  if (input.variables.kind === "available") {
    assertStructuralBudget(input.variables.body, "Figma Variables response");
  }
  const file = record(input.file, "Figma File response");
  const fileName = requiredSemanticString(file.name, "Figma File name", 1_024, "Untitled Figma import");
  const rawVersion = string(file.version, "Figma File version", 256);
  const resolvedVersion = containsEphemeralRemoteResourceUrl(rawVersion)
    ? `omitted-remote-version-${createHash("sha256").update(rawVersion).digest("hex").slice(0, 16)}`
    : rawVersion;
  const document = record(file.document, "Figma File document");
  const visual = projectFigmaVisualLayout(document, input.source.nodeIds);
  const editorType = optionalSemanticString(file.editorType, "Figma File editorType", 128);
  const role = optionalSemanticString(file.role, "Figma File role", 128);
  const linkAccess = optionalSemanticString(file.linkAccess, "Figma File linkAccess", 128);
  const lastModified = optionalSemanticString(file.lastModified, "Figma File lastModified", 256);
  const surface = figmaSurface(input.source, editorType);
  const components = surface === "design" ? keyedFacts(file.components, "Figma File components") : [];
  const componentSets = surface === "design" ? keyedFacts(file.componentSets, "Figma File componentSets") : [];
  const styles = keyedFacts(file.styles, "Figma File styles");
  const incomplete: string[] = [];
  const warnings: string[] = [];
  if (visual.truncated) {
    incomplete.push("visual-layout-node-budget");
    warnings.push("layout.json was truncated at the deterministic visual Node budget.");
  }
  if (input.depthLimited === true) {
    incomplete.push("depth-limited");
    warnings.push("The Figma document tree was fetched with an explicit depth limit.");
  }
  const omittedRemoteResources = sanitizedRemoteResources(input.file).omitted
    + (input.variables.kind === "available" ? sanitizedRemoteResources(input.variables.body).omitted : 0);
  if (omittedRemoteResources > 0) {
    warnings.push(`${omittedRemoteResources} ephemeral remote resource URL(s) were omitted from persisted artifacts.`);
  }
  let tokenAuthority: NormalizedFigmaImport["tokenAuthority"];

  let rawVariables: FigmaNormalizedPayload | null = null;
  let tokens: Record<string, unknown>;
  if (surface !== "design") {
    tokenAuthority = "not-applicable";
    tokens = {
      schemaVersion: 1,
      sourceFileKey: input.source.fileKey,
      sourceVersion: resolvedVersion,
      authority: tokenAuthority,
      completeness: "not-applicable",
      diagnostics: [`${surface} imports do not claim Figma component or token authority.`],
      collections: [],
      variables: [],
    };
  } else if (input.variables.kind === "available") {
    const variablesRoot = record(input.variables.body, "Figma Variables response");
    const meta = record(variablesRoot.meta, "Figma Variables meta");
    const collections = keyedFacts(meta.variableCollections, "Figma Variable collections");
    const variableFacts = keyedFacts(meta.variables, "Figma Variables");
    tokenAuthority = "figma-variables-exact";
    rawVariables = payload(input.variables.body, "Figma Variables response", MAX_RAW_VARIABLE_BYTES);
    tokens = {
      schemaVersion: 1,
      sourceFileKey: input.source.fileKey,
      sourceVersion: resolvedVersion,
      authority: tokenAuthority,
      completeness: "complete",
      diagnostics: [],
      collections,
      variables: variableFacts,
    };
  } else {
    incomplete.push(`variables-http-${input.variables.status}`);
    const variableReason = requiredSemanticString(
      input.variables.reason,
      "Figma Variables unavailable reason",
      2_048,
      `Figma Variables are unavailable (HTTP ${input.variables.status}).`,
    );
    warnings.push(variableReason);
    tokenAuthority = "style-values-inferred";
    tokens = {
      schemaVersion: 1,
      sourceFileKey: input.source.fileKey,
      sourceVersion: resolvedVersion,
      authority: tokenAuthority,
      completeness: "incomplete",
      diagnostics: [variableReason],
      collections: [],
      variables: [],
      observedStyles: styles,
    };
  }

  const outline = documentOutline(document);
  if (outline.truncated) {
    incomplete.push("outline-node-budget");
    warnings.push("Design.md outline was truncated at 500 Nodes.");
  }
  if (outline.truncatedNames > 0) {
    incomplete.push("outline-name-budget");
    warnings.push(`${outline.truncatedNames} Figma document Node name(s) were truncated in the Design.md preview.`);
  }
  const names = componentNames(components);
  const surfaceDescription = surface === "board" ? "research/knowledge"
    : surface === "slides" ? "storyboard"
      : "product design";
  const designMarkdown = [
    `# ${markdown(fileName)}`,
    "",
    "> Deterministically extracted Figma facts. This document contains no AI-invented source claims.",
    "",
    "## Source",
    "",
    `- URL: ${input.source.normalizedUrl}`,
    `- File key: \`${markdown(input.source.fileKey)}\``,
    `- Resolved version: \`${markdown(resolvedVersion)}\``,
    `- Import surface: ${surfaceDescription}`,
    `- Editor type: ${editorType === null ? "Unavailable" : markdown(editorType)}`,
    `- Access role: ${role === null ? "Unavailable" : markdown(role)}`,
    `- Link access: ${linkAccess === null ? "Unavailable" : markdown(linkAccess)}`,
    `- Last modified: ${lastModified === null ? "Unavailable" : markdown(lastModified)}`,
    "",
    "## Document structure",
    "",
    ...(outline.lines.length > 0 ? outline.lines : ["- No selected child Nodes were returned."]),
    "",
    surface === "slides" ? "## Storyboard" : surface === "board" ? "## Knowledge candidates" : "## Components",
    "",
    ...(names.length > 0 ? names.map((name) => `- ${markdown(name)}`) : ["- No local components were returned."]),
    "",
    "## Extraction diagnostics",
    "",
    ...(incomplete.length > 0 ? incomplete.map((diagnostic) => `- ${diagnostic}`) : ["- Complete for the requested import surface."]),
    "",
  ].join("\n");

  return {
    fileName,
    resolvedVersion,
    editorType,
    role,
    linkAccess,
    lastModified,
    incomplete,
    warnings,
    tokenAuthority,
    rawFile: payload(input.file, "Figma File response", MAX_RAW_FILE_BYTES),
    rawVariables,
    designMarkdown: textPayload(designMarkdown, "Derived Design.md"),
    tokensJson: payload(tokens, "Derived tokens.json", MAX_DERIVED_BYTES),
    componentsJson: payload({
      schemaVersion: 1,
      sourceFileKey: input.source.fileKey,
      sourceVersion: resolvedVersion,
      authority: "figma-file-response",
      components,
      componentSets,
      styles,
    }, "Derived components.json", MAX_DERIVED_BYTES),
    layoutJson: payload(visual.layout, "Derived layout.json", MAX_DERIVED_BYTES),
    visualLayout: visual.layout,
    visualCandidates: visual.candidates,
    referenceRenders: [],
  };
}
