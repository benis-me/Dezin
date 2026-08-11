const FIGMA_FILE_TYPES = new Set(["design", "file", "board", "slides"] as const);
const FIGMA_FILE_KEY = /^[A-Za-z0-9_-]{6,128}$/;
const FIGMA_NODE_ID = /^[0-9]+(?::[0-9]+)+$/;
export const FIGMA_NODE_ID_MAX_BYTES = 128;
export const FIGMA_NODE_IDS_MAX_BYTES = 4_096;

export type FigmaFileType = "design" | "file" | "board" | "slides";

export interface ParsedFigmaUrl {
  fileType: FigmaFileType;
  fileKey: string;
  branchKey: string | null;
  fileName: string;
  nodeIds: string[];
  requestedVersionId: string | null;
  normalizedUrl: string;
}

export class FigmaUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaUrlError";
  }
}

function fail(message: string): never {
  throw new FigmaUrlError(message);
}

function normalizedNodeIds(value: readonly unknown[] | undefined, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) fail(`${label} is invalid`);
  const result = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") fail(`${label} is invalid`);
    const normalized = candidate.trim().replaceAll("-", ":");
    if (!FIGMA_NODE_ID.test(normalized)
      || Buffer.byteLength(normalized, "utf8") > FIGMA_NODE_ID_MAX_BYTES) {
      fail(`${label} contains an invalid Node id`);
    }
    result.add(normalized);
  }
  const normalized = [...result].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (Buffer.byteLength(normalized.join(","), "utf8") > FIGMA_NODE_IDS_MAX_BYTES) {
    fail(`${label} exceeds the selected Node id byte budget`);
  }
  return normalized;
}

function queryNodeIds(url: URL): string[] {
  const values = url.searchParams.getAll("node-id");
  if (values.length === 0) return [];
  return normalizedNodeIds(values.flatMap((value) => value.split(",")), "Figma URL node-id");
}

export function parseFigmaUrl(value: unknown, explicitNodeIds?: readonly unknown[]): ParsedFigmaUrl {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > 4_096) {
    return fail("Figma URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return fail("Figma URL is invalid");
  }
  if (url.protocol !== "https:" || !["figma.com", "www.figma.com"].includes(url.hostname.toLowerCase())
    || url.port || url.username || url.password || url.hash) {
    return fail("Figma URL must be a credential-free https://www.figma.com file URL");
  }
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded.includes("/") || decoded.includes("\\")) return fail("Figma URL path contains an encoded separator");
      return decoded;
    } catch {
      return fail("Figma URL path is invalid");
    }
  });
  const branch = segments.length === 5 && segments[0] === "design" && segments[2] === "branch";
  if ((!branch && segments.length !== 3) || !FIGMA_FILE_TYPES.has(segments[0] as FigmaFileType)
    || !FIGMA_FILE_KEY.test(segments[1] ?? "") || (branch && !FIGMA_FILE_KEY.test(segments[3] ?? ""))) {
    return fail("Figma URL file identity is invalid");
  }
  const branchKey = branch ? segments[3]! : null;
  const fileName = segments[branch ? 4 : 2]?.trim() ?? "";
  if (!fileName || fileName === "." || fileName === ".." || Buffer.byteLength(fileName, "utf8") > 512) {
    return fail("Figma URL file name is invalid");
  }
  const fromUrl = queryNodeIds(url);
  const explicit = normalizedNodeIds(explicitNodeIds, "Figma import nodeIds");
  if (fromUrl.length > 0 && explicit.length > 0 && JSON.stringify(fromUrl) !== JSON.stringify(explicit)) {
    return fail("Figma URL node-id disagrees with explicit nodeIds");
  }
  const nodeIds = explicit.length > 0 ? explicit : fromUrl;
  const requestedVersionId = url.searchParams.get("version-id");
  if (requestedVersionId !== null) return fail("Historical Figma version URLs are not supported by exact Variables import");
  const normalizedPath = branch
    ? `${segments[0]}/${segments[1]}/branch/${branchKey}/${encodeURIComponent(fileName)}`
    : `${segments[0]}/${segments[1]}/${encodeURIComponent(fileName)}`;
  const normalized = new URL(`https://www.figma.com/${normalizedPath}`);
  if (nodeIds.length > 0) normalized.searchParams.set("node-id", nodeIds.join(","));
  return {
    fileType: segments[0] as FigmaFileType,
    fileKey: segments[1]!,
    branchKey,
    fileName,
    nodeIds,
    requestedVersionId,
    normalizedUrl: normalized.toString(),
  };
}
