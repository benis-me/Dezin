export interface FigmaImportUrlPreview {
  fileName: string;
  nodeIds: string[];
  normalizedUrl: string;
}

export function hasFigmaVersionSelection(value: string): boolean {
  try {
    return new URL(value.trim()).searchParams.has("version-id");
  } catch {
    return false;
  }
}

/**
 * Conservative browser-side preview only. The daemon reparses the original URL and remains
 * authoritative for URL identity, access, and import scope.
 */
export function previewFigmaImportUrl(value: string): FigmaImportUrlPreview | null {
  const candidate = value.trim();
  if (!candidate || new TextEncoder().encode(candidate).byteLength > 4_096) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["figma.com", "www.figma.com"].includes(url.hostname.toLowerCase())
    || url.port || url.username || url.password || url.hash) {
    return null;
  }
  const rawSegments = url.pathname.split("/").filter(Boolean);
  const segments: string[] = [];
  for (const segment of rawSegments) {
    try {
      const decoded = decodeURIComponent(segment);
      if (/[\\/]/.test(decoded)) return null;
      segments.push(decoded);
    } catch {
      return null;
    }
  }
  const branch = segments.length === 5 && segments[0] === "design" && segments[2] === "branch";
  if ((!branch && segments.length !== 3)
    || !["design", "file", "board", "slides"].includes(segments[0] ?? "")
    || !/^[A-Za-z0-9_-]{6,128}$/.test(segments[1] ?? "")
    || (branch && !/^[A-Za-z0-9_-]{6,128}$/.test(segments[3] ?? ""))) {
    return null;
  }
  const fileName = segments[branch ? 4 : 2]?.trim();
  if (!fileName || fileName === "." || fileName === ".." || new TextEncoder().encode(fileName).byteLength > 512) {
    return null;
  }
  const rawNodeIds = url.searchParams.getAll("node-id").flatMap((entry) => entry.split(","));
  if (rawNodeIds.length > 64) return null;
  const normalizedNodeIds = rawNodeIds.map((nodeId) => nodeId.trim().replaceAll("-", ":"));
  if (normalizedNodeIds.some((nodeId) => !/^[0-9]+(?::[0-9]+)+$/.test(nodeId))) return null;
  const nodeIds = [...new Set(normalizedNodeIds)]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (url.searchParams.has("version-id")) return null;
  const normalizedPath = branch
    ? `design/${segments[1]}/branch/${segments[3]}/${encodeURIComponent(fileName)}`
    : `${segments[0]}/${segments[1]}/${encodeURIComponent(fileName)}`;
  const normalized = new URL(`https://www.figma.com/${normalizedPath}`);
  if (nodeIds.length > 0) normalized.searchParams.set("node-id", nodeIds.join(","));
  return { fileName, nodeIds, normalizedUrl: normalized.toString() };
}
