import "./generation-plan.css";

import {
  Check,
  ExternalLink,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StudioHeaderActions,
  StudioHeaderCopy,
  StudioHeaderIdentity,
  StudioInspectorSection,
  StudioPanelHeader,
  StudioStatusBadge,
} from "../../components/ui/index.ts";
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
import { generationPlanResultKey } from "./generation-target-state.ts";

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

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
): "idle" | "active" | "success" | "failure" | "cancelled" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "blocked" || status === "blocked-context"
    || status === "compile-failed" || status === "requires-new-impact") return "failure";
  if (status === "cancelled") return "cancelled";
  if (status === "running" || status === "retry-wait" || status === "candidate-ready" || status === "needs-rebase"
    || status === "awaiting-context-refresh" || status === "cancel-requested") return "active";
  return "idle";
}

function statusTone(
  state: ReturnType<typeof displayState>,
): "neutral" | "active" | "success" | "danger" {
  if (state === "success") return "success";
  if (state === "failure") return "danger";
  if (state === "active") return "active";
  return "neutral";
}

interface ResearchSelectionDestination {
  resourceId: string;
  revisionId: string;
  href: string;
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
      resourceId,
      revisionId,
      href: `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/revisions/${encodeURIComponent(revisionId)}`,
    }];
  });
}

function taskDisplayState(projectId: string, task: GenerationTask): ReturnType<typeof displayState> {
  return researchSelectionDestinations(projectId, task).length > 0 ? "active" : displayState(task.status);
}

