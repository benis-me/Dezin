import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AgentCollapsible } from "../components/AgentCollapsible.tsx";
import {
  AgentImageGenerationState,
  AgentProgressList,
  AgentReasoning,
  AgentWebSearch,
  type AgentProgressItem,
  type AgentSearchResult,
} from "../components/AgentActivityBlocks.tsx";
import { AgentMessageBody } from "../components/AgentMessageBody.tsx";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { resolveFloatingChromeRect, type CanvasRect } from "../moodboard/canvas-utils.ts";
import type { AgentInfo } from "../lib/api.ts";
import { designExportPath, type DesignExportRevealResult } from "../lib/design-export.ts";
import { usePrefersReducedMotion } from "../lib/use-prefers-reduced-motion.ts";
import { cn } from "../lib/utils.ts";
import { BorderBeam } from "border-beam";
import { motion } from "motion/react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  FileUp,
  LoaderCircle,
  Paperclip,
  PanelRightClose,
  Square,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type Ref,
} from "react";

import { isDesignAgentCommand, type DesignCanvasApi } from "./api.ts";
import { NodeMentionInput } from "./NodeMentionInput.tsx";
import type {
  DesignJob,
  DesignJobActivity,
  DesignNode,
  DesignNodeVersion,
  DesignThread,
  DesignThreadScope,
} from "./types.ts";

const AGENT_MOTION_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];
const AGENT_MORPH_EASE: [number, number, number, number] = [0.77, 0, 0.175, 1];
const TRANSCRIPT_MESSAGE_PAGE_SIZE = 12;
const TRANSCRIPT_JOB_PAGE_SIZE = 6;
const RESERVED_MAIN_AGENT_QUEUED_REPLY =
  "Main Agent orchestration is queued. The final result will replace this status.";

interface FloatingPosition {
  nodeId: string | null;
  left: number;
  top: number;
  entryX: number;
  entryY: number;
  visible: boolean;
}

export const FLOATING_NODE_AGENT_WIDTH_PX = 352;

const COMPACT_AGENT_SIZE = { width: FLOATING_NODE_AGENT_WIDTH_PX, height: 520 } as const;
const FOCUSED_AGENT_SIZE = { width: FLOATING_NODE_AGENT_WIDTH_PX, height: 720 } as const;

function boundedEntryOffset(distance: number, limit: number): number {
  if (Math.abs(distance) < 3) return 0;
  return Math.max(-limit, Math.min(limit, distance));
}

export function floatingAgentTransform(x: number, y: number, scale: number): string {
  // Motion interpolates complex transform strings token by token. Keeping units
  // on both zero and non-zero endpoints prevents intermediate translate values
  // from losing `px` and becoming invalid CSS in Chromium.
  return `translate3d(${x}px, ${y}px, 0px) scale(${scale})`;
}

export function useFloatingNodePanel({
  hostRef,
  panelRef,
  nodeId,
  focused,
  mainPanelOpen,
  layoutNonce,
}: {
  hostRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  nodeId: string | null;
  focused: boolean;
  mainPanelOpen: boolean;
  layoutNonce: number;
}): FloatingPosition {
  const [position, setPosition] = useState<FloatingPosition>({
    nodeId: null,
    left: 16,
    top: 16,
    entryX: 0,
    entryY: 8,
    visible: false,
  });

  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host || !nodeId) {
      setPosition((current) => current.visible || current.nodeId !== null
        ? { ...current, nodeId: null, visible: false }
        : current);
      return;
    }
    const node = [...host.querySelectorAll<HTMLElement>("[data-design-node-id]")]
      .find((candidate) => candidate.dataset.designNodeId === nodeId);
    if (!node) {
      setPosition((current) => current.visible || current.nodeId !== null
        ? { ...current, nodeId: null, visible: false }
        : current);
      return;
    }

    const panel = panelRef.current;
    const hostRect = host.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const expectedSize = focused ? FOCUSED_AGENT_SIZE : COMPACT_AGENT_SIZE;
    const panelWidth = panel?.offsetWidth || expectedSize.width;
    const panelHeight = Math.min(panel?.offsetHeight || expectedSize.height, hostRect.height - 24);
    if (!focused && (
      nodeRect.right < hostRect.left
      || nodeRect.left > hostRect.right
      || nodeRect.bottom < hostRect.top
      || nodeRect.top > hostRect.bottom
    )) {
      setPosition((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }

    const occluders: CanvasRect[] = mainPanelOpen ? [{
      left: Math.max(0, hostRect.width - 400),
      top: 0,
      right: hostRect.width,
      bottom: hostRect.height,
      width: Math.min(400, hostRect.width),
      height: hostRect.height,
    }] : [];
    const resolved = focused ? {
      left: Math.max(12, hostRect.width - panelWidth - 12),
      top: 12,
    } : resolveFloatingChromeRect({
      anchor: {
        left: nodeRect.left - hostRect.left,
        top: nodeRect.top - hostRect.top,
        bottom: nodeRect.bottom - hostRect.top,
        targetLeft: nodeRect.left - hostRect.left,
        targetRight: nodeRect.right - hostRect.left,
      },
      containerWidth: hostRect.width,
      containerHeight: hostRect.height,
      surfaceWidth: panelWidth,
      surfaceHeight: panelHeight,
      placement: "right",
      occluders,
      padding: 10,
      gap: 12,
      allowSidePlacement: true,
    });
    const nodeCenterX = nodeRect.left - hostRect.left + nodeRect.width / 2;
    const nodeCenterY = nodeRect.top - hostRect.top + nodeRect.height / 2;
    const entryX = boundedEntryOffset(nodeCenterX - (resolved.left + panelWidth / 2), 8);
    const entryY = boundedEntryOffset(nodeCenterY - (resolved.top + panelHeight / 2), 12);
    const next = { nodeId, ...resolved, entryX, entryY, visible: true };
    setPosition((current) => (
      current.nodeId === next.nodeId
      && current.visible
      && current.left === next.left
      && current.top === next.top
      && current.entryX === next.entryX
      && current.entryY === next.entryY
        ? current
        : next
    ));
  }, [focused, hostRef, mainPanelOpen, nodeId, panelRef]);

  useLayoutEffect(() => {
    measure();
    let frame = 0;
    const host = hostRef.current;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    });
    if (host) observer.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hostRef, layoutNonce, measure, panelRef]);

  return position;
}

