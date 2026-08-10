import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
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
import { cn } from "../lib/utils.ts";
import { motion, useReducedMotion } from "motion/react";
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
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
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

const AGENT_MOTION_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const AGENT_MOTION_EASE_IN_OUT: [number, number, number, number] = [0.66, 0, 0.34, 1];
const TRANSCRIPT_MESSAGE_PAGE_SIZE = 12;
const TRANSCRIPT_JOB_PAGE_SIZE = 6;

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
    const entryX = boundedEntryOffset(nodeCenterX - (resolved.left + panelWidth / 2), 18);
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
  | { kind: "main-job-group"; id: string; createdAt: number; group: MainAgentJobGroup }
  | { kind: "node-job"; id: string; createdAt: number; job: DesignJob };

function boundedTurnLabel(thread: DesignThread | null, job: DesignJob): string {
  const prompt = thread?.messages.find((message) => message.jobId === job.id && message.role === "user")?.content.trim();
  if (prompt) return prompt.length > 72 ? `${prompt.slice(0, 72)}…` : prompt;
  return job.kind === "implementation-export" ? `Export · ${job.exportId ?? job.id}` : "Canvas activity";
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
      label: boundedTurnLabel(thread, parent),
      jobs: [parent, ...groupedChildren],
    }];
  });
  const visibleParents = new Set(parents.map((parent) => parent.id));
  for (const [parentJobId, orphanedChildren] of childrenByParent) {
    if (visibleParents.has(parentJobId)) continue;
    groups.push({
      parentJobId,
      label: `Canvas activity · ${parentJobId}`,
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
  deferTranscriptMs = 0,
  rootRef,
}: CanvasAgentPanelProps) {
  const reduceMotion = useReducedMotion();
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
  return (
    <motion.section
      ref={rootRef}
      data-canvas-agent-panel
      data-agent-scope={scopeKey}
      data-agent-size={compact ? "compact" : "focus"}
      className={cn("design-canvas-agent", floating && "design-canvas-agent--floating", className)}
      style={{ ...style, transformOrigin: "center center" }}
      initial={floating && !reduceMotion ? { opacity: 0, x: entryX, y: entryY, scale: 0.98 } : false}
      animate={floating ? { opacity: 1, x: 0, y: 0, scale: 1 } : undefined}
      exit={floating ? { opacity: 0, x: reduceMotion ? 0 : entryX, y: reduceMotion ? 0 : entryY, scale: 0.985 } : undefined}
      transition={{
        duration: reduceMotion ? 0 : 0.22,
        ease: AGENT_MOTION_EASE,
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
            <div className="flex shrink-0 items-center gap-1">
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
                        {appendingRevision ? <LoaderCircle aria-hidden className="animate-spin" /> : <FileUp aria-hidden />}
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
        deferTranscriptMs={deferTranscriptMs}
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
              {submitting ? <LoaderCircle aria-hidden className="animate-spin" /> : <ArrowUp aria-hidden />}
            </Button>
          </div>
        </div>
        {threadError ? (
          <motion.div
            role="alert"
            className="design-canvas-agent__composer-notice"
            initial={reduceMotion ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
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
  deferTranscriptMs,
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
  deferTranscriptMs: number;
  reduceMotion: boolean;
  tailKey: string;
}) {
  const [ready, setReady] = useState(reduceMotion || deferTranscriptMs <= 0);
  const [historyPages, setHistoryPages] = useState(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const messageHistoryLimit = historyPages * TRANSCRIPT_MESSAGE_PAGE_SIZE;
  const jobHistoryLimit = historyPages * (scopeType === "main" ? TRANSCRIPT_JOB_PAGE_SIZE : 2);
  const threadMessages = optimisticUserTurn
    ? [...(thread?.messages ?? []), optimisticUserTurn.message]
    : thread?.messages ?? [];
  const visibleMessages = threadMessages.slice(-messageHistoryLimit);
  const visibleMainJobGroups = mainJobGroups.slice(-jobHistoryLimit);
  const visibleRelatedJobs = relatedJobs.slice(-jobHistoryLimit);
  const hiddenTranscriptCount = Math.max(0, threadMessages.length - visibleMessages.length)
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
      items.push(...visibleMainJobGroups.map((group) => ({
        kind: "main-job-group" as const,
        id: `main-job-group:${group.parentJobId}`,
        createdAt: (optimisticUserTurn && !optimisticUserTurn.existingJobIds.has(group.parentJobId)
          ? optimisticUserTurn.message.createdAt
          : userTurnCreatedAt.get(group.parentJobId))
          ?? Math.min(...group.jobs.map((job) => job.createdAt)),
        group,
      })));
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
  }, [optimisticUserTurn, scopeType, threadMessages, visibleMainJobGroups, visibleMessages, visibleRelatedJobs]);

  useEffect(() => {
    setHistoryPages(1);
    restoreScrollRef.current = null;
    if (reduceMotion || deferTranscriptMs <= 0) {
      setReady(true);
      return;
    }
    setReady(false);
    const timer = window.setTimeout(() => setReady(true), deferTranscriptMs);
    return () => window.clearTimeout(timer);
  }, [deferTranscriptMs, reduceMotion, scopeKey]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !ready) return;
    const restore = restoreScrollRef.current;
    if (restore) {
      transcript.scrollTop = restore.top + transcript.scrollHeight - restore.height;
      restoreScrollRef.current = null;
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [historyPages, ready, tailKey, thread?.messages.length, thread?.updatedAt]);

  return (
    <div ref={transcriptRef} className="design-canvas-agent__transcript">
      {!ready || threadLoading ? (
        <div className="design-canvas-agent__transcript-placeholder" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
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
          {threadMessages.length === 0 && relatedJobs.length === 0 ? (
            <div className="design-canvas-agent__empty">
              <p className="text-[11px] font-medium text-foreground/75">
                {scopeType === "main" ? "Coordinate the canvas." : "Describe what this Node should become."}
              </p>
              <p className="max-w-[24rem] text-[10px] leading-[1.45] text-muted-foreground/80">
                Complete canvas context is already available to this Agent.
              </p>
            </div>
          ) : null}
          {timeline.map((item) => {
            if (item.kind === "message") {
              const { message } = item;
              return (
                <motion.article
                  key={item.id}
                  className="design-canvas-agent__message"
                  data-role={message.role}
                  initial={reduceMotion ? false : { opacity: 0, y: 8, x: message.role === "user" ? 5 : -3 }}
                  animate={{ opacity: 1, y: 0, x: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.28, ease: AGENT_MOTION_EASE }}
                >
                  <div className="design-canvas-agent__message-meta">
                    <span>{message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : message.role}</span>
                    <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                  <AgentMessageBody role={message.role === "user" ? "user" : "assistant"} content={message.content} />
                </motion.article>
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
        </>
      )}
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
  if (workJobs.length === 0) {
    if (mainActive) return <AgentThinkingIndicator reduceMotion={reduceMotion} />;
    if (mainJob?.status !== "failed") return null;
    return (
      <AgentActivityCard
        job={mainJob}
        projectPath={projectPath}
        onRevealExport={onRevealExport}
        onCancel={onCancelJob}
      />
    );
  }
  const childCount = workJobs.filter((job) => job.nodeId !== null).length;
  return (
    <section
      className="design-canvas-agent__activity-group"
      aria-label={group.label}
      data-parent-job-id={group.parentJobId}
    >
      <header className="design-canvas-agent__activity-group-header">
        <p>{group.label}</p>
        {childCount > 0 ? <span>{childCount} {childCount === 1 ? "child Agent" : "child Agents"}</span> : null}
      </header>
      {mainActive ? <AgentThinkingIndicator reduceMotion={reduceMotion} /> : null}
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
      initial={reduceMotion ? false : { opacity: 0, x: -4, y: 4 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.26, ease: AGENT_MOTION_EASE }}
    >
      <span className="design-canvas-agent__thinking-orb" aria-hidden>
        {Array.from({ length: 9 }, (_, index) => <span key={index} />)}
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
  const reduceMotion = useReducedMotion();
  const [revealFeedback, setRevealFeedback] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
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
    .filter((activity) => activity.kind === "text" && !isWebSearchActivity(activity) && !isImageGenerationActivity(activity))
    .map((activity) => ({ id: activity.id, text: compactActivityText(activity.text) }));
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
        : active && index === visibleProgressActivities.length - 1
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
      aria-label={`${label} · ${job.status}`}
    >
      {active ? (
        <motion.span
          className="design-canvas-agent__activity-live-beam"
          aria-hidden
          initial={false}
          animate={reduceMotion
            ? { opacity: 0 }
            : { x: ["-150%", "430%"], opacity: [0, 0.82, 0.82, 0] }}
          transition={reduceMotion ? { duration: 0 } : {
            duration: 2.6,
            ease: AGENT_MOTION_EASE_IN_OUT,
            repeat: Number.POSITIVE_INFINITY,
            repeatDelay: 0.8,
            times: [0, 0.18, 0.72, 1],
          }}
        />
      ) : null}
      <header>
        <motion.button
          type="button"
          className="design-canvas-agent__activity-toggle"
          aria-expanded={expanded}
          whileTap={reduceMotion ? undefined : { scale: 0.985 }}
          transition={{ duration: 0.12, ease: AGENT_MOTION_EASE }}
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
            animate={{ rotate: expanded ? 0 : -90 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: AGENT_MOTION_EASE }}
          >
            <ChevronDown />
          </motion.span>
        </motion.button>
        {active ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="design-canvas-agent__activity-stop"
            onClick={() => {
              void onCancel(job.id).catch(() => undefined);
            }}
          >
            <X aria-hidden />Stop
          </Button>
        ) : null}
      </header>
      {job.error && !expanded ? (
        <button
          type="button"
          className="design-canvas-agent__activity-error-summary"
          title={job.error}
          onClick={() => setExpanded(true)}
        >
          {compactActivityText(job.error)}
        </button>
      ) : null}
      <div className="design-canvas-agent__activity-collapsible" data-collapsed={!expanded || undefined}>
        <div>
          <div className="design-canvas-agent__activity-body">
            <AgentReasoning items={reasoningItems} active={active} durationMs={durationMs} />
            {searchQuery ? (
              <AgentWebSearch query={searchQuery} results={searchResults(searchActivities, active)} active={active} />
            ) : null}
            {active && imagePrompt ? <AgentImageGenerationState prompt={imagePrompt} /> : null}
            <AgentProgressList items={progressItems} defaultOpen={active || job.status === "failed"} />
          </div>
          {job.kind === "implementation-export" && job.exportId ? (
            <div className="design-canvas-agent__activity-result">
              <p>{job.status === "ready" ? "Export ready" : "Export"} · {job.exportId}</p>
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
                      {revealing ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                      Reveal export
                    </Button>
                    {revealFeedback ? <output role="status">{revealFeedback}</output> : null}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          {job.error ? (
            <p className="design-canvas-agent__activity-error" aria-hidden={!expanded}>{job.error}</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
