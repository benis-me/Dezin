import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, CircleAlert, CornerUpLeft, Download, Eye, FileCode2, Folder, History, Maximize2, Monitor, MousePointerClick, PanelsTopLeft, Paperclip, RotateCw, Settings, ShieldCheck, Smartphone, Sparkles, Square, Tablet, X } from "lucide-react";
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
  Loading,
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
import { setPendingAgent, setPendingBrief, takePendingBrief, takePendingImages, takePendingAgent, takePendingModel, takePendingRefs } from "../lib/pending-brief.ts";
import type { Conversation, Variant, DesignSystemCard, Message, Project, ProjectFile, ProjectMode, QualityFinding, RunEvent, RunSummary, SetupPhase } from "../lib/api.ts";
import { fetchProjectArtifact, slugify, toBase64 } from "../lib/project-ref.ts";
import { panelPercentFromPixels, readPanelPercent, readStoredPanelPercent, RESIZE_SEPARATOR_CLASS, savePanelFraction, twoPanelLayout } from "../lib/panel-layout.ts";

const TABS = ["Preview", "Files", "Quality", "Versions"] as const;
type Tab = (typeof TABS)[number];

type Device = "desktop" | "tablet" | "mobile";
const DEVICE_WIDTH: Record<Device, string> = { desktop: "100%", tablet: "768px", mobile: "390px" };

const SEVERITY_STYLE: Record<string, string> = {
  P0: "border-destructive text-destructive",
  P1: "border-border-strong text-foreground",
  P2: "border-border text-muted-foreground",
};

const SPLIT_KEY = "dezin.workspace.split";
const FILES_SPLIT_KEY = "dezin.workspace.files.split";
const WORKSPACE_CONVERSATION_PANEL = "conversation";
const WORKSPACE_ARTIFACT_PANEL = "artifact";
const FILES_BROWSER_PANEL = "browser";
const FILES_PREVIEW_PANEL = "preview";
const REPLAYABLE_RUN_STATUSES = new Set(["running", "pending", "cancelled", "failed"]);

function queueKey(projectId: string): string {
  return `dezin.workspace.queue.${projectId}`;
}

