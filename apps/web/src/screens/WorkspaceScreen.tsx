import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, CircleAlert, Copy, CornerUpLeft, Download, Eye, FileCode2, Folder, GitFork, GripVertical, History, Maximize2, Monitor, MousePointerClick, PanelsTopLeft, Paperclip, RotateCw, Settings, ShieldCheck, Smartphone, Sparkles, Square, Tablet, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FadeIn,
  IconButton,
  PanelBar,
  Segmented,
  Spinner,
  Tabs,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  type TabItem,
} from "../components/ui/index.ts";
import { diffLines, diffStat, type DiffLine } from "../lib/diff.ts";
import { PreviewModal } from "../components/PreviewModal.tsx";
import { AttachMenu } from "../components/AttachMenu.tsx";
import {
  AgentComposerContextCards,
  removeContextItem,
  upsertContextItems,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
import { ConversationSelect } from "../components/ConversationSelect.tsx";
import { VersionCompare } from "../components/VersionCompare.tsx";
import { VariantSwitcher } from "../components/VariantSwitcher.tsx";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { DesignSystemSelect } from "../components/DesignSystemSelect.tsx";
import { DesignSystemDetailScreen } from "./DesignSystemDetailScreen.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { navigate } from "../router.tsx";
import { persistAgentModelDefaults } from "../lib/agent-model-defaults.ts";
import { setPendingAgent, setPendingBrief, takePendingBrief, takePendingImages, takePendingAgent, takePendingModel, takePendingRefs } from "../lib/pending-brief.ts";
import type { Conversation, Variant, DesignSystemCard, Message, Moodboard, Project, ProjectFile, ProjectMode, QualityFinding, RunEvent, RunSummary, Settings as AppSettings, SetupPhase } from "../lib/api.ts";
import { fetchProjectArtifact, slugify, toBase64 } from "../lib/project-ref.ts";
import { panelPercentFromPixels, readPanelPercent, readStoredPanelPercent, RESIZE_SEPARATOR_CLASS, savePanelFraction, twoPanelLayout } from "../lib/panel-layout.ts";
import { previewBridgeOriginForSrc, previewSandboxForSrc } from "../lib/preview-sandbox.ts";
import { cn } from "../lib/utils.ts";

const TABS = ["Preview", "Files", "Quality", "Versions"] as const;
type Tab = (typeof TABS)[number];

type Device = "desktop" | "tablet" | "mobile";
const DEVICE_WIDTH: Record<Device, string> = { desktop: "100%", tablet: "768px", mobile: "390px" };
type MoodboardRunRef = { id: string; name?: string };
type QueuedPrompt = { text: string; moodboardRefs?: MoodboardRunRef[] };
type PreviewBusyState = { title: string; detail?: string };
type WorkspaceContextItem = AgentComposerContextItem<MarkupTarget>;

const SEVERITY_STYLE: Record<string, string> = {
  P0: "border-destructive text-destructive",
  P1: "border-border-strong text-foreground",
  P2: "border-border text-muted-foreground",
};

const SPLIT_KEY = "dezin.workspace.split";
const FILES_SPLIT_KEY = "dezin.workspace.files.split";
const INSPECT_SPLIT_KEY = "dezin.workspace.inspect.split";
const WORKSPACE_CONVERSATION_PANEL = "conversation";
const WORKSPACE_ARTIFACT_PANEL = "artifact";
const FILES_BROWSER_PANEL = "browser";
const FILES_PREVIEW_PANEL = "preview";
const PREVIEW_CANVAS_PANEL = "preview-canvas";
const PREVIEW_INSPECT_PANEL = "inspect";
const REPLAYABLE_RUN_STATUSES = new Set(["running", "pending", "cancelled", "failed"]);
const SHOW_VARIANT_FANOUT_BUTTON: boolean = false;
const ACTIVE_TOOL_BUTTON_CLASS = "!bg-primary !text-primary-foreground hover:!bg-primary hover:!text-primary-foreground";
const FLOATING_COMPOSER_FADE_PX = 48;
const SCROLL_TO_BOTTOM_GAP_PX = 12;
const MESSAGE_BOTTOM_CLEARANCE_PX = 44;

function hasDraggedFiles(event: ReactDragEvent<Element>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files") || (event.dataTransfer?.files?.length ?? 0) > 0;
}

function queueKey(projectId: string): string {
  return `dezin.workspace.queue.${projectId}`;
}

function readQueue(projectId: string): QueuedPrompt[] {
  if (projectId === "new") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(queueKey(projectId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): QueuedPrompt | null => {
        if (typeof item === "string") {
          const text = item.trim();
          return text ? { text } : null;
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const record = item as Record<string, unknown>;
        const text = typeof record.text === "string" ? record.text.trim() : "";
        if (!text) return null;
        const refs = Array.isArray(record.moodboardRefs)
          ? record.moodboardRefs
              .map((ref): MoodboardRunRef | null => {
                if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
                const refRecord = ref as Record<string, unknown>;
                const id = typeof refRecord.id === "string" ? refRecord.id.trim() : "";
                if (!id) return null;
                const name = typeof refRecord.name === "string" && refRecord.name.trim() ? refRecord.name.trim() : undefined;
                return { id, name };
              })
              .filter((ref): ref is MoodboardRunRef => ref !== null)
          : [];
        return refs.length ? { text, moodboardRefs: refs } : { text };
      })
      .filter((item): item is QueuedPrompt => item !== null);
  } catch {
    return [];
  }
}

type PreviewBridgeMessage = {
  source: "dezin";
  type?: string;
  selector?: string;
  tag?: string;
  text?: string;
  rect?: { x: number; y: number; w: number; h: number };
  styles?: MarkupStyles;
  attrs?: MarkupAttributes;
};

export function isPreviewBridgeMessage(event: MessageEvent, iframe: HTMLIFrameElement | null, previewSrc?: string | null): event is MessageEvent<PreviewBridgeMessage> {
  const data = event.data as Partial<PreviewBridgeMessage> | null;
  return Boolean(
    data &&
      typeof data === "object" &&
      data.source === "dezin" &&
      iframe?.contentWindow &&
      event.source === iframe.contentWindow &&
      event.origin === previewBridgeOriginForSrc(previewSrc),
  );
}

function moodboardReferenceLine(refs: MoodboardRunRef[]): string {
  if (!refs.length) return "";
  const names = refs.map((ref) => `${ref.name?.trim() || "Untitled moodboard"} (${ref.id})`).join(", ");
  return `\n\nMoodboard references (available to the Agent at run time): ${names}`;
}

function writeQueue(projectId: string, queue: QueuedPrompt[]): void {
  if (projectId === "new") return;
  try {
    localStorage.setItem(queueKey(projectId), JSON.stringify(queue));
  } catch {
    /* localStorage may be unavailable */
  }
}

interface ResultMeta {
  passed?: boolean;
  score?: number | null;
  rounds?: number;
  error?: boolean;
  status?: "done" | "stopped" | "failed";
  materialSources?: string[];
}
interface Msg {
  id: number;
  dbId?: string;
  kind: "user" | "assistant" | "result" | "process" | "question" | "visual-review";
  text: string;
  meta?: ResultMeta;
  steps?: string[];
  items?: LiveItem[];
  visualReview?: VisualReviewState;
  elapsedMs?: number;
  runId?: string;
  /** DB createdAt — used to link a Versions run back to its triggering message. */
  at?: number;
}

type RunCardStackPosition = "single" | "first" | "middle" | "last";
type TranscriptRow = { kind: "single"; message: Msg } | { kind: "stack"; messages: Msg[] };
type TranscriptBlock =
  | { kind: "row"; row: TranscriptRow }
  | { kind: "assistant-turn"; message: Msg; stack?: Msg[] };

/** A live, ordered chunk of the agent's turn — assistant prose or a tool step — so the two
 *  render interleaved (chronologically) during generation, not split into separate blocks. */
type LiveItem = { type: "text"; text: string } | { type: "tool"; summary: string };

interface VisualReviewState {
  status: "running" | "complete";
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

function normalizeTranscriptMessages(messages: Msg[]): Msg[] {
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

function groupRunCardMessages(source: Msg[]): TranscriptRow[] {
  const messages = normalizeTranscriptMessages(source);
  const rows: TranscriptRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isRunCardMessage(message)) {
      rows.push({ kind: "single", message });
      continue;
    }
    const start = i;
    while (i + 1 < messages.length && isRunCardMessage(messages[i + 1])) i++;
    const group = messages.slice(start, i + 1);
    rows.push(group.length > 1 ? { kind: "stack", messages: group } : { kind: "single", message });
  }
  return rows;
}

function groupAssistantTurns(rows: TranscriptRow[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
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

function runCardStackPosition(index: number, total: number): RunCardStackPosition {
  if (total <= 1) return "single";
  if (index === 0) return "first";
  if (index === total - 1) return "last";
  return "middle";
}

function runCardRadiusClass(position: RunCardStackPosition): string {
  if (position === "first") return "rounded-t-lg";
  if (position === "middle") return "rounded-none";
  if (position === "last") return "rounded-b-lg";
  return "rounded-lg";
}

interface MarkupRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MarkupStyles {
  display?: string;
  position?: string;
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
  zIndex?: string;
  width?: string;
  height?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;
  maxHeight?: string;
  overflow?: string;
  overflowX?: string;
  overflowY?: string;
  flexDirection?: string;
  flexWrap?: string;
  justifyContent?: string;
  alignItems?: string;
  alignContent?: string;
  gap?: string;
  rowGap?: string;
  columnGap?: string;
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  padding?: string;
  margin?: string;
  color?: string;
  background?: string;
  backgroundImage?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  textTransform?: string;
  borderRadius?: string;
  opacity?: string;
  borderColor?: string;
  borderWidth?: string;
  borderStyle?: string;
  borderTopColor?: string;
  borderTopWidth?: string;
  borderTopStyle?: string;
  borderRightColor?: string;
  borderRightWidth?: string;
  borderRightStyle?: string;
  borderBottomColor?: string;
  borderBottomWidth?: string;
  borderBottomStyle?: string;
  borderLeftColor?: string;
  borderLeftWidth?: string;
  borderLeftStyle?: string;
  outlineColor?: string;
  outlineWidth?: string;
  outlineStyle?: string;
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
  transform?: string;
  mixBlendMode?: string;
}

interface MarkupAttributes {
  id?: string;
  className?: string;
  role?: string;
  ariaLabel?: string;
  screenLabel?: string;
  href?: string;
  src?: string;
}

interface MarkupTarget {
  selector: string;
  tag: string;
  text: string;
  rect?: MarkupRect;
  note?: string;
  styles?: MarkupStyles;
  attrs?: MarkupAttributes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function normalizeFindings(value: unknown): QualityFinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((f): f is QualityFinding => {
    if (!isRecord(f)) return false;
    return typeof f.id === "string" && typeof f.message === "string" && typeof f.severity === "string" && (f.fix === undefined || typeof f.fix === "string");
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isVisualFinding(finding: QualityFinding): boolean {
  return finding.id.startsWith("visual-");
}

function isAgentVisualFinding(finding: QualityFinding): boolean {
  return finding.id.startsWith("visual-ai-review-") || finding.id === "visual-agent-review-failed" || finding.id === "visual-screenshot-missing";
}

function isVisualFailureFinding(finding: QualityFinding): boolean {
  return [
    "visual-qa-failed",
    "visual-devserver-unavailable",
    "visual-chrome-unavailable",
    "visual-render-failed",
    "visual-screenshot-missing",
    "visual-agent-review-failed",
    "visual-artifact-missing",
  ].includes(finding.id);
}

function reviewerLabel(input: { agentCommand?: string; model?: string }): string {
  return [input.agentCommand, input.model].filter((value): value is string => !!value && value.trim().length > 0).join(" / ") || "selected reviewer";
}

function firstVisualReviewFinding(findings: QualityFinding[]): QualityFinding | undefined {
  return findings.find((finding) => isAgentVisualFinding(finding) && (finding.screenshotUrl || finding.screenshotPath || finding.reviewSummary));
}

function visualReviewFindingSummary(findings: QualityFinding[]): string | undefined {
  return firstVisualReviewFinding(findings)?.reviewSummary;
}

function visualReviewScreenshotUrl(findings: QualityFinding[]): string | undefined {
  return firstVisualReviewFinding(findings)?.screenshotUrl;
}

function visualReviewScreenshotPath(findings: QualityFinding[]): string | undefined {
  return firstVisualReviewFinding(findings)?.screenshotPath;
}

function visualReviewStatusText(review: VisualReviewState): string {
  if (review.status === "running") return "Running";
  if (review.enabled === false) return "Skipped";
  if (review.findings.length > 0) return `${review.findings.length} issue${review.findings.length === 1 ? "" : "s"}`;
  return "Clean";
}

function visualReviewResultText(review: VisualReviewState): string {
  if (review.status === "running") return "Waiting for screenshot review result.";
  if (review.enabled === false) return "Visual review was disabled for this run.";
  if (review.summary) return review.summary;
  const findingSummary = visualReviewFindingSummary(review.findings);
  if (findingSummary) return findingSummary;
  if (review.findings.length > 0) return `${review.findings.length} screenshot issue${review.findings.length === 1 ? "" : "s"} reported.`;
  return "Screenshot review completed with no visible layout issues reported.";
}

function visualReviewQualitySummary(findings: QualityFinding[]): { screenshotUrl?: string; screenshotPath?: string; summary?: string } | null {
  const finding = firstVisualReviewFinding(findings);
  if (!finding) return null;
  return {
    screenshotUrl: finding.screenshotUrl,
    screenshotPath: finding.screenshotPath,
    summary: finding.reviewSummary,
  };
}

type QualityLaneStatus = "passed" | "issues" | "failed" | "running" | "not-run" | "not-recorded";

interface QualityCheckState {
  staticRan: boolean;
  visualRan: boolean;
  visualEnabled: boolean | null;
  source: "none" | "live" | "persisted";
}

interface QualityLane {
  key: "static" | "geometry" | "agent";
  label: string;
  desc: string;
  status: QualityLaneStatus;
  findings: QualityFinding[];
}

function qualityStatusText(status: QualityLaneStatus): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "issues":
      return "Issues";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "not-run":
      return "Not run";
    case "not-recorded":
      return "Not recorded";
  }
}

function qualityStatusClass(status: QualityLaneStatus): string {
  if (status === "passed") return "border-success/25 bg-success/10 text-success";
  if (status === "issues") return "border-border-strong bg-surface-2 text-foreground";
  if (status === "failed") return "border-destructive/35 bg-destructive/10 text-destructive";
  if (status === "running") return "border-accent/25 bg-accent/10 text-accent-foreground";
  return "border-border bg-surface-2 text-muted-foreground";
}

function laneStatus(input: {
  findings: QualityFinding[];
  ran: boolean;
  running: boolean;
  ranOnce: boolean;
  disabled?: boolean;
  failure?: boolean;
}): QualityLaneStatus {
  if (input.disabled) return "not-run";
  if (input.findings.length > 0) return input.failure ? "failed" : "issues";
  if (input.ran) return "passed";
  if (input.running) return "running";
  return input.ranOnce ? "not-recorded" : "not-run";
}

function buildQualityLanes(input: {
  findings: QualityFinding[];
  score: number | null;
  ranOnce: boolean;
  running: boolean;
  checks: QualityCheckState;
}): QualityLane[] {
  const staticFindings = input.findings.filter((finding) => !isVisualFinding(finding));
  const visualFindings = input.findings.filter(isVisualFinding);
  const geometryFindings = visualFindings.filter((finding) => !isAgentVisualFinding(finding));
  const agentFindings = visualFindings.filter(isAgentVisualFinding);
  const staticRan = input.checks.staticRan || input.score !== null || staticFindings.length > 0;
  const visualRan = input.checks.visualRan || visualFindings.length > 0;
  const visualDisabled = input.checks.visualEnabled === false;

  return [
    {
      key: "static",
      label: "Static anti-slop",
      desc: "Rules from the generated artifact and design lint.",
      status: laneStatus({ findings: staticFindings, ran: staticRan, running: input.running, ranOnce: input.ranOnce }),
      findings: staticFindings,
    },
    {
      key: "geometry",
      label: "Geometry",
      desc: "Viewport overflow, clipping, blank renders, and fixed-position defects.",
      status: laneStatus({
        findings: geometryFindings,
        ran: visualRan,
        running: input.running && input.checks.visualEnabled !== false,
        ranOnce: input.ranOnce,
        disabled: visualDisabled,
        failure: geometryFindings.some(isVisualFailureFinding),
      }),
      findings: geometryFindings,
    },
    {
      key: "agent",
      label: "Agent visual review",
      desc: "Screenshot review by the selected Agent with the current conversation context.",
      status: laneStatus({
        findings: agentFindings,
        ran: visualRan,
        running: input.running && input.checks.visualEnabled !== false,
        ranOnce: input.ranOnce,
        disabled: visualDisabled,
        failure: agentFindings.some(isVisualFailureFinding),
      }),
      findings: agentFindings,
    },
  ];
}

function normalizeResultMeta(value: unknown): ResultMeta | undefined {
  if (!isRecord(value)) return undefined;
  const meta: ResultMeta = {};
  if (typeof value.passed === "boolean") meta.passed = value.passed;
  if (typeof value.score === "number" || value.score === null) meta.score = value.score;
  if (typeof value.rounds === "number") meta.rounds = value.rounds;
  if (typeof value.error === "boolean") meta.error = value.error;
  if (value.status === "done" || value.status === "stopped" || value.status === "failed") meta.status = value.status;
  if (Array.isArray(value.materialSources)) meta.materialSources = value.materialSources.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return meta;
}

function normalizeLiveItems(value: unknown): LiveItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): LiveItem[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) return [{ type: "text", text: item.text }];
    if (item.type === "tool" && typeof item.summary === "string" && item.summary.trim()) return [{ type: "tool", summary: item.summary }];
    return [];
  });
}

