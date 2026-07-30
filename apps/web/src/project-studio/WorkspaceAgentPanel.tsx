import { ArrowDown, ArrowUp, ChevronLeft, LoaderCircle, MessageSquareText, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  AgentComposerContextCards,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
import { AgentMessageBody } from "../components/AgentMessageBody.tsx";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { AttachMenu } from "../components/AttachMenu.tsx";
import { DesignSystemSelect } from "../components/DesignSystemSelect.tsx";
import { useToast } from "../components/Toast.tsx";
import {
  Button,
  StudioHeaderCopy,
  StudioHeaderIdentity,
  StudioPanelHeader,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import type { AgentInfo, DesignSystemCard, EffectCard, Moodboard } from "../lib/api.ts";
import type { AgentTranscriptEntry } from "./scoped-agent-session.ts";

export type AgentTraceStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface AgentTraceOutput {
  kind: "artifact" | "resource";
  targetId: string;
  revisionId: string;
  label: string;
}
export type ProjectedAgentTranscriptEntry = AgentTranscriptEntry & {
  trace?: {
    status: AgentTraceStatus;
    planId: string;
    taskId?: string;
    output?: AgentTraceOutput;
  };
};

const TRACE_STATUS_COPY: Record<
  AgentTraceStatus,
  readonly [title: string, detail: string, turnState: string]
> = {
  running: ["Build in progress", "Dezin is producing the approved design output.", "Building"],
  succeeded: ["Build complete", "The approved design work completed successfully.", "Complete"],
  failed: [
    "Build needs attention",
    "The build stopped before publishing its requested output. Open the plan for details.",
    "Needs attention",
  ],
  cancelled: ["Build cancelled", "This build ended without changing the active design.", "Cancelled"],
  queued: ["Build queued", "Approved design work is queued in the build plan.", "Build queued"],
};

const NOOP_CONTEXT_CHANGE = (_items: AgentComposerContextItem[]) => {};
const NOOP_CONTEXT_REMOVE = (_id: string) => {};
const ERROR_TOAST_DEDUPE_MS = 4_000;
const recentErrorToastByDispatcher = new WeakMap<
  ReturnType<typeof useToast>["toast"],
  { signature: string; expiresAt: number }
>();
const COLLAPSED_BRIEF_LINE_LIMIT = 12;
const COLLAPSED_BRIEF_WIDTH_UNIT_LIMIT = 440;

function estimatedBriefWidthUnits(content: string): number {
  let units = 0;
  for (const character of content) {
    units += (character.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  }
  return units;
}

function shouldCollapseBrief(content: string): boolean {
  return content.split(/\r?\n/).length > COLLAPSED_BRIEF_LINE_LIMIT
    || estimatedBriefWidthUnits(content) > COLLAPSED_BRIEF_WIDTH_UNIT_LIMIT;
}

function latestProposalTranscriptEntryId(transcript: readonly ProjectedAgentTranscriptEntry[]): string | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.role === "assistant" && entry.state === "proposal") return entry.id;
  }
  return null;
}

type ProposalAffordance = {
  summary: string;
  changeCount: number;
  onOpen: () => void;
};

type PlanAffordance = {
  open?: boolean;
  planId?: string;
  status?: string;
  onToggle: () => void;
};

function traceCopy(
  entry: ProjectedAgentTranscriptEntry,
  proposalAffordance?: ProposalAffordance,
): readonly [title: string, detail: string] {
  if (entry.state === "failed" && entry.trace === undefined) {
    return ["Needs attention", entry.content];
  }
  const output = entry.trace?.output;
  const status = entry.trace?.status;
  if (status !== undefined) {
    const copy = TRACE_STATUS_COPY[status];
    return [
      copy[0],
      status === "succeeded" && output
        ? `${output.label} is ready as an immutable Revision.`
        : copy[1],
    ];
  }
  return entry.state === "proposal"
    ? ["Proposal ready", proposalAffordance?.summary ?? "A reviewable workspace proposal is ready."]
    : ["Build queued", "Design work is queued in the build plan."];
}

function turnStateLabel(entry: ProjectedAgentTranscriptEntry): string {
  const status = entry.trace?.status;
  if (status !== undefined) return TRACE_STATUS_COPY[status][2];
  return entry.state === "proposal"
    ? "Ready for review"
    : entry.state === "failed"
      ? "Needs attention"
      : entry.state === "queued"
        ? "Build queued"
        : entry.role === "user" ? "Sent" : "Working";
}