function readQueue(projectId: string): string[] {
  if (projectId === "new") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(queueKey(projectId)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function writeQueue(projectId: string, queue: string[]): void {
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
}
interface Msg {
  id: number;
  kind: "user" | "assistant" | "result" | "process" | "question";
  text: string;
  meta?: ResultMeta;
  steps?: string[];
  items?: LiveItem[];
  elapsedMs?: number;
  runId?: string;
  /** DB createdAt — used to link a Versions run back to its triggering message. */
  at?: number;
}

/** A live, ordered chunk of the agent's turn — assistant prose or a tool step — so the two
 *  render interleaved (chronologically) during generation, not split into separate blocks. */
type LiveItem = { type: "text"; text: string } | { type: "tool"; summary: string };

interface MarkupRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MarkupTarget {
  selector: string;
  tag: string;
  text: string;
  rect?: MarkupRect;
  note?: string;
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

function isVisualFinding(finding: QualityFinding): boolean {
  return finding.id.startsWith("visual-");
}

function normalizeResultMeta(value: unknown): ResultMeta | undefined {
  if (!isRecord(value)) return undefined;
  const meta: ResultMeta = {};
  if (typeof value.passed === "boolean") meta.passed = value.passed;
  if (typeof value.score === "number" || value.score === null) meta.score = value.score;
  if (typeof value.rounds === "number") meta.rounds = value.rounds;
  if (typeof value.error === "boolean") meta.error = value.error;
  if (value.status === "done" || value.status === "stopped" || value.status === "failed") meta.status = value.status;
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

function briefToName(brief: string): string {
  const t = brief.trim().replace(/\s+/g, " ");
  return t.length === 0 ? "Untitled" : t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function convLabel(c: Conversation, i: number): string {
  return c.title && c.title !== "Untitled" ? c.title : `Conversation ${i + 1}`;
}

function toMsg(m: Message, id: number): Msg {
  if (m.role === "system") {
    // Persisted process/result records are JSON blobs stored by the daemon.
    try {
      const parsed = JSON.parse(m.content) as unknown;
      if (isRecord(parsed) && isRecord(parsed.result) && typeof parsed.result.text === "string") {
        return { id, kind: "result", text: parsed.result.text, meta: normalizeResultMeta(parsed.result.meta), at: m.createdAt };
      }
      if (isRecord(parsed) && isRecord(parsed.question) && typeof parsed.question.text === "string") {
        return {
          id,
          kind: "question",
          text: parsed.question.text,
          runId: typeof parsed.question.runId === "string" ? parsed.question.runId : undefined,
          at: m.createdAt,
        };
      }
      if (isRecord(parsed) && isRecord(parsed.process)) {
        const items = normalizeLiveItems(parsed.process.items);
        const elapsedMs = typeof parsed.process.elapsedMs === "number" ? parsed.process.elapsedMs : undefined;
        return { id, kind: "process", text: "", items, elapsedMs, at: m.createdAt };
      }
      if (isRecord(parsed) && Array.isArray(parsed.steps)) return { id, kind: "process", text: "", steps: parsed.steps as string[], at: m.createdAt };
    } catch {
      /* fall through */
    }
    return { id, kind: "process", text: "", steps: [], at: m.createdAt };
  }
  return { id, kind: m.role === "user" ? "user" : "assistant", text: m.content, at: m.createdAt };
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
  for (const run of runs) {
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

/** A collapsed record of the agent's process or build steps, kept in the transcript. */
function ProcessRecord({ steps = [], items = [], elapsedMs }: { steps?: string[]; items?: LiveItem[]; elapsedMs?: number }) {
  const [open, setOpen] = useState(false);
  const process = items.length > 0;
  const elapsed = formatElapsed(elapsedMs);
  const label = process ? `Processed${elapsed ? ` ${elapsed}` : ""}` : `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/60">
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

function ResultCard({ text, meta, onView }: { text: string; meta?: ResultMeta; onView: () => void }) {
  const error = meta?.error;
  const score = meta?.score;
  const stopped = meta?.status === "stopped" || text === "Stopped.";
  const label = stopped ? "Stopped" : text;
  return (
    <div className={`rounded-lg border px-3 py-1.5 ${error ? "border-destructive/40 bg-destructive/5" : "border-border bg-card/70"}`}>
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
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
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

export function WorkspaceScreen({ projectId, onOpenSettings }: { projectId: string; onOpenSettings?: (section?: string) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("Preview");
  const [device, setDevice] = useState<Device>("desktop");
  const [fullscreen, setFullscreen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
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
  const [selectedTargets, setSelectedTargets] = useState<MarkupTarget[]>([]);
  const [pendingMark, setPendingMark] = useState<(MarkupTarget & { x: number; y: number }) | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const [setupPhase, setSetupPhase] = useState<SetupPhase | null>(null);
  const [running, setRunning] = useState(false);
  const [queue, setQueue] = useState<string[]>(() => readQueue(projectId));
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
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
  const msgId = useRef(0);
  const activeConv = useRef<string | null>(null);
  const modeRef = useRef<ProjectMode>("prototype");
  const liveItemsRef = useRef<LiveItem[]>([]);
  const currentTurnTextRef = useRef("");
  const finalSummaryTextRef = useRef("");
  const gotTurnText = useRef(false);
  const stickBottom = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const activeRunIdRef = useRef<string | null>(null);
  const runStartedAtRef = useRef<number | null>(null);
  const terminalEventRef = useRef(false);
  const liveQualityRef = useRef(false);
  const reattachedRunsRef = useRef<Set<string>>(new Set());

  const setActive = (id: string | null) => {
    activeConv.current = id;
    setActiveConvId(id);
  };

  const push = (kind: Msg["kind"], text: string) =>
    setMessages((m) => [...m, { id: msgId.current++, kind, text, at: Date.now() }]);

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
      setRuns(rs);
      // Reflect the active branch's latest run in the Quality tab when reopening a project.
      const activeVariantId = activeVariantIdOf(scopeVariants);
      const latest = activeVariantId ? (rs.find((run) => (run.variantId ?? activeVariantId) === activeVariantId) ?? null) : (rs[0] ?? null);
      if (latest && typeof latest.score === "number") {
        setScore(latest.score);
        setLintFindings(normalizeFindings(latest.findings));
        setRanOnce(true);
        liveQualityRef.current = false;
      } else {
        if (!liveQualityRef.current) {
          setScore(null);
          setLintFindings([]);
          setRanOnce(Boolean(latest));
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
        if (s.phase === "ready") break;
        if (s.phase === "error") return;
        await new Promise((r) => setTimeout(r, 1500));
      }
      const { url } = await api.getDevServerUrl(projectId);
      setPreviewSrc(url);
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

  const viewVersion = (runId: string): void => {
    setPreviewSrc(api.versionPreviewUrl(projectId, runId));
    setTab("Preview");
  };

  const openDiff = async (runId: string, label: string): Promise<void> => {
    try {
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

  const pushResult = (text: string, meta: ResultMeta): void =>
    setMessages((m) => [...m, { id: msgId.current++, kind: "result", text, meta }]);

  // Turn the live (interleaved) stream into the transcript: a collapsed process record,
  // then visible prose, then a compact steps summary. Used on completion and Stop.
  const materializeLive = ({ emitSummary = true }: { emitSummary?: boolean } = {}): string => {
    const items = liveItemsRef.current;
    if (!items.length) return "";
    const text = finalSummaryTextRef.current.trim() || liveText(items);
    const steps = items.filter((i): i is { type: "tool"; summary: string } => i.type === "tool").map((i) => i.summary);
    const elapsedMs = runStartedAtRef.current ? Date.now() - runStartedAtRef.current : undefined;
    const next: Msg[] = [{ id: msgId.current++, kind: "process", text: "", items: [...items], elapsedMs }];
    if (emitSummary && text) next.push({ id: msgId.current++, kind: "assistant", text });
    if (steps.length) next.push({ id: msgId.current++, kind: "process", text: "", steps });
    setMessages((m) => [...m, ...next]);
    liveItemsRef.current = [];
    currentTurnTextRef.current = "";
    finalSummaryTextRef.current = "";
    setLiveItems([]);
    return text;
  };

  const handleEvent = (ev: RunEvent, id: string): void => {
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
        setLiveItems([]);
        liveItemsRef.current = [];
        currentTurnTextRef.current = "";
        finalSummaryTextRef.current = "";
        gotTurnText.current = false;
        stickBottom.current = true;
        setLiveStatus("Starting…");
        break;
      case "turn-start":
        gotTurnText.current = false;
        currentTurnTextRef.current = "";
        setLiveStatus(ev.isRepair ? "Repairing the artifact…" : "Generating…");
        break;
      case "preview-update":
        // The agent rewrote the artifact mid-run — show it building live.
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
        // Runners that don't stream text chunks still hand the full turn text here.
        if (typeof ev.text === "string" && ev.text && !gotTurnText.current) {
          liveItemsRef.current = [...liveItemsRef.current, { type: "text", text: ev.text }];
          setLiveItems(liveItemsRef.current);
          finalSummaryTextRef.current = ev.text.trim();
        } else if (gotTurnText.current) {
          finalSummaryTextRef.current = (currentTurnTextRef.current || (typeof ev.text === "string" ? ev.text : "")).trim();
        }
        gotTurnText.current = false;
        break;
      case "lint": {
        const findings = Array.isArray(ev.findings) ? (ev.findings as QualityFinding[]) : [];
        setLintFindings(findings);
        setLiveStatus(`Found ${findings.length} issue${findings.length === 1 ? "" : "s"}, repairing`);
        break;
      }
      case "run-done": {
        terminalEventRef.current = true;
        activeRunIdRef.current = null;
        const rounds = typeof ev.rounds === "number" ? ev.rounds : 0;
        const s = typeof ev.score === "number" ? ev.score : null;
        if (Array.isArray(ev.findings)) setLintFindings(normalizeFindings(ev.findings));
        setScore(s);
        liveQualityRef.current = true;
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
        else setPreviewSrc(`${api.previewUrl(id)}?t=${Date.now()}`);
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
      for await (const ev of api.reattachRun(runId, ctrl.signal)) handleEvent(ev, projectId);
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
        pushResult(`Couldn't reconnect: ${err instanceof Error ? err.message : "stream unavailable"}`, { error: true });
      }
    } finally {
      if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
      runningRef.current = false;
      if (abortRef.current === ctrl) abortRef.current = null;
      setRunning(false);
    }
  };

  const runBrief = async (brief: string, agentOverride?: string, modelOverride?: string): Promise<void> => {
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
  }, [liveItems, messages, liveStatus, running, scrollChatToBottom]);

  // Drain queued prompts one at a time once the current run finishes.
  useEffect(() => {
    if (loading || runningRef.current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runBrief(next!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, running, queue]);

  useEffect(() => {
    setQueue(readQueue(projectId));
  }, [projectId]);

  useEffect(() => {
    writeQueue(projectId, queue);
  }, [projectId, queue]);

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

  // Element picker — receive the clicked element from the preview bridge.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as
        | { source?: string; type?: string; selector?: string; tag?: string; text?: string; rect?: { x: number; y: number; w: number; h: number } }
        | null;
      if (!d || d.source !== "dezin") return;
      if (d.type === "selected" && d.selector) {
        // Position a "Mark up" popover near the clicked element (iframe coords → page coords).
        const ir = previewIframeRef.current?.getBoundingClientRect();
        const r = d.rect;
        const pos = computeMarkupPosition(ir, r, { width: window.innerWidth, height: window.innerHeight });
        setPendingMark({ selector: d.selector, tag: d.tag ?? "", text: d.text ?? "", rect: r, x: pos.x, y: pos.y });
        setSelectMode(false);
      } else if (d.type === "cancel") {
        setSelectMode(false);
        setPendingMark(null);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Tell the preview bridge to enter/exit pick mode whenever the toggle flips.
  useEffect(() => {
    previewIframeRef.current?.contentWindow?.postMessage({ source: "dezin-parent", type: "select-mode", on: selectMode }, "*");
  }, [selectMode, previewSrc]);

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
    previewIframeRef.current?.contentWindow?.postMessage({ source: "dezin-parent", type: "clear" }, "*");
    setPendingMark(null);
  };

  const focusMarkupTarget = (target: MarkupTarget): void => {
    setTab("Preview");
    const message = {
      source: "dezin-parent",
      type: "focus-target",
      selector: target.selector,
      rect: target.rect,
    };
    const post = (): void => {
      previewIframeRef.current?.contentWindow?.postMessage(message, "*");
    };
    post();
    window.setTimeout(post, 60);
  };

  const addMark = (note: string): void => {
    if (!pendingMark) return;
    setSelectedTargets((cur) => [
      ...cur,
      {
        selector: pendingMark.selector,
        tag: pendingMark.tag,
        text: pendingMark.text,
        rect: pendingMark.rect,
        note: note.trim() || undefined,
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
    else setPreviewSrc(`${api.previewUrl(projectId)}?t=${Date.now()}`);
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
    const refs = attachments.length
      ? `\n\nReference files (read them from disk): ${attachments.map((a) => a.path).join(", ")}`
      : "";
    const targets = scoped
      ? `\n\nScoped edit — change ONLY the element(s) below and keep the rest of the design byte-for-byte unchanged:\n${selectedTargets
          .map(formatMarkupTarget)
          .join("\n")}`
      : "";
    const base = input.trim() || (scoped ? "Refine the marked element(s) per the notes." : "");
    const text = base + targets + refs;
    if (!text.trim()) return;
    setInput("");
    setAttachments([]);
    setSelectedTargets([]);
    // While a run is in flight, queue the prompt to run when it finishes.
    if (runningRef.current) setQueue((q) => [...q, text]);
    else void runBrief(text);
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
      setAttachments((a) => (a.some((x) => x.path === ref.path) ? a : [...a, ref]));
      toast(`Referencing ${project.name}.`);
    } catch {
      toast("Couldn't reference that project.", { variant: "error" });
    }
  };

  const [dragging, setDragging] = useState(false);
  const onComposerDrop = (e: React.DragEvent): void => {
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
        setAttachments((a) => [...a, ref]);
      } catch {
        toast(`Couldn't attach ${file.name}.`, { variant: "error" });
      }
    }
  };

  const refreshPreview = () => {
    setRefreshSpin((n) => n + 1);
    if (previewSrc) setPreviewSrc(previewSrc.startsWith("http") ? `${previewSrc.split("?")[0]}?t=${Date.now()}` : `${api.previewUrl(projectId)}?t=${Date.now()}`);
  };

  const canExport = previewSrc !== null && projectId !== "new";
  const isExisting = projectId !== "new";
  const visualFindings = lintFindings.filter(isVisualFinding);
  const antiSlopFindings = lintFindings.filter((finding) => !isVisualFinding(finding));
  const findingGroups = [
    { label: "Visual QA", desc: "Rendered screenshot and viewport geometry", findings: visualFindings },
    { label: "Anti-slop", desc: "Static design and accessibility rules", findings: antiSlopFindings },
  ].filter((group) => group.findings.length > 0);
  const versionGroups = buildVersionGroups(runs, variants);
  const activeVersionGroup = versionGroups.find((group) => group.active) ?? versionGroups[0] ?? null;
  const currentRun = activeVersionGroup?.runs[0] ?? null;

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
              <span className="truncate text-sm font-medium">{projectName || "New project"}</span>
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
          style={{ paddingBottom: composerH + 36 }}
        >
          {loading ? (
            <Loading />
          ) : messages.length === 0 ? (
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
              {messages.map((m) => (
                <FadeIn key={m.id}>
                  <div
                    data-at={m.at ?? undefined}
                    className={`-mx-2 rounded-xl px-2 py-1 transition-colors duration-700 ${
                      highlightAt != null && m.at === highlightAt ? "bg-surface-2 ring-1 ring-border" : ""
                    }`}
                  >
                    {m.kind === "user" ? (
                      <UserMessage text={m.text} srcFor={(p) => api.refUrl(projectId, p)} onTargetClick={focusMarkupTarget} />
                    ) : m.kind === "assistant" ? (
                      <Markdown>{m.text}</Markdown>
                    ) : m.kind === "process" ? (
                      <ProcessRecord steps={m.steps} items={m.items} elapsedMs={m.elapsedMs} />
                    ) : m.kind === "question" ? (
                      <QuestionCard question={m.text} onAnswer={(answer) => void runBrief(answer)} />
                    ) : (
                      <ResultCard text={m.text} meta={m.meta} onView={() => setTab("Preview")} />
                    )}
                  </div>
                </FadeIn>
              ))}
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
                    {liveStatus ?? "Working"}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
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
              className="app-no-drag absolute right-4 z-30 grid size-8 place-items-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              style={{ bottom: composerH + 16 }}
            >
              <ArrowDown size={15} strokeWidth={1.8} aria-hidden />
            </motion.button>
          ) : null}
        </AnimatePresence>
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
          {/* dissolve zone above the opaque strip */}
          <div aria-hidden className="h-12 bg-gradient-to-t from-background via-background/90 to-transparent" />
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
              if (!isExisting) return;
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
            {selectedTargets.length ? (
              <div className="mb-2">
                <p className="label-mono mb-1 flex items-center gap-1.5 text-brand">
                  <MousePointerClick size={11} strokeWidth={2} />
                  Scoped edit · {selectedTargets.length} element{selectedTargets.length === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                {selectedTargets.map((t, i) => (
                  <span
                    key={`${t.selector}-${i}`}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-foreground-2"
                    title={t.note ? `${t.selector}: ${t.note}` : t.selector}
                  >
                    <MousePointerClick size={11} strokeWidth={1.75} className="shrink-0 text-brand" />
                    <span className="truncate font-mono">{t.selector}</span>
                    {t.note ? <span className="truncate text-foreground/70">· {t.note}</span> : null}
                    <button
                      type="button"
                      aria-label={`Remove ${t.selector}`}
                      onClick={() => setSelectedTargets((cur) => cur.filter((_, j) => j !== i))}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </span>
                ))}
                </div>
              </div>
            ) : null}
            {attachments.length ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span
                    key={a.path}
                    className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-foreground-2"
                  >
                    <Paperclip size={11} strokeWidth={1.75} />
                    {a.name}
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => setAttachments((cur) => cur.filter((x) => x.path !== a.path))}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {queue.length ? (
              <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <History size={12} strokeWidth={1.75} />
                {queue.length} prompt{queue.length === 1 ? "" : "s"} queued — running after the current one
              </div>
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
                  onPickPaths={(paths) => setInput((i) => `${i}${i.trim() ? "\n" : ""}Reference local paths: ${paths.join(", ")}`)}
                  onContext={(text) => setInput((i) => `${i}${i.trim() ? "\n\n" : ""}${text}`)}
                  onReference={isExisting ? (p) => void referenceProject(p) : undefined}
                />
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <AgentModelSelect
                  agents={agents}
                  agent={runAgent}
                  model={runModel}
                  dropUp
                  onAgentChange={(v) => {
                    setRunAgent(v);
                    setRunModel("");
                  }}
                  onModelChange={setRunModel}
                  onRescan={rescanAgents}
                />
                {running && input.trim().length === 0 && selectedTargets.length === 0 ? (
                  <Button aria-label="Stop" size="icon-sm" variant="outline" onClick={stop} className="ml-0.5 rounded-lg" title="Stop generating">
                    <Square size={12} strokeWidth={2} className="fill-current" />
                  </Button>
                ) : (
                  <Button
                    aria-label={running ? "Queue" : "Send"}
                    size="icon-sm"
                    onClick={send}
                    disabled={!running && input.trim().length === 0 && selectedTargets.length === 0}
                    title={running ? "Queue this prompt to run next" : undefined}
                    className="ml-0.5 rounded-lg"
                  >
                    <ArrowUp size={15} strokeWidth={2} />
                  </Button>
                )}
              </div>
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
                      onClick={() => setSelectMode((v) => !v)}
                      className={`app-no-drag ${selectMode ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground" : ""}`}
                    >
                      <MousePointerClick size={15} strokeWidth={1.75} />
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
          {tab === "Preview" ? (
            previewSrc ? (
              <div className="flex h-full justify-center overflow-auto">
                <iframe
                  ref={previewIframeRef}
                  title="Artifact preview"
                  src={previewSrc}
                  // allow-same-origin keeps the preview in-process so the element-picker
                  // bridge receives pointer events (and dev-server modules load without CORS).
                  sandbox={previewSrc.startsWith("http") ? "allow-scripts allow-same-origin allow-forms" : "allow-scripts allow-same-origin allow-downloads"}
                  style={{ width: DEVICE_WIDTH[device], maxWidth: "100%" }}
                  className={`h-full border-0 bg-white ${device === "desktop" ? "" : "my-3 rounded-lg border border-border"}`}
                />
              </div>
            ) : projectMode === "standard" && setupPhase && setupPhase !== "ready" ? (
              <div className="grid h-full place-items-center">
                <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
                  <Spinner size={18} />
                  <p className="text-sm">
                    {setupPhase === "scaffolding"
                      ? "Scaffolding the Vite + React + GSAP project…"
                      : setupPhase === "installing"
                        ? "Installing dependencies (first run only)…"
                        : "Project setup failed. Check the daemon logs."}
                  </p>
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
              {findingGroups.length > 0 ? (
                <div className="flex-1 space-y-4 overflow-auto p-3 text-sm">
                  {findingGroups.map((group) => (
                    <section key={group.label} className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-foreground">{group.label}</div>
                          <div className="text-[11px] text-muted-foreground">{group.desc}</div>
                        </div>
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {group.findings.length}
                        </span>
                      </div>
                      <ul className="space-y-2">
                        {group.findings.map((f, idx) => (
                          <li key={`${f.id}-${idx}`} className="rounded-lg border border-border bg-card p-3">
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
                    </section>
                  ))}
                </div>
              ) : (
                <div className="flex-1">
                  {emptyPane(
                    running
                      ? "Generating…"
                      : ranOnce && typeof score === "number" && score < 100
                        ? "No stored quality details for this run."
                        : ranOnce
                          ? "No quality issues. Clean."
                          : "Run to check quality",
                  )}
                </div>
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
                                <Button variant="ghost" size="sm" aria-label={`View ${group.name} ${label}`} onClick={() => viewVersion(r.id)}>
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
                                        onClick={() =>
                                          setCompare({
                                            a: { url: api.versionPreviewUrl(projectId, r.id), label: `${group.name} ${label}` },
                                            b: {
                                              url: api.versionPreviewUrl(projectId, currentRun.id),
                                              label: `${activeVersionGroup?.name ?? "Current branch"} current`,
                                            },
                                          })
                                        }
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