function normalizeVisualReview(value: unknown): VisualReviewState | null {
  if (!isRecord(value)) return null;
  return {
    status: value.status === "running" ? "running" : "complete",
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    round: typeof value.round === "number" ? value.round : undefined,
    agentCommand: optionalString(value.agentCommand),
    model: optionalString(value.model),
    screenshotUrl: optionalString(value.screenshotUrl),
    screenshotPath: optionalString(value.screenshotPath),
    summary: optionalString(value.summary),
    findings: normalizeFindings(value.findings),
    process: normalizeLiveItems(value.process),
  };
}

function briefToName(brief: string): string {
  const t = brief.trim().replace(/\s+/g, " ");
  return t.length === 0 ? "Untitled" : t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function convLabel(c: Pick<Conversation, "title">, i: number): string {
  return c.title && c.title !== "Untitled" ? c.title : `Conversation ${i + 1}`;
}

function toMsg(m: Message, id: number): Msg {
  if (m.role === "system") {
    // Persisted process/result records are JSON blobs stored by the daemon.
    try {
      const parsed = JSON.parse(m.content) as unknown;
      if (isRecord(parsed) && isRecord(parsed.result) && typeof parsed.result.text === "string") {
        return { id, dbId: m.id, kind: "result", text: parsed.result.text, meta: normalizeResultMeta(parsed.result.meta), at: m.createdAt };
      }
      if (isRecord(parsed) && isRecord(parsed.question) && typeof parsed.question.text === "string") {
        return {
          id,
          dbId: m.id,
          kind: "question",
          text: parsed.question.text,
          runId: typeof parsed.question.runId === "string" ? parsed.question.runId : undefined,
          at: m.createdAt,
        };
      }
      if (isRecord(parsed) && isRecord(parsed.process)) {
        const items = normalizeLiveItems(parsed.process.items);
        const elapsedMs = typeof parsed.process.elapsedMs === "number" ? parsed.process.elapsedMs : undefined;
        return { id, dbId: m.id, kind: "process", text: "", items, elapsedMs, at: m.createdAt };
      }
      if (isRecord(parsed) && isRecord(parsed.visualReview)) {
        const visualReview = normalizeVisualReview(parsed.visualReview);
        if (visualReview) return { id, dbId: m.id, kind: "visual-review", text: "", visualReview, at: m.createdAt };
      }
      if (isRecord(parsed) && Array.isArray(parsed.steps)) return { id, dbId: m.id, kind: "process", text: "", steps: parsed.steps as string[], at: m.createdAt };
    } catch {
      /* fall through */
    }
    return { id, dbId: m.id, kind: "process", text: "", steps: [], at: m.createdAt };
  }
  return { id, dbId: m.id, kind: m.role === "user" ? "user" : "assistant", text: m.content, at: m.createdAt };
}

const IMG_REF_RE = /\.refs\/[^\s,"'`)]+\.(?:png|jpe?g|gif|webp|svg|avif)/gi;
const RECT_RE = /x=(-?\d+)\s+y=(-?\d+)\s+w=(\d+)\s+h=(\d+)/;

function unquote(value: string): string {
  return value.trim().replace(/^["“`]+|["”`]+$/g, "");
}

function parseMarkupTargets(block: string): MarkupTarget[] {
  const targets: MarkupTarget[] = [];
  let currentIndex = -1;
  const start = (selector: string): MarkupTarget => {
    const target = { selector, tag: "", text: "" };
    targets.push(target);
    currentIndex = targets.length - 1;
    return target;
  };
  for (const line of block.split("\n")) {
    const modern = line.match(/^\s*-\s*selector:\s*`([^`]+)`/);
    if (modern) {
      start(modern[1]!.trim());
      continue;
    }
    const legacy = line.match(/^\s*-\s*`([^`]+)`(?:\s+\(“([^”]*)”\))?(?::\s*(.*))?/);
    if (legacy) {
      const target = start(legacy[1]!.trim());
      target.text = legacy[2]?.trim() ?? "";
      target.note = legacy[3]?.trim() || undefined;
      continue;
    }
    const target = targets[currentIndex];
    if (!target) continue;
    const attr = line.match(/^\s*(tag|rect|text|note):\s*(.*)$/);
    if (!attr) continue;
    const [, key, raw = ""] = attr;
    if (key === "tag") target.tag = unquote(raw);
    else if (key === "text") target.text = unquote(raw);
    else if (key === "note") target.note = unquote(raw) || undefined;
    else if (key === "rect") {
      const m = raw.match(RECT_RE);
      if (m) target.rect = { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
    }
  }
  return targets;
}

/** Split a user message into its prose and any attached image refs, dropping the
 *  auto-generated "(read them from disk): …" reference lines from the visible text. */
function parseUserMessage(text: string): { body: string; images: string[]; targets: MarkupTarget[] } {
  const images = [...new Set(text.match(IMG_REF_RE) ?? [])];
  const targets: MarkupTarget[] = [];
  const bodyParts: string[] = [];
  for (const part of text.split(/\n{2,}/)) {
    if (/read them from disk/i.test(part)) continue;
    if (/^Scoped edit\s+—/i.test(part.trim())) {
      targets.push(...parseMarkupTargets(part));
      continue;
    }
    bodyParts.push(part);
  }
  return { body: bodyParts.join("\n\n").trim(), images, targets };
}

function MarkupTargetCards({ targets, onTargetClick }: { targets: MarkupTarget[]; onTargetClick?: (target: MarkupTarget) => void }) {
  if (!targets.length) return null;
  return (
    <div className="flex w-full flex-col items-end gap-1.5">
      {targets.map((target, idx) => (
        <button
          key={`${target.selector}-${idx}`}
          type="button"
          aria-label={`Marked target ${target.selector}`}
          onClick={() => onTargetClick?.(target)}
          className="max-w-[88%] rounded-xl border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <div className="mb-1.5 flex items-center gap-1.5">
            <MousePointerClick size={12} strokeWidth={2} className="shrink-0 text-brand" />
            <span className="label-mono text-brand">Marked target</span>
            {target.tag ? <span className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{target.tag}</span> : null}
            {target.rect ? (
              <span className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {target.rect.w}x{target.rect.h}
              </span>
            ) : null}
          </div>
          <code className="block truncate font-mono text-[11px] text-foreground-2">{target.selector}</code>
          {target.text ? <p className="mt-1 truncate text-xs text-muted-foreground">"{target.text}"</p> : null}
          {target.note ? <p className="mt-1 text-xs leading-snug text-foreground">{target.note}</p> : null}
        </button>
      ))}
    </div>
  );
}

function quoteMarkupValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatMarkupTarget(target: MarkupTarget): string {
  const lines = [`- selector: \`${target.selector}\``];
  if (target.tag) lines.push(`  tag: ${target.tag}`);
  if (target.rect) lines.push(`  rect: x=${target.rect.x} y=${target.rect.y} w=${target.rect.w} h=${target.rect.h}`);
  if (target.text) lines.push(`  text: ${quoteMarkupValue(target.text)}`);
  if (target.note) lines.push(`  note: ${target.note}`);
  return lines.join("\n");
}

/** A user turn: attached images render as 1:1 thumbnails (hover to preview), right-aligned
 *  above the message bubble — instead of the raw ".refs/…" paths the agent reads from disk. */
function UserMessage({
  text,
  srcFor,
  onTargetClick,
}: {
  text: string;
  srcFor: (refPath: string) => string;
  onTargetClick?: (target: MarkupTarget) => void;
}) {
  const { body, images, targets } = parseUserMessage(text);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <MarkupTargetCards targets={targets} onTargetClick={onTargetClick} />
      {images.length ? (
        <TooltipProvider delayDuration={120}>
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((p) => {
              const src = srcFor(p);
              return (
                <Tooltip key={p}>
                  <TooltipTrigger asChild>
                    <img src={src} alt="reference" loading="lazy" className="size-12 cursor-zoom-in rounded-lg border border-border object-cover" />
                  </TooltipTrigger>
                  <TooltipContent className="overflow-hidden rounded-lg p-0">
                    <img src={src} alt="reference" className="max-h-72 max-w-[18rem] object-contain" />
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>
      ) : null}
      {body ? (
        <span className="dz-selectable max-w-[88%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-foreground">
          {body}
        </span>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shortTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const UNASSIGNED_VARIANT_ID = "__unassigned__";

interface VersionGroup {
  id: string;
  name: string;
  active: boolean;
  runs: RunSummary[];
}

function activeVariantIdOf(variants: Variant[]): string | null {
  return variants.find((v) => v.active)?.id ?? variants[0]?.id ?? null;
}

function buildVersionGroups(runs: RunSummary[], variants: Variant[]): VersionGroup[] {
  const fallbackVariantId = activeVariantIdOf(variants) ?? UNASSIGNED_VARIANT_ID;
  const byVariant = new Map<string, RunSummary[]>();
  for (const run of sortRunsNewestFirst(runs)) {
    const variantId = run.variantId ?? fallbackVariantId;
    const groupRuns = byVariant.get(variantId);
    if (groupRuns) groupRuns.push(run);
    else byVariant.set(variantId, [run]);
  }

  const known = new Set<string>();
  const groups = variants.map((variant) => {
    known.add(variant.id);
    return { id: variant.id, name: variant.name, active: !!variant.active, runs: byVariant.get(variant.id) ?? [] };
  });
  for (const [id, groupRuns] of byVariant) {
    if (!known.has(id)) {
      groups.push({ id, name: id === UNASSIGNED_VARIANT_ID ? "Unassigned" : "Archived branch", active: false, runs: groupRuns });
    }
  }

  return groups.filter((group) => group.runs.length > 0 || group.active || variants.length > 1);
}

function sortRunsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => {
    const created = b.createdAt - a.createdAt;
    if (created !== 0) return created;
    const finished = (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
    return finished;
  });
}

function cacheBustPreviewUrl(url: string): string {
  return `${url.split("?")[0]}?t=${Date.now()}`;
}

function isVersionPreviewSrc(projectId: string, src: string | null): boolean {
  return !!src && src.includes(`/api/projects/${projectId}/versions/`);
}

function PreviewBusyOverlay({ title, detail }: PreviewBusyState): ReactNode {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-surface/78 p-4 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-center shadow-pop">
        <Spinner size={18} />
        <div className="text-sm font-medium text-foreground">{title}</div>
        {detail ? <div className="text-xs leading-snug text-muted-foreground">{detail}</div> : null}
      </div>
    </div>
  );
}

function statusDotClass(status: string): string {
  if (status === "succeeded") return "bg-success";
  if (status === "failed") return "bg-destructive";
  if (status === "running" || status === "pending") return "bg-primary";
  return "bg-border-strong";
}

/** A folder-navigable file browser: breadcrumb + back/forward, double-click into folders. */
function FilesBrowser({ files, activeFile, onOpen }: { files: ProjectFile[]; activeFile: string | null; onOpen: (path: string) => void }) {
  const [history, setHistory] = useState<string[]>([""]);
  const [hi, setHi] = useState(0);
  const dir = history[hi]!;

  const go = (d: string): void => {
    if (d === dir) return;
    const next = history.slice(0, hi + 1);
    next.push(d);
    setHistory(next);
    setHi(next.length - 1);
  };

  const prefix = dir ? `${dir}/` : "";
  const folders = new Set<string>();
  const here: ProjectFile[] = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) folders.add(rest.slice(0, slash));
    else here.push(f);
  }
  const folderList = [...folders].sort();
  const fileList = here.sort((a, b) => a.path.localeCompare(b.path));
  const segs = dir ? dir.split("/") : [];

  return (
    <div className="flex h-full flex-col bg-surface">
      <PanelBar className="gap-1 px-2">
        <button
          type="button"
          aria-label="Back"
          disabled={hi === 0}
          onClick={() => setHi((i) => Math.max(0, i - 1))}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
        >
          <ChevronLeft size={15} strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={hi === history.length - 1}
          onClick={() => setHi((i) => Math.min(history.length - 1, i + 1))}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
        >
          <ChevronRight size={15} strokeWidth={2} />
        </button>
        <div className="ml-1 flex min-w-0 items-center gap-0.5 overflow-x-auto font-mono">
          <button type="button" onClick={() => go("")} className="rounded px-1 py-0.5 hover:text-foreground">
            project
          </button>
          {segs.map((s, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <span className="text-border-strong">/</span>
              <button type="button" onClick={() => go(segs.slice(0, i + 1).join("/"))} className="rounded px-1 py-0.5 hover:text-foreground">
                {s}
              </button>
            </span>
          ))}
        </div>
      </PanelBar>
      <ul className="flex-1 overflow-auto p-1.5 text-sm">
        {folderList.map((f) => (
          <li key={`d:${f}`}>
            <button
              type="button"
              title="Double-click to open folder"
              onDoubleClick={() => go(prefix + f)}
              onKeyDown={(e) => e.key === "Enter" && go(prefix + f)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-xs text-foreground-2 hover:bg-surface-2"
            >
              <Folder size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{f}</span>
            </button>
          </li>
        ))}
        {fileList.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onOpen(file.path)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left font-mono text-xs hover:bg-surface-2 ${
                file.path === activeFile ? "bg-surface-2 text-foreground" : "text-foreground-2"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileCode2 size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{file.path.slice(prefix.length)}</span>
              </span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeView({ name, text }: { name: string; text: string }) {
  const lines = text.length ? text.split("\n") : [""];
  return (
    <div className="flex h-full flex-col bg-card">
      <PanelBar className="font-mono">
        <FileCode2 size={13} strokeWidth={1.75} />
        {name}
        <span className="tnum ml-auto">{lines.length} lines</span>
      </PanelBar>
      <div className="flex-1 overflow-auto">
        <div className="flex min-h-full font-mono text-xs leading-[1.6]">
          <div
            aria-hidden
            className="sticky left-0 shrink-0 select-none border-r border-border bg-muted/30 py-3 pl-3 pr-2.5 text-right tabular-nums text-muted-foreground/50"
          >
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="flex-1 py-3 pl-4 pr-6 text-foreground-2">
            <code>{text}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

function FilesPanel({
  files,
  activeFile,
  fileText,
  running,
  onOpen,
}: {
  files: ProjectFile[];
  activeFile: string | null;
  fileText: string;
  running: boolean;
  onOpen: (path: string) => void;
}) {
  const browserPercent = readPanelPercent(FILES_SPLIT_KEY, 38, 22, 58);

  if (files.length === 0) return emptyPane(running ? "Generating…" : "No files yet. Run to generate.");
  return (
    <Group
      id="dezin-files-layout"
      className="h-full bg-surface"
      defaultLayout={twoPanelLayout(FILES_BROWSER_PANEL, browserPercent, FILES_PREVIEW_PANEL)}
      onLayoutChanged={(layout) => savePanelFraction(FILES_SPLIT_KEY, layout, FILES_BROWSER_PANEL)}
      resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
    >
      <Panel id={FILES_BROWSER_PANEL} minSize="200px" maxSize="480px" groupResizeBehavior="preserve-pixel-size">
        <div className="h-full min-w-0">
          <FilesBrowser files={files} activeFile={activeFile} onOpen={onOpen} />
        </div>
      </Panel>
      <Separator
        aria-label="Resize file browser"
        className={RESIZE_SEPARATOR_CLASS}
      />
      <Panel id={FILES_PREVIEW_PANEL} minSize="240px">
        <div className="h-full min-w-0">
          {activeFile ? <CodeView name={activeFile} text={fileText} /> : emptyPane("Select a file to preview")}
        </div>
      </Panel>
    </Group>
  );
}

const MARKUP_POPOVER = { width: 288, height: 192, margin: 12, gap: 8 };

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function computeMarkupPosition(
  iframeRect: { left: number; top: number; width: number; height: number } | null | undefined,
  elementRect: { x: number; y: number; w: number; h: number } | null | undefined,
  viewport: { width: number; height: number },
  popover: { width: number; height: number; margin?: number; gap?: number } = MARKUP_POPOVER,
): { x: number; y: number } {
  const margin = popover.margin ?? MARKUP_POPOVER.margin;
  const gap = popover.gap ?? MARKUP_POPOVER.gap;
  const maxX = Math.max(margin, viewport.width - popover.width - margin);
  const maxY = Math.max(margin, viewport.height - popover.height - margin);
  if (!iframeRect || !elementRect) return { x: maxX, y: Math.min(120, maxY) };

  const anchorX = iframeRect.left + elementRect.x;
  const belowY = iframeRect.top + elementRect.y + elementRect.h + gap;
  const aboveY = iframeRect.top + elementRect.y - popover.height - gap;
  const y = belowY <= maxY ? belowY : aboveY >= margin ? clamp(aboveY, margin, maxY) : clamp(belowY, margin, maxY);

  return {
    x: clamp(anchorX, margin, maxX),
    y,
  };
}

function clampMarkupPopover(
  position: { x: number; y: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const margin = MARKUP_POPOVER.margin;
  return {
    x: clamp(position.x, margin, Math.max(margin, viewport.width - size.width - margin)),
    y: clamp(position.y, margin, Math.max(margin, viewport.height - size.height - margin)),
  };
}

/** Floating annotation popover shown when an element is picked in the preview. */
function MarkUpPopover({
  mark,
  onAdd,
  onCancel,
}: {
  mark: MarkupTarget & { x: number; y: number };
  onAdd: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: mark.x, y: mark.y });

  useLayoutEffect(() => {
    const update = (): void => {
      const rect = ref.current?.getBoundingClientRect();
      const size = rect ? { width: rect.width, height: rect.height } : MARKUP_POPOVER;
      setPos(clampMarkupPopover({ x: mark.x, y: mark.y }, { width: window.innerWidth, height: window.innerHeight }, size));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [mark.x, mark.y, mark.selector, mark.note]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onCancel} aria-hidden />
      <div
        ref={ref}
        className="fixed z-50 max-h-[calc(100vh-24px)] w-72 overflow-auto rounded-xl border border-border bg-popover p-3 shadow-pop"
        style={{ left: pos.x, top: pos.y }}
        role="dialog"
        aria-label="Mark up element"
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <MousePointerClick size={12} strokeWidth={2} className="text-brand" />
          <span className="label-mono">Mark up</span>
        </div>
        <code className="mb-2 block truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-foreground-2">{mark.selector}</code>
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onAdd(note);
            else if (e.key === "Escape") onCancel();
          }}
          placeholder="Describe the change to this element…"
          rows={2}
          className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        />
        <div className="mt-2 flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onAdd(note)}>
            Add
          </Button>
        </div>
      </div>
    </>
  );
}

function formatElapsed(ms?: number): string {
  if (!ms || ms < 1000) return "";
  const total = Math.max(1, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec.toString().padStart(2, "0")}s` : `${sec}s`;
}

function liveText(items: LiveItem[]): string {
  return items
    .filter((i): i is { type: "text"; text: string } => i.type === "text")
    .map((i) => i.text)
    .join("")
    .trim();
}

function VisualReviewRecord({
  review,
  stackPosition = "single",
}: {
  review: VisualReviewState;
  stackPosition?: RunCardStackPosition;
}) {
  const [open, setOpen] = useState(false);
  const status = visualReviewStatusText(review);
  const reviewer = reviewerLabel(review);
  const processItems = review.process.length
    ? review.process
    : [{ type: "tool" as const, summary: `Reviewing screenshot with ${reviewer}` }];
  return (
    <div
      data-testid="visual-review-message"
      className={cn(
        "overflow-hidden border border-border bg-card/70",
        runCardRadiusClass(stackPosition),
        stackPosition !== "single" && stackPosition !== "first" && "-mt-px",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div className="label-mono text-brand">Visual Review</div>
          <p className="mt-1 text-sm leading-snug text-foreground">{visualReviewResultText(review)}</p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
            review.status === "running"
              ? "border-accent/25 bg-accent/10 text-accent-foreground"
              : review.findings.length > 0
                ? "border-border-strong bg-surface-2 text-foreground"
                : "border-success/25 bg-success/10 text-success",
          )}
        >
          {status}
        </span>
      </div>
      {review.findings.length > 0 ? (
        <ul className="space-y-1.5 border-t border-border px-3 py-2">
          {review.findings.map((finding, index) => (
            <li key={`${finding.id}-${index}`} className="rounded-md bg-surface px-2 py-1.5 text-xs leading-snug text-foreground-2">
              {finding.message}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        aria-label="Visual Review process"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight size={13} strokeWidth={2} className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        {review.status === "running" ? <Spinner size={12} /> : <Check size={13} strokeWidth={2.5} className="text-success" />}
        <span className="font-medium">Process</span>
        <span className="min-w-0 truncate font-mono text-[11px]">{reviewer}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-2 border-t border-border px-3 py-2.5">
              {processItems.map((item, index) =>
                item.type === "text" ? (
                  <div key={index} className="text-sm leading-relaxed text-foreground-2">
                    <Markdown>{item.text}</Markdown>
                  </div>
                ) : (
                  <div key={index} className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                    <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                    <span className="truncate">{item.summary}</span>
                  </div>
                ),
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** A collapsed record of the agent's process or build steps, kept in the transcript. */
function ProcessRecord({
  steps = [],
  items = [],
  elapsedMs,
  stackPosition = "single",
}: {
  steps?: string[];
  items?: LiveItem[];
  elapsedMs?: number;
  stackPosition?: RunCardStackPosition;
}) {
  const [open, setOpen] = useState(false);
  const process = items.length > 0;
  const elapsed = formatElapsed(elapsedMs);
  const label = process ? `Processed${elapsed ? ` ${elapsed}` : ""}` : `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return (
    <div
      data-testid={stackPosition === "single" ? undefined : "run-card-stack-item"}
      className={cn(
        "overflow-hidden border border-border bg-card/60",
        runCardRadiusClass(stackPosition),
        stackPosition !== "single" && stackPosition !== "first" && "-mt-px",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight size={13} strokeWidth={2} className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        <Check size={13} strokeWidth={2.5} className="text-success" />
        <span className="font-medium">{label}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
            className="overflow-hidden"
          >
            {process ? (
              <div className="space-y-2 border-t border-border px-3 py-2.5">
                {items.map((item, i) =>
                  item.type === "text" ? (
                    <div key={i} className="text-sm leading-relaxed text-foreground-2">
                      <Markdown>{item.text}</Markdown>
                    </div>
                  ) : (
                    <div key={i} className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                      <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span className="truncate">{item.summary}</span>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <ul className="space-y-1.5 border-t border-border px-3 py-2.5">
                {steps.map((s, i) => (
                  <li key={i} className="flex items-center gap-2 font-mono text-[11px] text-foreground-2">
                    <Check size={12} strokeWidth={2.5} className="shrink-0 text-success/70" />
                    <span className="truncate">{s}</span>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ResultCard({
  text,
  meta,
  onView,
  stackPosition = "single",
}: {
  text: string;
  meta?: ResultMeta;
  onView: () => void;
  stackPosition?: RunCardStackPosition;
}) {
  const error = meta?.error;
  const score = meta?.score;
  const materialSources = meta?.materialSources ?? [];
  const stopped = meta?.status === "stopped" || text === "Stopped.";
  const label = stopped ? "Stopped" : text;
  return (
    <div
      data-testid={stackPosition === "single" ? undefined : "run-card-stack-item"}
      className={cn(
        "border px-3 py-1.5",
        error ? "border-destructive/40 bg-destructive/5" : "border-border bg-card/70",
        runCardRadiusClass(stackPosition),
        stackPosition !== "single" && stackPosition !== "first" && "-mt-px",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-md ${
            error ? "bg-destructive/15 text-destructive" : stopped ? "bg-surface-2 text-muted-foreground" : "bg-success/15 text-success"
          }`}
        >
          {error ? <CircleAlert size={13} strokeWidth={2} /> : stopped ? <Square size={10} strokeWidth={2.5} /> : <Check size={13} strokeWidth={2.5} />}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{label}</p>
        {!error ? (
          <div className="flex shrink-0 items-center gap-2">
            {typeof score === "number" ? (
              <span className="tnum rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-foreground-2">{score}/100</span>
            ) : null}
            <button
              type="button"
              onClick={onView}
              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground-2 transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              View preview
              <ChevronRight size={13} strokeWidth={2} />
            </button>
          </div>
        ) : null}
      </div>
      {materialSources.length > 0 ? (
        <div className="mt-1.5 flex items-start gap-2 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground-2">Material sources</span>
          <span className="min-w-0 flex-1 truncate">{materialSources.join(" · ")}</span>
        </div>
      ) : null}
    </div>
  );
}

function QuestionCard({ question, onAnswer }: { question: string; onAnswer: (answer: string) => void }) {
  const [answer, setAnswer] = useState("");
  const send = (): void => {
    const text = answer.trim();
    if (!text) return;
    setAnswer("");
    onAnswer(text);
  };
  return (
    <div className="rounded-lg border border-border bg-card/70 px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-2 text-foreground">
          <MousePointerClick size={12} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{question}</p>
          <div className="mt-2 flex items-end gap-2">
            <textarea
              aria-label="Answer question"
              rows={1}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              className="field-sizing-content max-h-24 min-h-8 flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
            <Button size="sm" onClick={send} disabled={!answer.trim()}>
              Send answer
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function emptyPane(label: string) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="grid size-10 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
          <PanelsTopLeft size={18} strokeWidth={1.5} />
        </span>
        <p className={cn("text-sm text-muted-foreground", label.startsWith("Generating") && "shiny-text")}>{label}</p>
      </div>
    </div>
  );
}

function StandardDoctor({
  phase,
  logs,
  error,
  onRefresh,
}: {
  phase: SetupPhase | null;
  logs: Array<{ at: number; level: "info" | "error"; message: string }>;
  error?: string | null;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground">Standard Doctor</div>
          <div className="text-[11px] text-muted-foreground">Setup and dev-server runtime</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {phase ?? "unknown"}
          </span>
          <IconButton aria-label="Refresh standard preview" className="h-7 w-7 rounded-md" onClick={onRefresh}>
            <RotateCw size={13} strokeWidth={1.8} />
          </IconButton>
        </div>
      </div>
      {error ? <p className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {logs.length > 0 ? (
        <ul className="max-h-44 space-y-1 overflow-auto px-3 py-2 font-mono text-[11px]">
          {logs.slice(-8).map((log, index) => (
            <li key={`${log.at}-${index}`} className={cn("truncate", log.level === "error" ? "text-destructive" : "text-muted-foreground")}>
              {log.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">No runtime logs recorded in this daemon session.</p>
      )}
    </section>
  );
}

function AgentVisualReviewSummary({ findings }: { findings: QualityFinding[] }) {
  const summary = visualReviewQualitySummary(findings);
  if (!summary) return null;
  return (
    <div className="border-t border-border px-3 py-2.5">
      <div className="flex gap-3 rounded-md border border-border bg-surface p-2">
        {summary.screenshotUrl ? (
          <img
            src={summary.screenshotUrl}
            alt="Visual review screenshot"
            loading="lazy"
            className="h-20 w-28 shrink-0 rounded-md border border-border bg-white object-cover"
          />
        ) : (
          <div className="grid h-20 w-28 shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground">
            <Eye size={16} strokeWidth={1.75} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="label-mono text-brand">Screenshot review</div>
          <p className="mt-1 text-xs leading-snug text-foreground">{summary.summary ?? "Screenshot review completed."}</p>
          {summary.screenshotPath && !summary.screenshotUrl ? (
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{summary.screenshotPath}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InspectSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-2 text-xs font-semibold text-foreground">{title}</div>
      {children}
    </section>
  );
}

function InspectField({ label, value, wide = false }: { label: string; value?: ReactNode; wide?: boolean }) {
  const displayValue = value === undefined || value === null || value === "" ? "—" : value;
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5 text-xs", wide && "col-span-2")}>
      <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-foreground">{displayValue}</span>
    </div>
  );
}

function InspectSwatch({ value }: { value?: string }) {
  const color = value && value !== "rgba(0, 0, 0, 0)" ? value : "transparent";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="size-3 shrink-0 rounded-sm border border-border bg-card" style={{ background: color }} />
      <span className="truncate">{value || "transparent"}</span>
    </span>
  );
}

function inspectOpacity(value?: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "100%";
}

function inspectEffect(value?: string): string {
  if (!value || value === "none") return "None";
  return value;
}

function inspectValue(value?: string): string | undefined {
  return value && value.trim() ? value : undefined;
}

function inspectBorderValue(styles: MarkupStyles, key: "Width" | "Style" | "Color"): string | undefined {
  const values =
    key === "Width"
      ? [styles.borderTopWidth, styles.borderRightWidth, styles.borderBottomWidth, styles.borderLeftWidth]
      : key === "Style"
        ? [styles.borderTopStyle, styles.borderRightStyle, styles.borderBottomStyle, styles.borderLeftStyle]
        : [styles.borderTopColor, styles.borderRightColor, styles.borderBottomColor, styles.borderLeftColor];
  const present = values.filter((value): value is string => !!value && value.trim().length > 0);
  if (present.length !== 4) return key === "Width" ? styles.borderWidth : key === "Style" ? styles.borderStyle : styles.borderColor;
  return present.every((value) => value === present[0]) ? present[0] : `T ${present[0]} · R ${present[1]} · B ${present[2]} · L ${present[3]}`;
}

function InspectPanel({
  target,
  projectName,
  projectMode,
  designSystem,
  files,
}: {
  target: MarkupTarget | null;
  projectName: string;
  projectMode: ProjectMode;
  designSystem?: DesignSystemCard;
  files: ProjectFile[];
}) {
  const htmlFiles = files.filter((file) => file.path.endsWith(".html")).length;
  const cssFiles = files.filter((file) => file.path.endsWith(".css")).length;
  const imageFiles = files.filter((file) => /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.path)).length;
  const styles = target?.styles ?? {};
  const attrs = target?.attrs ?? {};
  const swatch = designSystem?.swatch;
  const title = target?.attrs?.screenLabel || target?.attrs?.ariaLabel || (target?.tag ? target.tag.toUpperCase() : target ? "Element" : "Project variables");
  const hasStyleSnapshot = !!target?.styles;
  return (
    <aside className="flex h-full min-w-0 flex-col bg-card" aria-label="Inspect panel">
      <div className="flex min-h-12 shrink-0 items-center border-b border-border px-4 py-2">
        <div className="min-w-0">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          <p className="truncate text-[11px] text-muted-foreground">{target ? target.selector : projectName || "Untitled"}</p>
        </div>
      </div>
      <div className="flex-1 overflow-auto text-sm">
        {target ? (
          <>
            <InspectSection title="Position">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="X" value={target.rect?.x} />
                <InspectField label="Y" value={target.rect?.y} />
                <InspectField label="W" value={target.rect?.w} />
                <InspectField label="H" value={target.rect?.h} />
                <InspectField label="Tag" value={target.tag || "node"} />
              </div>
            </InspectSection>
            <InspectSection title="Layout">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="Display" value={styles.display} />
                <InspectField label="Position" value={styles.position} />
                <InspectField label="Z" value={styles.zIndex} />
                <InspectField label="Overflow" value={styles.overflow} />
                <InspectField label="Flex" value={styles.flexDirection} />
                <InspectField label="Wrap" value={styles.flexWrap} />
                <InspectField label="Justify" value={styles.justifyContent} />
                <InspectField label="Align" value={styles.alignItems} />
                <InspectField label="Gap" value={styles.gap} />
                <InspectField label="Padding" value={styles.padding} />
                <InspectField label="Margin" value={styles.margin} />
                <InspectField label="Grid cols" value={inspectValue(styles.gridTemplateColumns)} wide />
                <InspectField label="Grid rows" value={inspectValue(styles.gridTemplateRows)} wide />
              </div>
            </InspectSection>
            <InspectSection title="Appearance">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="Opacity" value={hasStyleSnapshot ? inspectOpacity(styles.opacity) : undefined} />
                <InspectField label="Radius" value={styles.borderRadius} />
                <InspectField label="Font" value={styles.fontSize} />
                <InspectField label="Weight" value={styles.fontWeight} />
                <InspectField label="Line" value={styles.lineHeight} />
                <InspectField label="Track" value={styles.letterSpacing} />
                <InspectField label="Align" value={styles.textAlign} />
                <InspectField label="Case" value={styles.textTransform} />
                <InspectField label="Family" value={styles.fontFamily} wide />
                <InspectField label="Transform" value={hasStyleSnapshot ? inspectEffect(styles.transform) : undefined} wide />
                <InspectField label="Blend" value={styles.mixBlendMode} wide />
              </div>
            </InspectSection>
            <InspectSection title="Fill">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="BG" value={hasStyleSnapshot ? <InspectSwatch value={styles.background} /> : undefined} wide />
                <InspectField label="Image" value={hasStyleSnapshot ? inspectEffect(styles.backgroundImage) : undefined} wide />
                <InspectField label="Text" value={hasStyleSnapshot ? <InspectSwatch value={styles.color} /> : undefined} wide />
              </div>
            </InspectSection>
            <InspectSection title="Stroke">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="Width" value={inspectBorderValue(styles, "Width")} />
                <InspectField label="Style" value={inspectBorderValue(styles, "Style")} />
                <InspectField label="Color" value={hasStyleSnapshot ? <InspectSwatch value={inspectBorderValue(styles, "Color")} /> : undefined} wide />
                <InspectField label="Outline" value={[styles.outlineWidth, styles.outlineStyle].filter(Boolean).join(" ") || undefined} />
                <InspectField label="O color" value={hasStyleSnapshot ? <InspectSwatch value={styles.outlineColor} /> : undefined} />
              </div>
            </InspectSection>
            <InspectSection title="Effects">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="Shadow" value={hasStyleSnapshot ? inspectEffect(styles.boxShadow) : undefined} wide />
                <InspectField label="Filter" value={hasStyleSnapshot ? inspectEffect(styles.filter) : undefined} wide />
                <InspectField label="Backdrop" value={hasStyleSnapshot ? inspectEffect(styles.backdropFilter) : undefined} wide />
              </div>
            </InspectSection>
            <InspectSection title="Content">
              <div className="space-y-2">
                <InspectField label="Selector" value={target.selector} wide />
                <div className="grid grid-cols-2 gap-2">
                  <InspectField label="ID" value={attrs.id} />
                  <InspectField label="Role" value={attrs.role} />
                  <InspectField label="Name" value={attrs.ariaLabel} wide />
                  <InspectField label="Class" value={attrs.className} wide />
                  <InspectField label="Href" value={attrs.href} wide />
                  <InspectField label="Src" value={attrs.src} wide />
                </div>
                {target.text ? <p className="line-clamp-4 rounded-md bg-surface-2 px-2 py-1.5 text-xs leading-snug text-foreground-2">"{target.text}"</p> : null}
                {target.note ? <p className="line-clamp-3 rounded-md bg-surface-2 px-2 py-1.5 text-xs leading-snug text-foreground">{target.note}</p> : null}
                {!hasStyleSnapshot ? <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-muted-foreground">Style snapshot was not captured for this target.</p> : null}
              </div>
            </InspectSection>
          </>
        ) : (
          <>
            <InspectSection title="Project">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="Name" value={projectName || "Untitled"} wide />
                <InspectField label="Mode" value={projectMode} />
                <InspectField label="System" value={designSystem?.name ?? "Clean"} />
                <InspectField label="Category" value={designSystem?.category} />
              </div>
            </InspectSection>
            <InspectSection title="Colors">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="BG" value={<InspectSwatch value={swatch?.bg} />} wide />
                <InspectField label="Surface" value={<InspectSwatch value={swatch?.surface} />} wide />
                <InspectField label="Text" value={<InspectSwatch value={swatch?.fg} />} wide />
                <InspectField label="Accent" value={<InspectSwatch value={swatch?.accent} />} wide />
              </div>
            </InspectSection>
            <InspectSection title="Viewports">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="Desktop" value={DEVICE_WIDTH.desktop} />
                <InspectField label="Tablet" value={DEVICE_WIDTH.tablet} />
                <InspectField label="Mobile" value={DEVICE_WIDTH.mobile} />
              </div>
            </InspectSection>
            <InspectSection title="Assets">
              <div className="grid grid-cols-2 gap-2">
                <InspectField label="Files" value={files.length} />
                <InspectField label="Images" value={imageFiles} />
                <InspectField label="HTML" value={htmlFiles} />
                <InspectField label="CSS" value={cssFiles} />
              </div>
            </InspectSection>
          </>
        )}
      </div>
    </aside>
  );
}

function ToolbarTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent sideOffset={2}>{label}</TooltipContent>
    </Tooltip>
  );
}

function MessageActions({
  message,
  disabled,
  onCopy,
  onFork,
}: {
  message: Msg;
  disabled: boolean;
  onCopy: (text: string) => void;
  onFork: (message: Msg) => void;
}) {
  const canAct = !disabled && !!message.dbId;
  if (!canAct) return null;
  return (
    <TooltipProvider delayDuration={120}>
      <div
        data-testid="assistant-message-actions"
        className="mt-1 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/assistant-turn:opacity-100 focus-within:opacity-100"
      >
        <ToolbarTooltip label="Copy">
          <IconButton aria-label="Copy message" className="h-7 w-7 rounded-md" onClick={() => onCopy(message.text)}>
            <Copy size={13} strokeWidth={1.8} />
          </IconButton>
        </ToolbarTooltip>
        <ToolbarTooltip label="Fork">
          <IconButton aria-label="Fork from this message" className="h-7 w-7 rounded-md" onClick={() => onFork(message)}>
            <GitFork size={13} strokeWidth={1.8} />
          </IconButton>
        </ToolbarTooltip>
      </div>
    </TooltipProvider>
  );
}

function AssistantMessage({ message }: { message: Msg }) {
  return (
    <div data-message-kind="assistant">
      <Markdown>{message.text}</Markdown>
    </div>
  );
}

function WorkspaceLoadingLayout({ conversationPercent }: { conversationPercent: number }) {
  return (
    <Group
      id="dezin-workspace-layout-loading"
      className="flex-1"
      defaultLayout={twoPanelLayout(WORKSPACE_CONVERSATION_PANEL, conversationPercent, WORKSPACE_ARTIFACT_PANEL)}
      onLayoutChanged={(layout) => savePanelFraction(SPLIT_KEY, layout, WORKSPACE_CONVERSATION_PANEL)}
      resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
    >
      <Panel id={WORKSPACE_CONVERSATION_PANEL} minSize="320px" maxSize="55%">
        <section aria-label="Conversation loading" className="relative flex h-full min-w-0 flex-col">
          <div className="app-drag titlebar-pad-left flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-5 w-5 rounded-md bg-surface-2" />
              <div className="h-4 w-36 rounded bg-surface-2" />
            </div>
            <div className="h-8 w-8 rounded-lg bg-surface-2" />
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-hidden px-4 pt-5">
            <div className="h-16 w-4/5 rounded-2xl rounded-bl-md bg-surface-2" />
            <div className="ml-auto h-10 w-2/3 rounded-2xl rounded-br-md bg-surface-2" />
            <div className="h-24 w-[88%] rounded-xl bg-surface-2" />
            <div className="h-14 w-3/4 rounded-2xl rounded-bl-md bg-surface-2/80" />
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0">
            <div aria-hidden className="h-12 bg-gradient-to-t from-background via-background/90 to-transparent" />
            <div className="bg-background px-3 pb-3">
              <div className="rounded-2xl border border-input bg-card px-2.5 pb-2 pt-2.5">
                <div className="h-10 rounded-md bg-surface-2" />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="h-8 w-36 rounded-md bg-surface-2" />
                  <div className="h-8 w-8 rounded-lg bg-surface-2" />
                </div>
              </div>
            </div>
          </div>
        </section>
      </Panel>

      <Separator aria-label="Resize panels" className={RESIZE_SEPARATOR_CLASS} />

      <Panel id={WORKSPACE_ARTIFACT_PANEL} minSize="360px">
        <section aria-label="Artifact loading" className="flex h-full min-w-0 flex-col">
          <div className="app-drag flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-1">
            <div className="flex items-center gap-1.5 px-1.5">
              <div className="h-7 w-20 rounded-md bg-surface-2" />
              <div className="h-7 w-16 rounded-md bg-surface-2/80" />
              <div className="h-7 w-20 rounded-md bg-surface-2/80" />
            </div>
            <div className="flex items-center gap-1">
              <div className="h-8 w-8 rounded-lg bg-surface-2" />
              <div className="h-8 w-8 rounded-lg bg-surface-2" />
            </div>
          </div>
          <div className="dz-canvas relative flex-1 overflow-hidden">
            <div className="absolute left-4 top-4 h-6 w-44 rounded bg-surface-2/80" />
            <div className="absolute right-4 top-4 h-8 w-28 rounded-lg bg-surface-2/80" />
            <div className="grid h-full place-items-center">
              <div className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-xs text-muted-foreground">
                <Spinner size={13} />
                Loading project
              </div>
            </div>
          </div>
        </section>
      </Panel>
    </Group>
  );
}

export function WorkspaceScreen({ projectId, onOpenSettings }: { projectId: string; onOpenSettings?: (section?: string) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("Preview");
  const [device, setDevice] = useState<Device>("desktop");
  const [fullscreen, setFullscreen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState<PreviewBusyState | null>(null);
  const [previewVersionRunId, setPreviewVersionRunId] = useState<string | null>(null);
  const [projectMode, setProjectMode] = useState<ProjectMode>("prototype");
  const [projectName, setProjectName] = useState("");
  const [dsId, setDsId] = useState("");
  const [viewDs, setViewDs] = useState(false);
  const [systems, setSystems] = useState<DesignSystemCard[]>([]);
  const [refreshSpin, setRefreshSpin] = useState(0);
  const [highlightAt, setHighlightAt] = useState<number | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(92);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectedTarget, setInspectedTarget] = useState<MarkupTarget | null>(null);
  const [pendingMark, setPendingMark] = useState<(MarkupTarget & { x: number; y: number }) | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const [setupPhase, setSetupPhase] = useState<SetupPhase | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLogs, setSetupLogs] = useState<Array<{ at: number; level: "info" | "error"; message: string }>>([]);
  const [running, setRunning] = useState(false);
  const [queue, setQueue] = useState<QueuedPrompt[]>(() => readQueue(projectId));
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [input, setInput] = useState("");
  const [contextItems, setContextItems] = useState<WorkspaceContextItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [loading, setLoading] = useState(projectId !== "new");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileText, setFileText] = useState("");
  const [lintFindings, setLintFindings] = useState<QualityFinding[]>([]);
  const [ranOnce, setRanOnce] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [qualityChecks, setQualityChecks] = useState<QualityCheckState>({ staticRan: false, visualRan: false, visualEnabled: null, source: "none" });
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [compare, setCompare] = useState<{ a: { url: string; label: string }; b: { url: string; label: string } } | null>(null);
  const { agents, rescan: rescanAgents } = useAgents();
  const [settingsAgent, setSettingsAgent] = useState<string | null>(null); // null = settings not loaded yet
  const [settingsModel, setSettingsModel] = useState("");
  const [runAgent, setRunAgent] = useState("");
  const [runModel, setRunModel] = useState("");
  const [diff, setDiff] = useState<{ label: string; lines: DiffLine[] } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const workspaceConversationPercent =
    readStoredPanelPercent(SPLIT_KEY, 24, 55) ??
    panelPercentFromPixels(400, typeof window === "undefined" ? 0 : window.innerWidth, 33, 24, 55);
  const inspectPanelPercent =
    readStoredPanelPercent(INSPECT_SPLIT_KEY, 18, 45) ??
    panelPercentFromPixels(280, typeof window === "undefined" ? 0 : window.innerWidth, 24, 18, 45);
  const msgId = useRef(0);
  const activeConv = useRef<string | null>(null);
  const modeRef = useRef<ProjectMode>("prototype");
  const liveItemsRef = useRef<LiveItem[]>([]);
  const currentTurnTextRef = useRef("");
  const finalSummaryTextRef = useRef("");
  const summaryBoundaryRef = useRef(false);
  const materialSourcesRef = useRef<string[]>([]);
  const gotTurnText = useRef(false);
  const stickBottom = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const queueRef = useRef<QueuedPrompt[]>(queue);
  const activeRunIdRef = useRef<string | null>(null);
  const runStartedAtRef = useRef<number | null>(null);
  const selectionModeRef = useRef<"markup" | "inspect" | null>(null);
  const versionPreviewRequestRef = useRef(0);
  const inspectedTargetRef = useRef<MarkupTarget | null>(null);
  const terminalEventRef = useRef(false);
  const liveQualityRef = useRef(false);
  const reattachedRunsRef = useRef<Set<string>>(new Set());
  const lastSeqByRunRef = useRef<Map<string, number>>(new Map());
  const qualityChecksRef = useRef<QualityCheckState>({ staticRan: false, visualRan: false, visualEnabled: null, source: "none" });
  const visualReviewMessageIdRef = useRef<number | null>(null);

  const updateQualityChecks = (next: QualityCheckState | ((current: QualityCheckState) => QualityCheckState)): void => {
    const resolved = typeof next === "function" ? next(qualityChecksRef.current) : next;
    qualityChecksRef.current = resolved;
    setQualityChecks(resolved);
  };

  const setActive = (id: string | null) => {
    activeConv.current = id;
    setActiveConvId(id);
  };

  const push = (kind: Msg["kind"], text: string) =>
    setMessages((m) => [...m, { id: msgId.current++, kind, text, at: Date.now() }]);

  const updateQueue = useCallback(
    (next: QueuedPrompt[] | ((current: QueuedPrompt[]) => QueuedPrompt[])): void => {
      const resolved = typeof next === "function" ? next(queueRef.current) : next;
      queueRef.current = resolved;
      setQueue(resolved);
      writeQueue(projectId, resolved);
    },
    [projectId],
  );

  const addContextItems = useCallback((items: WorkspaceContextItem[]): void => {
    setContextItems((current) => upsertContextItems(current, items));
  }, []);

  const previewTargetItems = contextItems.filter(
    (item): item is Extract<WorkspaceContextItem, { type: "preview-target" }> => item.type === "preview-target",
  );
  const selectedTargets = previewTargetItems.map((item) => item.target);
  const selectedMoodboardRefs = contextItems
    .filter((item): item is Extract<WorkspaceContextItem, { type: "moodboard" }> => item.type === "moodboard")
    .map((item) => ({ id: item.moodboardId, name: item.name }));
  const hasComposerContext = contextItems.length > 0;

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "auto"): void => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (typeof el.scrollTo === "function") {
      try {
        el.scrollTo({ top: el.scrollHeight, behavior });
      } catch {
        el.scrollTop = el.scrollHeight;
      }
    }
    stickBottom.current = true;
    setShowScrollToBottom(false);
  }, []);

  const scheduleScrollChatToBottom = useCallback(
    (behavior: ScrollBehavior = "auto"): void => {
      scrollChatToBottom(behavior);
      requestAnimationFrame(() => scrollChatToBottom(behavior));
      window.setTimeout(() => scrollChatToBottom(behavior), 80);
    },
    [scrollChatToBottom],
  );

  const updateChatBottomState = useCallback((): void => {
    const el = chatScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    stickBottom.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  }, []);

  const loadMessages = async (convId: string): Promise<void> => {
    const prior = await api.listMessages(projectId, convId);
    stickBottom.current = true;
    setShowScrollToBottom(false);
    msgId.current = 0;
    setMessages(prior.map((m) => toMsg(m, msgId.current++)));
    scheduleScrollChatToBottom("auto");
  };

  const clearVersionPreviewState = (): void => {
    setPreviewVersionRunId(null);
    setPreviewBusy(null);
  };

  const loadFiles = async (): Promise<void> => {
    try {
      const fs = await api.listFiles(projectId);
      setFiles(fs);
      setActiveFile((cur) => cur ?? fs.find((f) => f.path === "index.html")?.path ?? fs[0]?.path ?? null);
      // Show the existing artifact when reopening a prototype project (standard
      // projects preview the dev server, not a static index.html).
      if (modeRef.current !== "standard" && fs.some((f) => f.path === "index.html")) {
        setPreviewSrc((cur) => cur ?? `${api.previewUrl(projectId)}?t=${Date.now()}`);
      }
    } catch {
      // no artifact files yet
    }
  };

  const openFile = (path: string): void => {
    setActiveFile(path);
    setTab("Files");
  };

  const loadRuns = async (scopeVariants: Variant[] = variants): Promise<void> => {
    try {
      const rs = await api.listRuns(projectId, { all: true });
      const sortedRuns = sortRunsNewestFirst(rs);
      setRuns(sortedRuns);
      // Reflect the active branch's latest run in the Quality tab when reopening a project.
      const activeVariantId = activeVariantIdOf(scopeVariants);
      const latest = activeVariantId
        ? (sortedRuns.find((run) => (run.variantId ?? activeVariantId) === activeVariantId) ?? null)
        : (sortedRuns[0] ?? null);
      const latestFindings = normalizeFindings(latest?.findings);
      if (latest && (typeof latest.score === "number" || latestFindings.length > 0)) {
        const restoredFindings = latestFindings;
        setScore(latest.score);
        setLintFindings(restoredFindings);
        setRanOnce(true);
        liveQualityRef.current = false;
        updateQualityChecks({
          staticRan: latest.score !== null || restoredFindings.some((finding) => !isVisualFinding(finding)),
          visualRan: restoredFindings.some(isVisualFinding),
          visualEnabled: null,
          source: "persisted",
        });
      } else {
        if (!liveQualityRef.current) {
          setScore(null);
          setLintFindings([]);
          setRanOnce(Boolean(latest));
          updateQualityChecks({ staticRan: false, visualRan: false, visualEnabled: null, source: latest ? "persisted" : "none" });
        }
      }
      if (latest && REPLAYABLE_RUN_STATUSES.has(latest.status) && !reattachedRunsRef.current.has(latest.id)) {
        void reattachRun(latest.id, latest.status);
      }
    } catch {
      // no runs yet
    }
  };

  /**
   * Standard projects: wait for deps to install, then preview the Vite dev server
   * directly (the iframe loads its URL with allow-same-origin, so JSX is transpiled
   * and there's no CORS — see the sandbox keyed off an absolute src below).
   */
  const loadDevPreview = async (): Promise<void> => {
    try {
      for (let i = 0; i < 160; i++) {
        const s = await api.getSetup(projectId);
        setSetupPhase(s.phase);
        setSetupError(s.error ?? null);
        setSetupLogs(s.logs ?? []);
        if (s.phase === "ready") break;
        if (s.phase === "error") return;
        await new Promise((r) => setTimeout(r, 1500));
      }
      const { url } = await api.getDevServerUrl(projectId);
      clearVersionPreviewState();
      setPreviewSrc(url);
      void api.getSetup(projectId).then((s) => {
        setSetupPhase(s.phase);
        setSetupError(s.error ?? null);
        setSetupLogs(s.logs ?? []);
      }).catch(() => {});
      void api.captureProjectCover(projectId).catch(() => {});
    } catch {
      // setup not ready; the user can retry
    }
  };

  useEffect(() => {
    return () => {
      if (modeRef.current === "standard") void api.releaseDevServer(projectId).catch(() => {});
    };
  }, [api, projectId]);

  useEffect(() => {
    const onTitle = (event: Event): void => {
      const project = (event as CustomEvent<Project>).detail;
      if (project?.id === projectId && typeof project.name === "string") setProjectName(project.name);
    };
    window.addEventListener("dezin:project-title", onTitle);
    return () => window.removeEventListener("dezin:project-title", onTitle);
  }, [projectId]);

  const resolveVersionPreviewUrl = async (runId: string): Promise<string> => cacheBustPreviewUrl((await api.getVersionPreview(projectId, runId)).url);

  const viewVersion = async (runId: string): Promise<void> => {
    const requestId = versionPreviewRequestRef.current + 1;
    versionPreviewRequestRef.current = requestId;
    setPreviewVersionRunId(runId);
    setPreviewBusy({ title: "Loading version preview", detail: "Preparing the saved snapshot and starting its preview server." });
    setTab("Preview");
    try {
      const url = await resolveVersionPreviewUrl(runId);
      if (versionPreviewRequestRef.current !== requestId) return;
      setPreviewSrc(url);
      setPreviewBusy(null);
    } catch {
      if (versionPreviewRequestRef.current === requestId) {
        setPreviewBusy(null);
        setPreviewVersionRunId(null);
      }
      toast("Couldn't load that version preview.", { variant: "error" });
    }
  };

  const openVersionCompare = async (runId: string, label: string): Promise<void> => {
    if (!currentRun) return;
    setPreviewBusy({ title: "Loading version comparison", detail: "Preparing both saved snapshots for visual comparison." });
    try {
      const [versionUrl, currentUrl] = await Promise.all([resolveVersionPreviewUrl(runId), resolveVersionPreviewUrl(currentRun.id)]);
      setCompare({
        a: { url: versionUrl, label },
        b: { url: currentUrl, label: `${activeVersionGroup?.name ?? "Current branch"} current` },
      });
    } catch {
      toast("Couldn't load that comparison.", { variant: "error" });
    } finally {
      setPreviewBusy(null);
    }
  };

  const openDiff = async (runId: string, label: string): Promise<void> => {
    try {
      if (modeRef.current === "standard") {
        setDiff({ label: `${label} → current`, lines: await api.getVersionDiff(projectId, runId) });
        return;
      }
      const [versionHtml, currentHtml] = await Promise.all([
        api.getVersionText(projectId, runId),
        api.getFileText(projectId, "index.html").catch(() => ""),
      ]);
      setDiff({ label: `${label} → current`, lines: diffLines(versionHtml, currentHtml) });
    } catch {
      toast("Couldn't load that diff.", { variant: "error" });
    }
  };

  const restoreVersion = async (runId: string): Promise<void> => {
    try {
      await api.restoreVersion(projectId, runId);
      toast("Restored that version as the current design.");
      clearVersionPreviewState();
      setPreviewSrc(`${api.previewUrl(projectId)}?t=${Date.now()}`);
      setTab("Preview");
      void loadRuns();
    } catch {
      toast("Couldn't restore that version.", { variant: "error" });
    }
  };

  const setVersionCover = async (runId: string): Promise<void> => {
    try {
      const result = await api.setVersionCover(projectId, runId);
      toast(result.captured ? "Set that version as the project cover." : "Couldn't capture that version as a cover.", {
        variant: result.captured ? undefined : "error",
      });
    } catch {
      toast("Couldn't set that version as the cover.", { variant: "error" });
    }
  };

  const copyAssistantMessage = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      toast("Couldn't copy that message.", { variant: "error" });
    }
  };

  const forkAssistantMessage = async (message: Msg): Promise<void> => {
    if (!message.dbId) return;
    try {
      const fork = await api.forkMessage(projectId, message.dbId);
      setVariants(fork.variants);
      setActive(fork.conversationId);
      await loadMessages(fork.conversationId);
      reloadArtifact(fork.variants);
      toast("Forked from that message.");
    } catch {
      toast("Couldn't fork from that message.", { variant: "error" });
    }
  };

  const pushResult = (text: string, meta: ResultMeta): void => {
    const materialSources = materialSourcesRef.current;
    setMessages((m) => [...m, { id: msgId.current++, kind: "result", text, meta: materialSources.length ? { ...meta, materialSources } : meta }]);
  };

  // Turn the live (interleaved) stream into the transcript: a collapsed process record,
  // then visible prose, then a compact steps summary. Used on completion and Stop.
  const materializeLive = ({ emitSummary = true }: { emitSummary?: boolean } = {}): string => {
    const items = liveItemsRef.current;
    const text = finalSummaryTextRef.current.trim() || liveText(items);
    const steps = items.filter((i): i is { type: "tool"; summary: string } => i.type === "tool").map((i) => i.summary);
    const elapsedMs = runStartedAtRef.current ? Date.now() - runStartedAtRef.current : undefined;
    const processItems = summaryBoundaryRef.current ? items : items.filter((i): i is { type: "tool"; summary: string } => i.type === "tool");
    const next: Msg[] = processItems.length ? [{ id: msgId.current++, kind: "process", text: "", items: processItems, elapsedMs }] : [];
    if (emitSummary && text) next.push({ id: msgId.current++, kind: "assistant", text });
    if (steps.length) next.push({ id: msgId.current++, kind: "process", text: "", steps });
    setMessages((m) => [...m, ...next]);
    liveItemsRef.current = [];
    currentTurnTextRef.current = "";
    finalSummaryTextRef.current = "";
    summaryBoundaryRef.current = false;
    setLiveItems([]);
    return text;
  };

  const startVisualReviewMessage = (ev: RunEvent): void => {
    if (liveItemsRef.current.length > 0 || finalSummaryTextRef.current.trim()) materializeLive();
    const agentCommand = optionalString(ev.agentCommand);
    const model = optionalString(ev.model);
    const screenshotUrl = optionalString(ev.screenshotUrl);
    const screenshotPath = optionalString(ev.screenshotPath);
    const reviewer = reviewerLabel({ agentCommand, model });
    const enabled = typeof ev.enabled === "boolean" ? ev.enabled : true;
    const id = msgId.current++;
    visualReviewMessageIdRef.current = id;
    setMessages((current) => [
      ...current,
      {
        id,
        kind: "visual-review",
        text: "",
        visualReview: {
          status: "running",
          enabled,
          round: typeof ev.round === "number" ? ev.round : undefined,
          agentCommand,
          model,
          screenshotUrl,
          screenshotPath,
          findings: [],
          process: [
            { type: "tool", summary: screenshotUrl || screenshotPath ? "Captured preview screenshot" : "Preparing preview screenshot" },
            { type: "tool", summary: `Reviewing screenshot with ${reviewer}` },
          ],
        },
      },
    ]);
  };

  const completeVisualReviewMessage = (ev: RunEvent, findings: QualityFinding[]): void => {
    if (liveItemsRef.current.length > 0 || finalSummaryTextRef.current.trim()) materializeLive();
    const screenshotUrl = optionalString(ev.screenshotUrl) ?? visualReviewScreenshotUrl(findings);
    const screenshotPath = optionalString(ev.screenshotPath) ?? visualReviewScreenshotPath(findings);
    const summary = optionalString(ev.reviewSummary) ?? visualReviewFindingSummary(findings);
    const existingId = visualReviewMessageIdRef.current;
    if (existingId === null) {
      const id = msgId.current++;
      visualReviewMessageIdRef.current = id;
      setMessages((current) => [
        ...current,
        {
          id,
          kind: "visual-review",
          text: "",
          visualReview: {
            status: "complete",
            enabled: typeof ev.enabled === "boolean" ? ev.enabled : true,
            screenshotUrl,
            screenshotPath,
            summary,
            findings,
            process: [{ type: "tool", summary: "Reviewed preview screenshot" }],
          },
        },
      ]);
      return;
    }
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== existingId || message.kind !== "visual-review") return message;
        const prior = message.visualReview;
        return {
          ...message,
          visualReview: {
            status: "complete",
            enabled: typeof ev.enabled === "boolean" ? ev.enabled : prior?.enabled,
            round: prior?.round,
            agentCommand: prior?.agentCommand,
            model: prior?.model,
            screenshotUrl: screenshotUrl ?? prior?.screenshotUrl,
            screenshotPath: screenshotPath ?? prior?.screenshotPath,
            summary,
            findings,
            process: prior?.process ?? [],
          },
        };
      }),
    );
  };

  const handleEvent = (ev: RunEvent, id: string): void => {
    const seq = typeof ev.seq === "number" && Number.isFinite(ev.seq) ? ev.seq : null;
    const eventRunId = typeof ev.runId === "string" ? ev.runId : activeRunIdRef.current;
    if (seq !== null && eventRunId) {
      const lastSeq = lastSeqByRunRef.current.get(eventRunId) ?? 0;
      if (seq <= lastSeq) return;
      lastSeqByRunRef.current.set(eventRunId, seq);
    }
    switch (ev.type) {
      case "run-start":
        terminalEventRef.current = false;
        runStartedAtRef.current = Date.now();
        if (typeof ev.runId === "string") activeRunIdRef.current = ev.runId;
        if (typeof ev.conversationId === "string") {
          const cid = ev.conversationId;
          setActive(cid);
          setConversations((c) =>
            c.some((x) => x.id === cid) ? c : [...c, { id: cid, projectId: id, title: "Untitled", createdAt: Date.now() }],
          );
        }
        setLintFindings([]);
        setScore(null);
        liveQualityRef.current = false;
        updateQualityChecks({ staticRan: false, visualRan: false, visualEnabled: null, source: "live" });
        setLiveItems([]);
        liveItemsRef.current = [];
        currentTurnTextRef.current = "";
        finalSummaryTextRef.current = "";
        summaryBoundaryRef.current = false;
        materialSourcesRef.current = [];
        visualReviewMessageIdRef.current = null;
        gotTurnText.current = false;
        stickBottom.current = true;
        setLiveStatus("Starting…");
        break;
      case "turn-start":
        gotTurnText.current = false;
        currentTurnTextRef.current = "";
        summaryBoundaryRef.current = false;
        setLiveStatus(ev.isRepair ? "Repairing the artifact…" : "Generating…");
        break;
      case "preview-update":
        // The agent rewrote the artifact mid-run — show it building live.
        clearVersionPreviewState();
        setPreviewSrc(`${api.previewUrl(id)}?t=${typeof ev.t === "number" ? ev.t : Date.now()}`);
        setTab("Preview");
        break;
      case "activity": {
        // liveItemsRef is the synchronous source of truth (run-done reads it in the same tick);
        // setLiveItems just mirrors it for rendering.
        const a = ev.activity as { kind: string; text?: string; summary?: string } | undefined;
        const arr = liveItemsRef.current;
        const last = arr[arr.length - 1];
        if (a?.kind === "tool" && a.summary) {
          if (last?.type === "tool" && last.summary === a.summary) break;
          liveItemsRef.current = [...arr, { type: "tool", summary: a.summary }];
          setLiveItems(liveItemsRef.current);
        } else if (a?.kind === "text" && a.text) {
          gotTurnText.current = true;
          currentTurnTextRef.current += a.text;
          finalSummaryTextRef.current = currentTurnTextRef.current.trim();
          liveItemsRef.current =
            last?.type === "text" ? [...arr.slice(0, -1), { type: "text", text: last.text + a.text }] : [...arr, { type: "text", text: a.text }];
          setLiveItems(liveItemsRef.current);
        }
        break;
      }
      case "turn-end":
        if (ev.summaryBoundary === true) summaryBoundaryRef.current = true;
        // turn-end text is the final summary. Streamed activity remains the process.
        if (typeof ev.text === "string" && ev.text) {
          finalSummaryTextRef.current = ev.text.trim();
        } else if (gotTurnText.current && !summaryBoundaryRef.current) {
          finalSummaryTextRef.current = currentTurnTextRef.current.trim();
        }
        gotTurnText.current = false;
        break;
      case "lint":
      case "static-quality": {
        const findings = Array.isArray(ev.findings) ? normalizeFindings(ev.findings) : [];
        setLintFindings(findings);
        updateQualityChecks((current) => ({ ...current, staticRan: true, source: "live" }));
        setLiveStatus(`Found ${findings.length} issue${findings.length === 1 ? "" : "s"}, repairing`);
        break;
      }
      case "visual-qa-start": {
        startVisualReviewMessage(ev);
        updateQualityChecks((current) => ({
          ...current,
          visualEnabled: typeof ev.enabled === "boolean" ? ev.enabled : current.visualEnabled,
          source: "live",
        }));
        setLiveStatus(ev.enabled === false ? "Visual review skipped." : "Reviewing screenshot…");
        break;
      }
      case "visual-qa": {
        const findings = Array.isArray(ev.findings) ? normalizeFindings(ev.findings) : [];
        completeVisualReviewMessage(ev, findings);
        setLintFindings((current) => [...current.filter((finding) => !isVisualFinding(finding)), ...findings]);
        updateQualityChecks((current) => ({
          ...current,
          visualRan: ev.enabled === false ? false : true,
          visualEnabled: typeof ev.enabled === "boolean" ? ev.enabled : current.visualEnabled,
          source: "live",
        }));
        break;
      }
      case "images": {
        const count = typeof ev.count === "number" ? ev.count : 0;
        if (count > 0) materialSourcesRef.current = [`Generated image assets (${count})`];
        break;
      }
      case "run-done": {
        terminalEventRef.current = true;
        activeRunIdRef.current = null;
        const rounds = typeof ev.rounds === "number" ? ev.rounds : 0;
        const s = typeof ev.score === "number" ? ev.score : null;
        const finalFindings = Array.isArray(ev.findings) ? normalizeFindings(ev.findings) : lintFindings;
        if (Array.isArray(ev.findings)) setLintFindings(finalFindings);
        setScore(s);
        liveQualityRef.current = true;
        updateQualityChecks((current) => ({
          staticRan: s !== null || finalFindings.some((finding) => !isVisualFinding(finding)) || current.staticRan,
          visualRan: current.visualRan || finalFindings.some(isVisualFinding),
          visualEnabled: current.visualEnabled,
          source: "live",
        }));
        setLiveStatus(null);
        materializeLive();
        const fixes = rounds ? ` after ${rounds} fix${rounds > 1 ? "es" : ""}` : "";
        const quality = s !== null ? `, quality ${s}/100` : "";
        pushResult(
          ev.mode === "standard"
            ? "Done. Updated the project; the dev preview reflects it live."
            : ev.passed
              ? `Done${quality}${fixes}.`
              : `Done, with remaining issues${quality}.`,
          { passed: !!ev.passed, score: s, rounds, status: "done" },
        );
        if (modeRef.current === "standard") void loadDevPreview();
        else {
          clearVersionPreviewState();
          setPreviewSrc(`${api.previewUrl(id)}?t=${Date.now()}`);
        }
        setTab("Preview");
        setRanOnce(true);
        void loadFiles();
        void loadRuns();
        break;
      }
      case "run-error":
        terminalEventRef.current = true;
        activeRunIdRef.current = null;
        setLiveStatus(null);
        materializeLive();
        setLiveItems([]);
        liveItemsRef.current = [];
        currentTurnTextRef.current = "";
        finalSummaryTextRef.current = "";
        pushResult(`The run failed: ${typeof ev.message === "string" ? ev.message : "generation failed"}`, { error: true });
        break;
      case "ask-user-question": {
        const question = typeof ev.question === "string" ? ev.question.trim() : "";
        if (question) {
          materializeLive({ emitSummary: false });
          setMessages((m) => [
            ...m,
            { id: msgId.current++, kind: "question", text: question, runId: typeof ev.runId === "string" ? ev.runId : undefined },
          ]);
        }
        setLiveStatus(null);
        break;
      }
      case "run-cancelled":
        terminalEventRef.current = true;
        activeRunIdRef.current = null;
        setLiveStatus(null);
        if (ev.reason === "question") {
          liveItemsRef.current = [];
          currentTurnTextRef.current = "";
          finalSummaryTextRef.current = "";
          summaryBoundaryRef.current = false;
          setLiveItems([]);
        } else {
          materializeLive();
          pushResult("Stopped", { status: "stopped" });
        }
        break;
      default:
        break;
    }
  };

  const reattachRun = async (runId: string, status: string): Promise<void> => {
    if (runningRef.current) return;
    reattachedRunsRef.current.add(runId);
    runningRef.current = true;
    setRunning(true);
    setLiveStatus(status === "running" || status === "pending" ? "Reconnecting…" : "Replaying interrupted run…");
    activeRunIdRef.current = runId;
    terminalEventRef.current = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      for await (const ev of api.reattachRun(runId, ctrl.signal, { afterSeq: lastSeqByRunRef.current.get(runId) ?? 0 })) handleEvent(ev, projectId);
      if (!terminalEventRef.current) {
        setLiveStatus(null);
        materializeLive();
        pushResult(status === "cancelled" ? "Interrupted." : status === "failed" ? "The run failed before it could report an error." : "Disconnected.", {
          error: status === "failed",
        });
      }
    } catch (err) {
      setLiveStatus(null);
      if (!ctrl.signal.aborted) {
        setLiveItems([]);
        liveItemsRef.current = [];
        currentTurnTextRef.current = "";
        finalSummaryTextRef.current = "";
        summaryBoundaryRef.current = false;
        pushResult(`Couldn't reconnect: ${err instanceof Error ? err.message : "stream unavailable"}`, { error: true });
      }
    } finally {
      if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
      runningRef.current = false;
      if (abortRef.current === ctrl) abortRef.current = null;
      setRunning(false);
    }
  };

  const runBrief = async (brief: string, agentOverride?: string, modelOverride?: string, refs: MoodboardRunRef[] = []): Promise<void> => {
    const text = brief.trim();
    if (!text || runningRef.current) return;

    if (projectId === "new") {
      try {
        const project = await api.createProject({ name: briefToName(text) });
        setPendingBrief(text);
        const agent = agentOverride || runAgent;
        const model = modelOverride || runModel;
        if (agent) setPendingAgent(agent, model || undefined);
        navigate(`/projects/${project.id}`);
      } catch {
        toast("Couldn't create the project.", { variant: "error" });
      }
      return;
    }

    push("user", text);
    runningRef.current = true;
    terminalEventRef.current = false;
    activeRunIdRef.current = null;
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const stream = api.streamRun(
        {
          projectId,
          brief: text,
          conversationId: activeConv.current ?? undefined,
          agentCommand: agentOverride || runAgent || undefined,
          model: modelOverride || runModel || undefined,
          moodboardRefs: refs.length ? refs : undefined,
        },
        ctrl.signal,
      );
      for await (const ev of stream) handleEvent(ev, projectId);
      if (ctrl.signal.aborted && !terminalEventRef.current) {
        materializeLive();
        pushResult("Stopped", { status: "stopped" });
      }
    } catch (err) {
      setLiveStatus(null);
      if (ctrl.signal.aborted) {
        // User pressed Stop — keep what was generated so far, note the stop, no error.
        if (!terminalEventRef.current) {
          materializeLive();
          pushResult("Stopped", { status: "stopped" });
        }
      } else {
        setLiveItems([]);
        liveItemsRef.current = [];
        currentTurnTextRef.current = "";
        finalSummaryTextRef.current = "";
        summaryBoundaryRef.current = false;
        pushResult(`The run failed: ${err instanceof Error ? err.message : "run failed"}`, { error: true });
        toast("The run failed.", { variant: "error" });
      }
    } finally {
      runningRef.current = false;
      activeRunIdRef.current = null;
      abortRef.current = null;
      setRunning(false);
    }
  };

  const runVariantFanout = async (count = 3): Promise<void> => {
    const text = input.trim();
    if (!isExisting || !text || runningRef.current) return;
    runningRef.current = true;
    terminalEventRef.current = false;
    activeRunIdRef.current = null;
    setRunning(true);
    setInput("");
    setLiveItems([]);
    liveItemsRef.current = [];
    setLiveStatus(`Generating ${count} variants…`);
    push("user", `Generate ${count} variants:\n\n${text}`);
    try {
      let convId = activeConv.current;
      if (!convId) {
        const conv = await api.createConversation(projectId, "Variants");
        setConversations((current) => [...current, conv]);
        setActive(conv.id);
        convId = conv.id;
      }

      let nextVariants = variants;
      const targets: Variant[] = [];
      for (let i = 0; i < count; i++) {
        nextVariants = await api.createVariant(projectId, `Variant ${nextVariants.length + 1}`);
        const active = nextVariants.find((variant) => variant.active);
        if (active) targets.push(active);
      }
      setVariants(nextVariants);

      await Promise.all(
        targets.map(async (variant, index) => {
          const stream = api.streamRun({
            projectId,
            conversationId: convId!,
            variantId: variant.id,
            brief: `${text}\n\nCreate variant ${index + 1} of ${count}. Make it a distinct visual direction while preserving the user's core request.`,
            agentCommand: runAgent || undefined,
            model: runModel || undefined,
          });
          for await (const ev of stream) {
            if (ev.type === "run-error") throw new Error(typeof ev.message === "string" ? ev.message : "variant run failed");
          }
        }),
      );

      await loadMessages(convId);
      await loadRuns(nextVariants);
      await loadFiles();
      reloadArtifact(nextVariants);
      setTab("Versions");
      toast(`Generated ${targets.length} variants.`);
    } catch (err) {
      toast(`Couldn't generate variants: ${err instanceof Error ? err.message : "run failed"}`, { variant: "error" });
    } finally {
      runningRef.current = false;
      activeRunIdRef.current = null;
      setRunning(false);
      setLiveStatus(null);
    }
  };

  const stop = (): void => {
    const runId = activeRunIdRef.current;
    materializeLive();
    if (runId) void api.cancelRun(runId).catch(() => {});
    abortRef.current?.abort();
  };

  // Keep the transcript pinned to the newest content as it streams — unless the user scrolled
  // up to read (stickBottom is cleared by the container's onScroll below).
  useEffect(() => {
    if (stickBottom.current) scrollChatToBottom("auto");
  }, [composerH, liveItems, messages, liveStatus, running, scrollChatToBottom]);

  // Drain queued prompts one at a time once the current run finishes.
  useEffect(() => {
    if (loading || runningRef.current || queueRef.current.length === 0) return;
    const [next, ...rest] = queueRef.current;
    updateQueue(rest);
    if (next?.text.trim()) void runBrief(next.text, undefined, undefined, next.moodboardRefs ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, running, queue, updateQueue]);

  useEffect(() => {
    const next = readQueue(projectId);
    queueRef.current = next;
    setQueue(next);
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setSettingsAgent(s?.agentCommand ?? "");
        setSettingsModel(s?.model ?? "");
      })
      .catch(() => alive && setSettingsAgent(""));
    return () => {
      alive = false;
    };
  }, [api]);

  // Default the composer to the saved agent + model — only once settings have loaded, so the
  // scan resolving first doesn't lock it onto the first available agent. A pending hand-off
  // from Home or a manual pick (runAgent already set) is preserved.
  useEffect(() => {
    if (settingsAgent === null) return;
    const avail = agents.filter((a) => a.available);
    if (!avail.length) return;
    const useSaved = settingsAgent !== "" && avail.some((a) => a.command === settingsAgent);
    setRunAgent((cur) => cur || (useSaved ? settingsAgent : avail[0]!.command));
    if (useSaved && settingsModel) setRunModel((cur) => cur || settingsModel);
  }, [agents, settingsAgent, settingsModel]);

  const saveAgentModelDefaults = useCallback(
    (patch: Pick<AppSettings, "agentCommand" | "model">) => {
      persistAgentModelDefaults(api, patch, () => toast("Couldn't save settings.", { variant: "error" }));
    },
    [api, toast],
  );

  const changeRunAgent = useCallback(
    (command: string) => {
      setRunAgent(command);
      setRunModel("");
      setSettingsAgent(command);
      setSettingsModel("");
      saveAgentModelDefaults({ agentCommand: command, model: "" });
    },
    [saveAgentModelDefaults],
  );

  const changeRunModel = useCallback(
    (model: string) => {
      setRunModel(model);
      setSettingsModel(model);
      if (runAgent) saveAgentModelDefaults({ agentCommand: runAgent, model });
    },
    [runAgent, saveAgentModelDefaults],
  );

  // Rehydrate the project's conversations + latest transcript, then run any pending brief.
  useEffect(() => {
    if (projectId === "new") return;
    let alive = true;
    liveQualityRef.current = false;
    setScore(null);
    setLintFindings([]);
    setRanOnce(false);
    setLoading(true);
    void (async () => {
      try {
        const convs = await api.listConversations(projectId);
        if (!alive) return;
        setConversations(convs);
        const last = convs.at(-1);
        if (last) {
          setActive(last.id);
          await loadMessages(last.id);
        }
      } catch {
        // a fresh project has no conversations yet
      }
      try {
        const proj = await api.getProject(projectId);
        if (alive) {
          modeRef.current = proj.mode;
          setProjectMode(proj.mode);
          setProjectName(proj.name);
          setDsId(proj.designSystemId ?? "");
          if (proj.mode === "standard") void loadDevPreview();
        }
        void api.listDesignSystems().then((d) => alive && setSystems(d)).catch(() => {});
      } catch {
        // project lookup failed — treat as prototype
      }
      if (alive) {
        setLoading(false);
        void loadFiles();
        void (async () => {
          const vs = await loadVariants();
          await loadRuns(vs);
        })();
      }
      const pendingImgs = takePendingImages();
      const pendingRefList = takePendingRefs();
      const pendingAg = takePendingAgent();
      const pendingMd = takePendingModel();
      if (pendingAg && alive) setRunAgent(pendingAg);
      if (pendingMd && alive) setRunModel(pendingMd);
      const pending = takePendingBrief();
      if (pending && alive) {
        if (pendingImgs.length || pendingRefList.length) {
          void (async () => {
            let note = "";
            const imgPaths: string[] = [];
            for (const img of pendingImgs) {
              try {
                imgPaths.push((await api.uploadRef(projectId, img.name, img.base64)).path);
              } catch {
                /* skip a failed upload */
              }
            }
            if (imgPaths.length) {
              note += `\n\nRecreate the attached reference screenshot(s) faithfully — match layout, type, colour, and spacing (read them from disk): ${imgPaths.join(", ")}`;
            }
            const refPaths: string[] = [];
            for (const r of pendingRefList) {
              try {
                refPaths.push((await api.uploadRef(projectId, `reference-${slugify(r.name)}.html`, r.base64)).path);
              } catch {
                /* skip a failed upload */
              }
            }
            if (refPaths.length) {
              note += `\n\nReference these existing designs (read them from disk) and match their style, structure, and design language: ${refPaths.join(", ")}`;
            }
            if (alive) void runBrief(pending + note, pendingAg ?? undefined, pendingMd ?? undefined);
          })();
        } else {
          void runBrief(pending, pendingAg ?? undefined, pendingMd ?? undefined);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Fetch the selected file's source whenever the Files tab is shown for it.
  useEffect(() => {
    if (tab !== "Files" || !activeFile) return;
    let alive = true;
    void api.getFileText(projectId, activeFile).then(
      (t) => alive && setFileText(t),
      () => alive && setFileText(""),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeFile, projectId]);

  const switchTo = async (convId: string): Promise<void> => {
    setActive(convId);
    try {
      await loadMessages(convId);
      // The artifact is project-level (one index.html / dev server), not per-conversation —
      // restore the preview so switching conversations doesn't blank it.
      if (modeRef.current === "standard") void loadDevPreview();
      else void loadFiles();
    } catch {
      toast("Couldn't load that conversation.", { variant: "error" });
    }
  };

  /** Versions → chat: switch to the run's conversation and scroll to the message that triggered it. */
  const jumpToRun = async (run: RunSummary): Promise<void> => {
    if (run.conversationId && run.conversationId !== activeConvId) await switchTo(run.conversationId);
    window.setTimeout(() => {
      const container = chatScrollRef.current;
      if (!container) return;
      const els = Array.from(container.querySelectorAll<HTMLElement>("[data-at]"));
      let target: HTMLElement | null = null;
      let best = -Infinity;
      for (const el of els) {
        const at = Number(el.dataset.at);
        if (Number.isFinite(at) && at <= run.createdAt && at > best) {
          best = at;
          target = el;
        }
      }
      target = target ?? els[0] ?? null;
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightAt(best > -Infinity ? best : null);
      window.setTimeout(() => setHighlightAt(null), 1800);
    }, 70);
  };

  const postPreviewBridge = useCallback((message: Record<string, unknown>): void => {
    previewIframeRef.current?.contentWindow?.postMessage({ source: "dezin-parent", ...message }, "*");
  }, []);

  const setPreviewPickMode = useCallback(
    (on: boolean): void => {
      postPreviewBridge({ type: "select-mode", on });
    },
    [postPreviewBridge],
  );

  const clearPreviewBridge = useCallback((): void => {
    postPreviewBridge({ type: "clear" });
  }, [postPreviewBridge]);

  // Element picker — receive the clicked element from the preview bridge.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!isPreviewBridgeMessage(e, previewIframeRef.current, previewSrc)) return;
      const d = e.data;
      if (d.type === "selected" && d.selector) {
        const target = { selector: d.selector, tag: d.tag ?? "", text: d.text ?? "", rect: d.rect, styles: d.styles, attrs: d.attrs };
        setInspectedTarget(target);
        inspectedTargetRef.current = target;
        if (selectionModeRef.current === "inspect") {
          setPendingMark(null);
          setSelectMode(false);
          setInspectOpen(true);
          setPreviewPickMode(true);
          return;
        }
        // Position a "Mark up" popover near the clicked element (iframe coords → page coords).
        const ir = previewIframeRef.current?.getBoundingClientRect();
        const r = d.rect;
        const pos = computeMarkupPosition(ir, r, { width: window.innerWidth, height: window.innerHeight });
        setPendingMark({ ...target, x: pos.x, y: pos.y });
        setInspectOpen(false);
        setSelectMode(false);
      } else if (d.type === "cancel") {
        setPendingMark(null);
        setSelectMode(false);
        if (selectionModeRef.current === "inspect") {
          clearPreviewBridge();
          if (inspectedTargetRef.current) {
            inspectedTargetRef.current = null;
            setInspectedTarget(null);
            setInspectOpen(true);
            setPreviewPickMode(true);
          } else {
            setInspectOpen(false);
          }
          return;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [clearPreviewBridge, previewSrc, setPreviewPickMode]);

  useEffect(() => {
    inspectedTargetRef.current = inspectedTarget;
  }, [inspectedTarget]);

  useEffect(() => {
    selectionModeRef.current = selectMode ? "markup" : inspectOpen ? "inspect" : null;
  }, [selectMode, inspectOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || (!selectMode && !inspectOpen && !pendingMark)) return;
      event.preventDefault();
      clearPreviewBridge();
      if (pendingMark) {
        setPendingMark(null);
        setSelectMode(false);
        return;
      }
      if (selectMode) {
        setSelectMode(false);
        return;
      }
      if (inspectOpen && inspectedTarget) {
        inspectedTargetRef.current = null;
        setInspectedTarget(null);
        setPreviewPickMode(true);
        return;
      }
      setSelectMode(false);
      setInspectOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clearPreviewBridge, inspectOpen, inspectedTarget, pendingMark, selectMode, setPreviewPickMode]);

  // Tell the preview bridge to enter/exit pick mode whenever the toggle flips.
  useEffect(() => {
    setPreviewPickMode(selectMode || inspectOpen);
  }, [selectMode, inspectOpen, previewSrc, setPreviewPickMode]);

  // Track the floating composer's height so the message list can clear it.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // Clear the pinned outline in the preview and close the popover.
  const dismissMark = (): void => {
    clearPreviewBridge();
    setPendingMark(null);
  };

  const focusMarkupTarget = (target: MarkupTarget): void => {
    setTab("Preview");
    setInspectedTarget(target);
    setInspectOpen(true);
    setSelectMode(false);
    setPendingMark(null);
    const message = {
      type: "focus-target",
      selector: target.selector,
      rect: target.rect,
    };
    const post = (): void => {
      postPreviewBridge(message);
    };
    post();
    window.setTimeout(post, 60);
  };

  const addMark = (note: string): void => {
    if (!pendingMark) return;
    const target: MarkupTarget = {
      selector: pendingMark.selector,
      tag: pendingMark.tag,
      text: pendingMark.text,
      rect: pendingMark.rect,
      styles: pendingMark.styles,
      attrs: pendingMark.attrs,
      note: note.trim() || undefined,
    };
    addContextItems([
      {
        id: `preview-target:${target.selector}:${target.note ?? ""}`,
        type: "preview-target",
        title: target.selector,
        subtitle: target.note || target.tag || "Preview element",
        selector: target.selector,
        note: target.note,
        target,
      },
    ]);
    dismissMark();
  };

  const newConversation = async (): Promise<void> => {
    try {
      const conv = await api.createConversation(projectId);
      setConversations((c) => [...c, conv]);
      setActive(conv.id);
      msgId.current = 0;
      setMessages([]);
      // Keep the project's current artifact in the preview — a new conversation iterates on it.
    } catch {
      toast("Couldn't start a new conversation.", { variant: "error" });
    }
  };

  const loadVariants = async (): Promise<Variant[]> => {
    if (!isExisting) return [];
    try {
      const vs = await api.listVariants(projectId);
      setVariants(vs);
      return vs;
    } catch {
      /* none yet */
      return [];
    }
  };

  // Switching/forking a branch changes the active artifact source — reload everything.
  const reloadArtifact = (scopeVariants: Variant[] = variants): void => {
    void loadFiles();
    void loadRuns(scopeVariants);
    if (modeRef.current === "standard") void loadDevPreview();
    else {
      clearVersionPreviewState();
      setPreviewSrc(`${api.previewUrl(projectId)}?t=${Date.now()}`);
    }
  };

  const switchVariant = async (vid: string): Promise<void> => {
    try {
      const next = await api.activateVariant(projectId, vid);
      setVariants(next);
      reloadArtifact(next);
    } catch {
      toast("Couldn't switch branch.", { variant: "error" });
    }
  };
  const createVariant = async (): Promise<void> => {
    try {
      const next = await api.createVariant(projectId);
      setVariants(next);
      reloadArtifact(next);
      toast("Forked a new branch.");
    } catch {
      toast("Couldn't create a branch.", { variant: "error" });
    }
  };
  const renameVariant = (vid: string, name: string): void => {
    setVariants((vs) => vs.map((v) => (v.id === vid ? { ...v, name } : v)));
    void api.renameVariant(projectId, vid, name).catch(() => toast("Couldn't rename the branch.", { variant: "error" }));
  };
  const deleteVariant = async (vid: string): Promise<void> => {
    if (!window.confirm("Delete this branch? Its artifact and versions are removed.")) return;
    try {
      const next = await api.deleteVariant(projectId, vid);
      setVariants(next);
      reloadArtifact(next);
    } catch {
      toast("Couldn't delete the branch.", { variant: "error" });
    }
  };

  const changeDs = (id: string): void => {
    setDsId(id);
    void api.patchProject(projectId, { designSystemId: id || null }).catch(() => toast("Couldn't change the design system.", { variant: "error" }));
  };

  const renameConv = (cid: string, title: string): void => {
    setConversations((cs) => cs.map((c) => (c.id === cid ? { ...c, title } : c)));
    void api.renameConversation(projectId, cid, title).catch(() => toast("Couldn't rename the conversation.", { variant: "error" }));
  };

  const deleteConv = async (cid: string): Promise<void> => {
    if (!window.confirm("Delete this conversation? This can't be undone.")) return;
    const remaining = conversations.filter((c) => c.id !== cid);
    try {
      await api.deleteConversation(projectId, cid);
      setConversations(remaining);
      if (activeConvId === cid) {
        if (remaining.length) void switchTo(remaining[remaining.length - 1]!.id);
        else void newConversation();
      }
    } catch {
      toast("Couldn't delete the conversation.", { variant: "error" });
    }
  };

  const send = () => {
    const scoped = selectedTargets.length > 0;
    const fileReferencePaths = contextItems.flatMap((item) => {
      if (item.type === "file") return [item.path];
      if (item.type === "project" && item.referencePath) return [item.referencePath];
      return [];
    });
    const localPathItems = contextItems.filter((item): item is Extract<WorkspaceContextItem, { type: "local-path" }> => item.type === "local-path");
    const textContextItems = contextItems.filter((item): item is Extract<WorkspaceContextItem, { type: "text-context" }> => item.type === "text-context");
    const fileRefs = fileReferencePaths.length
      ? `\n\nReference files (read them from disk): ${fileReferencePaths.join(", ")}`
      : "";
    const localPathRefs = localPathItems.length
      ? `\n\nReference local paths: ${localPathItems.map((item) => item.path).join(", ")}`
      : "";
    const textContextRefs = textContextItems.length
      ? `\n\n${textContextItems.map((item) => `${item.title}:\n${item.body}`).join("\n\n")}`
      : "";
    const boardRefs = moodboardReferenceLine(selectedMoodboardRefs);
    const targets = scoped
      ? `\n\nScoped edit — change ONLY the element(s) below and keep the rest of the design byte-for-byte unchanged:\n${selectedTargets
          .map(formatMarkupTarget)
          .join("\n")}`
      : "";
    const base = input.trim() || (scoped ? "Refine the marked element(s) per the notes." : "");
    const text = base + targets + fileRefs + localPathRefs + textContextRefs + boardRefs;
    if (!text.trim()) return;
    setInput("");
    setContextItems([]);
    // While a run is in flight, queue the prompt to run when it finishes.
    if (runningRef.current) updateQueue((q) => [...q, selectedMoodboardRefs.length ? { text, moodboardRefs: selectedMoodboardRefs } : { text }]);
    else void runBrief(text, undefined, undefined, selectedMoodboardRefs);
  };

  const updateQueuedPrompt = (index: number, value: string): void => {
    updateQueue((items) => items.map((item, i) => (i === index ? { ...item, text: value } : item)));
  };

  const deleteQueuedPrompt = (index: number): void => {
    updateQueue((items) => items.filter((_, i) => i !== index));
  };

  const moveQueuedPrompt = (from: number, to: number): void => {
    updateQueue((items) => {
      if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
      const next = [...items];
      const [item] = next.splice(from, 1);
      if (item === undefined) return items;
      next.splice(to, 0, item);
      return next;
    });
  };

  const referenceProject = async (project: Project): Promise<void> => {
    if (!isExisting) return;
    try {
      const html = await fetchProjectArtifact(api, project.id);
      if (!html) {
        toast("That project has no design to reference yet.", { variant: "error" });
        return;
      }
      const ref = await api.uploadRef(projectId, `reference-${slugify(project.name)}.html`, toBase64(html));
      addContextItems([
        {
          id: `project:${project.id}`,
          type: "project",
          title: project.name,
          subtitle: ref.path,
          projectId: project.id,
          name: project.name,
          referencePath: ref.path,
        },
      ]);
      toast(`Referencing ${project.name}.`);
    } catch {
      toast("Couldn't reference that project.", { variant: "error" });
    }
  };

  const referenceMoodboard = (board: Moodboard): void => {
    addContextItems([
      {
        id: `moodboard:${board.id}`,
        type: "moodboard",
        title: board.name || "Untitled moodboard",
        subtitle: "Moodboard",
        moodboardId: board.id,
        name: board.name,
      },
    ]);
    toast(`Referencing ${board.name}.`);
  };

  const [dragging, setDragging] = useState(false);
  const [draggingQueueIndex, setDraggingQueueIndex] = useState<number | null>(null);
  const onComposerDrop = (e: React.DragEvent): void => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void attachFiles(e.dataTransfer.files);
  };

  const attachFiles = async (files: FileList | null): Promise<void> => {
    if (!files || projectId === "new") return;
    for (const file of Array.from(files)) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const base64 = dataUrl.split(",")[1] ?? "";
        const ref = await api.uploadRef(projectId, file.name, base64);
        addContextItems([
          {
            id: `file:${ref.path}`,
            type: "file",
            title: ref.name,
            subtitle: ref.path,
            name: ref.name,
            path: ref.path,
          },
        ]);
      } catch {
        toast(`Couldn't attach ${file.name}.`, { variant: "error" });
      }
    }
  };

  const refreshDevPreview = async (): Promise<void> => {
    try {
      const { url } = await api.getDevServerUrl(projectId);
      clearVersionPreviewState();
      setPreviewSrc(`${url.split("?")[0]}?t=${Date.now()}`);
      void api.getSetup(projectId)
        .then((s) => {
          setSetupPhase(s.phase);
          setSetupError(s.error ?? null);
          setSetupLogs(s.logs ?? []);
        })
        .catch(() => {});
    } catch {
      toast("Couldn't refresh the dev preview.", { variant: "error" });
    }
  };

  const refreshPreview = () => {
    setRefreshSpin((n) => n + 1);
    if (previewVersionRunId) {
      void viewVersion(previewVersionRunId);
      return;
    }
    if (isVersionPreviewSrc(projectId, previewSrc)) {
      setPreviewSrc(cacheBustPreviewUrl(previewSrc!));
      return;
    }
    if (modeRef.current === "standard") {
      void refreshDevPreview();
      return;
    }
    if (previewSrc) setPreviewSrc(previewSrc.startsWith("http") ? cacheBustPreviewUrl(previewSrc) : cacheBustPreviewUrl(api.previewUrl(projectId)));
  };

  const canExport = previewSrc !== null && projectId !== "new";
  const isExisting = projectId !== "new";
  const qualityLanes = buildQualityLanes({ findings: lintFindings, score, ranOnce, running, checks: qualityChecks });
  const qualityHasFindings = qualityLanes.some((lane) => lane.findings.length > 0);
  const qualityRecorded = qualityLanes.some((lane) => lane.status === "passed" || lane.status === "issues" || lane.status === "failed");
  const qualityClean = ranOnce && qualityRecorded && !qualityHasFindings && qualityLanes.every((lane) => lane.status === "passed" || lane.status === "not-run");
  const versionGroups = buildVersionGroups(runs, variants);
  const activeVersionGroup = versionGroups.find((group) => group.active) ?? versionGroups[0] ?? null;
  const currentRun = activeVersionGroup?.runs[0] ?? null;
  const activeDesignSystem = systems.find((system) => system.id === dsId);

  const TAB_ICON: Record<Tab, ReactNode> = {
    Preview: <Eye size={13} strokeWidth={1.75} />,
    Files: <Folder size={13} strokeWidth={1.75} />,
    Quality: <ShieldCheck size={13} strokeWidth={1.75} />,
    Versions: <History size={13} strokeWidth={1.75} />,
  };
  const tabItems: TabItem[] = TABS.map((t) => ({
    value: t,
    label: (
      <>
        {TAB_ICON[t]}
        <span>{t}</span>
        {t === "Quality" && lintFindings.length > 0 ? (
          <span className="rounded-full bg-surface-2 px-1 text-[10px] leading-tight text-muted-foreground">{lintFindings.length}</span>
        ) : null}
      </>
    ),
  }));

  const transcriptRows = useMemo(() => groupRunCardMessages(messages), [messages]);
  const transcriptBlocks = useMemo(() => groupAssistantTurns(transcriptRows), [transcriptRows]);
  const composerOverlayH = composerH + FLOATING_COMPOSER_FADE_PX;
  const messageBottomPadding = composerOverlayH + MESSAGE_BOTTOM_CLEARANCE_PX;
  const renderTranscriptMessage = (m: Msg, stackPosition: RunCardStackPosition = "single"): ReactNode =>
    m.kind === "user" ? (
      <UserMessage text={m.text} srcFor={(p) => api.refUrl(projectId, p)} onTargetClick={focusMarkupTarget} />
    ) : m.kind === "assistant" ? (
      <AssistantMessage message={m} />
    ) : m.kind === "process" ? (
      <ProcessRecord steps={m.steps} items={m.items} elapsedMs={m.elapsedMs} stackPosition={stackPosition} />
    ) : m.kind === "visual-review" && m.visualReview ? (
      <VisualReviewRecord review={m.visualReview} stackPosition={stackPosition} />
    ) : m.kind === "question" ? (
      <QuestionCard question={m.text} onAnswer={(answer) => void runBrief(answer)} />
    ) : (
      <ResultCard text={m.text} meta={m.meta} onView={() => setTab("Preview")} stackPosition={stackPosition} />
    );
  const renderRunCardStack = (stack: Msg[], separated = false): ReactNode => (
    <div data-testid="run-card-stack" className={cn(separated && "mt-3")}>
      {stack.map((m, index) => (
        <Fragment key={m.id}>{renderTranscriptMessage(m, runCardStackPosition(index, stack.length))}</Fragment>
      ))}
    </div>
  );
  const renderPreviewFrame = (): ReactNode => (
    <iframe
      key={previewSrc ?? "artifact-preview"}
      ref={previewIframeRef}
      title="Artifact preview"
      src={previewSrc ?? undefined}
      sandbox={previewSandboxForSrc(previewSrc)}
      style={{ width: DEVICE_WIDTH[device], maxWidth: "100%" }}
      className={`h-full border-0 bg-white ${device === "desktop" ? "" : "my-3 rounded-lg border border-border"}`}
    />
  );

  if (loading) {
    return <WorkspaceLoadingLayout conversationPercent={workspaceConversationPercent} />;
  }

  return (
    <>
      <Group
        id="dezin-workspace-layout"
        className="flex-1"
        defaultLayout={twoPanelLayout(WORKSPACE_CONVERSATION_PANEL, workspaceConversationPercent, WORKSPACE_ARTIFACT_PANEL)}
        onLayoutChanged={(layout) => savePanelFraction(SPLIT_KEY, layout, WORKSPACE_CONVERSATION_PANEL)}
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
      >
        <Panel id={WORKSPACE_CONVERSATION_PANEL} minSize="320px" maxSize="55%">
          <section aria-label="Conversation" className="relative flex h-full min-w-0 flex-col">
            <div className="app-drag titlebar-pad-left flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              aria-label="Back to home"
              title="Back to home"
              onClick={() => navigate("/")}
              className="app-no-drag flex min-w-0 items-center gap-1 rounded-lg py-1 pl-1 pr-2 text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronLeft size={16} strokeWidth={2} className="shrink-0 text-muted-foreground" />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={projectName || "New project"}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
                  className="truncate text-sm font-medium"
                >
                  {projectName || "New project"}
                </motion.span>
              </AnimatePresence>
            </button>
            {projectMode === "standard" ? (
              <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Standard</span>
            ) : null}
            {isExisting && variants.length > 0 ? (
              <>
                <span className="shrink-0 text-border-strong">·</span>
                <VariantSwitcher
                  variants={variants}
                  onSwitch={(id) => void switchVariant(id)}
                  onCreate={() => void createVariant()}
                  onRename={renameVariant}
                  onDelete={(id) => void deleteVariant(id)}
                  onCompare={(vid) => {
                    const a = variants.find((v) => v.active);
                    const b = variants.find((v) => v.id === vid);
                    if (a && b)
                      setCompare({
                        a: { url: api.variantPreviewUrl(projectId, a.id), label: a.name },
                        b: { url: api.variantPreviewUrl(projectId, b.id), label: b.name },
                      });
                  }}
                />
              </>
            ) : null}
          </div>
          {isExisting ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <ConversationSelect
                conversations={conversations}
                activeId={activeConvId}
                onSwitch={(id) => void switchTo(id)}
                onRename={renameConv}
                onDelete={(id) => void deleteConv(id)}
                onCreate={() => void newConversation()}
                label={convLabel}
              />
            </div>
          ) : null}
        </div>

        <div
          ref={chatScrollRef}
          data-testid="conversation-scroll"
          onScroll={updateChatBottomState}
          className="flex-1 space-y-4 overflow-auto px-4 pt-5"
          style={{ paddingBottom: messageBottomPadding }}
        >
          {messages.length === 0 ? (
            <div className="grid h-full place-items-center">
              <div className="flex max-w-[16rem] flex-col items-center gap-3 text-center">
                <span className="grid h-11 w-11 place-items-center rounded-2xl border border-border bg-card text-foreground">
                  <Sparkles size={20} strokeWidth={1.75} />
                </span>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {projectId === "new"
                    ? "Describe the design you want. Dezin builds it here, then lints it against its own rules."
                    : "Send a message to iterate on this design."}
                </p>
              </div>
            </div>
          ) : (
            <>
              {transcriptBlocks.map((block) => {
                const row = block.kind === "row" ? block.row : undefined;
                const rowMessages =
                  block.kind === "assistant-turn" ? [block.message, ...(block.stack ?? [])] : row!.kind === "stack" ? row!.messages : [row!.message];
                const firstMessage = rowMessages[0];
                const highlighted = highlightAt != null && rowMessages.some((m) => m.at === highlightAt);
                return (
                  <FadeIn
                    key={
                      block.kind === "assistant-turn"
                        ? `assistant-turn-${rowMessages.map((m) => m.id).join("-")}`
                        : row!.kind === "stack"
                          ? `stack-${rowMessages.map((m) => m.id).join("-")}`
                          : firstMessage.id
                    }
                  >
                    <div
                      data-at={firstMessage.at ?? undefined}
                      className={`-mx-2 rounded-xl px-2 py-1 transition-colors duration-700 ${
                        block.kind === "assistant-turn" ? "group/assistant-turn" : ""
                      } ${
                        highlighted ? "bg-surface-2 ring-1 ring-border" : ""
                      }`}
                    >
                      {block.kind === "assistant-turn" ? (
                        <>
                          <AssistantMessage message={block.message} />
                          {block.stack ? renderRunCardStack(block.stack, true) : null}
                          <MessageActions
                            message={block.message}
                            disabled={running}
                            onCopy={(text) => void copyAssistantMessage(text)}
                            onFork={(msg) => void forkAssistantMessage(msg)}
                          />
                        </>
                      ) : row!.kind === "stack" ? (
                        renderRunCardStack(row!.messages)
                      ) : (
                        renderTranscriptMessage(firstMessage)
                      )}
                    </div>
                  </FadeIn>
                );
              })}
              {running ? (
                <div className="space-y-3">
                  {liveItems.map((it, i) =>
                    it.type === "text" ? (
                      it.text.trim() ? <Markdown key={i}>{it.text}</Markdown> : null
                    ) : (
                      <div key={i} className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                        <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                        <span className="truncate">{it.summary}</span>
                      </div>
                    ),
                  )}
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Spinner size={13} />
                    <span className={(liveStatus ?? "Working").startsWith("Generating") ? "shiny-text" : undefined}>
                      {liveStatus ?? "Working"}
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
          <AnimatePresence>
            {showScrollToBottom ? (
              <motion.button
                type="button"
                aria-label="Scroll to bottom"
                onClick={() => scrollChatToBottom("smooth")}
                initial={{ opacity: 0, y: 6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.96 }}
                transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
                className={cn(
                  "pointer-events-auto app-no-drag absolute right-4 z-30 grid size-8 place-items-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  running &&
                    "overflow-hidden before:absolute before:inset-[-1px] before:rounded-full before:border before:border-primary/20 before:border-t-primary/70 before:content-[''] before:animate-spin",
                )}
                style={{ bottom: `calc(100% + ${SCROLL_TO_BOTTOM_GAP_PX}px)` }}
              >
                <ArrowDown size={15} strokeWidth={1.8} aria-hidden />
              </motion.button>
            ) : null}
          </AnimatePresence>
          {/* dissolve zone above the opaque strip */}
          <div aria-hidden className="bg-gradient-to-t from-background via-background/90 to-transparent" style={{ height: FLOATING_COMPOSER_FADE_PX }} />
          {/* opaque strip — fully masks content scrolling underneath + holds the card */}
          <div ref={composerRef} className="bg-background px-3 pb-3">
          {isExisting ? (
            <div className="pointer-events-auto mb-1.5 flex items-center gap-1 px-0.5">
              <DesignSystemSelect compact systems={systems} value={dsId} onChange={changeDs} />
              {dsId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs text-muted-foreground"
                  onClick={() => setViewDs(true)}
                >
                  <Eye size={13} strokeWidth={1.75} />
                  View
                </Button>
              ) : null}
            </div>
          ) : null}
          <div
            onDragOver={(e) => {
              if (!isExisting || !hasDraggedFiles(e)) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragging(false);
            }}
            onDrop={isExisting ? onComposerDrop : undefined}
            className={`pointer-events-auto relative rounded-2xl border bg-card px-2.5 pb-2 pt-2.5 transition-[color,border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:hover:border-ring ${
              dragging ? "border-ring ring-2 ring-ring/40" : "border-input hover:border-border-strong"
            }`}
          >
            {dragging ? (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-card/90 text-sm font-medium text-foreground">
                <span className="flex items-center gap-2">
                  <Paperclip size={15} strokeWidth={1.75} />
                  Drop files to attach
                </span>
              </div>
            ) : null}
            <AgentComposerContextCards
              items={contextItems}
              onChange={setContextItems}
              onRemove={(id) => setContextItems((items) => removeContextItem(items, id))}
            />
            {queue.length ? (
              <TooltipProvider delayDuration={120}>
                <div className="mb-2 rounded-lg border border-border bg-surface-2/60 p-1.5">
                  <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                    <History size={12} strokeWidth={1.75} />
                    {queue.length} prompt{queue.length === 1 ? "" : "s"} queued
                  </div>
                  <div className="space-y-1">
                    {queue.map((prompt, i) => (
                      <div
                        key={i}
                        data-testid={`queued-prompt-row-${i}`}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const raw = e.dataTransfer?.getData("application/x-dezin-queue-index") || e.dataTransfer?.getData("text/plain");
                          const from = draggingQueueIndex ?? Number(raw);
                          if (!Number.isNaN(from)) moveQueuedPrompt(from, i);
                          setDraggingQueueIndex(null);
                        }}
                        className={`flex min-w-0 items-start gap-1 rounded-md border bg-card px-1 py-1 transition-colors ${
                          draggingQueueIndex === i ? "border-ring" : "border-border"
                        }`}
                      >
                        <ToolbarTooltip label="Drag to reorder">
                          <button
                            type="button"
                            aria-label={`Drag queued prompt ${i + 1}`}
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              setDraggingQueueIndex(i);
                              if (e.dataTransfer) {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("application/x-dezin-queue-index", String(i));
                                e.dataTransfer.setData("text/plain", String(i));
                              }
                            }}
                            onDragEnd={(e) => {
                              e.stopPropagation();
                              setDraggingQueueIndex(null);
                            }}
                            className="mt-0.5 grid h-6 w-5 shrink-0 cursor-grab place-items-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground active:cursor-grabbing"
                          >
                            <GripVertical size={13} strokeWidth={1.75} />
                          </button>
                        </ToolbarTooltip>
                        <textarea
                          aria-label={`Queued prompt ${i + 1}`}
                          rows={1}
                          value={prompt.text}
                          onChange={(e) => updateQueuedPrompt(i, e.target.value)}
                          className="field-sizing-content max-h-20 min-h-[28px] flex-1 resize-none bg-transparent px-1 py-1 text-xs leading-snug text-foreground outline-none placeholder:text-muted-foreground"
                        />
                        <ToolbarTooltip label="Delete queued prompt">
                          <IconButton
                            aria-label={`Delete queued prompt ${i + 1}`}
                            onClick={() => deleteQueuedPrompt(i)}
                            className="mt-0.5 h-6 w-6 rounded-md"
                          >
                            <Trash2 size={12} strokeWidth={1.75} />
                          </IconButton>
                        </ToolbarTooltip>
                      </div>
                    ))}
                  </div>
                </div>
              </TooltipProvider>
            ) : null}
            {isExisting ? (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.json,.csv,.svg"
                className="hidden"
                aria-label="Attach files"
                onChange={(e) => {
                  void attachFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            ) : null}
            <textarea
              aria-label="Message"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                selectedTargets.length
                  ? "Describe the change, or send to refine the selected element(s)…"
                  : isExisting
                    ? "Iterate on this design…"
                    : "Describe the design you want…"
              }
              className="field-sizing-content max-h-40 min-h-[36px] w-full resize-none bg-transparent px-1 py-0.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-0.5">
                <AttachMenu
                  onAttachFile={isExisting ? () => fileInputRef.current?.click() : undefined}
                  onPickPaths={(paths) =>
                    addContextItems(
                      paths.map((path) => ({
                        id: `local-path:${path}`,
                        type: "local-path",
                        title: path.split(/[\\/]/).filter(Boolean).pop() || path,
                        subtitle: path,
                        path,
                      })),
                    )
                  }
                  onContext={(text) =>
                    addContextItems([
                      {
                        id: `text-context:${Date.now()}:${text.slice(0, 32)}`,
                        type: "text-context",
                        title: "Imported context",
                        subtitle: "Text",
                        body: text,
                      },
                    ])
                  }
                  onReference={isExisting ? (p) => void referenceProject(p) : undefined}
                  onReferenceMoodboard={isExisting ? referenceMoodboard : undefined}
                />
              </div>
              <TooltipProvider delayDuration={120}>
                <div className="flex min-w-0 items-center gap-1">
                  <AgentModelSelect
                    agents={agents}
                    agent={runAgent}
                    model={runModel}
                    dropUp
                    onAgentChange={changeRunAgent}
                    onModelChange={changeRunModel}
                    onRescan={rescanAgents}
                  />
                  {SHOW_VARIANT_FANOUT_BUTTON ? (
                    <ToolbarTooltip label="Generate 3 variants">
                      <Button
                        aria-label="Generate variants"
                        size="icon-sm"
                        variant="outline"
                        onClick={() => void runVariantFanout(3)}
                        disabled={!isExisting || running || input.trim().length === 0}
                        className="ml-0.5 rounded-lg"
                      >
                        <GitFork size={13} strokeWidth={1.8} />
                      </Button>
                    </ToolbarTooltip>
                  ) : null}
                  {running && input.trim().length === 0 && !hasComposerContext ? (
                    <Button aria-label="Stop" size="icon-sm" variant="outline" onClick={stop} className="ml-0.5 rounded-lg" title="Stop generating">
                      <Square size={12} strokeWidth={2} className="fill-current" />
                    </Button>
                  ) : (
                    <Button
                      aria-label={running ? "Queue" : "Send"}
                      size="icon-sm"
                      onClick={send}
                      disabled={!running && input.trim().length === 0 && !hasComposerContext}
                      title={running ? "Queue this prompt to run next" : undefined}
                      className="ml-0.5 rounded-lg"
                    >
                      <ArrowUp size={15} strokeWidth={2} />
                    </Button>
                  )}
                </div>
              </TooltipProvider>
            </div>
          </div>
          </div>
        </div>
        </section>
      </Panel>

      <Separator aria-label="Resize panels" className={RESIZE_SEPARATOR_CLASS} />

      <Panel id={WORKSPACE_ARTIFACT_PANEL} minSize="360px">
        <section aria-label="Artifact" className="flex h-full min-w-0 flex-col">
          <div className="app-drag flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-1">
          <Tabs
            aria-label="Artifact views"
            className="[&_[role=tab]]:px-2.5"
            items={tabItems}
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            variant="plain"
          />
          <TooltipProvider delayDuration={120}>
            <div className="flex items-center gap-1">
              {tab === "Preview" && previewSrc ? (
                <>
                  <Segmented
                    ariaLabel="Device"
                    size="xs"
                    value={device}
                    onChange={setDevice}
                    className="app-no-drag mr-1"
                    options={[
                      { value: "desktop", title: "Desktop", icon: <Monitor size={13} strokeWidth={1.75} /> },
                      { value: "tablet", title: "Tablet", icon: <Tablet size={13} strokeWidth={1.75} /> },
                      { value: "mobile", title: "Mobile", icon: <Smartphone size={13} strokeWidth={1.75} /> },
                    ]}
                  />
                  <ToolbarTooltip label={selectMode ? "Click an element in the preview" : "Select an element to refine"}>
                    <IconButton
                      aria-label="Select an element"
                      onClick={() =>
                        setSelectMode((v) => {
                          const next = !v;
                          if (next) {
                            setInspectOpen(false);
                            setInspectedTarget(null);
                            setPendingMark(null);
                          }
                          return next;
                        })
                      }
                      className={cn("app-no-drag", selectMode && ACTIVE_TOOL_BUTTON_CLASS)}
                    >
                      <MousePointerClick size={15} strokeWidth={1.75} />
                    </IconButton>
                  </ToolbarTooltip>
                  <ToolbarTooltip label={inspectOpen ? "Hide inspect panel" : "Inspect preview"}>
                    <IconButton
                      aria-label="Inspect preview"
                      onClick={() =>
                        setInspectOpen((v) => {
                          const next = !v;
                          setSelectMode(false);
                          setPendingMark(null);
                          setInspectedTarget(null);
                          if (!next) clearPreviewBridge();
                          return next;
                        })
                      }
                      className={cn("app-no-drag", inspectOpen && ACTIVE_TOOL_BUTTON_CLASS)}
                    >
                      <Eye size={15} strokeWidth={1.75} />
                    </IconButton>
                  </ToolbarTooltip>
                  <ToolbarTooltip label="Refresh preview">
                    <IconButton aria-label="Refresh preview" onClick={refreshPreview} className="app-no-drag">
                      <motion.span animate={{ rotate: refreshSpin * 360 }} transition={{ duration: 0.5, ease: [0.25, 1, 0.5, 1] }}>
                        <RotateCw size={15} strokeWidth={1.75} />
                      </motion.span>
                    </IconButton>
                  </ToolbarTooltip>
                  <ToolbarTooltip label="Full screen preview">
                    <IconButton
                      aria-label="Full screen preview"
                      onClick={() => setFullscreen(true)}
                      className="app-no-drag"
                    >
                      <Maximize2 size={15} strokeWidth={1.75} />
                    </IconButton>
                  </ToolbarTooltip>
                </>
              ) : null}
              {canExport || onOpenSettings ? (
                <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
              ) : null}
              {canExport ? (
                <DropdownMenu open={exportOpen} onOpenChange={setExportOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="app-no-drag inline-flex">
                        <DropdownMenuTrigger
                          aria-label="Export project"
                          onClick={() => setExportOpen(true)}
                          className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-[transform,color,background-color] duration-150 ease-out hover:bg-surface-2 hover:text-foreground active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
                        >
                          <Download size={15} strokeWidth={1.75} />
                        </DropdownMenuTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={2}>Export project</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem asChild>
                      <a href={api.exportUrl(projectId)} download>
                        Source ZIP
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <a href={api.exportUrl(projectId, "full")} download>
                        Full project ZIP
                      </a>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {onOpenSettings ? (
                <>
                  <ToolbarTooltip label="Settings">
                    <IconButton aria-label="Settings" onClick={() => onOpenSettings()} className="app-no-drag">
                      <Settings size={15} strokeWidth={1.75} />
                    </IconButton>
                  </ToolbarTooltip>
                </>
              ) : null}
            </div>
          </TooltipProvider>
        </div>

        <div className="dz-canvas relative flex-1 overflow-hidden">
          {selectMode && tab === "Preview" && previewSrc ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2.5">
              <span className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md">
                <MousePointerClick size={12} strokeWidth={2} />
                Click an element to attach it · Esc to cancel
              </span>
            </div>
          ) : null}
          {previewBusy ? <PreviewBusyOverlay {...previewBusy} /> : null}
          {tab === "Preview" ? (
            previewSrc ? (
              <Group
                id="dezin-preview-inspect-layout"
                className="h-full min-w-0 bg-surface"
                defaultLayout={twoPanelLayout(PREVIEW_CANVAS_PANEL, 100 - inspectPanelPercent, PREVIEW_INSPECT_PANEL)}
                onLayoutChanged={(layout) => savePanelFraction(INSPECT_SPLIT_KEY, layout, PREVIEW_INSPECT_PANEL)}
                resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
              >
                <Panel id={PREVIEW_CANVAS_PANEL} minSize="300px">
                  <div className="flex h-full min-w-0 justify-center overflow-auto">{renderPreviewFrame()}</div>
                </Panel>
                {inspectOpen ? (
                  <Separator aria-label="Resize inspect panel" className={RESIZE_SEPARATOR_CLASS} />
                ) : null}
                {inspectOpen ? (
                  <Panel id={PREVIEW_INSPECT_PANEL} minSize="240px" maxSize="460px" groupResizeBehavior="preserve-pixel-size">
                    <InspectPanel target={inspectedTarget} projectName={projectName} projectMode={projectMode} designSystem={activeDesignSystem} files={files} />
                  </Panel>
                ) : null}
              </Group>
            ) : projectMode === "standard" && setupPhase && setupPhase !== "ready" ? (
              <div className="grid h-full place-items-center p-4">
                <div className="flex w-full max-w-xl flex-col items-center gap-3 text-center text-muted-foreground">
                  <Spinner size={18} />
                  <p className="text-sm">
                    {setupPhase === "scaffolding"
                      ? "Scaffolding the Vite + React + GSAP project…"
                      : setupPhase === "installing"
                        ? "Installing dependencies (first run only)…"
                        : "Project setup failed."}
                  </p>
                  <div className="w-full text-left">
                    <StandardDoctor phase={setupPhase} logs={setupLogs} error={setupError} onRefresh={refreshPreview} />
                  </div>
                </div>
              </div>
            ) : (
              emptyPane(running ? "Generating…" : "Your preview will appear here")
            )
          ) : tab === "Files" ? (
            <FilesPanel files={files} activeFile={activeFile} fileText={fileText} running={running} onOpen={openFile} />
          ) : tab === "Quality" ? (
            <div className="flex h-full flex-col bg-surface">
              {ranOnce && score !== null ? (
                <PanelBar className="gap-1.5">
                  Quality score
                  <span className="tnum font-mono font-semibold text-foreground">{score}/100</span>
                </PanelBar>
              ) : null}
              {ranOnce || running || projectMode === "standard" ? (
                <div className="flex-1 overflow-auto p-3 text-sm">
                  {projectMode === "standard" ? (
                    <div className="mb-3">
                      <StandardDoctor phase={setupPhase} logs={setupLogs} error={setupError} onRefresh={refreshPreview} />
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {qualityLanes.map((lane) => (
                      <section key={lane.key} className="overflow-hidden rounded-lg border border-border bg-card">
                        <div className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-foreground">{lane.label}</div>
                            <div className="truncate text-[11px] text-muted-foreground">{lane.desc}</div>
                          </div>
                          <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium", qualityStatusClass(lane.status))}>
                            {qualityStatusText(lane.status)}
                          </span>
                        </div>
                        {lane.key === "agent" ? <AgentVisualReviewSummary findings={lane.findings} /> : null}
                        {lane.findings.length > 0 ? (
                          <ul className="space-y-2 border-t border-border px-3 py-2.5">
                            {lane.findings.map((f, idx) => (
                              <li key={`${f.id}-${idx}`} className="rounded-md border border-border bg-surface p-2.5">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${SEVERITY_STYLE[f.severity] ?? "border-border text-muted-foreground"}`}
                                  >
                                    {f.severity}
                                  </span>
                                  <span className="font-mono text-xs text-muted-foreground">{f.id}</span>
                                </div>
                                <p className="mt-1.5 text-sm leading-snug text-foreground">{f.message}</p>
                                {f.fix ? <p className="mt-1 text-xs leading-snug text-muted-foreground">Fix: {f.fix}</p> : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </section>
                    ))}
                  </div>
                  {!qualityHasFindings ? (
                    <p className="mt-3 px-1 text-xs text-muted-foreground">
                      {running
                        ? "Quality checks are still running."
                        : qualityClean
                          ? "No findings in recorded checks."
                          : ranOnce
                            ? "No stored quality details for this run."
                            : "Run to check quality."}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="flex-1">{emptyPane("Run to check quality")}</div>
              )}
            </div>
          ) : tab === "Versions" ? (
            versionGroups.length > 0 ? (
              <div className="h-full overflow-auto bg-surface p-3 text-sm">
                {versionGroups.map((group) => (
                  <section key={group.id} className="mb-4 last:mb-0">
                    <div className="mb-2 flex items-center justify-between gap-3 px-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-xs font-semibold text-foreground">{group.name}</span>
                        {group.active ? (
                          <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Current branch
                          </span>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {group.runs.length} version{group.runs.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {group.runs.length > 0 ? (
                      <ul className="space-y-2">
                        {group.runs.map((r, i) => {
                          const label = `v${group.runs.length - i}`;
                          const isCurrent = currentRun?.id === r.id;
                          return (
                            <li key={r.id} className="group flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                              <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(r.status)}`} aria-hidden />
                              <span className="text-sm font-medium">{label}</span>
                              {isCurrent ? (
                                <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">Current</span>
                              ) : null}
                              {r.score !== null ? (
                                <span className="tnum rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-foreground-2">
                                  {r.score}/100
                                </span>
                              ) : null}
                              <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {r.repairRounds} fix{r.repairRounds === 1 ? "" : "es"} · {shortTime(r.createdAt)}
                              </span>
                              <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Jump to the message for ${group.name} ${label}`}
                                  title="Jump to the chat message"
                                  onClick={() => void jumpToRun(r)}
                                >
                                  <CornerUpLeft size={14} strokeWidth={1.75} />
                                  Chat
                                </Button>
                                <Button variant="ghost" size="sm" aria-label={`View ${group.name} ${label}`} onClick={() => void viewVersion(r.id)}>
                                  View
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Set ${group.name} ${label} as cover`}
                                  onClick={() => void setVersionCover(r.id)}
                                >
                                  Cover
                                </Button>
                                {!isCurrent ? (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      aria-label={`Diff ${group.name} ${label}`}
                                      onClick={() => void openDiff(r.id, `${group.name} ${label}`)}
                                    >
                                      Diff
                                    </Button>
                                    {currentRun ? (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-label={`Compare ${group.name} ${label} visually`}
                                        title="Visual compare with the current version"
                                        onClick={() => void openVersionCompare(r.id, `${group.name} ${label}`)}
                                      >
                                        Compare
                                      </Button>
                                    ) : null}
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      aria-label={`Restore ${group.name} ${label}`}
                                      onClick={() => void restoreVersion(r.id)}
                                    >
                                      Restore
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        No versions on this branch yet.
                      </div>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              emptyPane(running ? "Generating…" : "No runs yet")
            )
          ) : (
            emptyPane(running ? "Generating…" : "Your preview will appear here")
          )}
        </div>
        </section>
      </Panel>
      </Group>

      {pendingMark ? <MarkUpPopover mark={pendingMark} onAdd={addMark} onCancel={dismissMark} /> : null}
      {compare ? <VersionCompare open onClose={() => setCompare(null)} a={compare.a} b={compare.b} /> : null}
      {viewDs && dsId ? (
        <Dialog open onClose={() => setViewDs(false)} label="Design system" className="sm:max-w-5xl" showClose>
          <div className="h-[82vh]">
            <DesignSystemDetailScreen id={dsId} embedded />
          </div>
        </Dialog>
      ) : null}
      <PreviewModal open={fullscreen} src={previewSrc ?? undefined} onClose={() => setFullscreen(false)} />

      {diff ? (
        <Dialog open onClose={() => setDiff(null)} label={`Diff ${diff.label}`} className="sm:max-w-3xl" align="top" showClose>
          <div className="flex h-9 items-center gap-3 border-b border-border px-4 text-xs">
            <span className="font-medium">{diff.label}</span>
            <span className="text-success">+{diffStat(diff.lines).added}</span>
            <span className="text-destructive">−{diffStat(diff.lines).removed}</span>
          </div>
          <div className="max-h-[68vh] overflow-auto bg-card font-mono text-xs leading-relaxed">
            {diff.lines.map((l, k) => (
              <div
                key={k}
                className={
                  l.t === "add"
                    ? "bg-success/10 text-success"
                    : l.t === "del"
                      ? "bg-destructive/10 text-destructive"
                      : "text-muted-foreground/60"
                }
              >
                <span className="inline-block w-5 select-none pl-2 opacity-60">
                  {l.t === "add" ? "+" : l.t === "del" ? "−" : ""}
                </span>
                {l.text || " "}
              </div>
            ))}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
