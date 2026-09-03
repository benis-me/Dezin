import { formatTime } from "../lib/format-date.ts";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AgentMessageBody } from "../components/AgentMessageBody.tsx";
import {
  Button,
  IconSwap,
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
import { ConversationSelect } from "../components/ConversationSelect.tsx";
import { resolveFloatingChromeRect, type CanvasRect } from "../moodboard/canvas-utils.ts";
import type { AgentInfo } from "../lib/api.ts";
import type { DesignExportRevealResult } from "../lib/design-export.ts";
import { usePrefersReducedMotion } from "../lib/use-prefers-reduced-motion.ts";
import { cn } from "../lib/utils.ts";
import { BorderBeam } from "border-beam";
import { motion } from "motion/react";
import {
  ArrowUp,
  ArrowDown,
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
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type Ref,
} from "react";

import {
  buildAgentTranscriptPage,
  buildAgentOutputModel,
  versionOptionLabel,
  type MainAgentJobGroup,
  type OptimisticUserTurn,
} from "./agent-panel-model.ts";
import { AgentOutputRenderer } from "./AgentOutputRenderer.tsx";
import { DezinAgentJobDisclosure, DezinAgentLoadingState } from "./DezinAgentPrimitives.tsx";
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
export const MAIN_AGENT_WIDTH_PX = 440;

export interface PanelWidthRange {
  min: number;
  max: number;
}

function clampPanelWidth(width: number, range: PanelWidthRange): number {
  return Math.round(Math.min(range.max, Math.max(range.min, width)));
}

/** A right-docked panel width the user can drag, remembered per storage key. */
export function usePersistedPanelWidth(
  storageKey: string,
  fallback: number,
  range: PanelWidthRange,
): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored > 0) return clampPanelWidth(stored, range);
    } catch {
      // localStorage may be unavailable
    }
    return clampPanelWidth(fallback, range);
  });
  const update = useCallback((next: number) => {
    const clamped = clampPanelWidth(next, range);
    setWidth(clamped);
    try {
      localStorage.setItem(storageKey, String(clamped));
    } catch {
      // ignore
    }
  }, [range, storageKey]);
  return [width, update];
}

/**
 * Drag strip on the left edge of a right-docked panel. Dragging left widens
 * the panel; arrow keys nudge it for keyboard users.
 */
