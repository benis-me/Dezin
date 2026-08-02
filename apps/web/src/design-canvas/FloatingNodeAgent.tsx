import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AgentMessageBody } from "../components/AgentMessageBody.tsx";
import { Button } from "../components/ui/Button.tsx";
import { resolveFloatingChromeRect, type CanvasRect } from "../moodboard/canvas-utils.ts";
import type { AgentInfo } from "../lib/api.ts";
import { designExportPath, type DesignExportRevealResult } from "../lib/design-export.ts";
import { cn } from "../lib/utils.ts";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  PanelRightClose,
  Sparkles,
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

import type { DesignCanvasApi } from "./api.ts";
import { catalogItem } from "./catalog.ts";
import type {
  DesignJob,
  DesignNode,
  DesignNodeVersion,
  DesignThread,
  DesignThreadScope,
} from "./types.ts";

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
      left: Math.max(0, hostRect.width - 356),
      top: 0,
      right: hostRect.width,
      bottom: hostRect.height,
      width: Math.min(356, hostRect.width),
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
      surfaceWidth: panelRect.width || 332,
      surfaceHeight: Math.min(panelRect.height || 590, hostRect.height - 16),
      placement: "top",
      occluders,
      padding: 8,
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
  assetRevision?: string | null;
  agents?: readonly AgentInfo[];
  initialAgentCommand?: string;
  initialModel?: string;
  onRescanAgents?: () => Promise<void>;
  onSubmit: (prompt: string, nodeIds: readonly string[], selection: { agentCommand?: string; model?: string }) => Promise<void>;
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
  assetRevision = null,
  agents = [],
  initialAgentCommand = "",
  initialModel = "",
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
  const [thread, setThread] = useState<DesignThread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [agentCommand, setAgentCommand] = useState(initialAgentCommand);
  const [model, setModel] = useState(initialModel);
  const [contextNodeIds, setContextNodeIds] = useState<string[]>(nodes.map((node) => node.id));
  const [allContext, setAllContext] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const threadLoadSequenceRef = useRef(0);
  const scopeKey = scope.type === "main" ? "main" : `node:${scope.nodeId}`;
  const relatedJobs = useMemo(() => (
    scope.type === "main"
      ? jobs.filter((job) => job.kind === "main-agent" || job.kind === "implementation-export" || job.parentJobId !== null)
      : jobs.filter((job) => job.nodeId === scope.nodeId)
  ), [jobs, scope]);
  const nodeNames = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
  const mainJobGroups = useMemo(
    () => scope.type === "main" ? groupMainAgentJobs(relatedJobs, thread) : [],
    [relatedJobs, scope.type, thread],
  );
  const live = relatedJobs.some((job) => job.status === "queued" || job.status === "running" || job.status === "validating");

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
    if (allContext) setContextNodeIds([...existingIds]);
    else setContextNodeIds((current) => current.filter((id) => existingIds.has(id)));
  }, [allContext, nodes]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void loadThread(), 1_200);
    return () => window.clearInterval(timer);
  }, [live, loadThread]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [thread?.messages.length, relatedJobs.length]);

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || submitting) return;
    setSubmitting(true);
    setThreadError(null);
    try {
      await onSubmit(prompt, contextNodeIds, {
        ...(agentCommand ? { agentCommand } : {}),
        ...(model ? { model } : {}),
      });
      setDraft("");
      await loadThread();
    } catch (problem) {
      setThreadError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      ref={rootRef}
      data-canvas-agent-panel
      data-agent-scope={scopeKey}
      className={cn("design-canvas-agent", floating && "design-canvas-agent--floating", className)}
      style={style}
      aria-label={`${title} panel`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <header className="design-canvas-agent__header">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="design-canvas-agent__mark"><Sparkles aria-hidden /></span>
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {onClose ? (
          <Button variant="ghost" size="icon-xs" aria-label={`Close ${title}`} onClick={onClose}>
            {floating ? <X aria-hidden /> : <PanelRightClose aria-hidden />}
          </Button>
        ) : null}
      </header>

      {assetRevision ? (
        <div className="design-canvas-agent__versions">
          <span className="design-canvas-agent__versions-label">Version</span>
          <output className="design-canvas-agent__asset-revision">Asset revision · {assetRevision}</output>
        </div>
      ) : versions.length > 0 && onSelectVersion ? (
        <div className="design-canvas-agent__versions">
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
                <option key={version.id} value={version.id}>v{version.sequence} · {new Date(version.createdAt).toLocaleString()}</option>
              ))}
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-2 size-3 text-muted-foreground" />
          </div>
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
                <span>{childCount} {childCount === 1 ? "child Agent" : "child Agents"}</span>
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
        <div className="design-canvas-agent__context-row">
          <div className="design-canvas-agent__context-control">
            <button
              type="button"
              className="design-canvas-agent__context-trigger"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen((current) => !current)}
            >
              Focus · {contextNodeIds.length} <ChevronDown aria-hidden />
            </button>
            {contextOpen ? (
              <div className="design-canvas-agent__context-menu" role="menu" aria-label="Focused canvas nodes">
              <button
                type="button"
                className="design-canvas-agent__context-item"
                onClick={() => setAllContext((current) => !current)}
              >
                {allContext ? <Check aria-hidden /> : <Circle aria-hidden />}
                <span><strong>Prioritize all nodes</strong><small>Automatically prioritizes new nodes</small></span>
              </button>
              <p className="px-2 pb-1 pt-0.5 text-[9px] leading-4 text-muted-foreground">The entire canvas is always available. Selected Nodes receive extra focus.</p>
              <div className="my-1 h-px bg-border" />
              <div className="max-h-52 overflow-y-auto">
                {nodes.map((node) => {
                  const checked = contextNodeIds.includes(node.id);
                  return (
                    <button
                      type="button"
                      key={node.id}
                      className="design-canvas-agent__context-item"
                      onClick={() => {
                        setAllContext(false);
                        setContextNodeIds((current) => checked ? current.filter((id) => id !== node.id) : [...current, node.id]);
                      }}
                    >
                      {checked ? <Check aria-hidden /> : <Circle aria-hidden />}
                      <span><strong>{node.name}</strong><small>{catalogItem(node.kind).label}</small></span>
                    </button>
                  );
                })}
              </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="design-canvas-agent__composer-shell">
          <textarea
            aria-label={`${title} message`}
            value={draft}
            rows={1}
            placeholder={scope.type === "main" ? "Coordinate the canvas and its Agents…" : "Ask this node's Agent…"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="design-canvas-agent__actions">
            <div className="flex min-w-0 items-center gap-1">
              <Button variant="ghost" size="icon-xs" aria-label="Attach canvas context files" onClick={() => fileInputRef.current?.click()}>
                <Paperclip aria-hidden />
              </Button>
              {agents.length > 0 ? (
                <AgentModelSelect
                  agents={[...agents]}
                  agent={agentCommand}
                  model={model}
                  onAgentChange={setAgentCommand}
                  onModelChange={setModel}
                  onRescan={onRescanAgents}
                  dropUp
                />
              ) : null}
            </div>
            <Button
              size="icon-sm"
              aria-label={`Send to ${title}`}
              disabled={!draft.trim() || submitting}
              onClick={() => void submit()}
              className="size-7"
            >
              {submitting ? <LoaderCircle aria-hidden className="animate-spin" /> : <ArrowUp aria-hidden />}
            </Button>
          </div>
        </div>
        {threadError ? <p role="alert" className="mt-1.5 text-[10px] leading-4 text-destructive">{threadError}</p> : null}
      </div>
    </section>
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
  const [revealFeedback, setRevealFeedback] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const active = job.status === "queued" || job.status === "running" || job.status === "validating";
  const kindLabel = job.kind === "node-generation"
    ? "Node generation"
    : job.kind === "node-analysis"
      ? "Node analysis"
      : job.kind === "main-agent"
        ? "Main Agent"
        : "Implementation export";
  const label = job.nodeId === null ? kindLabel : `${kindLabel} · ${nodeName ?? job.nodeId}`;
  const exportId = job.kind === "implementation-export" ? job.exportId : null;
  const exportPath = exportId
    ? designExportPath(projectPath, exportId)
    : null;
  return (
    <article
      className="design-canvas-agent__activity"
      data-status={job.status}
      data-job-id={job.id}
      data-node-id={job.nodeId ?? undefined}
      data-parent-job-id={job.parentJobId ?? undefined}
      aria-label={`${label} · ${job.status}`}
    >
      <header>
        <div className="min-w-0">
          <p>{label}</p>
          <span>{job.status}</span>
        </div>
        {active ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 px-1.5 text-[9px]"
            onClick={() => {
              void onCancel(job.id).catch(() => undefined);
            }}
          >
            <X aria-hidden />Stop
          </Button>
        ) : job.status === "ready" ? <Check aria-hidden /> : <Circle aria-hidden />}
      </header>
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
      {job.activity.length ? (
        <ol>
          {job.activity.slice(-4).map((item, index) => (
            <li key={item.id} data-current={index === Math.min(3, job.activity.length - 1) && active}>
              <span aria-hidden />
              <p>{item.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-3 pb-3 text-[10px] text-muted-foreground">Waiting for activity…</p>
      )}
      {job.error ? <p className="border-t border-border px-3 py-2 text-[10px] text-destructive">{job.error}</p> : null}
    </article>
  );
}
