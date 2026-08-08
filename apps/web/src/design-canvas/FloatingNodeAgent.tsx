import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import {
  AgentImageGenerationState,
  AgentProgressList,
  AgentReasoning,
  AgentThinkingState,
  AgentWebSearch,
  type AgentProgressItem,
  type AgentSearchResult,
} from "../components/AgentActivityBlocks.tsx";
import { AgentMessageBody } from "../components/AgentMessageBody.tsx";
import { Button } from "../components/ui/index.ts";
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
  MessageSquareText,
  Paperclip,
  PanelRightClose,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
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

interface FloatingPosition {
  left: number;
  top: number;
  visible: boolean;
}

export function useFloatingNodePanel({
  hostRef,
  panelRef,
  nodeId,
  mainPanelOpen,
  layoutNonce,
}: {
  hostRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  nodeId: string | null;
  mainPanelOpen: boolean;
  layoutNonce: number;
}): FloatingPosition {
  const [position, setPosition] = useState<FloatingPosition>({ left: 16, top: 16, visible: false });

  const measure = useCallback(() => {
    const host = hostRef.current;
    const panel = panelRef.current;
    if (!host || !panel || !nodeId) {
      setPosition((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }
    const node = [...host.querySelectorAll<HTMLElement>("[data-design-node-id]")]
      .find((candidate) => candidate.dataset.designNodeId === nodeId);
    if (!node) {
      setPosition((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    if (nodeRect.right < hostRect.left || nodeRect.left > hostRect.right || nodeRect.bottom < hostRect.top || nodeRect.top > hostRect.bottom) {
      setPosition((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const occluders: CanvasRect[] = mainPanelOpen ? [{
      left: Math.max(0, hostRect.width - 400),
      top: 0,
      right: hostRect.width,
      bottom: hostRect.height,
      width: Math.min(400, hostRect.width),
      height: hostRect.height,
    }] : [];
    const resolved = resolveFloatingChromeRect({
      anchor: {
        left: nodeRect.left - hostRect.left,
        top: nodeRect.top - hostRect.top,
        bottom: nodeRect.bottom - hostRect.top,
        targetLeft: nodeRect.left - hostRect.left,
        targetRight: nodeRect.right - hostRect.left,
      },
      containerWidth: hostRect.width,
      containerHeight: hostRect.height,
      surfaceWidth: panelRect.width || 372,
      surfaceHeight: Math.min(panelRect.height || 560, hostRect.height - 24),
      placement: "right",
      occluders,
      padding: 10,
      gap: 12,
      allowSidePlacement: true,
    });
    setPosition((current) => {
      if (current.visible && current.left === resolved.left && current.top === resolved.top) return current;
      return { ...resolved, visible: true };
    });
  }, [hostRef, mainPanelOpen, nodeId, panelRef]);

  useEffect(() => {
    let frame = window.requestAnimationFrame(measure);
    const host = hostRef.current;
    const panel = panelRef.current;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    });
    if (host) observer.observe(host);
    if (panel) observer.observe(panel);
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

function boundedTurnLabel(thread: DesignThread | null, job: DesignJob): string {
  const prompt = thread?.messages.find((message) => message.jobId === job.id && message.role === "user")?.content.trim();
  if (prompt) return `Turn · ${prompt.length > 72 ? `${prompt.slice(0, 72)}…` : prompt}`;
  return job.kind === "implementation-export" ? `Export · ${job.exportId ?? job.id}` : "Main Agent turn";
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
  const groups = parents.map((parent) => ({
    parentJobId: parent.id,
    label: boundedTurnLabel(thread, parent),
    jobs: [parent, ...(childrenByParent.get(parent.id) ?? [])],
  }));
  const visibleParents = new Set(parents.map((parent) => parent.id));
  for (const [parentJobId, orphanedChildren] of childrenByParent) {
    if (visibleParents.has(parentJobId)) continue;
    groups.push({
      parentJobId,
      label: `Main Agent turn · ${parentJobId}`,
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
  return `v${version.sequence} · ${materialName ? `${materialName} · ` : ""}${timestamp}`;
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
  rootRef,
}: CanvasAgentPanelProps) {
  const reduceMotion = useReducedMotion();
  const [thread, setThread] = useState<DesignThread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
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
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const threadLoadSequenceRef = useRef(0);
  const scopeKey = scope.type === "main" ? "main" : `node:${scope.nodeId}`;
  const relatedJobs = useMemo(() => {
    const related = scope.type === "main"
      ? jobs.filter((job) => job.kind === "main-agent" || job.kind === "implementation-export" || job.parentJobId !== null)
      : jobs.filter((job) => job.nodeId === scope.nodeId);
    return related.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }, [jobs, scope]);
  const nodeNames = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
  const scopedNode = scope.type === "node" ? nodes.find((node) => node.id === scope.nodeId) ?? null : null;
  const mainJobGroups = useMemo(
    () => scope.type === "main" ? groupMainAgentJobs(relatedJobs, thread) : [],
    [relatedJobs, scope.type, thread],
  );
  const confinedAgents = useMemo(
    () => agents.filter((agent) => isDesignAgentCommand(agent.command) && agent.available),
    [agents],
  );
  const activeConfinedAgent = confinedAgents.find((agent) => agent.command === agentSelection.agentCommand) ?? null;
  const live = relatedJobs.some((job) => job.status === "queued" || job.status === "running" || job.status === "validating");
  const transcriptTailKey = relatedJobs.map((job) => (
    `${job.id}:${job.status}:${job.activity.length}:${job.error ?? ""}`
  )).join("|");

  const loadThread = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++threadLoadSequenceRef.current;
    try {
      const next = await api.getThread(projectId, scope, signal);
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current) {
        setThread(next);
        setThreadError(null);
      }
    } catch (problem) {
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current) {
        setThreadError(problem instanceof Error ? problem.message : String(problem));
      }
    }
  }, [api, projectId, scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadThread(controller.signal);
    return () => controller.abort();
  }, [loadThread]);

  useEffect(() => {
    const existingIds = new Set(nodes.map((node) => node.id));
    setContextNodeIds((current) => current.filter((id) => existingIds.has(id)));
  }, [nodes]);

  useEffect(() => {
    const active = confinedAgents.find((agent) => agent.command === agentSelection.agentCommand) ?? null;
    if (active) {
      if (agentSelection.model && !active.models.includes(agentSelection.model)) {
        setAgentSelection({ agentCommand: active.command, model: "" });
      }
      return;
    }
    const fallback = confinedAgents[0] ?? null;
    if (fallback) {
      setAgentSelection({ agentCommand: fallback.command, model: "" });
    } else if (agentSelection.agentCommand || agentSelection.model) {
      setAgentSelection({ agentCommand: "", model: "" });
    }
  }, [agentSelection.agentCommand, agentSelection.model, confinedAgents, setAgentSelection]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void loadThread(), 1_200);
    return () => window.clearInterval(timer);
  }, [live, loadThread]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [thread?.messages.length, thread?.updatedAt, transcriptTailKey]);

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || submitting || !activeConfinedAgent) return;
    setSubmitting(true);
    setThreadError(null);
    try {
      await onSubmit(prompt, contextNodeIds, {
        agentCommand: activeConfinedAgent.command,
        ...(agentSelection.model
          ? { model: agentSelection.model }
          : { model: null }),
      });
      setDraft("");
      await loadThread();
    } catch (problem) {
      setThreadError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setSubmitting(false);
    }
  };

  const panelVisible = style?.visibility !== "hidden";
  return (
    <motion.section
      ref={rootRef}
      data-canvas-agent-panel
      data-agent-scope={scopeKey}
      className={cn("design-canvas-agent", floating && "design-canvas-agent--floating", className)}
      style={style}
      initial={floating && !reduceMotion ? { opacity: 0, x: 8, y: 2, scale: 0.992, filter: "blur(2px)" } : false}
      animate={floating ? (panelVisible
        ? { opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" }
        : { opacity: 0, x: reduceMotion ? 0 : 8, y: 0, scale: reduceMotion ? 1 : 0.992, filter: reduceMotion ? "blur(0px)" : "blur(2px)" }) : undefined}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: AGENT_MOTION_EASE }}
      aria-label={`${title} panel`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <header className="design-canvas-agent__header">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
          {subtitle ? <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{subtitle}</p> : null}
        </div>
        {onClose ? (
          <Button variant="ghost" size="icon-xs" aria-label={`Close ${title}`} onClick={onClose}>
            {floating ? <X aria-hidden /> : <PanelRightClose aria-hidden />}
          </Button>
        ) : null}
      </header>

      {(versions.length > 0 && onSelectVersion) || onAppendMaterialVersion ? (
        <div className="design-canvas-agent__versions">
          {versions.length > 0 && onSelectVersion ? (
            <>
              <label htmlFor={`${scopeKey}-version`}>Version</label>
              <div className="relative min-w-0 flex-1">
                <select
                  id={`${scopeKey}-version`}
                  value={selectedVersionId ?? versions.at(-1)?.id ?? ""}
                  onChange={(event) => {
                    void onSelectVersion(event.target.value).catch((problem) => {
                      setThreadError(problem instanceof Error ? problem.message : String(problem));
                    });
                  }}
                  className="h-7 w-full appearance-none rounded-md border border-border bg-background px-2 pr-7 text-[11px] text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                >
                  {[...versions].reverse().map((version) => (
                    <option key={version.id} value={version.id}>{versionOptionLabel(version)}</option>
                  ))}
                </select>
                <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-2 size-3 text-muted-foreground" />
              </div>
            </>
          ) : (
            <span className="design-canvas-agent__versions-label">No versions yet</span>
          )}
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
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="shrink-0"
                disabled={appendingRevision}
                onClick={() => revisionInputRef.current?.click()}
              >
                {appendingRevision ? <LoaderCircle aria-hidden className="animate-spin" /> : <FileUp aria-hidden />}
                Add revision
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <div ref={transcriptRef} className="design-canvas-agent__transcript">
        {(thread?.messages.length ?? 0) === 0 && relatedJobs.length === 0 ? (
          <div className="design-canvas-agent__empty">
            <MessageSquareText aria-hidden />
            <p>Ask this Agent to work from the complete canvas context.</p>
          </div>
        ) : null}
        {thread?.messages.map((message) => (
          <article key={message.id} className="design-canvas-agent__message" data-role={message.role}>
            <div className="design-canvas-agent__message-meta">
              <span>{message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : message.role}</span>
              <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
            <AgentMessageBody role={message.role === "user" ? "user" : "assistant"} content={message.content} />
          </article>
        ))}
        {scope.type === "main" ? mainJobGroups.map((group) => {
          const childCount = group.jobs.filter((job) => job.nodeId !== null).length;
          return (
            <section
              key={group.parentJobId}
              className="design-canvas-agent__activity-group"
              aria-label={group.label}
              data-parent-job-id={group.parentJobId}
            >
              <header className="design-canvas-agent__activity-group-header">
                <p>{group.label}</p>
                {childCount > 0 ? <span>{childCount} {childCount === 1 ? "child Agent" : "child Agents"}</span> : null}
              </header>
              {group.jobs.map((job) => (
                <AgentActivityCard
                  key={job.id}
                  job={job}
                  nodeName={job.nodeId === null ? undefined : nodeNames.get(job.nodeId)}
                  projectPath={projectPath}
                  onRevealExport={onRevealExport}
                  onCancel={onCancelJob}
                />
              ))}
            </section>
          );
        }) : relatedJobs.map((job) => (
          <AgentActivityCard
            key={job.id}
            job={job}
            nodeName={job.nodeId === null ? undefined : nodeNames.get(job.nodeId)}
            projectPath={projectPath}
            onRevealExport={onRevealExport}
            onCancel={onCancelJob}
          />
        ))}
      </div>

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
              {confinedAgents.length > 0 ? (
                <AgentModelSelect
                  agents={confinedAgents}
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
                  title="No compatible Design Agent is currently available"
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
              disabled={!draft.trim() || submitting || !activeConfinedAgent}
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
            initial={reduceMotion ? false : { opacity: 0, y: 5, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: AGENT_MOTION_EASE }}
          >
            <CircleAlert aria-hidden />
            <span>{threadError}</span>
            <button type="button" aria-label="Dismiss Agent error" onClick={() => setThreadError(null)}><X aria-hidden /></button>
          </motion.div>
        ) : null}
      </div>
    </motion.section>
  );
}

function AgentActivityCard({
  job,
  nodeName,
  projectPath,
  onRevealExport,
  onCancel,
}: {
  job: DesignJob;
  nodeName?: string;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onCancel: (jobId: string) => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const [revealFeedback, setRevealFeedback] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const active = job.status === "queued" || job.status === "running" || job.status === "validating";
  const [expanded, setExpanded] = useState(active || job.status === "failed");
  useEffect(() => {
    if (active || job.status === "failed") setExpanded(true);
  }, [active, job.status]);
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
          transition={{
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
      <div className="design-canvas-agent__activity-collapsible" data-collapsed={!expanded || undefined}>
        <div>
          <div className="design-canvas-agent__activity-body">
            <AgentReasoning items={reasoningItems} active={active} durationMs={durationMs} />
            {searchQuery ? (
              <AgentWebSearch query={searchQuery} results={searchResults(searchActivities, active)} active={active} />
            ) : null}
            {active && imagePrompt ? <AgentImageGenerationState prompt={imagePrompt} /> : null}
            <AgentProgressList items={progressItems} defaultOpen={active || job.status === "failed"} />
            {active && job.activity.length === 0 ? <AgentThinkingState /> : null}
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
          {job.error ? <p className="design-canvas-agent__activity-error">{job.error}</p> : null}
        </div>
      </div>
    </article>
  );
}