export function PanelResizeHandle({
  width,
  range,
  label,
  onResize,
}: {
  width: number;
  range: PanelWidthRange;
  label: string;
  onResize: (width: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      className="design-canvas-agent__resize-handle nodrag nopan"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.setAttribute("data-dragging", "");
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onResize(drag.startWidth + (drag.startX - event.clientX));
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.removeAttribute("data-dragging");
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        dragRef.current = null;
        event.currentTarget.removeAttribute("data-dragging");
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        if (event.key === "ArrowLeft") onResize(width + step);
        else if (event.key === "ArrowRight") onResize(width - step);
        else return;
        event.preventDefault();
      }}
    />
  );
}

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
  initialContextNodeIds?: readonly string[];
  contextSeedGeneration?: number;
  initialDraft?: string;
  draftSeedMode?: "replace" | "append";
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
  /** Present when the panel's width can be dragged from its left edge. */
  panelWidth?: { width: number; range: PanelWidthRange; onResize: (width: number) => void };
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
  initialContextNodeIds,
  contextSeedGeneration,
  initialDraft,
  draftSeedMode,
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
  panelWidth,
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
    sessions,
    createSession,
    switchSession,
    renameSession,
    deleteSession,
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
    activeTurnJob,
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
    initialContextNodeIds,
    contextSeedGeneration,
    initialDraft,
    draftSeedMode,
    agentSelection: controlledAgentSelection,
    onAgentSelectionChange,
    onSubmit,
    onAppendMaterialVersion,
    onSelectVersion,
    onAttachFiles,
    onRescanAgents,
  });

  const activeTurnLabel = scope.type === "main"
    ? "Canvas plan"
    : `${scopedNode?.name ?? "Node"} Agent`;
  const {
    stopping: stoppingActiveTurn,
    stopError: activeTurnStopError,
    dismissStopError: dismissActiveTurnStopError,
    stop: stopActiveTurn,
  } = useJobActionController({
    jobId: activeTurnJob?.id ?? "",
    active: activeTurnJob !== null,
    displayLabel: activeTurnLabel,
    onCancel: onCancelJob,
  });
  const composerError = threadError ?? activeTurnStopError;

  // One row: the title, the session switcher (Main Agent only), then the controls.
  const panelTitle = title === "Main Agent" ? "Main Agent" : title.replace(/\s+Agent$/, "");
  const sessionLabel = (session: { title: string | null }, index: number) => session.title || `Session ${index + 1}`;
  const activeSessionIndex = sessions?.sessions.findIndex((session) => session.id === sessions.activeId) ?? -1;
  const activeSessionLabel = sessions && activeSessionIndex >= 0
    ? sessionLabel(sessions.sessions[activeSessionIndex]!, activeSessionIndex)
    : undefined;
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
      {panelWidth ? (
        <PanelResizeHandle
          width={panelWidth.width}
          range={panelWidth.range}
          label={`Resize ${title} panel`}
          onResize={panelWidth.onResize}
        />
      ) : null}
      <div className="design-canvas-agent__surface">
      <header className="design-canvas-agent__header">
        <div className="design-canvas-agent__header-copy">
          <h2 title={subtitle || undefined}>{panelTitle}</h2>
          {sessions ? (
            <ConversationSelect
              conversations={sessions.sessions.map((session) => ({ ...session, title: session.title ?? "" }))}
              activeId={sessions.activeId}
              onSwitch={(sessionId) => void switchSession(sessionId)}
              onCreate={() => void createSession()}
              onRename={(sessionId, nextTitle) => void renameSession(sessionId, nextTitle)}
              onDelete={(sessionId) => void deleteSession(sessionId)}
              label={sessionLabel}
              ariaLabel="Sessions"
              newLabel="New session"
              triggerLabel={activeSessionLabel}
            />
          ) : null}
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
                        <IconSwap
                          active={appendingRevision}
                          first={<FileUp aria-hidden />}
                          second={<LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} />}
                        />
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
          borderRadius={11}
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
                type="button"
                size="icon-sm"
                variant={activeTurnJob ? "destructive" : "default"}
                aria-label={activeTurnJob
                  ? `${stoppingActiveTurn ? "Stopping" : "Stop"} ${activeTurnLabel}`
                  : `Send to ${title}`}
                aria-busy={stoppingActiveTurn || undefined}
                title={activeTurnJob ? `Stop ${activeTurnLabel}` : undefined}
                disabled={activeTurnJob
                  ? stoppingActiveTurn
                  : !draft.trim() || submitting || !activeAgent}
                onClick={() => {
                  if (activeTurnJob) void stopActiveTurn();
                  else void submit();
                }}
                className="size-7"
              >
                <IconSwap
                  active={activeTurnJob !== null}
                  first={submitting
                    ? <LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} />
                    : <ArrowUp aria-hidden />}
                  second={<Square aria-hidden fill="currentColor" />}
                />
              </Button>
            </div>
          </div>
        </BorderBeam>
        {composerError ? (
          <motion.div
            role="alert"
            className="design-canvas-agent__composer-notice"
            initial={reduceMotion ? false : { opacity: 0, transform: "translate3d(0px, 5px, 0px) scale(0.98)" }}
            animate={{ opacity: 1, transform: "translate3d(0px, 0px, 0px) scale(1)" }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: AGENT_MOTION_EASE }}
          >
            <CircleAlert aria-hidden />
            <span>{composerError}</span>
            <button
              type="button"
              aria-label="Dismiss Agent error"
              onClick={threadError ? dismissThreadError : dismissActiveTurnStopError}
            >
              <X aria-hidden />
            </button>
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
  tailKey: string;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const {
    historyPages,
    transcriptRef,
    onScroll,
    showEarlier,
    showScrollToBottom,
    scrollToBottom,
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
    <div className="design-canvas-agent__transcript-wrap">
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
          return <AgentThinkingIndicator key={item.id} />;
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
                <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
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
      {showScrollToBottom ? (
        <motion.button
          type="button"
          className="design-canvas-agent__scroll-latest"
          aria-label="Scroll to latest activity"
          initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.16, ease: AGENT_MOTION_EASE }}
          onClick={scrollToBottom}
        >
          <ArrowDown aria-hidden />
          Latest
        </motion.button>
      ) : null}
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
  latestVisibleJobId,
}: {
  group: MainAgentJobGroup;
  nodeNames: ReadonlyMap<string, string>;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onCancelJob: (jobId: string) => Promise<void>;
  onRetryJob?: (jobId: string) => Promise<void>;
  latestVisibleJobId: string | null;
}) {
  const workJobs = group.jobs.filter((job) => job.kind !== "main-agent");
  const childCount = workJobs.filter((job) => job.nodeId !== null).length;
  const childLabel = childCount > 0 ? `${childCount} ${childCount === 1 ? "child Agent" : "child Agents"}` : null;
  const showGroupHeader = childLabel !== null || group.jobs.length > 1;
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
      {group.jobs.map((job) => (
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

function AgentThinkingIndicator() {
  return (
    <div className="design-canvas-agent__thinking">
      <DezinAgentLoadingState label="Thinking" variant="dots" />
    </div>
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
  const active = job.status === "queued" || job.status === "running" || job.status === "validating";
  const [expanded, setExpanded] = useState(active || (job.status === "failed" && initiallyExpanded));
  useEffect(() => {
    if (active) {
      setExpanded(true);
    } else if (job.status === "ready" || job.status === "cancelled" || job.status === "superseded") {
      setExpanded(false);
    } else if (job.status === "failed" && initiallyExpanded) {
      setExpanded(true);
    }
  }, [active, initiallyExpanded, job.status]);
  const kindLabel = job.kind === "node-generation"
    ? "Node generation"
    : job.kind === "node-analysis"
      ? "Node analysis"
      : job.kind === "main-agent"
        ? "Main Agent"
        : "Implementation export";
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
  const outputModel = buildAgentOutputModel(job, { nodeName });
  const hasOutput = outputModel.blocks.length > 0;
  const hasDetails = hasOutput || stopError !== null;
  const taskMeta = [kindLabel, job.model].filter(Boolean).join(" · ");
  return (
    <div
      className="design-canvas-agent__job"
      data-job-id={job.id}
      data-node-id={job.nodeId ?? undefined}
      data-parent-job-id={job.parentJobId ?? undefined}
    >
      <span className="agent-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {displayLabel}: {job.status}
      </span>
      <DezinAgentJobDisclosure
        title={displayLabel}
        meta={taskMeta}
        status={job.status}
        open={expanded}
        onOpenChange={setExpanded}
        trailing={active ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="design-canvas-agent__task-stop"
            aria-label={`${stopping ? "Stopping" : "Stop"} ${displayLabel}`}
            aria-busy={stopping || undefined}
            disabled={stopping}
            onClick={() => void stop()}
          >
            <IconSwap
              active={stopping}
              first={<Square aria-hidden fill="currentColor" />}
              second={<LoaderCircle aria-hidden className={reduceMotion ? undefined : "animate-spin"} />}
            />
            <span>{stopping ? "Stopping" : "Stop"}</span>
          </Button>
        ) : null}
      >
        {hasDetails ? (
          <>
            {stopError ? (
              <div className="design-canvas-agent__job-error" role="alert">
                <CircleAlert aria-hidden />
                <p>{stopError}</p>
              </div>
            ) : null}
            {hasOutput ? (
              <AgentOutputRenderer
                model={outputModel}
                projectPath={projectPath}
                onRevealExport={onRevealExport}
                onRetry={onRetry ? async () => retry() : undefined}
                retrying={retrying}
                retryError={retryError}
              />
            ) : null}
          </>
        ) : null}
      </DezinAgentJobDisclosure>
    </div>
  );
}