export interface CanvasAgentPanelProps {
  projectId: string;
  api: DesignCanvasApi;
  scope: DesignThreadScope;
  title: string;
  subtitle: string;
  nodes: readonly DesignNode[];
  jobs: readonly DesignJob[];
  versions?: readonly DesignNodeVersion[];
  selectedVersionId?: string | null;
  onAppendMaterialVersion?: (file: File) => Promise<void>;
  materialRevisionAccept?: string;
  agents?: readonly AgentInfo[];
  initialAgentCommand?: string;
  initialModel?: string;
  agentSelection?: CanvasAgentSelection;
  onAgentSelectionChange?: (selection: CanvasAgentSelection) => void;
  onRescanAgents?: () => Promise<void>;
  onSubmit: (prompt: string, nodeIds: readonly string[], selection: { agentCommand?: string; model?: string | null }) => Promise<void>;
  onCancelJob: (jobId: string) => Promise<void>;
  onAttachFiles: (files: readonly File[]) => Promise<void>;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onSelectVersion?: (versionId: string) => Promise<void>;
  onClose?: () => void;
  className?: string;
  style?: React.CSSProperties;
  floating?: boolean;
  compact?: boolean;
  entryX?: number;
  entryY?: number;
  deferTranscriptMs?: number;
  rootRef?: Ref<HTMLElement>;
}

export interface CanvasAgentSelection {
  agentCommand: string;
  model: string;
}

interface MainAgentJobGroup {
  parentJobId: string;
  label: string;
  jobs: DesignJob[];
}

interface OptimisticUserTurn {
  scopeKey: string;
  message: DesignThread["messages"][number];
  existingMessageIds: ReadonlySet<string>;
  existingJobIds: ReadonlySet<string>;
}

type AgentTimelineItem =
  | { kind: "message"; id: string; createdAt: number; message: DesignThread["messages"][number] }
  | { kind: "thinking"; id: string; createdAt: number }
  | { kind: "main-job-group"; id: string; createdAt: number; group: MainAgentJobGroup }
  | { kind: "node-job"; id: string; createdAt: number; job: DesignJob };

function isReservedMainAgentReply(message: DesignThread["messages"][number]): boolean {
  return message.role === "assistant"
    && message.jobId !== null
    && message.content.trim() === RESERVED_MAIN_AGENT_QUEUED_REPLY;
}

export function composerBeamActive(focused: boolean, reduceMotion: boolean | null): boolean {
  return focused && reduceMotion !== true;
}

function useApplicationBeamTheme(): "dark" | "light" {
  const readTheme = () => (
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark" as const
      : "light" as const
  );
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const updateTheme = () => setTheme(readTheme());
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function mainAgentGroupLabel(job: DesignJob): string {
  return job.kind === "implementation-export" ? "Implementation export" : "Canvas execution";
}

function groupMainAgentJobs(jobs: readonly DesignJob[], thread: DesignThread | null): MainAgentJobGroup[] {
  const parents = jobs.filter((job) => job.kind === "main-agent" || job.kind === "implementation-export");
  const children = jobs.filter((job) => job.parentJobId !== null);
  const childrenByParent = new Map<string, DesignJob[]>();
  for (const child of children) {
    const grouped = childrenByParent.get(child.parentJobId!);
    if (grouped) grouped.push(child);
    else childrenByParent.set(child.parentJobId!, [child]);
  }
  const groups = parents.flatMap((parent) => {
    const groupedChildren = childrenByParent.get(parent.id) ?? [];
    const hasAssistantReply = thread?.messages.some((message) => (
      message.role === "assistant" && message.jobId === parent.id
    )) ?? false;
    const conversationOnly = parent.kind === "main-agent"
      && parent.status === "ready"
      && parent.conversationOnly === true
      && groupedChildren.length === 0
      && hasAssistantReply;
    return conversationOnly ? [] : [{
      parentJobId: parent.id,
      label: mainAgentGroupLabel(parent),
      jobs: [parent, ...groupedChildren],
    }];
  });
  const visibleParents = new Set(parents.map((parent) => parent.id));
  for (const [parentJobId, orphanedChildren] of childrenByParent) {
    if (visibleParents.has(parentJobId)) continue;
    groups.push({
      parentJobId,
      label: "Canvas execution",
      jobs: orphanedChildren,
    });
  }
  return groups;
}

function versionOptionLabel(version: DesignNodeVersion): string {
  const materialName = version.contentKind === "asset"
    ? version.fileName ?? version.mimeType ?? "Material"
    : null;
  const timestamp = new Date(version.createdAt).toLocaleString();
  return `V${version.sequence} · ${materialName ? `${materialName} · ` : ""}${timestamp}`;
}

function compactActivityText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Activity updated";
  if ((normalized.startsWith("{") || normalized.startsWith("[")) && normalized.length > 240) {
    return "Prepared the structured response";
  }
  if (normalized.length <= 260) return normalized;
  const sentence = normalized.match(/^.{80,220}?[.!?](?:\s|$)/)?.[0]?.trim();
  return `${sentence ?? normalized.slice(0, 220).trimEnd()}…`;
}

function isWebSearchActivity(activity: DesignJobActivity): boolean {
  return /\b(?:web\s+search|searching\s+(?:the\s+)?web|searched\s+(?:the\s+)?web)\b/i.test(activity.text);
}

function isImageGenerationActivity(activity: DesignJobActivity): boolean {
  return /\b(?:generating|generate|rendering)\s+(?:an?\s+)?image\b/i.test(activity.text);
}

function isReasoningActivity(activity: DesignJobActivity): boolean {
  return activity.kind === "text"
    && !isWebSearchActivity(activity)
    && !isImageGenerationActivity(activity);
}

type AgentActivityPhase = "reasoning" | "progress" | "search" | "image";