function TranscriptMessage({
  entry,
  planAffordance,
  proposalAffordance,
  onOpenTrace,
  onOpenTraceOutput,
  onRetry,
  retryDisabled = false,
}: {
  entry: ProjectedAgentTranscriptEntry;
  planAffordance?: PlanAffordance | null;
  proposalAffordance?: ProposalAffordance;
  onOpenTrace?: (entry: ProjectedAgentTranscriptEntry) => void;
  onOpenTraceOutput?: (output: AgentTraceOutput) => void;
  onRetry?: () => void | Promise<void>;
  retryDisabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const collapsible = entry.role === "user" && shouldCollapseBrief(entry.content);

  if (entry.role === "assistant"
    && (entry.state === "proposal" || entry.state === "queued" || entry.state === "failed")) {
    const review = entry.state === "proposal" && entry.trace === undefined;
    const failedSubmission = entry.state === "failed" && entry.trace === undefined;
    const planId = entry.trace?.planId ?? entry.planId;
    const [title, detail] = traceCopy(entry, proposalAffordance);
    const open = planAffordance?.open && planAffordance.planId === planId
      ? undefined
      : (review ? proposalAffordance?.onOpen : undefined)
      ?? (onOpenTrace && (planId ?? entry.proposalId ?? entry.taskId)
        ? () => onOpenTrace(entry)
        : undefined);
    const output = entry.trace?.output;
    return (
      <div
        data-agent-trace-state={entry.trace?.status ?? entry.state}
      >
        <div>
          <div>
            <h3>{title}</h3>
            <p>{detail}</p>
          </div>
          {review && proposalAffordance ? (
            <span>
              {proposalAffordance.changeCount} {proposalAffordance.changeCount === 1 ? "change" : "changes"}
            </span>
          ) : null}
        </div>
        {failedSubmission ? (
          <p data-agent-failure-retained>
            Your brief is retained. You can revise it or try again without rebuilding the request.
          </p>
        ) : null}
        {failedSubmission && onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={retryDisabled}
            onClick={() => void onRetry()}
          >
            Try again
          </Button>
        ) : null}
        {open ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={open}
          >
            {review ? "Review proposal" : "View in plan"}
          </Button>
        ) : null}
        {output && onOpenTraceOutput ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onOpenTraceOutput(output)}
          >
            Open {output.label}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div id={contentId}>
        <AgentMessageBody
          role={entry.role}
          content={entry.content}
        />
      </div>
      {collapsible ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show full brief"}
        </Button>
      ) : null}
    </>
  );
}

