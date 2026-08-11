/**
 * Pure parser for Claude Code's `--output-format stream-json --verbose` output.
 *
 * Each stdout line is a standalone JSON object. We extract the assistant text,
 * tool uses/results, the final result, and the session id. Kept pure
 * (string in → struct out) so it is unit-tested with fixtures and no `claude` CLI.
 */

import type { AgentActivity } from "./types.ts";

export interface ClaudeToolUse {
  id: string | null;
  name: string;
  input: Record<string, unknown>;
}

/** Runtime identity emitted by the spawned Claude-compatible CLI itself. */
export interface ClaudeStreamInit {
  model: string | null;
  apiKeySource: string | null;
  cliVersion: string | null;
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
  /** The sole system/init envelope. Runners reject a missing or ambiguous init. */
  init: ClaudeStreamInit | null;
  /** Number of system/init envelopes observed in the stream, including safe re-announcements. */
  initCount: number;
  /** True when repeated init envelopes disagree about the runtime or execution. */
  initConflict: boolean;
}

export interface AskUserQuestionExtraction {
  /** Assistant text with the Dezin control marker removed. */
  text: string;
  /** The question to show in Dezin's AskUserQuestion card, if present. */
  question: string | null;
}

export interface FinalSummaryExtraction {
  /** Agent work narrative before the final summary marker. */
  processText: string;
  /** Final user-facing summary text. */
  summaryText: string;
  /** True only when a complete Dezin final summary boundary was found. */
  hadBoundary: boolean;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const ASK_USER_QUESTION_RE = /<dezin-ask-user-question>([\s\S]*?)<\/dezin-ask-user-question>/i;
export const FINAL_SUMMARY_START = "<dezin-final-summary>";
export const FINAL_SUMMARY_END = "</dezin-final-summary>";
const FINAL_SUMMARY_RE = /<dezin-final-summary>([\s\S]*?)<\/dezin-final-summary>/gi;

export function extractAskUserQuestion(text: string): AskUserQuestionExtraction {
  const match = text.match(ASK_USER_QUESTION_RE);
  if (!match || match.index === undefined) return { text: text.trim(), question: null };
  const question = (match[1] ?? "").trim();
  const stripped = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
  return { text: stripped, question: question || null };
}

export function extractFinalSummary(text: string): FinalSummaryExtraction {
  let last: RegExpMatchArray | null = null;
  FINAL_SUMMARY_RE.lastIndex = 0;
  for (const match of text.matchAll(FINAL_SUMMARY_RE)) last = match;
  if (!last || last.index === undefined) return { processText: "", summaryText: text.trim(), hadBoundary: false };

  const summaryText = (last[1] ?? "").trim();
  if (!summaryText) return { processText: "", summaryText: text.trim(), hadBoundary: false };

  return {
    processText: text.slice(0, last.index).trim(),
    summaryText,
    hadBoundary: true,
  };
}

/** A live step in the agent's process, surfaced to the UI as it happens. */
export type ClaudeActivity = AgentActivity;

const TOOL_CALL_ID_MAX_BYTES = 512;
const TOOL_INPUT_MAX_BYTES = 64 * 1024;
const TOOL_RESULT_MAX_BYTES = 64 * 1024;
const TOOL_DIFF_MAX_BYTES = 128 * 1024;

function boundedText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const marker = "\n… [truncated]";
  const available = maximumBytes - Buffer.byteLength(marker, "utf8");
  const output: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > available) break;
    output.push(character);
    bytes += size;
  }
  return `${output.join("")}${marker}`;
}

function validToolCallId(value: unknown): string | undefined {
  const id = str(value);
  return id && id.trim() === id && Buffer.byteLength(id, "utf8") <= TOOL_CALL_ID_MAX_BYTES
    ? id
    : undefined;
}

function serializedToolInput(input: Record<string, unknown>): string {
  const serialized = JSON.stringify(input, null, 2);
  if (Buffer.byteLength(serialized, "utf8") <= TOOL_INPUT_MAX_BYTES) return serialized;
  return JSON.stringify({
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    preview: boundedText(serialized, 8 * 1024),
  }, null, 2);
}

function contentLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split("\n");
  if (value.endsWith("\n")) lines.pop();
  return lines;
}

function diffLines(prefix: "-" | "+", lines: readonly string[]): string {
  return lines.map((line) => `${prefix}${line}`).join("\n");
}

function diffPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/[\r\n]/g, "").replace(/^\/+/, "") || "unknown";
}

function replacementHunk(before: string, after: string): string {
  const beforeLines = contentLines(before);
  const afterLines = contentLines(after);
  return [
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    diffLines("-", beforeLines),
    diffLines("+", afterLines),
  ].filter(Boolean).join("\n");
}