function activityPhase(activity: DesignJobActivity): AgentActivityPhase {
  if (isWebSearchActivity(activity)) return "search";
  if (isImageGenerationActivity(activity)) return "image";
  if (isReasoningActivity(activity)) return "reasoning";
  return "progress";
}

function quotedActivityText(text: string): string | null {
  return /[“"]([^”"]{2,180})[”"]/.exec(text)?.[1]?.trim() ?? null;
}

function searchResults(activities: readonly DesignJobActivity[], active: boolean): AgentSearchResult[] {
  return activities.flatMap((activity, index) => {
    const href = activity.text.match(/https?:\/\/[^\s)>\]]+/)?.[0]?.replace(/[.,;:]$/, "");
    if (!href) return [];
    const title = compactActivityText(activity.text.replace(href, "").replace(/^[\s·—:-]+|[\s·—:-]+$/g, "")) || href;
    return [{
      id: activity.id,
      title,
      href,
      state: active && index === activities.length - 1 ? "loading" as const : "done" as const,
    }];
  });
}

function jobStatusLabel(job: DesignJob): string {
  switch (job.status) {
    case "queued": return "Queued";
    case "running": return "Working";
    case "validating": return "Validating";
    case "ready": return "Complete";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "superseded": return "Superseded";
  }
}

function compactJobDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function CanvasAgentPanel({
  projectId,
  api,
  scope,
  title,
  subtitle,
  nodes,
  jobs,
  versions = [],
  selectedVersionId,
  onAppendMaterialVersion,
  materialRevisionAccept,
  agents = [],
  initialAgentCommand = "",
  initialModel = "",
  agentSelection: controlledAgentSelection,
  onAgentSelectionChange,
  onRescanAgents = async () => {},
  onSubmit,
  onCancelJob,
  onAttachFiles,
  projectPath,
  onRevealExport,
  onSelectVersion,
  onClose,
  className,
  style,
  floating = false,
  compact = false,
  entryX = 0,
  entryY = 8,
  rootRef,
}: CanvasAgentPanelProps) {
  const reduceMotion = usePrefersReducedMotion();
  const composerBeamTheme = useApplicationBeamTheme();
  const [composerFocused, setComposerFocused] = useState(false);
  const [thread, setThread] = useState<DesignThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(true);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [optimisticUserTurn, setOptimisticUserTurn] = useState<OptimisticUserTurn | null>(null);
  const [appendingRevision, setAppendingRevision] = useState(false);
  const [internalAgentSelection, setInternalAgentSelection] = useState<CanvasAgentSelection>(() => ({
    agentCommand: initialAgentCommand,
    model: initialModel,
  }));
  const agentSelection = controlledAgentSelection ?? internalAgentSelection;
  const setAgentSelection = useCallback((next: CanvasAgentSelection) => {
    setInternalAgentSelection(next);
    onAgentSelectionChange?.(next);
  }, [onAgentSelectionChange]);
  const [contextNodeIds, setContextNodeIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const revisionInputRef = useRef<HTMLInputElement | null>(null);
  const optimisticTurnSequenceRef = useRef(0);
  const threadLoadSequenceRef = useRef(0);
  const loadedThreadScopeRef = useRef<string | null>(null);
  const scopeKey = scope.type === "main" ? "main" : `node:${scope.nodeId}`;
  const relatedJobs = useMemo(() => {
    const related = scope.type === "main"
      ? jobs.filter((job) => job.kind === "main-agent" || job.kind === "implementation-export" || job.parentJobId !== null)
      : jobs.filter((job) => job.nodeId === scope.nodeId);
    return related.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }, [jobs, scopeKey]);
  const nodeNames = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
  const scopedNode = scope.type === "node" ? nodes.find((node) => node.id === scope.nodeId) ?? null : null;
  const mainJobGroups = useMemo(
    () => scope.type === "main" ? groupMainAgentJobs(relatedJobs, thread) : [],
    [relatedJobs, scope.type, thread],
  );
  const availableAgents = useMemo(
    () => agents.filter((agent) => isDesignAgentCommand(agent.command) && agent.available),
    [agents],
  );
  const activeAgent = availableAgents.find((agent) => agent.command === agentSelection.agentCommand) ?? null;
  const live = relatedJobs.some((job) => job.status === "queued" || job.status === "running" || job.status === "validating");
  const transcriptTailKey = relatedJobs.map((job) => (
    `${job.id}:${job.status}:${job.activity.length}:${job.error ?? ""}`
  )).join("|");
  const requestedVersionId = selectedVersionId ?? versions.at(-1)?.id ?? "";
  const activeVersion = versions.find((version) => version.id === requestedVersionId) ?? versions.at(-1) ?? null;
  const activeVersionId = activeVersion?.id ?? "";
  const visibleOptimisticUserTurn = useMemo(() => {
    if (!optimisticUserTurn || optimisticUserTurn.scopeKey !== scopeKey) return null;
    const canonicalMessageArrived = thread?.messages.some((message) => (
      message.role === "user"
      && message.content.trim() === optimisticUserTurn.message.content
      && !optimisticUserTurn.existingMessageIds.has(message.id)
    )) ?? false;
    return canonicalMessageArrived ? null : optimisticUserTurn;
  }, [optimisticUserTurn, scopeKey, thread]);

  const loadThread = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++threadLoadSequenceRef.current;
    const initialLoad = loadedThreadScopeRef.current !== scopeKey;
    if (initialLoad) setThreadLoading(true);
    try {
      const next = await api.getThread(projectId, scope, signal);
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current) {
        loadedThreadScopeRef.current = scopeKey;
        setThread(next);
        setThreadError(null);
      }
    } catch (problem) {
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current) {
        loadedThreadScopeRef.current = scopeKey;
        setThreadError(problem instanceof Error ? problem.message : String(problem));
      }
    } finally {
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current && initialLoad) setThreadLoading(false);
    }
  }, [api, projectId, scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadThread(controller.signal);
    return () => controller.abort();
  }, [loadThread]);

  useEffect(() => {
    setOptimisticUserTurn(null);
  }, [scopeKey]);

  useEffect(() => {
    const existingIds = new Set(nodes.map((node) => node.id));
    setContextNodeIds((current) => current.filter((id) => existingIds.has(id)));
  }, [nodes]);

  useEffect(() => {
    const active = availableAgents.find((agent) => agent.command === agentSelection.agentCommand) ?? null;
    if (active) {
      if (agentSelection.model && !active.models.includes(agentSelection.model)) {
        setAgentSelection({ agentCommand: active.command, model: "" });
      }
      return;
    }
    const fallback = availableAgents[0] ?? null;
    if (fallback) {
      setAgentSelection({ agentCommand: fallback.command, model: "" });
    } else if (agentSelection.agentCommand || agentSelection.model) {
      setAgentSelection({ agentCommand: "", model: "" });
    }
  }, [agentSelection.agentCommand, agentSelection.model, availableAgents, setAgentSelection]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void loadThread(), 1_200);
    return () => window.clearInterval(timer);
  }, [live, loadThread]);

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || submitting || !activeAgent) return;
    const optimisticId = `optimistic-user-${++optimisticTurnSequenceRef.current}`;
    setOptimisticUserTurn({
      scopeKey,
      message: {
        id: optimisticId,
        role: "user",
        content: prompt,
        jobId: null,
        createdAt: Date.now(),
      },
      existingMessageIds: new Set(thread?.messages.map((message) => message.id) ?? []),
      existingJobIds: new Set(relatedJobs.map((job) => job.id)),
    });
    setSubmitting(true);
    setThreadError(null);
    try {
      await onSubmit(prompt, contextNodeIds, {
        agentCommand: activeAgent.command,
        ...(agentSelection.model
          ? { model: agentSelection.model }
          : { model: null }),
      });
      setDraft("");
      await loadThread();
    } catch (problem) {
      setOptimisticUserTurn((current) => current?.message.id === optimisticId ? null : current);
      setThreadError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setSubmitting(false);
    }
  };

  const panelTitle = title === "Main Agent" ? "Canvas" : title.replace(/\s+Agent$/, "");
  const panelEyebrow = scope.type === "main" ? "Main Agent" : null;
  const panelTransformOrigin = floating
    ? `${entryX < -1 ? "left" : entryX > 1 ? "right" : "center"} ${entryY < -1 ? "top" : entryY > 1 ? "bottom" : "center"}`
    : "center center";
  const panelEntryTransform = floatingAgentTransform(entryX, entryY, 0.98);
  const panelOpenTransform = floatingAgentTransform(0, 0, 1);
  const panelExitTransform = floatingAgentTransform(
    reduceMotion ? 0 : entryX,
    reduceMotion ? 0 : entryY,
    1,
  );
  return (
    <motion.section
      ref={rootRef}
      layout={floating && !reduceMotion ? "position" : false}
      data-canvas-agent-panel
      data-agent-scope={scopeKey}
      data-agent-size={compact ? "compact" : "focus"}
      className={cn("design-canvas-agent", floating && "design-canvas-agent--floating", className)}
      style={{ ...style, transformOrigin: panelTransformOrigin }}
      initial={floating && !reduceMotion ? { opacity: 0, transform: panelEntryTransform } : false}
      animate={floating ? {
        opacity: 1,
        transform: panelOpenTransform,
        transition: { duration: reduceMotion ? 0 : 0.22, ease: AGENT_MOTION_EASE },
      } : undefined}
      exit={floating ? {
        opacity: 0,
        transform: panelExitTransform,
        transition: { duration: reduceMotion ? 0 : 0.13, ease: AGENT_MOTION_EASE },
      } : undefined}
      transition={{
        duration: reduceMotion ? 0 : 0.22,
        ease: AGENT_MOTION_EASE,
        layout: { duration: reduceMotion ? 0 : 0.28, ease: AGENT_MORPH_EASE },
      }}
      aria-label={`${title} panel`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="design-canvas-agent__surface">
      <header className="design-canvas-agent__header">
        <div className="design-canvas-agent__header-copy">
          {panelEyebrow ? <span className="design-canvas-agent__eyebrow">{panelEyebrow}</span> : null}
          <h2>{panelTitle}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {(activeVersion && onSelectVersion) || onAppendMaterialVersion || onClose ? (
          <TooltipProvider delayDuration={120}>
            <div className="design-canvas-agent__header-controls">
              {activeVersion && onSelectVersion ? (
                <Select
                  value={activeVersionId}
                  onValueChange={(versionId) => {
                    if (versionId === activeVersionId) return;
                    void onSelectVersion(versionId).catch((problem) => {
                      setThreadError(problem instanceof Error ? problem.message : String(problem));
                    });
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Version"
                    className="h-7 min-w-[52px] gap-1 rounded-lg border-transparent bg-transparent px-2 text-[10px] font-semibold shadow-none hover:bg-surface-2 [&_svg:not([class*='size-'])]:size-3"
                  >
                    <SelectValue>{`V${activeVersion.sequence}`}</SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="end"
                    className="w-[min(280px,calc(100vw-24px))] min-w-0 max-w-[calc(100vw-24px)]"
                  >
                    {[...versions].reverse().map((version) => (
                      <SelectItem
                        key={version.id}
                        value={version.id}
                        className="min-w-0 overflow-hidden text-xs [&>span:last-child]:block [&>span:last-child]:min-w-0 [&>span:last-child]:truncate"
                      >
                        {versionOptionLabel(version)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {onAppendMaterialVersion ? (
                <>
                  <input
                    ref={revisionInputRef}
                    type="file"
                    accept={materialRevisionAccept}
                    className="hidden"
                    aria-label={`Add revision to ${scopedNode?.name ?? title}`}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file || appendingRevision) return;
                      setAppendingRevision(true);
                      setThreadError(null);
                      void onAppendMaterialVersion(file).catch((problem) => {
                        setThreadError(problem instanceof Error ? problem.message : String(problem));
                      }).finally(() => setAppendingRevision(false));
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-7 rounded-full"
                        aria-label={`Upload revision for ${scopedNode?.name ?? title}`}
                        disabled={appendingRevision}
                        onClick={() => revisionInputRef.current?.click()}
                      >
                        {appendingRevision ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} /> : <FileUp aria-hidden />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>Add revision</TooltipContent>
                  </Tooltip>
                </>
              ) : null}
              {onClose ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-7 rounded-full"
                      aria-label={`Close ${title}`}
                      onClick={onClose}
                    >
                      {floating ? <X aria-hidden /> : <PanelRightClose aria-hidden />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" sideOffset={6}>{floating ? "Hide Agent" : "Close Agent"}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </TooltipProvider>
        ) : null}
      </header>

      <AgentTranscript
        scopeKey={scopeKey}
        scopeType={scope.type}
        thread={thread}
        optimisticUserTurn={visibleOptimisticUserTurn}
        threadLoading={threadLoading && visibleOptimisticUserTurn === null}
        relatedJobs={relatedJobs}
        mainJobGroups={mainJobGroups}
        nodeNames={nodeNames}
        projectPath={projectPath}
        onRevealExport={onRevealExport}
        onCancelJob={onCancelJob}
        reduceMotion={reduceMotion === true}
        tailKey={`${transcriptTailKey}|${visibleOptimisticUserTurn?.message.id ?? ""}`}
      />

      <div className="design-canvas-agent__composer">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label={`Attach files to ${title}`}
          onChange={(event) => {
            const files = event.target.files ? [...event.target.files] : [];
            event.target.value = "";
            if (files.length) {
              void onAttachFiles(files).catch((problem) => {
                setThreadError(problem instanceof Error ? problem.message : String(problem));
              });
            }
          }}
        />
        <BorderBeam
          active={composerBeamActive(composerFocused, reduceMotion)}
          borderRadius={14}
          brightness={1.22}
          className="design-canvas-agent__composer-beam"
          colorVariant="colorful"
          data-beam-theme={composerBeamTheme}
          duration={2.18}
          hueRange={22}
          saturation={1.05}
          staticColors={reduceMotion === true}
          strength={0.56}
          theme={composerBeamTheme}
          onFocusCapture={() => setComposerFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setComposerFocused(false);
          }}
        >
          <div className="design-canvas-agent__composer-shell">
            <NodeMentionInput
              nodes={nodes}
              excludeNodeId={scope.type === "node" ? scope.nodeId : undefined}
              value={draft}
              onChange={setDraft}
              priorityNodeIds={contextNodeIds}
              onPriorityNodeIdsChange={setContextNodeIds}
              ariaLabel={`${title} message`}
              placeholder={scope.type === "main"
                ? "Coordinate the canvas. Type @ to reference a Node…"
                : "Ask this Node's Agent. Type @ to add context…"}
              onSubmitShortcut={() => void submit()}
            />
            <div className="design-canvas-agent__actions">
              <div className="flex min-w-0 items-center gap-1">
                <Button variant="ghost" size="icon-xs" aria-label="Attach canvas context files" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip aria-hidden />
                </Button>
                {availableAgents.length > 0 ? (
                  <AgentModelSelect
                    agents={availableAgents}
                    agent={agentSelection.agentCommand}
                    model={agentSelection.model}
                    onAgentChange={(agentCommand) => {
                      if (agentSelection.agentCommand !== agentCommand) {
                        setAgentSelection({ agentCommand, model: "" });
                      }
                    }}
                    onModelChange={(model) => {
                      if (agentSelection.model !== model) {
                        setAgentSelection({ ...agentSelection, model });
                      }
                    }}
                    onRescan={onRescanAgents}
                    dropUp
                  />
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="design-canvas-agent__agent-unavailable"
                    title="No Design Agent is currently available"
                    onClick={() => {
                      void onRescanAgents().catch((problem) => {
                        setThreadError(problem instanceof Error ? problem.message : String(problem));
                      });
                    }}
                  >
                    <CircleAlert aria-hidden />Agent unavailable
                  </Button>
                )}
              </div>
              <Button
                size="icon-sm"
                aria-label={`Send to ${title}`}
                disabled={!draft.trim() || submitting || !activeAgent}
                onClick={() => void submit()}
                className="size-7"
              >
                {submitting ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} /> : <ArrowUp aria-hidden />}
              </Button>
            </div>
          </div>
        </BorderBeam>
        {threadError ? (
          <motion.div
            role="alert"
            className="design-canvas-agent__composer-notice"
            initial={reduceMotion ? false : { opacity: 0, transform: "translate3d(0px, 5px, 0px) scale(0.98)" }}
            animate={{ opacity: 1, transform: "translate3d(0px, 0px, 0px) scale(1)" }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: AGENT_MOTION_EASE }}
          >
            <CircleAlert aria-hidden />
            <span>{threadError}</span>
            <button type="button" aria-label="Dismiss Agent error" onClick={() => setThreadError(null)}><X aria-hidden /></button>
          </motion.div>
        ) : null}
      </div>
      </div>
    </motion.section>
  );
}

const AgentTranscript = memo(function AgentTranscript({
  scopeKey,
  scopeType,
  thread,
  optimisticUserTurn,
  threadLoading,
  relatedJobs,
  mainJobGroups,
  nodeNames,
  projectPath,
  onRevealExport,
  onCancelJob,
  reduceMotion,
  tailKey,
}: {
  scopeKey: string;
  scopeType: DesignThreadScope["type"];
  thread: DesignThread | null;
  optimisticUserTurn: OptimisticUserTurn | null;
  threadLoading: boolean;
  relatedJobs: readonly DesignJob[];
  mainJobGroups: readonly MainAgentJobGroup[];
  nodeNames: ReadonlyMap<string, string>;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onCancelJob: (jobId: string) => Promise<void>;
  reduceMotion: boolean;
  tailKey: string;
}) {
  const [historyPages, setHistoryPages] = useState(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const followTailRef = useRef(true);
  const messageHistoryLimit = historyPages * TRANSCRIPT_MESSAGE_PAGE_SIZE;
  const jobHistoryLimit = historyPages * (scopeType === "main" ? TRANSCRIPT_JOB_PAGE_SIZE : 2);
  const threadMatchesScope = thread !== null && (
    thread.scope.type === "main"
      ? scopeKey === "main"
      : scopeKey === `node:${thread.scope.nodeId}`
  );
  const threadMessages = optimisticUserTurn
    ? [...(threadMatchesScope ? thread.messages : []), optimisticUserTurn.message]
    : threadMatchesScope ? thread.messages : [];
  const reservedMainReplies = scopeType === "main"
    ? threadMessages.filter(isReservedMainAgentReply)
    : [];
  const presentableMessages = scopeType === "main"
    ? threadMessages.filter((message) => !isReservedMainAgentReply(message))
    : threadMessages;
  const visibleMessages = presentableMessages.slice(-messageHistoryLimit);
  const visibleMainJobGroups = mainJobGroups.slice(-jobHistoryLimit);
  const visibleRelatedJobs = relatedJobs.slice(-jobHistoryLimit);
  const visibleReservedMainReplies = reservedMainReplies.slice(-jobHistoryLimit);
  const hiddenTranscriptCount = Math.max(0, presentableMessages.length - visibleMessages.length)
    + (scopeType === "main"
      ? Math.max(0, mainJobGroups.length - visibleMainJobGroups.length)
      : Math.max(0, relatedJobs.length - visibleRelatedJobs.length));
  const latestRelatedJobId = relatedJobs.at(-1)?.id ?? null;
  const timeline = useMemo<AgentTimelineItem[]>(() => {
    const userTurnCreatedAt = new Map<string, number>();
    for (const message of threadMessages) {
      if (message.role === "user" && message.jobId !== null) {
        userTurnCreatedAt.set(message.jobId, message.createdAt);
      }
    }
    const items: AgentTimelineItem[] = visibleMessages.map((message) => ({
      kind: "message",
      id: `message:${message.id}`,
      createdAt: message.createdAt,
      message,
    }));
    if (scopeType === "main") {
      const representedJobIds = new Set(visibleMainJobGroups.map((group) => group.parentJobId));
      items.push(...visibleMainJobGroups.map((group) => ({
        kind: "main-job-group" as const,
        id: `main-job-group:${group.parentJobId}`,
        createdAt: (optimisticUserTurn && !optimisticUserTurn.existingJobIds.has(group.parentJobId)
          ? optimisticUserTurn.message.createdAt
          : userTurnCreatedAt.get(group.parentJobId))
          ?? Math.min(...group.jobs.map((job) => job.createdAt)),
        group,
      })));
      items.push(...visibleReservedMainReplies.flatMap((message) => (
        message.jobId !== null && representedJobIds.has(message.jobId)
          ? []
          : [{
            kind: "thinking" as const,
            id: `thinking:${message.id}`,
            createdAt: userTurnCreatedAt.get(message.jobId ?? "") ?? message.createdAt,
          }]
      )));
    } else {
      items.push(...visibleRelatedJobs.map((job) => ({
        kind: "node-job" as const,
        id: `node-job:${job.id}`,
        createdAt: (optimisticUserTurn && !optimisticUserTurn.existingJobIds.has(job.id)
          ? optimisticUserTurn.message.createdAt
          : userTurnCreatedAt.get(job.id)) ?? job.createdAt,
        job,
      })));
    }
    const priority = (item: AgentTimelineItem): number => {
      if (item.kind !== "message") return 1;
      return item.message.role === "user" ? 0 : 2;
    };
    return items.sort((left, right) => (
      left.createdAt - right.createdAt
      || priority(left) - priority(right)
      || left.id.localeCompare(right.id)
    ));
  }, [optimisticUserTurn, scopeType, threadMessages, visibleMainJobGroups, visibleMessages, visibleRelatedJobs, visibleReservedMainReplies]);

  useEffect(() => {
    setHistoryPages(1);
    restoreScrollRef.current = null;
    followTailRef.current = true;
  }, [scopeKey]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const restore = restoreScrollRef.current;
    if (restore) {
      transcript.scrollTop = restore.top + transcript.scrollHeight - restore.height;
      restoreScrollRef.current = null;
    } else if (followTailRef.current || optimisticUserTurn !== null) {
      transcript.scrollTop = transcript.scrollHeight;
      followTailRef.current = true;
    }
  }, [historyPages, optimisticUserTurn, tailKey, thread?.messages.length, thread?.updatedAt]);

  return (
    <div
      ref={transcriptRef}
      className="design-canvas-agent__transcript"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={threadLoading || undefined}
      onScroll={(event) => {
        const transcript = event.currentTarget;
        followTailRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 56;
      }}
    >
      {hiddenTranscriptCount > 0 ? (
        <button
          type="button"
          className="design-canvas-agent__history-more"
          onClick={() => {
            const transcript = transcriptRef.current;
            if (transcript) restoreScrollRef.current = { height: transcript.scrollHeight, top: transcript.scrollTop };
            setHistoryPages((current) => current + 1);
          }}
        >
          Show earlier activity <span>{hiddenTranscriptCount}</span>
        </button>
      ) : null}
      {!threadLoading && presentableMessages.length === 0 && reservedMainReplies.length === 0 && relatedJobs.length === 0 ? (
        <div className="design-canvas-agent__empty">
          <p className="text-[11px] font-medium text-foreground/75">
            {scopeType === "main" ? "Coordinate the canvas." : "Describe what this Node should become."}
          </p>
          <p className="max-w-[24rem] text-[10.5px] leading-[1.45] text-muted-foreground">
            Complete canvas context is already available to this Agent.
          </p>
        </div>
      ) : null}
      {timeline.map((item) => {
        if (item.kind === "thinking") {
          return <AgentThinkingIndicator key={item.id} reduceMotion={reduceMotion} />;
        }
        if (item.kind === "message") {
          const { message } = item;
          return (
            <article
              key={item.id}
              className="design-canvas-agent__message"
              data-role={message.role}
            >
              <div className="design-canvas-agent__message-meta">
                <span>{message.role === "user" ? "Prompt" : message.role === "assistant" ? "Response" : message.role === "system" ? "System" : "Tool"}</span>
                <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </div>
              <AgentMessageBody role={message.role === "user" ? "user" : "assistant"} content={message.content} />
            </article>
          );
        }
        if (item.kind === "main-job-group") {
          return (
            <MainAgentJobGroupView
              key={item.id}
              group={item.group}
              nodeNames={nodeNames}
              projectPath={projectPath}
              onRevealExport={onRevealExport}
              onCancelJob={onCancelJob}
              reduceMotion={reduceMotion}
              latestRelatedJobId={latestRelatedJobId}
            />
          );
        }
        return (
          <AgentActivityCard
            key={item.id}
            job={item.job}
            nodeName={item.job.nodeId === null ? undefined : nodeNames.get(item.job.nodeId)}
            projectPath={projectPath}
            onRevealExport={onRevealExport}
            onCancel={onCancelJob}
          />
        );
      })}
    </div>
  );
});

function MainAgentJobGroupView({
  group,
  nodeNames,
  projectPath,
  onRevealExport,
  onCancelJob,
  reduceMotion,
  latestRelatedJobId,
}: {
  group: MainAgentJobGroup;
  nodeNames: ReadonlyMap<string, string>;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onCancelJob: (jobId: string) => Promise<void>;
  reduceMotion: boolean;
  latestRelatedJobId: string | null;
}) {
  const mainJob = group.jobs.find((job) => job.kind === "main-agent") ?? null;
  const workJobs = group.jobs.filter((job) => job.kind !== "main-agent");
  const mainActive = mainJob !== null && ["queued", "running", "validating"].includes(mainJob.status);
  const mainTerminalOutcome = mainJob !== null && ["failed", "cancelled", "superseded"].includes(mainJob.status)
    ? mainJob
    : null;
  if (workJobs.length === 0) {
    if (mainActive) return <AgentThinkingIndicator reduceMotion={reduceMotion} />;
    if (!mainTerminalOutcome) return null;
  }
  const childCount = workJobs.filter((job) => job.nodeId !== null).length;
  const childLabel = childCount > 0 ? `${childCount} ${childCount === 1 ? "child Agent" : "child Agents"}` : null;
  const showGroupHeader = childLabel !== null || mainTerminalOutcome !== null || workJobs.length > 1;
  return (
    <section
      className="design-canvas-agent__activity-group"
      aria-label={childLabel ? `${group.label} · ${childLabel}` : group.label}
      data-parent-job-id={group.parentJobId}
    >
      {showGroupHeader ? (
        <header className="design-canvas-agent__activity-group-header">
          <p>{group.label}</p>
          {childLabel ? <span>{childLabel}</span> : null}
        </header>
      ) : null}
      {mainActive ? <AgentThinkingIndicator reduceMotion={reduceMotion} /> : null}
      {mainTerminalOutcome ? (
        <div
          className="design-canvas-agent__activity-group-outcome"
          data-status={mainTerminalOutcome.status}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {mainTerminalOutcome.status === "failed" ? <CircleAlert aria-hidden /> : <Circle aria-hidden />}
          <strong>{jobStatusLabel(mainTerminalOutcome)}</strong>
          {mainTerminalOutcome.status === "failed" && mainTerminalOutcome.error
            ? <span>{compactActivityText(mainTerminalOutcome.error)}</span>
            : null}
        </div>
      ) : null}
      {workJobs.map((job) => (
        <AgentActivityCard
          key={job.id}
          job={job}
          nodeName={job.nodeId === null ? undefined : nodeNames.get(job.nodeId)}
          projectPath={projectPath}
          onRevealExport={onRevealExport}
          onCancel={onCancelJob}
          initiallyExpanded={job.id === latestRelatedJobId && job.kind === "implementation-export" && job.status === "ready"}
        />
      ))}
    </section>
  );
}

function AgentThinkingIndicator({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.div
      className="design-canvas-agent__thinking"
      role="status"
      aria-label="Thinking"
      initial={reduceMotion ? false : { opacity: 0, transform: "translate3d(-4px, 4px, 0px) scale(0.98)" }}
      animate={{ opacity: 1, transform: "translate3d(0px, 0px, 0px) scale(1)" }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: AGENT_MOTION_EASE }}
    >
      <span className="design-canvas-agent__thinking-orb" aria-hidden>
        {Array.from({ length: 3 }, (_, index) => <span key={index} />)}
      </span>
      <span className="design-canvas-agent__thinking-label">Thinking…</span>
    </motion.div>
  );
}

function AgentActivityCard({
  job,
  nodeName,
  projectPath,
  onRevealExport,
  onCancel,
  initiallyExpanded = false,
}: {
  job: DesignJob;
  nodeName?: string;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onCancel: (jobId: string) => Promise<void>;
  initiallyExpanded?: boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const [revealFeedback, setRevealFeedback] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const detailsId = useId();
  const active = job.status === "queued" || job.status === "running" || job.status === "validating";
  const [expanded, setExpanded] = useState(active || initiallyExpanded);
  useEffect(() => {
    if (active || initiallyExpanded) setExpanded(true);
  }, [active, initiallyExpanded]);
  const kindLabel = job.kind === "node-generation"
    ? "Node generation"
    : job.kind === "node-analysis"
      ? "Node analysis"
      : job.kind === "main-agent"
        ? "Main Agent"
        : "Implementation export";
  const label = job.nodeId === null ? kindLabel : `${kindLabel} · ${nodeName ?? job.nodeId}`;
  const displayLabel = job.kind === "node-generation"
    ? `${nodeName ?? "Node"} generation`
    : job.kind === "node-analysis"
      ? `${nodeName ?? "Node"} analysis`
      : job.kind === "main-agent"
        ? "Canvas plan"
        : "Implementation export";
  const exportId = job.kind === "implementation-export" ? job.exportId : null;
  const exportPath = exportId
    ? designExportPath(projectPath, exportId)
    : null;
  const searchActivities = job.activity.filter(isWebSearchActivity);
  const imageActivity = [...job.activity].reverse().find(isImageGenerationActivity) ?? null;
  const reasoningItems = job.activity
    .filter(isReasoningActivity)
    .map((activity) => ({ id: activity.id, text: activity.text.trim() || "Activity updated" }));
  const latestActivity = job.activity.at(-1);
  const activePhase: AgentActivityPhase | null = active
    ? latestActivity === undefined ? "reasoning" : activityPhase(latestActivity)
    : null;
  const reasoningActive = activePhase === "reasoning";
  const progressActive = activePhase === "progress";
  const searchActive = activePhase === "search";
  const imageActive = activePhase === "image";
  const progressActivities = job.activity.filter((activity) => (
    activity.kind !== "text" && !isWebSearchActivity(activity) && !isImageGenerationActivity(activity)
  ));
  const omittedProgressCount = Math.max(0, progressActivities.length - 7);
  const visibleProgressActivities = progressActivities.slice(-7);
  const progressItems: AgentProgressItem[] = [
    ...(omittedProgressCount > 0 ? [{
      id: `${job.id}-earlier-actions`,
      text: `${omittedProgressCount} earlier actions completed`,
      state: "done" as const,
    }] : []),
    ...visibleProgressActivities.map((activity, index) => ({
      id: activity.id,
      text: compactActivityText(activity.text),
      state: job.status === "failed" && index === visibleProgressActivities.length - 1
        ? "failed" as const
        : progressActive && index === visibleProgressActivities.length - 1
          ? "active" as const
          : "done" as const,
    })),
  ];
  const searchQuery = searchActivities.length > 0
    ? quotedActivityText(searchActivities[0]!.text)
      ?? (compactActivityText(searchActivities[0]!.text).replace(/^.*?\bsearch(?:ing|ed)?\b\s*/i, "") || "the web")
    : null;
  const imagePrompt = imageActivity
    ? quotedActivityText(imageActivity.text) ?? compactActivityText(imageActivity.text)
    : null;
  const durationMs = Math.max(0, (job.finishedAt ?? job.updatedAt) - job.createdAt);
  return (
    <article
      className="design-canvas-agent__activity"
      data-status={job.status}
      data-collapsed={!expanded || undefined}
      data-job-id={job.id}
      data-node-id={job.nodeId ?? undefined}
      data-parent-job-id={job.parentJobId ?? undefined}
      data-agent-component="execution-log"
      aria-label={`${label} · ${job.status}`}
    >
      <span className="agent-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {displayLabel}: {jobStatusLabel(job)}
      </span>
      <header>
        <button
          type="button"
          className="design-canvas-agent__activity-toggle"
          aria-controls={detailsId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="design-canvas-agent__activity-status" data-status={job.status} aria-hidden>
            {active
              ? <LoaderCircle />
              : job.status === "ready"
                ? <Check />
                : job.status === "failed"
                  ? <CircleAlert />
                  : <Circle />}
          </span>
          <span className="design-canvas-agent__activity-copy">
            <strong>{displayLabel}</strong>
            <small>
              {jobStatusLabel(job)}
              {!active && durationMs > 0 ? ` · ${compactJobDuration(durationMs)}` : ""}
            </small>
          </span>
          <motion.span
            className="design-canvas-agent__activity-chevron"
            aria-hidden
            animate={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: AGENT_MOTION_EASE }}
          >
            <ChevronDown />
          </motion.span>
        </button>
        {active ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="design-canvas-agent__activity-stop"
            aria-label={`${stopping ? "Stopping" : "Stop"} ${displayLabel}`}
            aria-busy={stopping || undefined}
            disabled={stopping}
            onClick={() => {
              if (stopping) return;
              setStopping(true);
              void onCancel(job.id).catch(() => undefined).finally(() => setStopping(false));
            }}
          >
            {stopping
              ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} />
              : <Square aria-hidden fill="currentColor" />}
            <span>{stopping ? "Stopping" : "Stop"}</span>
          </Button>
        ) : null}
      </header>
      <AgentCollapsible id={detailsId} className="design-canvas-agent__activity-collapsible" open={expanded}>
        <>
          <div className="design-canvas-agent__activity-body">
            <AgentReasoning items={reasoningItems} active={reasoningActive} durationMs={durationMs} />
            {searchQuery ? (
              <AgentWebSearch query={searchQuery} results={searchResults(searchActivities, searchActive)} active={searchActive} />
            ) : null}
            {imagePrompt ? <AgentImageGenerationState prompt={imagePrompt} active={imageActive} /> : null}
            <AgentProgressList
              items={progressItems}
              defaultOpen={active || job.status === "failed"}
              completionTone={job.status === "ready" ? "auto" : "neutral"}
            />
          </div>
          {job.kind === "implementation-export" && job.exportId ? (
            <div className="design-canvas-agent__activity-result">
              <p>{job.status === "ready" ? "Export ready" : "Export"}</p>
              {job.status === "ready" ? (
                <>
                  {exportPath ? (
                    <code title={exportPath}>{exportPath}</code>
                  ) : <small>Output path unavailable until Project metadata loads.</small>}
                  <div className="design-canvas-agent__activity-export-actions">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={revealing || !exportPath || !onRevealExport}
                      onClick={() => {
                        if (!onRevealExport || !exportId) return;
                        setRevealing(true);
                        setRevealFeedback(null);
                        void onRevealExport(exportId).then((result) => {
                          setRevealFeedback(result === "revealed"
                            ? "Opened in Finder."
                            : result === "copied"
                              ? "Finder unavailable · path copied."
                              : "Reveal unavailable · copy the path shown above.");
                        }).catch(() => {
                          setRevealFeedback("Couldn't reveal this export.");
                        }).finally(() => setRevealing(false));
                      }}
                    >
                      {revealing ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} /> : null}
                      Reveal export
                    </Button>
                    {revealFeedback ? <output role="status">{revealFeedback}</output> : null}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          {job.status === "failed" && job.error ? (
            <div className="design-canvas-agent__activity-error" aria-hidden={!expanded}>
              <CircleAlert aria-hidden />
              <p>{job.error}</p>
            </div>
          ) : null}
        </>
      </AgentCollapsible>
    </article>
  );
}
