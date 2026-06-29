/**
 * A tiny frontmatter parser for Dezin's SKILL.md — deliberately NOT full YAML.
 * Supported subset: a `---` fenced block of flat `key: value` lines where value
 * is a string, `true`/`false`, or a flow array `[a, b, c]`. Everything after the
 * closing fence is the body.
 */

export type FrontmatterValue = string | boolean | string[];

export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

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

export function parseFrontmatter(text: string): Frontmatter {
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