function targetLabel(
  task: GenerationTask,
  targetLabels?: GenerationPlanTargetLabels,
): string {
  if (task.target.type === "workspace") return "Workspace";
  const ownedLabel = task.target.type === "artifact"
    ? targetLabels?.artifacts.get(task.target.id)
    : targetLabels?.resources.get(task.target.id);
  if (typeof ownedLabel === "string" && ownedLabel.trim().length > 0) return ownedLabel.trim();
  const plain = task.target.id
    .replace(/^artifact-/, "")
    .replace(/^resource-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return plain.length > 0 ? plain.replace(/\b\w/g, (character) => character.toUpperCase()) : task.target.id;
}

const LOCAL_FAILURE_PATH =
  /\/(?:Users|home|private|tmp|var|opt|usr|Applications|Volumes)(?:\/[^\s/]+)+/g;

function publicFailureMessage(value: string): string {
  return value.replace(LOCAL_FAILURE_PATH, (path) => {
    const name = path.split("/").at(-1)?.replace(/[),.;:'"]+$/g, "") ?? "";
    return /^[a-zA-Z0-9._-]{1,80}$/.test(name) ? name : "local path";
  });
}

function taskMessage(task: GenerationTask): string | null {
  const message = task.error?.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return publicFailureMessage(message.trim());
  }
  return task.blockedReason;
}

function planMessage(plan: GenerationPlan): string | null {
  if (plan.compileError === null) return null;
  const message = plan.compileError.message;
  return typeof message === "string" && message.trim().length > 0
    ? publicFailureMessage(message.trim())
    : "The approved proposal could not be compiled.";
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

function retryablePlan(plan: GenerationPlan): boolean {
  return plan.status === "failed" || plan.status === "queued" || plan.status === "running";
}

function immutablePlan(plan: GenerationPlan): boolean {
  return plan.status !== "failed" && TERMINAL_PLAN_STATUSES.has(plan.status);
}

function canCancel(plan: GenerationPlan): boolean {
  return plan.status === "approved" || plan.status === "queued" || plan.status === "running";
}

function shortPlanLabel(plan: GenerationPlan, index: number): string {
  const suffix = plan.id.length > 8 ? plan.id.slice(-6) : plan.id;
  return `Plan ${index + 1} · ${suffix}`;
}

function PlanCloseButton({ onClose }: { onClose?: () => void }) {
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

function PlanHistorySelect({
  plans,
  value,
  onChange,
}: {
  plans: readonly GenerationPlan[];
  value: string;
  onChange: (planId: string) => void;
}) {
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
            <SelectItem key={plan.id} value={plan.id}>{shortPlanLabel(plan, index)}</SelectItem>
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
    ? `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(task.target.id)}/candidates/${encodeURIComponent(detail.plan.id)}/${encodeURIComponent(task.id)}/${task.currentAttempt}`
    : `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(task.target.id)}/revisions/${encodeURIComponent(revisionId)}`;
  const kind = taskLabel(task.kind);
  return action === "candidate"
    ? { href, ariaLabel: `Review ${kind} candidate`, label: "Review candidate", evidenceHash }
    : { href, ariaLabel: `Open published ${kind} revision`, label: "Open published revision", evidenceHash };
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
  onClose?: () => void;
  showHeader?: boolean;
}) {
  const complete = detail.tasks.filter((task) => task.status === "succeeded").length;
  const failureMessage = planMessage(detail.plan);
  const connectionLabel = connection === "live"
    ? "Live updates"
    : connection === "connecting"
      ? "Connecting"
      : connection === "offline"
        ? "Reconnecting"
        : connection === "error"
          ? "Updates unavailable"
        : "Durable snapshot";

  return (
    <section
      className="dezin-generation-plan"
      aria-labelledby={showHeader ? "generation-plan-title" : undefined}
      aria-label={showHeader ? undefined : "Generation Plan details"}
    >
      {showHeader ? (
        <GenerationPlanHeader plan={detail.plan} state="ready" onClose={onClose} />
      ) : null}

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
          <span data-connection={connection}>{connectionLabel}</span>
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
          {detail.tasks.map((task) => (
            <i key={task.id} data-state={taskDisplayState(projectId, task)} aria-hidden />
          ))}
        </div>
        {failureMessage ? (
          <p className="dezin-generation-plan__plan-message" role="alert">{failureMessage}</p>
        ) : null}
        {plans.length > 1 ? (
          <PlanHistorySelect plans={plans} value={detail.plan.id} onChange={onSelectPlan} />
        ) : null}
      </StudioInspectorSection>

      <StudioInspectorSection
        className="dezin-generation-plan__tasks-section"
        heading="Tasks"
        actions={<StudioStatusBadge>{detail.tasks.length}</StudioStatusBadge>}
        contentClassName="dezin-generation-plan__tasks-content"
      >
        <ol className="dezin-generation-plan__tasks" aria-label="Generation tasks">
          {detail.tasks.map((task) => {
            const label = taskLabel(task.kind);
            const selectionDestinations = researchSelectionDestinations(projectId, task);
            const awaitingDirectionSelection = selectionDestinations.length > 0;
            const state = awaitingDirectionSelection ? "active" : displayState(task.status);
            const message = taskMessage(task);
            const artifactDestination = artifactRevisionDestination(projectId, task, detail);
            const target = targetLabel(task, targetLabels);
            return (
              <li key={task.id} className="dezin-generation-plan__task" data-state={state}>
                <span className="dezin-generation-plan__task-marker" data-state={state} aria-hidden />
                <div className="dezin-generation-plan__task-body">
                  <div className="dezin-generation-plan__task-topline">
                    <span className="dezin-generation-plan__task-kind">{label}</span>
                    <StudioStatusBadge
                      className="dezin-generation-plan__task-status"
                      tone={statusTone(state)}
                    >
                      {awaitingDirectionSelection ? "Choose direction" : statusLabel(task.status)}
                    </StudioStatusBadge>
                    <strong title={target}>{target}</strong>
                  </div>
                  <p className="dezin-generation-plan__task-meta">{dependencyLabel(task)}</p>
                  {message ? <p className="dezin-generation-plan__task-message">{message}</p> : null}
                  {artifactDestination ? (
                    <a
                      className="dezin-generation-plan__artifact-link"
                      href={artifactDestination.href}
                      aria-label={artifactDestination.ariaLabel}
                      title={artifactDestination.evidenceHash === null
                        ? undefined
                        : `Candidate evidence ${artifactDestination.evidenceHash}`}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(artifactDestination.href);
                      }}
                    >
                      <span>{artifactDestination.label}</span>
                      <ExternalLink aria-hidden />
                    </a>
                  ) : null}
                  {selectionDestinations.map((destination) => (
                    <a
                      key={`${destination.resourceId}:${destination.revisionId}`}
                      className="dezin-generation-plan__artifact-link"
                      href={destination.href}
                      aria-label={`Review Research directions from Revision ${destination.revisionId}`}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(destination.href);
                      }}
                    >
                      <span>Review Research directions</span>
                      <ExternalLink aria-hidden />
                    </a>
                  ))}
                  {retryablePlan(detail.plan) && canRetry(task) && !awaitingDirectionSelection ? (
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
            <Square aria-hidden />
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

function GenerationPlanHeader({
  plan,
  state,
  onClose,
}: {
  plan: GenerationPlan | null;
  state: InspectorLoadState;
  onClose?: () => void;
}) {
  const planStatus = plan === null
    ? state === "loading"
      ? "Loading"
      : state === "empty"
        ? "No plan"
        : state === "error"
          ? "Unavailable"
          : "Ready"
    : statusLabel(plan.status, true);
  const planState: ReturnType<typeof displayState> = plan === null
    ? state === "loading"
      ? "active"
      : state === "error"
        ? "failure"
        : "idle"
    : displayState(plan.status);
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
        <PlanCloseButton onClose={onClose} />
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

export function GenerationPlanInspector({
  projectId,
  preferredPlanId,
  targetLabels,
  onDetailChange,
  onWorkspaceChanged,
  onClose,
}: {
  projectId: string;
  preferredPlanId: string | null;
  targetLabels?: GenerationPlanTargetLabels;
  onDetailChange?: (change: GenerationPlanDetailChange) => void;
  onWorkspaceChanged?: () => void;
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
  }, [api, commitDetail, preferredPlanId, projectId]);

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

  const retry = useCallback(async (taskId: string, mode: GenerationTaskRetryMode) => {
    if (selectedPlanId === null || actionLock.current) return;
    const planId = selectedPlanId;
    const epoch = selectionEpoch.current;
    const mutationEpoch = ++detailMutationEpoch.current;
    const key = `${taskId}:${mode}`;
    actionLock.current = true;
    setBusyAction(key);
    setMessage(null);
    try {
      const next = await api.retryGenerationTask(projectId, planId, taskId, mode);
      if (epoch !== selectionEpoch.current
        || mutationEpoch !== detailMutationEpoch.current
        || next.plan.id !== planId) return;
      commitDetail(next, "retry");
      setConnection("connecting");
    } catch (error) {
      if (epoch === selectionEpoch.current) {
        setMessage(error instanceof Error ? error.message : "The task could not be retried.");
      }
    } finally {
      if (epoch === selectionEpoch.current) {
        actionLock.current = false;
        setBusyAction(null);
      }
    }
  }, [api, commitDetail, projectId, selectedPlanId]);

  const cancel = useCallback(async () => {
    if (selectedPlanId === null || actionLock.current) return;
    const planId = selectedPlanId;
    const epoch = selectionEpoch.current;
    const mutationEpoch = ++detailMutationEpoch.current;
    actionLock.current = true;
    setBusyAction("cancel");
    setMessage(null);
    try {
      const next = await api.cancelGenerationPlan(projectId, planId);
      if (epoch !== selectionEpoch.current
        || mutationEpoch !== detailMutationEpoch.current
        || next.plan.id !== planId) return;
      commitDetail(next, "cancel");
    } catch (error) {
      if (epoch === selectionEpoch.current) {
        setMessage(error instanceof Error ? error.message : "The Generation Plan could not be stopped.");
      }
    } finally {
      if (epoch === selectionEpoch.current) {
        actionLock.current = false;
        setBusyAction(null);
      }
    }
  }, [api, commitDetail, projectId, selectedPlanId]);

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
      <GenerationPlanHeader
        plan={renderedState === "ready" ? readyDetail?.plan ?? null : null}
        state={renderedState}
        onClose={onClose}
      />
      <div className="dezin-generation-plan__body">
        {renderedState === "loading" ? (
          <div className="dezin-generation-plan dezin-generation-plan--placeholder">
            <LoaderCircle className="dezin-generation-plan__placeholder-icon motion-safe:animate-spin" aria-hidden />
            <p role="status">Loading build plan…</p>
          </div>
        ) : renderedState === "empty" ? (
          <div className="dezin-generation-plan dezin-generation-plan--placeholder">
            <ListChecks className="dezin-generation-plan__placeholder-icon" aria-hidden />
            <h2>No build plan yet</h2>
            <p>Approved generation work will appear here as a durable task sequence.</p>
          </div>
        ) : renderedState === "error" || readyDetail === null ? (
          <div className="dezin-generation-plan dezin-generation-plan--placeholder">
            <TriangleAlert className="dezin-generation-plan__placeholder-icon" aria-hidden />
            <h2>Build plan unavailable</h2>
            <p role="alert">{message ?? "The Generation Plan could not be loaded."}</p>
            {plans.length > 1 ? (
              <PlanHistorySelect plans={plans} value={selectedPlanId ?? ""} onChange={selectPlan} />
            ) : null}
            {selectedPlanId !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => selectPlan(selectedPlanId)}
                aria-label="Retry loading build plan"
              >
                <RefreshCw aria-hidden />
                Try again
              </Button>
            ) : null}
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
            showHeader={false}
          />
        )}
        {renderedState === "ready" && message ? (
          <p className="dezin-generation-plan__action-error" role="alert">{message}</p>
        ) : null}
      </div>
    </section>
  );
}
