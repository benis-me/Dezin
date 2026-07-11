import type { QualityFinding } from "../lib/api.ts";
import type { ResearchCardData } from "./ResearchViews.tsx";

export interface ResultMeta {
  passed?: boolean;
  score?: number | null;
  rounds?: number;
  error?: boolean;
  status?: "done" | "stopped" | "failed";
  materialSources?: string[];
  /** False when Visual Review was on but the critic never rendered/judged (only anti-slop ran). */
  designReviewed?: boolean;
  /** Count of defects the auto-fixer repeatedly failed to resolve (gave up on). */
  unresolved?: number;
}

export interface Msg {
  id: number;
  dbId?: string;
  kind: "user" | "assistant" | "result" | "process" | "question" | "visual-review" | "direction-gate" | "research";
  text: string;
  directions?: Array<{ slug: string; title: string; markdown: string }>;
  /** Live + final state of the pre-design Research phase (its dedicated card). */
  research?: ResearchCardData;
  meta?: ResultMeta;
  steps?: string[];
  items?: LiveItem[];
  visualReview?: VisualReviewState;
  elapsedMs?: number;
  runId?: string;
  /** DB createdAt — used to link a Versions run back to its triggering message. */
  at?: number;
}

export type RunCardStackPosition = "single" | "first" | "middle" | "last";
export type TranscriptRow = { kind: "single"; message: Msg } | { kind: "stack"; messages: Msg[] };
export type TranscriptBlock =
  | { kind: "row"; row: TranscriptRow }
  | { kind: "assistant-turn"; prelude?: Msg[]; message: Msg; stack?: Msg[] };

/** A live, ordered chunk of the agent's turn — assistant prose or a tool step — so the two
 *  render interleaved (chronologically) during generation, not split into separate blocks. */
export type LiveItem = { type: "text"; text: string } | { type: "tool"; summary: string };

export interface VisualReviewState {
  status: "running" | "complete";
  runId?: string;
  enabled?: boolean;
  round?: number;
  agentCommand?: string;
  model?: string;
  screenshotUrl?: string;
  screenshotPath?: string;
  summary?: string;
  findings: QualityFinding[];
  process: LiveItem[];
}

function isRunCardMessage(message: Msg): boolean {
  return message.kind === "process" || message.kind === "result" || message.kind === "visual-review";
}

function isStepsMessage(message: Msg | undefined): message is Msg {
  return message?.kind === "process" && (message.steps?.length ?? 0) > 0;
}

function isTurnProcessMessage(message: Msg | undefined): message is Msg {
  return message?.kind === "process" && (message.items?.length ?? 0) > 0;
}

function shouldSplitRunCardStack(current: Msg, next: Msg): boolean {
  return current.kind === "visual-review" && isTurnProcessMessage(next);
}

export function liveText(items: LiveItem[]): string {
  return items
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
}

function processSummaryText(message: Msg): string {
  return message.kind === "process" && message.items ? liveText(message.items).replace(/\s+/g, " ").trim() : "";
}

function stripDuplicatedProcessText(message: Msg, summary?: string): Msg | null {
  if (message.kind !== "process" || !message.items?.length) return message;
  const normalizedSummary = (summary ?? "").replace(/\s+/g, " ").trim();
  const normalizedProcessText = processSummaryText(message);
  if (!normalizedSummary || normalizedSummary !== normalizedProcessText) return message;
  const items = message.items.filter((item): item is { type: "tool"; summary: string } => item.type === "tool");
  if (!items.length && !message.steps?.length) return null;
  return { ...message, items };
}

export function normalizeTranscriptMessages(messages: Msg[]): Msg[] {
  const normalized: Msg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!;
    if (current.kind === "process" && current.items?.length) {
      const next = messages[i + 1];
      const assistant = isStepsMessage(next) ? messages[i + 2] : next;
      const cleaned = stripDuplicatedProcessText(current, assistant?.kind === "assistant" ? assistant.text : undefined);
      if (cleaned) normalized.push(cleaned);
      continue;
    }
    if (isStepsMessage(current) && messages[i - 1]?.kind === "process" && messages[i + 1]?.kind === "assistant") {
      continue;
    }
    normalized.push(current);
    if (current.kind === "assistant" && messages[i - 2]?.kind === "process" && isStepsMessage(messages[i - 1])) {
      normalized.push(messages[i - 1]!);
    }
  }
  return normalized;
}

export function groupRunCardMessages(source: Msg[]): TranscriptRow[] {
  const messages = normalizeTranscriptMessages(source);
  const rows: TranscriptRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (!isRunCardMessage(message)) {
      rows.push({ kind: "single", message });
      continue;
    }
    const start = i;
    while (
      i + 1 < messages.length &&
      isRunCardMessage(messages[i + 1]!) &&
      !shouldSplitRunCardStack(messages[i]!, messages[i + 1]!)
    )
      i++;
    const group = messages.slice(start, i + 1);
    rows.push(group.length > 1 ? { kind: "stack", messages: group } : { kind: "single", message });
  }
  return rows;
}

export function groupAssistantTurns(rows: TranscriptRow[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === "single" && isTurnProcessMessage(row.message)) {
      const next = rows[i + 1];
      if (next?.kind === "single" && next.message.kind === "assistant") {
        const after = rows[i + 2];
        if (after?.kind === "stack") {
          blocks.push({ kind: "assistant-turn", prelude: [row.message], message: next.message, stack: after.messages });
          i += 2;
        } else {
          blocks.push({ kind: "assistant-turn", prelude: [row.message], message: next.message });
          i++;
        }
        continue;
      }
    }
    if (row.kind === "single" && row.message.kind === "assistant") {
      const next = rows[i + 1];
      if (next?.kind === "stack") {
        blocks.push({ kind: "assistant-turn", message: row.message, stack: next.messages });
        i++;
      } else {
        blocks.push({ kind: "assistant-turn", message: row.message });
      }
      continue;
    }
    blocks.push({ kind: "row", row });
  }
  return blocks;
}

export function runCardStackPosition(index: number, total: number): RunCardStackPosition {
  if (total <= 1) return "single";
  if (index === 0) return "first";
  if (index === total - 1) return "last";
  return "middle";
}

export function runCardRadiusClass(position: RunCardStackPosition): string {
  if (position === "first") return "rounded-t-lg";
  if (position === "middle") return "rounded-none";
  if (position === "last") return "rounded-b-lg";
  return "rounded-lg";
}
