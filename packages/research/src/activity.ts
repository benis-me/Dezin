/**
 * Parse the research agent's `--output-format stream-json` output into live
 * activity steps for the UI. Research is otherwise a black box; this surfaces
 * what it is actually doing — searching, fetching, downloading, writing — so the
 * workspace can show a live Research card instead of a silent spinner. Pure.
 */

/** One live step in the research agent's process, surfaced to the UI. */
export type ResearchActivity =
  | { kind: "search"; text: string }
  | { kind: "fetch"; text: string }
  | { kind: "download"; text: string }
  | { kind: "write"; text: string }
  | { kind: "note"; text: string };

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function base(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}
function domain(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u.slice(0, 60);
  }
}

/** Map a single tool_use to a research step, or null if it's not worth surfacing. */
function toolActivity(name: string, input: Record<string, unknown>): ResearchActivity | null {
  switch (name) {
    case "WebSearch":
      return { kind: "search", text: (str(input.query) || "the web").slice(0, 80) };
    case "WebFetch":
      return { kind: "fetch", text: domain(str(input.url) || str(input.prompt)) };
    case "Write": {
      const f = base(str(input.file_path));
      return f ? { kind: "write", text: f } : null;
    }
    case "Bash": {
      const cmd = str(input.command);
      if (/\b(curl|wget)\b/.test(cmd)) {
        const m = cmd.match(/https?:\/\/[^\s'"]+/);
        const url = m?.[0] ?? "";
        return { kind: "download", text: url ? base(url.split("?")[0]!) || domain(url) : "an asset" };
      }
      return null; // other shell noise isn't a research step
    }
    default:
      return null; // Read/Glob/Grep/TodoWrite/etc.
  }
}

/** Parse ONE stream-json line into research activity steps (for incremental streaming). */
export function parseResearchActivity(line: string): ResearchActivity[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const obj = asObject(parsed);
  if (!obj || obj.type !== "assistant") return [];
  const content = asObject(obj.message)?.content;
  if (!Array.isArray(content)) return [];
  const out: ResearchActivity[] = [];
  for (const raw of content) {
    const block = asObject(raw);
    if (!block) continue;
    if (block.type === "text") {
      const t = str(block.text).trim();
      if (t) out.push({ kind: "note", text: (t.split("\n")[0] ?? "").slice(0, 140) });
    } else if (block.type === "tool_use") {
      const a = toolActivity(str(block.name), asObject(block.input) ?? {});
      if (a) out.push(a);
    }
  }
  return out;
}
