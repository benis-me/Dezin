import "./generation-plan.css";

import {
  Check,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import {
  StudioHeaderActions,
  StudioHeaderCopy,
  StudioHeaderIdentity,
  StudioPanelHeader,
} from "../../components/ui/StudioHeader.tsx";
import {
  StudioInspectorSection,
  StudioStatusBadge,
} from "../../components/ui/StudioInspector.tsx";
import { useApi } from "../../lib/api-context.tsx";
import {
  GenerationPlanStreamError,
  type GenerationPlan,
  type GenerationPlanDetail,
  type GenerationPlanEvent,
  type GenerationTask,
  type GenerationTaskRetryMode,
  type GenerationTaskStatus,
} from "../../lib/api.ts";
import { navigate } from "../../router.tsx";
import {
  generationPlanResultKey,
  generationStatusPhase,
  type GenerationTargetPhase,
} from "./generation-target-state.ts";
import {
  generationPlanFailureMessage,
  publicFailureMessage,
} from "./public-failure-message.ts";

export type GenerationPlanConnection = "connecting" | "live" | "offline" | "error" | "settled";

export interface GenerationPlanTargetLabels {
  readonly artifacts: ReadonlyMap<string, string>;
  readonly resources: ReadonlyMap<string, string>;
}

export type GenerationPlanDetailChangeSource = "load" | "observation" | "retry" | "cancel";

export interface GenerationPlanDetailChange {
  readonly detail: GenerationPlanDetail;
  readonly source: GenerationPlanDetailChangeSource;
}

const TERMINAL_PLAN_STATUSES = new Set<GenerationPlan["status"]>([
  "succeeded",
  "failed",
  "compile-failed",
  "requires-new-impact",
  "cancelled",
]);

const TASK_LABELS: Partial<Record<GenerationTask["kind"], string>> = {
  "prototype-validation": "Flow check",
  "propagation-candidate": "Propagation",
  "propagation-publish": "Publish batch",
};

type DisplayState = "idle" | "active" | "success" | "failure" | "blocked" | "cancelled";

const STATUS_LABELS: Partial<Record<GenerationTaskStatus | GenerationPlan["status"], string>> = {
  approved: "Preparing",
  "materialization-pending": "Preparing",
  "retry-wait": "Retry scheduled",
  "blocked-context": "Context needed",
  "candidate-ready": "Ready to publish",
  "needs-rebase": "Rebasing",
  "awaiting-context-refresh": "Refreshing context",
  "cancel-requested": "Stopping",
  succeeded: "Complete",
  "compile-failed": "Plan failed",
  "requires-new-impact": "Review required",
};

const DISPLAY_STATES: Record<GenerationTargetPhase, DisplayState> = {
  queued: "idle",
  running: "active",
  complete: "success",
  failed: "failure",
  blocked: "blocked",
  cancelled: "cancelled",
};

const CONNECTION_LABELS: Record<GenerationPlanConnection, string> = {
  live: "Live updates",
  connecting: "Connecting",
  offline: "Reconnecting",
  error: "Updates unavailable",
  settled: "Durable snapshot",
};

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function taskLabel(kind: GenerationTask["kind"]): string {
  return TASK_LABELS[kind] ?? label(kind);
}

function statusLabel(status: GenerationTaskStatus | GenerationPlan["status"], plan = false): string {
  if (plan && status === "failed") return "Needs attention";
  return STATUS_LABELS[status] ?? label(status);
}

function displayState(
  status: GenerationTaskStatus | GenerationPlan["status"],
): DisplayState {
  if (status === "retry-wait") return "active";
  return DISPLAY_STATES[generationStatusPhase(status)];
}

function statusTone(
  state: ReturnType<typeof displayState>,
): "neutral" | "active" | "success" | "danger" {
  if (state === "failure") return "danger";
  return state === "success" || state === "active" ? state : "neutral";
}

interface ResearchSelectionDestination {
  key: string;
  href: string;
  ariaLabel: string;
  label: string;
}

function projectRoute(...segments: Array<string | number>): string {
  return `/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`;
}

function researchSelectionDestinations(projectId: string, task: GenerationTask): ResearchSelectionDestination[] {
  const refs = task.error?.refs;
  if (task.status !== "blocked-context" || !Array.isArray(refs)) return [];
  const seen = new Set<string>();
  return refs.flatMap((value): ResearchSelectionDestination[] => {
    if (typeof value !== "string") return [];
    const match = /^research:([^@]+)@([^:]+):direction-selection$/.exec(value);
    if (!match?.[1] || !match[2]) return [];
    const resourceId = match[1];
    const revisionId = match[2];
    const key = `${resourceId}@${revisionId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      key,
      href: projectRoute("projects", projectId, "resources", resourceId, "revisions", revisionId),
      ariaLabel: `Review Research directions from Revision ${revisionId}`,
      label: "Review Research directions",
    }];
  });
}

function targetLabel(
  task: GenerationTask,
  targetLabels?: GenerationPlanTargetLabels,
): string {
  if (task.target.type === "workspace") return "Workspace";
  const ownedLabel = task.target.type === "artifact"
    ? targetLabels?.artifacts.get(task.target.id)
    : targetLabels?.resources.get(task.target.id);
  const resolvedLabel = textValue(ownedLabel);
  if (resolvedLabel !== null) return resolvedLabel;
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(task.target.id)
    || /^[0-9a-f]{24,}$/i.test(task.target.id)) {
    return `${taskLabel(task.kind)} ${task.ordinal + 1}`;
  }
  const plain = task.target.id
    .replace(/^artifact-/, "")
    .replace(/^resource-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return plain.length > 0 ? plain.replace(/\b\w/g, (character) => character.toUpperCase()) : task.target.id;
}

export function generationPlanActivityStatus(detail: GenerationPlanDetail): string {
  return detail.plan.status === "running" ? "Building" : statusLabel(detail.plan.status, true);
}

function taskMessage(
  task: GenerationTask,
  tasksById: ReadonlyMap<string, GenerationTask>,
  targetLabels?: GenerationPlanTargetLabels,
): string | null {
  if (task.status === "blocked" && task.blockedByTaskId !== null) {
    const blocker = tasksById.get(task.blockedByTaskId);
    return blocker === undefined
      ? "Blocked by an upstream task"
      : `Blocked by ${targetLabel(blocker, targetLabels)}`;
  }
  const message = textValue(task.error?.message);
  if (message !== null) return publicFailureMessage(message);
  return task.blockedReason === null ? null : publicFailureMessage(task.blockedReason);
}

function dependencyLabel(task: GenerationTask): string {
  const dependencies = task.dependencyIds.length;
  const attempt = task.currentAttempt > 0 ? `Attempt ${task.currentAttempt}` : "Not started";
  const rebases = (task.rebaseCount ?? 0) > 0 ? ` · Rebased ${task.rebaseCount}×` : "";
  return `${attempt} · ${dependencies} ${dependencies === 1 ? "dependency" : "dependencies"}${rebases}`;
}

function canRetry(task: GenerationTask): boolean {
  return task.status === "failed" || task.status === "blocked-context";
}

function immutablePlan(plan: GenerationPlan): boolean {
  return plan.status !== "failed" && TERMINAL_PLAN_STATUSES.has(plan.status);
}

export function terminalGenerationPlan(detail: GenerationPlanDetail): boolean {
  return TERMINAL_PLAN_STATUSES.has(detail.plan.status);
}

function canCancel(plan: GenerationPlan): boolean {
  return plan.status === "approved" || plan.status === "queued" || plan.status === "running";
}

function renderPlanCloseButton(onClose?: () => void) {
  return onClose ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="dezin-generation-plan__close"
      aria-label="Close build plan"
      title="Close build plan"
      onClick={onClose}
    >
      <X aria-hidden />
    </Button>
  ) : null;
}

function renderPlanHistorySelect(
  plans: readonly GenerationPlan[],
  value: string,
  onChange: (planId: string) => void,
) {
  return (
    <div className="dezin-generation-plan__selector">
      <span>History</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          size="sm"
          value={value}
          aria-label="Selected generation plan"
          className="dezin-generation-plan__selector-trigger"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" className="z-[100]">
          {plans.map((plan, index) => (
            <SelectItem key={plan.id} value={plan.id} data-plan-id={plan.id}>
              {`Plan ${index + 1}, ${statusLabel(plan.status, true)}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface ArtifactRevisionDestination {
  href: string;
  ariaLabel: string;
  label: string;
  evidenceHash: string | null;
}

function artifactRevisionDestination(
  projectId: string,
  task: GenerationTask,
  detail: GenerationPlanDetail,
): ArtifactRevisionDestination | null {
  if (task.target.type !== "artifact") return null;
  let revisionId: string | null = null;
  let action: "candidate" | "published" | null = null;
  let evidenceHash: string | null = null;
  if (task.status === "succeeded" && task.resultRevisionId !== null) {
    revisionId = task.resultRevisionId;
    action = "published";
  } else if (task.status === "candidate-ready" || task.status === "needs-rebase") {
    const matches = detail.currentAttempts.filter((attempt) => (
      attempt.taskId === task.id
      && attempt.attempt === task.currentAttempt
      && attempt.status === task.status
      && attempt.candidateRevisionId !== null
      && attempt.candidateResourceRevisionId === null
      && attempt.candidateEvidence !== null
      && attempt.candidateEvidenceHash !== null
    ));
    if (matches.length !== 1) return null;
    revisionId = matches[0]!.candidateRevisionId;
    evidenceHash = matches[0]!.candidateEvidenceHash;
    action = "candidate";
  }
  if (revisionId === null || action === null) return null;
  const href = action === "candidate"
    ? projectRoute(
        "projects",
        projectId,
        "artifacts",
        task.target.id,
        "candidates",
        detail.plan.id,
        task.id,
        task.currentAttempt,
      )
    : projectRoute("projects", projectId, "artifacts", task.target.id, "revisions", revisionId);
  const kind = taskLabel(task.kind);
  return action === "candidate"
    ? { href, ariaLabel: `Review ${kind} candidate`, label: "Review candidate", evidenceHash }
    : { href, ariaLabel: `Open published ${kind} revision`, label: "Open published revision", evidenceHash };
}

function renderDestinationLink(
  destination: Pick<ArtifactRevisionDestination, "href" | "ariaLabel" | "label">
    & Partial<Pick<ArtifactRevisionDestination, "evidenceHash">>,
  key?: string,
) {
  return (
    <a
      key={key}
      className="dezin-generation-plan__artifact-link"
      href={destination.href}
      aria-label={destination.ariaLabel}
      title={destination.evidenceHash ? `Candidate evidence ${destination.evidenceHash}` : undefined}
      onClick={(event) => {
        event.preventDefault();
        navigate(destination.href);
      }}
    >
      <span>{destination.label}</span>
    </a>
  );
}

const EVENT_COPY: Readonly<Record<string, string>> = {
  "task-blocked-context": "Waiting for context",
  "task-materialized": "Inputs prepared",
  "task-running": "Generation started",
  "task-needs-rebase": "Candidate needs rebase",
  "task-rebase-disposition": "Rebase evaluated",
  "task-retry-wait": "Retry scheduled",
  "plan-succeeded": "Build completed",
};

const TASK_PROGRESS_COPY = {
  generating: "Generating draft",
  "verifying-sources": "Verifying sources",
  reviewing: "Independent review",
  repairing: "Repairing quality issues",
  "generating-assets": "Generating visual assets",
  publishing: "Publishing revision",
} as const;

type TaskProgressPhase = keyof typeof TASK_PROGRESS_COPY;

function taskProgressPhase(event: GenerationPlanEvent): TaskProgressPhase | null {
  if (event.type !== "task-progress"
    || !Number.isSafeInteger(event.payload.attempt)
    || typeof event.payload.phase !== "string"
    || !(event.payload.phase in TASK_PROGRESS_COPY)) {
    return null;
  }
  return event.payload.phase as TaskProgressPhase;
}

function latestTaskProgress(
  events: readonly GenerationPlanEvent[],
  task: GenerationTask,
): TaskProgressPhase | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.taskId !== task.id || event.payload.attempt !== task.currentAttempt) continue;
    const phase = taskProgressPhase(event);
    if (phase !== null) return phase;
  }
  return null;
}

function revisionOutput(artifactRevision: unknown, resourceRevision: unknown): string | null {
  if (artifactRevision !== null && artifactRevision !== undefined) return "Artifact revision published";
  if (resourceRevision !== null && resourceRevision !== undefined) return "Resource revision published";
  return null;
}

function eventTitle(event: GenerationPlanEvent): string {
  if (event.type === "plan-queued") {
    const taskCount = event.payload.taskCount;
    if (!Number.isSafeInteger(taskCount)) return "Build plan queued";
    return `${taskCount as number} ${taskCount === 1 ? "task" : "tasks"} queued`;
  }
  const progress = taskProgressPhase(event);
  if (progress !== null) return TASK_PROGRESS_COPY[progress];
  return EVENT_COPY[event.type] ?? label(event.type.replace(/[-_]+/g, " "));
}

function eventTaskMeta(
  event: GenerationPlanEvent,
  task: GenerationTask,
  targetLabels?: GenerationPlanTargetLabels,
): string {
  const attempt = Number.isSafeInteger(event.payload.attempt)
    ? `Attempt ${event.payload.attempt as number}`
    : null;
  const output = revisionOutput(event.payload.resultRevisionId, event.payload.resultResourceRevisionId)
    ?? (event.payload.candidateRevisionId ? "Artifact candidate ready" : null)
    ?? (event.payload.candidateResourceRevisionId ? "Resource candidate ready" : null)
    ?? (event.payload.resultSnapshotId ? "Workspace checkpoint saved" : null);
  return [
    taskLabel(task.kind),
    targetLabel(task, targetLabels),
    attempt,
    output,
  ].filter(Boolean).join(" · ");
}

function currentTaskOutput(
  task: GenerationTask,
  progress: TaskProgressPhase | null = null,
): string {
  const revision = revisionOutput(task.resultRevisionId, task.resultResourceRevisionId);
  if (revision !== null) return revision;
  if (task.resultSnapshotId !== null) return "Workspace checkpoint saved";
  if (task.status === "candidate-ready" || task.status === "needs-rebase") {
    const candidate = task.target.type === "resource" ? "Resource" : "Artifact";
    return `${candidate} candidate ${task.status === "needs-rebase" ? "awaiting rebase" : "ready"}`;
  }
  if (task.status === "running") {
    return progress === null ? "Generation in progress" : `${TASK_PROGRESS_COPY[progress]} in progress`;
  }
  if (task.status === "queued") return "Inputs ready, waiting to run";
  if (task.status === "retry-wait") return "Retry reserved";
  if (task.status === "blocked-context") return "Waiting for required context";
  if (task.status === "failed" || task.status === "blocked" || task.status === "cancelled") {
    return "No published output";
  }
  return "No output yet";
}

function renderCanvasFocus(
  task: GenerationTask,
  targetLabels?: GenerationPlanTargetLabels,
  onFocusTask?: (task: GenerationTask) => void,
  labelled = false,
) {
  return onFocusTask && task.target.type !== "workspace" ? (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={labelled ? `Show ${targetLabel(task, targetLabels)} on canvas` : undefined}
      onClick={() => onFocusTask(task)}
    >
      Show on canvas
    </Button>
  ) : null;
}

function renderProcessTimeline(
  events: readonly GenerationPlanEvent[],
  tasksById: ReadonlyMap<string, GenerationTask>,
  targetLabels?: GenerationPlanTargetLabels,
  onFocusTask?: (task: GenerationTask) => void,
) {
  if (events.length === 0) {
    return (
      <p className="dezin-generation-plan__timeline-empty">
        No durable activity is available for this plan yet.
      </p>
    );
  }
  return (
    <ol className="dezin-generation-plan__timeline" aria-label="Generation process">
      {[...events].reverse().map((event) => {
        const time = new Date(event.createdAt);
        const task = event.taskId === null ? undefined : tasksById.get(event.taskId);
        return (
          <li key={event.sequence} className="dezin-generation-plan__event">
            <span className="dezin-generation-plan__event-marker" aria-hidden />
            <div className="dezin-generation-plan__event-body">
              <div className="dezin-generation-plan__event-heading">
                <strong>{eventTitle(event)}</strong>
                <time
                  dateTime={time.toISOString()}
                >
                  {time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </time>
              </div>
              {task ? <small>{eventTaskMeta(event, task, targetLabels)}</small> : null}
              {task ? renderCanvasFocus(task, targetLabels, onFocusTask, true) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function GenerationPlanPanel({
  projectId,
  plans,
  detail,
  connection,
  busyAction,
  targetLabels,
  onSelectPlan,
  onRetry,
  onCancel,
  onFocusTask,
  onClose,
  showHeader = true,
}: {
  projectId: string;
  plans: readonly GenerationPlan[];
  detail: GenerationPlanDetail;
  connection: GenerationPlanConnection;
  busyAction: string | null;
  targetLabels?: GenerationPlanTargetLabels;
  onSelectPlan: (planId: string) => void;
  onRetry: (taskId: string, mode: GenerationTaskRetryMode) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onFocusTask?: (task: GenerationTask) => void;
  onClose?: () => void;
  showHeader?: boolean;
}) {
  let complete = 0;
  const tasksById = new Map<string, GenerationTask>();
  for (const task of detail.tasks) {
    tasksById.set(task.id, task);
    if (task.status === "succeeded") complete += 1;
  }
  const directionSelections = detail.tasks.map((task) => researchSelectionDestinations(projectId, task));
  const retryable = detail.plan.status === "failed"
    || detail.plan.status === "queued"
    || detail.plan.status === "running";
  const events = detail.events ?? [];
  const failureMessage = generationPlanFailureMessage(detail.plan);
  return (
    <section
      className="dezin-generation-plan"
      aria-labelledby={showHeader ? "generation-plan-title" : undefined}
      aria-label={showHeader ? undefined : "Generation Plan details"}
    >
      {showHeader ? renderGenerationPlanHeader(detail.plan, "ready", onClose) : null}

      <StudioInspectorSection
        className="dezin-generation-plan__overview"
        heading="Progress"
        contentClassName="dezin-generation-plan__overview-content"
      >
        <div
          className="dezin-generation-plan__overview-copy"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <strong>{complete} of {detail.tasks.length} complete</strong>
          <span data-connection={connection}>{CONNECTION_LABELS[connection]}</span>
        </div>
        <div
          className="dezin-generation-plan__progress"
          role="progressbar"
          aria-label="Generation progress"
          aria-valuemin={0}
          aria-valuemax={detail.tasks.length}
          aria-valuenow={complete}
          aria-valuetext={`${complete} of ${detail.tasks.length} tasks complete`}
        >
          {detail.tasks.map((task, index) => (
            <i
              key={task.id}
              data-state={directionSelections[index]!.length > 0 ? "active" : displayState(task.status)}
              aria-hidden
            />
          ))}
        </div>
        {failureMessage ? (
          <p className="dezin-generation-plan__plan-message" role="alert">{failureMessage}</p>
        ) : null}
        {plans.length > 1 ? renderPlanHistorySelect(plans, detail.plan.id, onSelectPlan) : null}
      </StudioInspectorSection>

      <StudioInspectorSection
        className="dezin-generation-plan__process-section"
        heading="Process"
        actions={<StudioStatusBadge>{events.length}</StudioStatusBadge>}
        contentClassName="dezin-generation-plan__process-content"
      >
        {renderProcessTimeline(events, tasksById, targetLabels, onFocusTask)}
      </StudioInspectorSection>

      <StudioInspectorSection
        className="dezin-generation-plan__tasks-section"
        heading="Tasks"
        actions={<StudioStatusBadge>{detail.tasks.length}</StudioStatusBadge>}
        contentClassName="dezin-generation-plan__tasks-content"
      >
        <ol className="dezin-generation-plan__tasks" aria-label="Generation tasks">
          {detail.tasks.map((task, index) => {
            const label = taskLabel(task.kind);
            const selectionDestinations = directionSelections[index]!;
            const awaitingDirectionSelection = selectionDestinations.length > 0;
            const state = awaitingDirectionSelection ? "active" : displayState(task.status);
            const message = taskMessage(task, tasksById, targetLabels);
            const artifactDestination = artifactRevisionDestination(projectId, task, detail);
            const target = targetLabel(task, targetLabels);
            const progress = task.status === "running" ? latestTaskProgress(events, task) : null;
            return (
              <li
                key={task.id}
                className="dezin-generation-plan__task"
                data-state={state}
              >
                <div
                  className="dezin-generation-plan__task-toggle"
                >
                  <span className="dezin-generation-plan__task-marker" data-state={state} aria-hidden />
                  <span className="dezin-generation-plan__task-body">
                    <span className="dezin-generation-plan__task-topline">
                      <span className="dezin-generation-plan__task-kind">{label}</span>
                      <StudioStatusBadge
                        className="dezin-generation-plan__task-status"
                        tone={statusTone(state)}
                      >
                        {awaitingDirectionSelection
                          ? "Choose direction"
                          : progress === null
                            ? statusLabel(task.status)
                            : TASK_PROGRESS_COPY[progress]}
                      </StudioStatusBadge>
                      <strong title={target}>{target}</strong>
                    </span>
                    <span className="dezin-generation-plan__task-meta">{dependencyLabel(task)}</span>
                    {message ? <span className="dezin-generation-plan__task-message">{message}</span> : null}
                    <span className="dezin-generation-plan__task-output">
                      Output · {currentTaskOutput(task, progress)}
                    </span>
                  </span>
                </div>
                <div className="dezin-generation-plan__task-actions">
                  {renderCanvasFocus(task, targetLabels, onFocusTask)}
                  {artifactDestination ? renderDestinationLink(artifactDestination) : null}
                  {selectionDestinations.map((destination) => (
                    renderDestinationLink(destination, destination.key)
                  ))}
                  {retryable && canRetry(task) && !awaitingDirectionSelection ? (
                    <div
                      className="dezin-generation-plan__retry-actions"
                      role="group"
                      aria-label={`${label} retry options`}
                    >
                      {task.currentAttempt > 0 ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={busyAction !== null}
                          aria-label={`Retry ${label} with the same context`}
                          onClick={() => void onRetry(task.id, "same-context")}
                        >
                          <RotateCcw aria-hidden />
                          Same input
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busyAction !== null}
                        aria-label={`Retry ${label} with refreshed context`}
                        onClick={() => void onRetry(task.id, "latest-context")}
                      >
                        <RefreshCw aria-hidden />
                        Refresh context
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </StudioInspectorSection>

      <footer className="dezin-generation-plan__footer">
        {canCancel(detail.plan) ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="dezin-generation-plan__cancel"
            disabled={busyAction !== null}
            aria-label="Cancel generation plan"
            onClick={() => void onCancel()}
          >
            Stop
          </Button>
        ) : (
          <span className="dezin-generation-plan__settled">
            <Check aria-hidden />
            Settled
          </span>
        )}
      </footer>
    </section>
  );
}

type InspectorLoadState = "loading" | "ready" | "empty" | "error";

const EMPTY_PLAN_HEADERS: Record<InspectorLoadState, readonly [string, DisplayState]> = {
  loading: ["Loading", "active"],
  ready: ["Ready", "idle"],
  empty: ["No plan", "idle"],
  error: ["Unavailable", "failure"],
};

function renderGenerationPlanHeader(
  plan: GenerationPlan | null,
  state: InspectorLoadState,
  onClose?: () => void,
) {
  const emptyHeader = EMPTY_PLAN_HEADERS[state];
  const planStatus = plan === null ? emptyHeader[0] : statusLabel(plan.status, true);
  const planState = plan === null ? emptyHeader[1] : displayState(plan.status);
  return (
    <StudioPanelHeader className="dezin-generation-plan__header gap-3 px-3">
      <StudioHeaderIdentity className="min-w-0 flex-1">
        <StudioHeaderCopy
          title="Build plan"
          subtitle="Generation progress"
          titleId="generation-plan-title"
          headingLevel={2}
        />
      </StudioHeaderIdentity>
      <StudioHeaderActions>
        <StudioStatusBadge
          className="dezin-generation-plan__plan-state"
          data-state={planState}
          tone={statusTone(planState)}
          aria-label={plan === null ? `Build plan state: ${planStatus}` : `Plan status: ${planStatus}`}
        >
          <i aria-hidden />
          <span>{planStatus}</span>
        </StudioStatusBadge>
        {renderPlanCloseButton(onClose)}
      </StudioHeaderActions>
    </StudioPanelHeader>
  );
}

function preferredPlan(plans: readonly GenerationPlan[], preferredPlanId: string | null): GenerationPlan | null {
  if (preferredPlanId !== null) {
    const preferred = plans.find((plan) => plan.id === preferredPlanId);
    if (preferred !== undefined) return preferred;
  }
  const active = plans.find((plan) => !TERMINAL_PLAN_STATUSES.has(plan.status));
  return active ?? plans[0] ?? null;
}

function generationPlanEventSequence(detail: GenerationPlanDetail): number {
  let latest = 0;
  for (const event of detail.events ?? []) {
    if (Number.isSafeInteger(event.sequence) && event.sequence > latest) latest = event.sequence;
  }
  return latest;
}

function generationPlanExecutionEpoch(detail: GenerationPlanDetail): number {
  const epoch = detail.plan.executionEpoch ?? 0;
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
}

/**
 * Parent polling and the Inspector stream are independent readers of the same
 * durable Plan. Accept a parent snapshot only when its durable clock advances;
 * a delayed poll must never roll a newer retry/cancel/stream result backward.
 */
function authoritativeDetailAdvances(
  current: GenerationPlanDetail,
  next: GenerationPlanDetail,
): boolean {
  if (current.plan.id !== next.plan.id) return false;
  const currentEpoch = generationPlanExecutionEpoch(current);
  const nextEpoch = generationPlanExecutionEpoch(next);
  if (nextEpoch !== currentEpoch) return nextEpoch > currentEpoch;
  const currentSequence = generationPlanEventSequence(current);
  const nextSequence = generationPlanEventSequence(next);
  if (nextSequence !== currentSequence) return nextSequence > currentSequence;

  const nextTaskById = new Map(next.tasks.map((task) => [task.id, task]));
  let attemptAdvanced = false;
  for (const task of current.tasks) {
    const nextTask = nextTaskById.get(task.id);
    if (nextTask === undefined || nextTask.currentAttempt < task.currentAttempt) return false;
    if (nextTask.currentAttempt > task.currentAttempt) attemptAdvanced = true;
  }
  if (attemptAdvanced) return true;

  const currentTerminal = immutablePlan(current.plan);
  const nextTerminal = immutablePlan(next.plan);
  if (currentTerminal !== nextTerminal) return nextTerminal;
  if (current.plan.status === next.plan.status) return false;
  const activeStatuses: GenerationPlan["status"][] = ["approved", "queued", "running"];
  const currentRank = activeStatuses.indexOf(current.plan.status);
  return currentRank >= 0 && activeStatuses.indexOf(next.plan.status) > currentRank;
}

export function GenerationPlanInspector({
  projectId,
  preferredPlanId,
  authoritativeDetail,
  targetLabels,
  onDetailChange,
  onWorkspaceChanged,
  onFocusTask,
  onClose,
}: {
  projectId: string;
  preferredPlanId: string | null;
  authoritativeDetail?: GenerationPlanDetail | null;
  targetLabels?: GenerationPlanTargetLabels;
  onDetailChange?: (change: GenerationPlanDetailChange) => void;
  onWorkspaceChanged?: () => void;
  onFocusTask?: (task: GenerationTask) => void;
  onClose?: () => void;
}) {
  const api = useApi();
  const [loadState, setLoadState] = useState<InspectorLoadState>("loading");
  const [plans, setPlans] = useState<GenerationPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(preferredPlanId);
  const [detail, setDetail] = useState<GenerationPlanDetail | null>(null);
  const [connection, setConnection] = useState<GenerationPlanConnection>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const selectionEpoch = useRef(0);
  const detailMutationEpoch = useRef(0);
  const actionLock = useRef(false);
  const workspaceResultKey = useRef("");

  const commitDetail = useCallback((
    next: GenerationPlanDetail,
    source: GenerationPlanDetailChangeSource,
  ) => {
    setDetail(next);
    setPlans((current) => current.map((plan) => plan.id === next.plan.id ? next.plan : plan));
    if (immutablePlan(next.plan)) setConnection("settled");
    onDetailChange?.({ detail: next, source });
    const resultKey = generationPlanResultKey(next);
    const scopedResultKey = resultKey === null ? null : `${projectId}:${resultKey}`;
    if (scopedResultKey !== workspaceResultKey.current) {
      workspaceResultKey.current = scopedResultKey ?? "";
      if (resultKey !== null) onWorkspaceChanged?.();
    }
  }, [onDetailChange, onWorkspaceChanged, projectId]);

  const refresh = useCallback(async (
    planId: string,
    epoch: number,
    source: GenerationPlanDetailChangeSource,
  ): Promise<GenerationPlanDetail | null> => {
    if (actionLock.current) return null;
    const mutationEpoch = detailMutationEpoch.current;
    const next = await api.getGenerationPlan(projectId, planId);
    if (next.plan.id !== planId) throw new Error("Generation Plan identity mismatch");
    if (epoch !== selectionEpoch.current
      || mutationEpoch !== detailMutationEpoch.current
      || actionLock.current) return null;
    commitDetail(next, source);
    return next;
  }, [api, commitDetail, projectId]);

  useEffect(() => {
    const epoch = ++selectionEpoch.current;
    actionLock.current = false;
    setBusyAction(null);
    setLoadState("loading");
    setPlans([]);
    setMessage(null);
    void api.listGenerationPlans(projectId)
      .then(async (nextPlans) => {
        if (epoch !== selectionEpoch.current) return;
        const sorted = [...nextPlans].sort((left, right) =>
          right.createdAt - left.createdAt || right.id.localeCompare(left.id));
        const selected = preferredPlan(sorted, preferredPlanId);
        setPlans(sorted);
        if (selected === null) {
          setSelectedPlanId(null);
          setDetail(null);
          setConnection("settled");
          setLoadState("empty");
          return;
        }
        setSelectedPlanId(selected.id);
        const next = await api.getGenerationPlan(projectId, selected.id);
        if (epoch !== selectionEpoch.current) return;
        if (next.plan.id !== selected.id) throw new Error("Generation Plan identity mismatch");
        commitDetail(next, "load");
        setConnection(immutablePlan(next.plan) ? "settled" : "connecting");
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (epoch !== selectionEpoch.current) return;
        setMessage(error instanceof Error ? error.message : "Generation Plans could not be loaded.");
        setLoadState("error");
      });
    return () => {
      if (epoch === selectionEpoch.current) selectionEpoch.current += 1;
    };
  }, [api, commitDetail, loadEpoch, preferredPlanId, projectId]);

  const streamPlanId = loadState === "ready" && selectedPlanId !== null
    && detail?.plan.id === selectedPlanId
    && !immutablePlan(detail.plan)
    ? selectedPlanId
    : null;
  useEffect(() => {
    if (streamPlanId === null) return;
    const controller = new AbortController();
    const epoch = selectionEpoch.current;
    let cursor = 0;
    const ownsSelection = (): boolean => (
      !controller.signal.aborted && epoch === selectionEpoch.current
    );
    const run = async (): Promise<void> => {
      let delay = 250;
      while (ownsSelection()) {
        try {
          setConnection(cursor === 0 ? "connecting" : "live");
          const events: AsyncIterator<GenerationPlanEvent> = api.streamGenerationPlanEvents(
            projectId,
            streamPlanId,
            controller.signal,
            { after: cursor },
          )[Symbol.asyncIterator]();
          let pending: Promise<IteratorResult<GenerationPlanEvent>> = events.next();
          try {
            while (ownsSelection()) {
              let item: IteratorResult<GenerationPlanEvent> = await pending;
              if (item.done) break;
              let observedCursor = cursor;
              const batchBoundary = new Promise<undefined>((resolve) => setTimeout(resolve, 25));
              do {
                const event: GenerationPlanEvent = item.value;
                if (event.planId === streamPlanId && Number.isSafeInteger(event.sequence)
                  && event.sequence > observedCursor) {
                  observedCursor = event.sequence;
                  setConnection("live");
                }
                pending = events.next();
                const batched: IteratorResult<GenerationPlanEvent> | undefined = await Promise.race([
                  pending,
                  batchBoundary,
                ]);
                if (batched === undefined) break;
                item = batched;
              } while (!item.done && ownsSelection());
              if (observedCursor > cursor) {
                const next = await refresh(streamPlanId, epoch, "observation");
                if (next === null || !ownsSelection()) break;
                cursor = observedCursor;
                delay = 250;
                if (immutablePlan(next.plan)) {
                  setConnection("settled");
                  controller.abort();
                  break;
                }
              }
              if (item.done) break;
            }
          } finally {
            try {
              await events.return?.();
            } catch {
              // Preserve the authoritative stream/refresh outcome.
            }
          }
          if (ownsSelection()) throw new Error();
        } catch (error: unknown) {
          if (!ownsSelection()) break;
          if (error instanceof GenerationPlanStreamError) {
            setConnection("error");
            setMessage(error.message);
            break;
          }
          setConnection("offline");
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 4, 4_000);
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [api, projectId, refresh, streamPlanId]);

  const selectPlan = useCallback((planId: string) => {
    const previousPlanId = selectedPlanId;
    const previousDetail = detail;
    const epoch = ++selectionEpoch.current;
    actionLock.current = false;
    setBusyAction(null);
    setSelectedPlanId(planId);
    setLoadState("loading");
    setConnection("connecting");
    setMessage(null);
    void refresh(planId, epoch, "load")
      .then((next) => {
        if (next !== null) setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (epoch !== selectionEpoch.current) return;
        setMessage(error instanceof Error ? error.message : "The Generation Plan could not be loaded.");
        if (previousPlanId !== null && previousDetail?.plan.id === previousPlanId) {
          setSelectedPlanId(previousPlanId);
          setDetail(previousDetail);
          setConnection(immutablePlan(previousDetail.plan) ? "settled" : "connecting");
          setLoadState("ready");
        } else {
          setLoadState("error");
        }
      });
  }, [detail, refresh, selectedPlanId]);

  useEffect(() => {
    if (loadState !== "ready"
      || !authoritativeDetail
      || authoritativeDetail.plan.id !== selectedPlanId
      || detail?.plan.id !== selectedPlanId
      || authoritativeDetail === detail
      || actionLock.current
      || !authoritativeDetailAdvances(detail, authoritativeDetail)) return;
    commitDetail(authoritativeDetail, "observation");
    if (immutablePlan(authoritativeDetail.plan)) setMessage(null);
  }, [authoritativeDetail, busyAction, commitDetail, detail, loadState, selectedPlanId]);

  const runAction = useCallback(async (
    source: Extract<GenerationPlanDetailChangeSource, "retry" | "cancel">,
    taskId?: string,
    mode?: GenerationTaskRetryMode,
  ) => {
    if (selectedPlanId === null || actionLock.current) return;
    const planId = selectedPlanId;
    const epoch = selectionEpoch.current;
    const mutationEpoch = ++detailMutationEpoch.current;
    actionLock.current = true;
    setBusyAction(source === "retry" ? `${taskId}:${mode}` : source);
    setMessage(null);
    try {
      const next = source === "retry"
        ? await api.retryGenerationTask(projectId, planId, taskId!, mode!)
        : await api.cancelGenerationPlan(projectId, planId);
      if (epoch !== selectionEpoch.current
        || mutationEpoch !== detailMutationEpoch.current
        || next.plan.id !== planId) return;
      commitDetail(next, source);
      if (source === "retry") setConnection("connecting");
    } catch (error) {
      if (epoch === selectionEpoch.current) {
        setMessage(error instanceof Error
          ? error.message
          : source === "retry"
            ? "The task could not be retried."
            : "The Generation Plan could not be stopped.");
      }
    } finally {
      if (epoch === selectionEpoch.current) {
        actionLock.current = false;
        setBusyAction(null);
      }
    }
  }, [api, commitDetail, projectId, selectedPlanId]);

  const retry = useCallback(
    (taskId: string, mode: GenerationTaskRetryMode) => runAction("retry", taskId, mode),
    [runAction],
  );

  const cancel = useCallback(() => runAction("cancel"), [runAction]);

  const readyDetail = loadState === "ready"
    && selectedPlanId !== null
    && detail?.plan.id === selectedPlanId
    ? detail
    : null;
  const renderedState: InspectorLoadState = loadState === "ready" && readyDetail === null
    ? "error"
    : loadState;
  return (
    <section className="dezin-generation-plan__container" aria-labelledby="generation-plan-title">
      {renderGenerationPlanHeader(
        renderedState === "ready" ? readyDetail?.plan ?? null : null,
        renderedState,
        onClose,
      )}
      <div className="dezin-generation-plan__body">
        {renderedState !== "ready" || readyDetail === null ? (
          <div className="dezin-generation-plan dezin-generation-plan--placeholder">
            {renderedState === "loading" ? (
              <>
                <LoaderCircle className="dezin-generation-plan__placeholder-icon motion-safe:animate-spin" aria-hidden />
                <p role="status">Loading build plan…</p>
              </>
            ) : renderedState === "empty" ? (
              <>
                <h2>No build plan yet</h2>
                <p>Approved generation work will appear here as a durable task sequence.</p>
              </>
            ) : (
              <>
                <h2>Build plan unavailable</h2>
                <p role="alert">{message ?? "The Generation Plan could not be loaded."}</p>
                {plans.length > 1 ? renderPlanHistorySelect(plans, selectedPlanId ?? "", selectPlan) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => plans.length === 0
                    ? setLoadEpoch((epoch) => epoch + 1)
                    : selectedPlanId && selectPlan(selectedPlanId)}
                  aria-label="Retry loading build plan"
                >
                  <RefreshCw aria-hidden />
                  Try again
                </Button>
              </>
            )}
          </div>
        ) : (
          <GenerationPlanPanel
            projectId={projectId}
            plans={plans}
            detail={readyDetail}
            connection={connection}
            busyAction={busyAction}
            targetLabels={targetLabels}
            onSelectPlan={selectPlan}
            onRetry={retry}
            onCancel={cancel}
            onFocusTask={onFocusTask}
            showHeader={false}
          />
        )}
        {renderedState === "ready" && message ? (
          <>
            <p className="dezin-generation-plan__action-error" role="alert">{message}</p>
            {connection === "error" && selectedPlanId !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => selectPlan(selectedPlanId)}
                aria-label="Reconnect build plan updates"
              >
                <RefreshCw aria-hidden />
                Reconnect
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
