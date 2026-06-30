/**
 * Pure parser for Claude Code's `--output-format stream-json --verbose` output.
 *
 * Each stdout line is a standalone JSON object. We extract the assistant text,
 * any file-writing tool uses, the final result, and the session id. Kept pure
 * (string in → struct out) so it is unit-tested with fixtures and no `claude` CLI.
 */

export interface ClaudeToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface ParsedClaudeStream {
  /** Concatenated assistant text (falls back to the final result string). */
  text: string;
  /** Tool uses observed, e.g. Write/Edit with their inputs. */
  toolUses: ClaudeToolUse[];
  /** The final result string, if a result event was seen. */
  result: string | null;
  /** True if the run ended in an error result. */
  isError: boolean;
  /** Claude Code session id, if present (for future --resume). */
  sessionId: string | null;
}

export interface AskUserQuestionExtraction {
  /** Assistant text with the Dezin control marker removed. */
  text: string;
  /** The question to show in Dezin's AskUserQuestion card, if present. */
  question: string | null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const ASK_USER_QUESTION_RE = /<dezin-ask-user-question>([\s\S]*?)<\/dezin-ask-user-question>/i;

export function extractAskUserQuestion(text: string): AskUserQuestionExtraction {
  const match = text.match(ASK_USER_QUESTION_RE);
  if (!match || match.index === undefined) return { text: text.trim(), question: null };
  const question = (match[1] ?? "").trim();
  const stripped = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
  return { text: stripped, question: question || null };
}

/** A live step in the agent's process, surfaced to the UI as it happens. */
export type ClaudeActivity = { kind: "text"; text: string } | { kind: "tool"; name: string; summary: string };

function base(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** Human one-liner for a tool use; returns null for tools too noisy to surface. */
function toolSummary(name: string, input: Record<string, unknown>): string | null {
  const file = str(input.file_path);
  switch (name) {
    case "Write":
      return `Writing ${file ? base(file) : "a file"}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${file ? base(file) : "a file"}`;
    case "Bash": {
      const cmd = str(input.command) ?? "";
      return `Running ${cmd.replace(/\s+/g, " ").slice(0, 48)}${cmd.length > 48 ? "…" : ""}`;
    }
    default:
      return null; // Read/Glob/Grep/TodoWrite/etc. — not worth a step
  }
}

/** Parse ONE stream-json line into live activity events (for incremental streaming). */
export function parseClaudeLine(line: string): ClaudeActivity[] {
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
  const out: ClaudeActivity[] = [];
  for (const raw of content) {
    const block = asObject(raw);
    if (!block) continue;
    if (block.type === "text") {
      const t = str(block.text);
      if (t && t.trim()) out.push({ kind: "text", text: t });
    } else if (block.type === "tool_use") {
      const name = str(block.name);
      if (name) {
        const summary = toolSummary(name, asObject(block.input) ?? {});
        if (summary) out.push({ kind: "tool", name, summary });
      }
    }
  }
  return out;
}

export function parseClaudeStream(input: string | string[]): ParsedClaudeStream {
  const lines = Array.isArray(input) ? input : input.split("\n");
  let text = "";
  const toolUses: ClaudeToolUse[] = [];
  let result: string | null = null;
  let isError = false;
  let sessionId: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // ignore non-JSON noise
    }
    const obj = asObject(parsed);
    if (!obj) continue;

    const sid = str(obj.session_id);
    if (sid) sessionId = sid;

    switch (obj.type) {
      case "assistant": {
        const message = asObject(obj.message);
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const raw of content) {
            const block = asObject(raw);
            if (!block) continue;
            if (block.type === "text") {
              const t = str(block.text);
              if (t) text += t;
            } else if (block.type === "tool_use") {
              const name = str(block.name);
              if (name) toolUses.push({ name, input: asObject(block.input) ?? {} });
            }
          }
        }
        break;
      }
      case "result": {
        const r = str(obj.result);
        if (r !== null) result = r;
        isError = obj.is_error === true || str(obj.subtype)?.startsWith("error") === true;
        break;
      }
      default:
        break; // system/user/other events carry no artifact text
    }
  }

  if (!text && result) text = result;
  return { text: text.trim(), toolUses, result, isError, sessionId };
}