export function WorkspaceAgentPanel({
  projectName,
  onBackHome,
  draft,
  onDraftChange,
  contextLabel,
  contextItems = [],
  onContextItemsChange = NOOP_CONTEXT_CHANGE,
  onRemoveContextItem = NOOP_CONTEXT_REMOVE,
  transcript = [],
  onOpenTrace,
  onOpenTraceOutput,
  title = "Workspace Agent",
  draftLabel = "Workspace Agent draft",
  placeholder = "Plan a page, component, or workspace change…",
  scopeLabel = "Workspace",
  onSubmit,
  submitting = false,
  error = null,
  status = null,
  planAffordance = null,
  proposalAffordance,
  submitLabel = "Create proposal",
  submittingLabel = "Creating a reviewable proposal…",
  onAttachFiles,
  attaching = false,
  onReferenceMoodboard,
  onReferenceEffect,
  workspaceReferences = [],
  onReferenceWorkspaceItem,
  agents = [],
  agent = "",
  model = "",
  onAgentChange,
  onModelChange,
  onRescanAgents,
  agentDisabledReason,
  submissionBlockedReason = null,
  submissionBlockedPending = false,
  designSystems = [],
  designSystemId = "",
  designSystemInherited = false,
  defaultDesignSystemId,
  designSystemSelectionStatus = "ready",
  onDesignSystemChange,
  onUseDefaultDesignSystem,
  designSystemCatalogStatus = "ready",
  onRetryDesignSystems,
}: {
  projectName?: string;
  onBackHome?: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
  contextLabel: string;
  contextItems?: AgentComposerContextItem[];
  onContextItemsChange?: (items: AgentComposerContextItem[]) => void;
  onRemoveContextItem?: (id: string) => void;
  transcript?: ProjectedAgentTranscriptEntry[];
  onOpenTrace?: (entry: ProjectedAgentTranscriptEntry) => void;
  onOpenTraceOutput?: (output: AgentTraceOutput) => void;
  title?: string;
  draftLabel?: string;
  placeholder?: string;
  scopeLabel?: string;
  onSubmit?: () => void | Promise<void>;
  submitting?: boolean;
  error?: string | null;
  status?: string | null;
  planAffordance?: PlanAffordance | null;
  proposalAffordance?: ProposalAffordance;
  submitLabel?: string;
  submittingLabel?: string;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  attaching?: boolean;
  onReferenceMoodboard?: (board: Moodboard) => void;
  onReferenceEffect?: (effect: EffectCard) => void;
  workspaceReferences?: Array<{ id: string; label: string; detail?: string }>;
  onReferenceWorkspaceItem?: (id: string) => void;
  agents?: AgentInfo[];
  agent?: string;
  model?: string;
  onAgentChange?: (command: string) => void;
  onModelChange?: (model: string) => void;
  onRescanAgents?: () => Promise<unknown>;
  agentDisabledReason?: (agent: AgentInfo) => string | null;
  submissionBlockedReason?: string | null;
  submissionBlockedPending?: boolean;
  designSystems?: DesignSystemCard[];
  designSystemId?: string;
  designSystemInherited?: boolean;
  defaultDesignSystemId?: string;
  designSystemSelectionStatus?: "loading" | "ready" | "error";
  onDesignSystemChange?: (id: string) => void;
  onUseDefaultDesignSystem?: () => void;
  designSystemCatalogStatus?: "loading" | "ready" | "error";
  onRetryDesignSystems?: () => void;
}) {
  const pendingMessage = submissionBlockedPending
    ? submissionBlockedReason ?? "Checking Agent availability…"
    : null;
  const activityMessage = pendingMessage
    ?? (attaching ? "Saving immutable context…" : submitting ? submittingLabel : null);
  const submitHint = activityMessage ?? submissionBlockedReason;
  const activityLabel = pendingMessage ?? `${title} activity`;
  const errorNotification = submissionBlockedPending ? error : submissionBlockedReason ?? error;
  const activityMessageId = "workspace-agent-activity";
  const describedBy = activityMessage ? activityMessageId : undefined;
  const canSubmit = onSubmit !== undefined
    && draft.trim().length > 0
    && !submissionBlockedPending
    && !submitting
    && !attaching
    && submissionBlockedReason === null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const stickTranscriptBottomRef = useRef(true);
  const lastErrorNotificationRef = useRef<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const { toast } = useToast();
  const hasAgentPicker = onAgentChange !== undefined
    && onModelChange !== undefined
    && onRescanAgents !== undefined;
  const hasDesignSystemPicker = onDesignSystemChange !== undefined;
  const hasTranscriptFooter = status !== null || planAffordance !== null || submitting;
  const latestProposalEntryId = proposalAffordance === undefined
    ? null
    : latestProposalTranscriptEntryId(transcript);

  const scrollTranscriptToLatest = useCallback((behavior: ScrollBehavior = "auto"): void => {
    const element = transcriptScrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    if (typeof element.scrollTo === "function") {
      try {
        element.scrollTo({ top: element.scrollHeight, behavior });
      } catch {
        element.scrollTop = element.scrollHeight;
      }
    }
    stickTranscriptBottomRef.current = true;
    setShowScrollToLatest(false);
  }, []);

  const updateTranscriptBottomState = useCallback((): void => {
    const element = transcriptScrollRef.current;
    if (!element || (transcript.length === 0 && !hasTranscriptFooter)) {
      stickTranscriptBottomRef.current = true;
      setShowScrollToLatest(false);
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    stickTranscriptBottomRef.current = nearBottom;
    setShowScrollToLatest(!nearBottom);
  }, [hasTranscriptFooter, transcript.length]);

  const latestTranscriptEntry = transcript.at(-1);
  const latestTranscriptSignature = latestTranscriptEntry
    ? `${latestTranscriptEntry.id}\u0000${latestTranscriptEntry.state}\u0000${latestTranscriptEntry.content}`
    : "";

  useEffect(() => {
    if (transcript.length === 0 && !hasTranscriptFooter) {
      stickTranscriptBottomRef.current = true;
      setShowScrollToLatest(false);
      return;
    }
    if (stickTranscriptBottomRef.current) scrollTranscriptToLatest("auto");
    else setShowScrollToLatest(true);
  }, [hasTranscriptFooter, latestTranscriptSignature, scrollTranscriptToLatest, transcript.length]);

  useEffect(() => {
    if (!errorNotification) {
      lastErrorNotificationRef.current = null;
      return;
    }
    if (lastErrorNotificationRef.current === errorNotification) return;
    lastErrorNotificationRef.current = errorNotification;
    const now = Date.now();
    const signature = `${title}\u0000${errorNotification}`;
    const recent = recentErrorToastByDispatcher.get(toast);
    if (recent?.signature === signature && recent.expiresAt > now) return;
    recentErrorToastByDispatcher.set(toast, {
      signature,
      expiresAt: now + ERROR_TOAST_DEDUPE_MS,
    });
    toast(errorNotification, { variant: "error" });
  }, [errorNotification, title, toast]);

  const attachFiles = (files: FileList | File[]): void => {
    if (!onAttachFiles || attaching) return;
    const next = Array.from(files);
    if (next.length > 0) void onAttachFiles(next);
  };

  return (
    <section aria-labelledby="workspace-agent-title">
      <StudioPanelHeader draggable>
        {onBackHome ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to projects"
            title={projectName ? `Back to projects · ${projectName}` : "Back to projects"}
            onClick={onBackHome}
          >
            <ChevronLeft aria-hidden />
          </Button>
        ) : null}
        <StudioHeaderIdentity>
          <StudioHeaderCopy
            title={title}
            subtitle={contextLabel}
            titleId="workspace-agent-title"
            headingLevel={2}
          />
        </StudioHeaderIdentity>
      </StudioPanelHeader>

      <div>
        <div
          ref={transcriptScrollRef}
          onScroll={updateTranscriptBottomState}
          aria-label={`${title} transcript`}
        >
          {transcript.length === 0 ? (
            <div>
              <div>
                <span>
                  <MessageSquareText aria-hidden />
                </span>
                <p>Work in this scope</p>
                <p>
                  Attach exact project revisions, then describe the design decision or change.
                </p>
              </div>
            </div>
          ) : (
            <ol>
              {transcript.map((entry) => {
                const timestamp = new Date(entry.createdAt);
                const timestampIso = timestamp.toJSON();
                return (
                  <li key={entry.id}>
                    <article
                      data-agent-role={entry.role}
                      data-agent-turn-id={entry.turnId}
                    >
                      <div
                        data-agent-message-meta={entry.id}
                        data-role={entry.role}
                      >
                        <span>{entry.role === "user" ? "You" : "Dezin Agent"}</span>
                        {timestampIso ? (
                          <time dateTime={timestampIso}>
                            {timestamp.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          </time>
                        ) : null}
                        <span data-agent-turn-state={entry.id}>
                          {turnStateLabel(entry)}
                        </span>
                      </div>
                      <TranscriptMessage
                        entry={entry}
                        planAffordance={planAffordance}
                        proposalAffordance={entry.id === latestProposalEntryId ? proposalAffordance : undefined}
                        onOpenTrace={onOpenTrace}
                        onOpenTraceOutput={onOpenTraceOutput}
                        onRetry={onSubmit}
                        retryDisabled={!canSubmit}
                      />
                    </article>
                  </li>
                );
              })}
            </ol>
          )}
          {submitting ? (
            <section
              id={activityMessageId}
              data-agent-proposal-progress
              role="status"
              aria-label={`${title} proposal progress`}
              aria-live="polite"
              aria-atomic="true"
              aria-busy="true"
            >
              <div>
                <LoaderCircle aria-hidden />
                <strong>Dezin Agent</strong>
                <span>Thinking</span>
              </div>
              <h3>{submittingLabel}</h3>
              <p>Reviewing the brief and exact context before the next design action.</p>
            </section>
          ) : null}
          {planAffordance ? (
            <section
              data-agent-build-activity
              aria-label="Build activity"
            >
              <h3>Build activity</h3>
              <p>{planAffordance.status ?? "Build plan ready"}</p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label={planAffordance.open ? "Hide build details" : "Open build plan"}
                aria-expanded={planAffordance.open}
                aria-controls="project-studio-inspector"
                title="Build plan"
                onClick={planAffordance.onToggle}
              >
                <PanelRightOpen aria-hidden />
                {planAffordance.open ? "Hide details" : "Open build plan"}
              </Button>
            </section>
          ) : null}
          {status ? (
            <div
              role="status"
              aria-label={`${title} task status`}
              aria-live="polite"
            >
              <span>{status}</span>
            </div>
          ) : null}
        </div>
        {showScrollToLatest ? (
          <TooltipProvider delayDuration={180}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Scroll to latest"
                  onClick={() => scrollTranscriptToLatest("smooth")}
                >
                  <ArrowDown aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>Scroll to latest</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>

      <div data-workspace-agent-composer>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(event) => {
            if (event.target.files) attachFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <label htmlFor="workspace-agent-draft">
          {draftLabel}
        </label>
        {hasDesignSystemPicker ? (
          <div
            data-workspace-agent-design-system
          >
            <DesignSystemSelect
              compact
              systems={designSystems}
              value={designSystemId}
              defaultId={defaultDesignSystemId}
              inherited={designSystemInherited}
              selectionStatus={designSystemSelectionStatus}
              onChange={onDesignSystemChange}
              onUseDefault={onUseDefaultDesignSystem}
              catalogStatus={designSystemCatalogStatus}
              onRetry={onRetryDesignSystems}
            />
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void onSubmit();
          }}
          onDragEnter={(event) => {
            if (!onAttachFiles || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDraggingFiles(true);
          }}
          onDragOver={(event) => {
            if (!onAttachFiles || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
          }}
          onDrop={(event) => {
            if (!onAttachFiles || event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            setDraggingFiles(false);
            attachFiles(event.dataTransfer.files);
          }}
        >
          <AgentComposerContextCards
            items={contextItems}
            onChange={onContextItemsChange}
            onRemove={onRemoveContextItem}
            ariaLabel="Selected Agent Context"
          />
          <div
            data-agent-composer-shell
            data-dragging={draggingFiles || undefined}
          >
            <textarea
              id="workspace-agent-draft"
              aria-label={draftLabel}
              aria-describedby={describedBy}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              placeholder={draggingFiles ? "Drop files to attach…" : placeholder}
              rows={1}
              spellCheck
            />
            <div
              data-workspace-agent-actions
            >
              <div>
                {onAttachFiles ? (
                  <AttachMenu
                    fileActionLabel="Upload a reference"
                    onAttachFile={() => fileInputRef.current?.click()}
                    onReferenceMoodboard={onReferenceMoodboard}
                    onReferenceEffect={onReferenceEffect}
                    workspaceReferences={workspaceReferences}
                    onReferenceWorkspaceItem={onReferenceWorkspaceItem}
                    allowLocalPaths={false}
                    allowProjectReference={false}
                    allowFigImport={false}
                  />
                ) : null}
                {!hasAgentPicker && !hasDesignSystemPicker ? (
                  <span>Project context</span>
                ) : null}
                <span>{scopeLabel}</span>
              </div>
              <div>
                {hasAgentPicker ? (
                  <div>
                    <AgentModelSelect
                      agents={agents}
                      agent={agent}
                      model={model}
                      onAgentChange={onAgentChange}
                      onModelChange={onModelChange}
                      onRescan={onRescanAgents}
                      agentDisabledReason={agentDisabledReason}
                      dropUp
                    />
                  </div>
                ) : null}
                {onSubmit ? (
                  <TooltipProvider delayDuration={180}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={submitHint ? 0 : undefined}
                          aria-label={submitHint ?? undefined}
                        >
                          <Button
                            type="submit"
                            size="icon-xs"
                            aria-label={submitLabel}
                            aria-describedby={activityMessage ? activityMessageId : undefined}
                            aria-busy={activityMessage ? true : undefined}
                            disabled={!canSubmit}
                          >
                            <ArrowUp data-agent-submit-icon aria-hidden />
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {submitHint ? (
                        <TooltipContent side="top" sideOffset={6}>{submitHint}</TooltipContent>
                      ) : null}
                    </Tooltip>
                  </TooltipProvider>
                ) : null}
              </div>
            </div>
          </div>
          {activityMessage && !submitting ? (
            <span
              id={activityMessageId}
              role="status"
              aria-label={activityLabel}
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {activityMessage}
            </span>
          ) : null}
        </form>
      </div>
    </section>
  );
}