/** Exact provider patch projection. It never inspects the human summary or guesses file state. */
function toolDiff(name: string, input: Record<string, unknown>): string | undefined {
  const explicit = str(input.diff) ?? str(input.patch);
  if (explicit) return boundedText(explicit, TOOL_DIFF_MAX_BYTES);
  const file = diffPath(str(input.file_path) ?? "unknown");
  if (name === "Edit") {
    const before = str(input.old_string);
    const after = str(input.new_string);
    if (before === null || after === null) return undefined;
    const budget = Math.floor(TOOL_DIFF_MAX_BYTES / 4);
    return [
      `--- a/${file}`,
      `+++ b/${file}`,
      replacementHunk(boundedText(before, budget), boundedText(after, budget)),
    ].join("\n");
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const replacementBudget = Math.max(256, Math.floor(TOOL_DIFF_MAX_BYTES / Math.max(4, input.edits.length * 4)));
    const replacements = input.edits.flatMap((candidate) => {
      const edit = asObject(candidate);
      const before = str(edit?.old_string);
      const after = str(edit?.new_string);
      return before === null || after === null
        ? []
        : [replacementHunk(boundedText(before, replacementBudget), boundedText(after, replacementBudget))];
    });
    if (replacements.length > 0) {
      return boundedText(`--- a/${file}\n+++ b/${file}\n${replacements.join("\n")}`, TOOL_DIFF_MAX_BYTES);
    }
  }
  return undefined;
}

function toolResultText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? boundedText(value, TOOL_RESULT_MAX_BYTES) : null;
  if (Array.isArray(value)) {
    const text = value.flatMap((candidate) => {
      const block = asObject(candidate);
      const content = str(block?.text) ?? str(block?.content);
      return content === null ? [] : [content];
    }).join("\n");
    if (text.trim()) return boundedText(text, TOOL_RESULT_MAX_BYTES);
  }
  if (value !== undefined && value !== null) {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized?.trim()) return boundedText(serialized, TOOL_RESULT_MAX_BYTES);
  }
  return null;
}

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
    case "Read":
      return `Reading ${file ? base(file) : "a file"}`;
    case "Grep":
    case "Glob":
      return "Searching project files";
    case "WebSearch":
      return "Searching the web";
    default:
      return null;
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
  if (!obj || (obj.type !== "assistant" && obj.type !== "user")) return [];
  const content = asObject(obj.message)?.content;
  if (!Array.isArray(content)) return [];
  const out: ClaudeActivity[] = [];
  for (const raw of content) {
    const block = asObject(raw);
    if (!block) continue;
    if (obj.type === "assistant" && block.type === "text") {
      const t = str(block.text);
      if (t && t.trim()) out.push({ kind: "text", text: t });
    } else if (obj.type === "assistant" && block.type === "tool_use") {
      const name = str(block.name);
      if (name) {
        const input = asObject(block.input) ?? {};
        const summary = toolSummary(name, input);
        if (summary) {
          const toolCallId = validToolCallId(block.id);
          const diff = toolDiff(name, input);
          out.push({
            kind: "tool",
            name,
            summary,
            ...(toolCallId === undefined ? {} : { toolCallId }),
            toolInput: serializedToolInput(input),
            ...(diff === undefined ? {} : { diff }),
          });
        }
      }
    } else if (obj.type === "user" && block.type === "tool_result") {
      const toolCallId = validToolCallId(block.tool_use_id);
      const toolResult = toolResultText(block.content);
      if (toolCallId !== undefined && toolResult !== null) out.push({
        kind: "tool-result",
        toolCallId,
        toolResult,
        toolResultError: block.is_error === true,
      });
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
  let init: ClaudeStreamInit | null = null;
  let initCount = 0;
  let initExecutionKey: string | null = null;
  let initHasStableExecutionId = false;
  let initConflict = false;

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
      case "system": {
        if (obj.subtype !== "init") break;
        initCount += 1;
        const candidate: ClaudeStreamInit = {
          model: str(obj.model),
          apiKeySource: str(obj.apiKeySource),
          cliVersion: str(obj.claude_code_version) ?? str(obj.cli_version) ?? str(obj.version),
        };
        // CodeBuddy re-emits system/init after an unavailable-tool recovery. That is
        // one execution, not an ambiguous identity, when both its runtime identity
        // and stable execution identifiers remain identical. Volatile timestamps are
        // deliberately excluded. A changed session/request still fails closed.
        const stableExecutionIds = [str(obj.session_id), str(obj.uuid), str(obj._requestId)];
        const candidateHasStableExecutionId = stableExecutionIds.some((value) => value !== null);
        const candidateExecutionKey = JSON.stringify([
          candidate.model,
          candidate.apiKeySource,
          candidate.cliVersion,
          ...stableExecutionIds,
        ]);
        if (initCount === 1) {
          init = candidate;
          initExecutionKey = candidateExecutionKey;
          initHasStableExecutionId = candidateHasStableExecutionId;
        } else if (!initHasStableExecutionId || !candidateHasStableExecutionId
          || candidateExecutionKey !== initExecutionKey) {
          initConflict = true;
        }
        break;
      }
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
              if (name) toolUses.push({ id: validToolCallId(block.id) ?? null, name, input: asObject(block.input) ?? {} });
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
  return { text: text.trim(), toolUses, result, isError, sessionId, init, initCount, initConflict };
}
