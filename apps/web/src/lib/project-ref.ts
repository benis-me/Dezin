import type { ApiClient } from "./api.ts";

/** UTF-8-safe base64 of a string (uploadRef takes base64, and designs contain non-ASCII). */
export function toBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

/** Fetch a project's main HTML artifact (index.html, else the first .html file), or null. */
export async function fetchProjectArtifact(api: ApiClient, projectId: string): Promise<string | null> {
  try {
    return await api.getFileText(projectId, "index.html");
  } catch {
    /* fall through to a file scan */
  }
  try {
    const files = await api.listFiles(projectId);
    const html = files.find((f) => f.path.endsWith(".html"));
    return html ? await api.getFileText(projectId, html.path) : null;
  } catch {
    return null;
  }
}
