import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AgentCollapsible } from "../components/AgentCollapsible.tsx";
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
import type { DesignExportRevealResult } from "../lib/design-export.ts";
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
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type Ref,
} from "react";

import {
  buildAgentTranscriptPage,
  buildAgentOutputModel,
  compactActivityText,
  compactJobDuration,
  jobRetryLabel,
  jobStatusLabel,
  versionOptionLabel,
  type MainAgentJobGroup,
  type OptimisticUserTurn,
} from "./agent-panel-model.ts";
import { AgentOutputRenderer } from "./AgentOutputRenderer.tsx";
import { type DesignCanvasApi } from "./api.ts";
import { NodeMentionInput } from "./NodeMentionInput.tsx";
import type {
  DesignJob,
  DesignNode,
  DesignNodeVersion,
  DesignThread,
  DesignThreadScope,
} from "./types.ts";
import {
  useAgentTranscriptController,
  useCanvasAgentPanelController,
  useJobActionController,
  type CanvasAgentSelection,
} from "./useCanvasAgentPanelController.ts";

export type { CanvasAgentSelection } from "./useCanvasAgentPanelController.ts";

const AGENT_MOTION_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];
const AGENT_MORPH_EASE: [number, number, number, number] = [0.77, 0, 0.175, 1];

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
  onRetryJob?: (jobId: string) => Promise<void>;
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
  rootRef?: Ref<HTMLElement>;
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
  onRetryJob,
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const revisionInputRef = useRef<HTMLInputElement | null>(null);
  const {
    scopeKey,
    thread,
    threadLoading,
    threadError,
    dismissThreadError,
    draft,
    setDraft,
    submitting,
    visibleOptimisticUserTurn,
    appendingRevision,
    agentSelection,
    setAgentSelection,
    contextNodeIds,
    setContextNodeIds,
    relatedJobs,
    nodeNames,
    scopedNode,
    mainJobGroups,
    availableAgents,
    activeAgent,
    transcriptTailKey,
    activeVersion,
    activeVersionId,
    submit,
    appendMaterialRevision,
    selectVersion,
    attachFiles,
    rescanAgents,
  } = useCanvasAgentPanelController({
    projectId,
    api,
    scope,
    nodes,
    jobs,
    versions,
    selectedVersionId,
    agents,
    initialAgentCommand,
    initialModel,
    agentSelection: controlledAgentSelection,
    onAgentSelectionChange,
    onSubmit,
    onAppendMaterialVersion,
    onSelectVersion,
    onAttachFiles,
    onRescanAgents,
  });

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
                    void selectVersion(versionId);
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
                      void appendMaterialRevision(file);
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
        onRetryJob={onRetryJob}
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
            if (files.length) void attachFiles(files);
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
                    onRescan={rescanAgents}
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
                      void rescanAgents();
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
            <button type="button" aria-label="Dismiss Agent error" onClick={dismissThreadError}><X aria-hidden /></button>
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
  onRetryJob,
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
  onRetryJob?: (jobId: string) => Promise<void>;
  reduceMotion: boolean;
  tailKey: string;
}) {
  const {
    historyPages,
    transcriptRef,
    onScroll,
    showEarlier,
  } = useAgentTranscriptController({
    scopeKey,
    tailKey,
    optimisticUserTurnId: optimisticUserTurn?.message.id ?? null,
    threadMessageCount: thread?.messages.length,
    threadUpdatedAt: thread?.updatedAt,
  });
  const {
    presentableMessages,
    reservedMainReplies,
    hiddenTranscriptCount,
    latestVisibleJobId,
    timeline,
  } = buildAgentTranscriptPage({
    scopeKey,
    scopeType,
    thread,
    optimisticUserTurn,
    relatedJobs,
    mainJobGroups,
    historyPages,
  });

  return (
    <div
      ref={transcriptRef}
      className="design-canvas-agent__transcript"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={threadLoading || undefined}
      onScroll={onScroll}
    >
      {hiddenTranscriptCount > 0 ? (
        <button
          type="button"
          className="design-canvas-agent__history-more"
          onClick={showEarlier}
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
              onRetryJob={onRetryJob}
              reduceMotion={reduceMotion}
              latestVisibleJobId={latestVisibleJobId}
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
            onRetry={onRetryJob}
            initiallyExpanded={item.job.id === latestVisibleJobId}
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
  onRetryJob,
  reduceMotion,
  latestVisibleJobId,
}: {
  group: MainAgentJobGroup;
  nodeNames: ReadonlyMap<string, string>;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onCancelJob: (jobId: string) => Promise<void>;
  onRetryJob?: (jobId: string) => Promise<void>;
  reduceMotion: boolean;
  latestVisibleJobId: string | null;
}) {
  const mainJob = group.jobs.find((job) => job.kind === "main-agent") ?? null;
  const workJobs = group.jobs.filter((job) => job.kind !== "main-agent");
  const mainActive = mainJob !== null && ["queued", "running", "validating"].includes(mainJob.status);
  const mainTerminalOutcome = mainJob !== null && ["failed", "cancelled", "superseded"].includes(mainJob.status)
    ? mainJob
    : null;
  const { retrying, retryError, retry } = useJobActionController({
    jobId: mainTerminalOutcome?.id ?? group.parentJobId,
    active: mainActive,
    displayLabel: "Canvas plan",
    onRetry: onRetryJob,
  });
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
      {mainTerminalOutcome?.status === "failed" && onRetryJob ? (
        <div className="design-canvas-agent__activity-group-retry">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="design-canvas-agent__activity-retry"
            aria-label={`${jobRetryLabel(mainTerminalOutcome)} Canvas plan`}
            aria-busy={retrying || undefined}
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying
              ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} />
              : <RotateCcw aria-hidden />}
            <span>{retrying ? "Retrying" : jobRetryLabel(mainTerminalOutcome)}</span>
          </Button>
        </div>
      ) : null}
      {retryError ? (
        <div className="design-canvas-agent__activity-error" role="alert">
          <CircleAlert aria-hidden />
          <p>{retryError}</p>
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
          onRetry={onRetryJob}
          initiallyExpanded={job.id === latestVisibleJobId}
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
  onRetry,
  initiallyExpanded = false,
}: {
  job: DesignJob;
  nodeName?: string;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onCancel: (jobId: string) => Promise<void>;
  onRetry?: (jobId: string) => Promise<void>;
  initiallyExpanded?: boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();
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
  const {
    stopping,
    stopError,
    stop,
    retrying,
    retryError,
    retry,
  } = useJobActionController({
    jobId: job.id,
    active,
    displayLabel,
    onCancel,
    onRetry,
  });
  const outputModel = buildAgentOutputModel(job);
  const durationMs = Math.max(0, (job.finishedAt ?? job.updatedAt) - job.createdAt);
  return (
    <article
      className="design-canvas-agent__activity"
      data-status={job.status}
      data-collapsed={!expanded || undefined}
      data-job-id={job.id}
      data-node-id={job.nodeId ?? undefined}
      data-parent-job-id={job.parentJobId ?? undefined}
      data-agent-component="task-row"
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
            onClick={() => void stop()}
          >
            {stopping
              ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} />
              : <Square aria-hidden fill="currentColor" />}
            <span>{stopping ? "Stopping" : "Stop"}</span>
          </Button>
        ) : null}
        {job.status === "failed" && onRetry ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="design-canvas-agent__activity-retry"
            aria-label={`${jobRetryLabel(job)} ${displayLabel}`}
            aria-busy={retrying || undefined}
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying
              ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} />
              : <RotateCcw aria-hidden />}
            <span>{retrying ? "Retrying" : jobRetryLabel(job)}</span>
          </Button>
        ) : null}
      </header>
      {stopError ? (
        <div className="design-canvas-agent__activity-error" role="alert">
          <CircleAlert aria-hidden />
          <p>{stopError}</p>
        </div>
      ) : null}
      {retryError ? (
        <div className="design-canvas-agent__activity-error" role="alert">
          <CircleAlert aria-hidden />
          <p>{retryError}</p>
        </div>
      ) : null}
      <AgentCollapsible id={detailsId} className="design-canvas-agent__activity-collapsible" open={expanded}>
        <AgentOutputRenderer
          model={outputModel}
          projectPath={projectPath}
          onRevealExport={onRevealExport}
        />
      </AgentCollapsible>
    </article>
  );
}
