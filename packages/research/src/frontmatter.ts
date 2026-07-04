/**
 * Minimal frontmatter for research/brief.md — the same flat subset Dezin uses for
 * SKILL.md (string | boolean | string[]), kept self-contained so @dezin/research
 * has no cross-package dependency. Serialize + parse round-trip.
 */

export type FrontmatterValue = string | boolean | string[];

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseValue(raw: string): FrontmatterValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0);
  }
  return stripQuotes(raw);
}

function needsQuoting(s: string): boolean {
  return /^[\s]|[\s]$|[:#[\]",]/.test(s) || s === "true" || s === "false" || s === "";
}

function renderScalar(s: string): string {
  return needsQuoting(s) ? JSON.stringify(s) : s;
}

/** Render a flat key→value map as a `---` fenced frontmatter block (no trailing newline). */
export function renderFrontmatter(data: Record<string, FrontmatterValue>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(renderScalar).join(", ")}]`);
    else if (typeof value === "boolean") lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${renderScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** Parse a `---` fenced block + body. Returns empty data when no frontmatter is present. */
export function parseFrontmatter(text: string): { data: Record<string, FrontmatterValue>; body: string } {
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { data: {}, body: norm.trim() };
  const end = norm.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: norm.trim() };
  const block = norm.slice(4, end);
  const body = norm.slice(end + 4).replace(/^\n/, "").trim();
  const data: Record<string, FrontmatterValue> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) data[key] = parseValue(value);
  }
  return { data, body };
}
