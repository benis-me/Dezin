import "./generation-plan.css";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

export type GenerationPlanConnection = "connecting" | "live" | "offline" | "error" | "settled";

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
  if (status === "running" || status === "candidate-ready" || status === "needs-rebase"
    || status === "awaiting-context-refresh" || status === "cancel-requested") return "active";
  return "idle";
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

function targetLabel(task: GenerationTask): string {
  if (task.target.type === "workspace") return "Workspace";
  const plain = task.target.id
    .replace(/^artifact-/, "")
    .replace(/^resource-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return plain.length > 0 ? plain.replace(/\b\w/g, (character) => character.toUpperCase()) : task.target.id;
}

function taskMessage(task: GenerationTask): string | null {
  const message = task.error?.message;
  if (typeof message === "string" && message.trim().length > 0) return message.trim();
  return task.blockedReason;
}

function planMessage(plan: GenerationPlan): string | null {
  if (plan.compileError === null) return null;
  const message = plan.compileError.message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
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
    <button type="button" className="dezin-generation-plan__close" aria-label="Close build plan" onClick={onClose}>
      <X size={12} aria-hidden />
    </button>
  ) : null;
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
  onSelectPlan,
  onRetry,
  onCancel,
  onClose,
}: {
  projectId: string;
  plans: readonly GenerationPlan[];
  detail: GenerationPlanDetail;
  connection: GenerationPlanConnection;
  busyAction: string | null;
  onSelectPlan: (planId: string) => void;
  onRetry: (taskId: string, mode: GenerationTaskRetryMode) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onClose?: () => void;
}) {
  const complete = detail.tasks.filter((task) => task.status === "succeeded").length;
  const planStatus = statusLabel(detail.plan.status, true);
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
    <section className="dezin-generation-plan" aria-labelledby="generation-plan-title">
      <header className="dezin-generation-plan__header">
        <div className="dezin-generation-plan__heading">
          <span>Generation</span>
          <h2 id="generation-plan-title">Build plan</h2>
        </div>
        <div className="dezin-generation-plan__header-actions">
          <div
            className="dezin-generation-plan__plan-state"
            data-state={displayState(detail.plan.status)}
            aria-label={`Plan status: ${planStatus}`}
          >
            <i aria-hidden />
            <span>{planStatus}</span>
          </div>
          <PlanCloseButton onClose={onClose} />
        </div>
      </header>

      <div className="dezin-generation-plan__overview">
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
          <label className="dezin-generation-plan__selector">
            <span>History</span>
            <select
              aria-label="Selected generation plan"
              value={detail.plan.id}
              onChange={(event) => onSelectPlan(event.target.value)}
            >
              {plans.map((plan, index) => (
                <option key={plan.id} value={plan.id}>{shortPlanLabel(plan, index)}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <ol className="dezin-generation-plan__tasks" aria-label="Generation tasks">
        {detail.tasks.map((task) => {
          const label = taskLabel(task.kind);
          const selectionDestinations = researchSelectionDestinations(projectId, task);
          const awaitingDirectionSelection = selectionDestinations.length > 0;
          const state = awaitingDirectionSelection ? "active" : displayState(task.status);
          const message = taskMessage(task);
          const artifactDestination = artifactRevisionDestination(projectId, task, detail);
          return (
            <li key={task.id} className="dezin-generation-plan__task" data-state={state}>
              <span className="dezin-generation-plan__task-marker" data-state={state} aria-hidden />
              <div className="dezin-generation-plan__task-body">
                <div className="dezin-generation-plan__task-topline">
                  <div>
                    <span>{label}</span>
                    <strong>{targetLabel(task)}</strong>
                  </div>
                  <span className="dezin-generation-plan__task-status">
                    {awaitingDirectionSelection ? "Awaiting direction selection" : statusLabel(task.status)}
                  </span>
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
                    <span aria-hidden>↗</span>
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
                    <span aria-hidden>↗</span>
                  </a>
                ))}
                {retryablePlan(detail.plan) && canRetry(task) && !awaitingDirectionSelection ? (
                  <div className="dezin-generation-plan__retry-actions" aria-label={`${label} retry options`}>
                    {task.currentAttempt > 0 ? (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        aria-label={`Retry ${label} with the same context`}
                        onClick={() => void onRetry(task.id, "same-context")}
                      >
                        <span aria-hidden>↻</span>
                        Same input
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      aria-label={`Retry ${label} with refreshed context`}
                      onClick={() => void onRetry(task.id, "latest-context")}
                    >
                      Refresh context
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="dezin-generation-plan__footer">
        <span className="dezin-generation-plan__identity" title={detail.plan.id}>
          {detail.plan.id.slice(-12)}
        </span>
        {canCancel(detail.plan) ? (
          <button
            type="button"
            className="dezin-generation-plan__cancel"
            disabled={busyAction !== null}
            aria-label="Cancel generation plan"
            onClick={() => void onCancel()}
          >
            <span aria-hidden>×</span>
            Stop
          </button>
        ) : (
          <span className="dezin-generation-plan__settled">
            <span aria-hidden>■</span>
            Settled
          </span>
        )}
      </footer>
    </section>
  );
}

type InspectorLoadState = "loading" | "ready" | "empty" | "error";

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
  onWorkspaceChanged,
  onClose,
}: {
  projectId: string;
  preferredPlanId: string | null;
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

  const commitDetail = useCallback((next: GenerationPlanDetail) => {
    setDetail(next);
    setPlans((current) => current.map((plan) => plan.id === next.plan.id ? next.plan : plan));
    if (immutablePlan(next.plan)) setConnection("settled");
    const results = next.tasks.flatMap((task) => {
      const identities = [task.resultRevisionId, task.resultResourceRevisionId, task.resultSnapshotId];
      return identities.some((value) => value !== null) ? [`${task.id}:${identities.join(":")}`] : [];
    });
    const resultKey = `${projectId}:${next.plan.id}:${results.join("|")}`;
    if (resultKey !== workspaceResultKey.current) {
      workspaceResultKey.current = resultKey;
      if (results.length > 0) onWorkspaceChanged?.();
    }
  }, [onWorkspaceChanged, projectId]);

  const refresh = useCallback(async (
    planId: string,
    epoch: number,
  ): Promise<GenerationPlanDetail | null> => {
    if (actionLock.current) return null;
    const mutationEpoch = detailMutationEpoch.current;
    const next = await api.getGenerationPlan(projectId, planId);
    if (next.plan.id !== planId) throw new Error("Generation Plan identity mismatch");
    if (epoch !== selectionEpoch.current
      || mutationEpoch !== detailMutationEpoch.current
      || actionLock.current) return null;
    commitDetail(next);
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
        if (epoch !== selectionEpoch.current || next.plan.id !== selected.id) return;
        commitDetail(next);
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
                const next = await refresh(streamPlanId, epoch);
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
    setDetail(null);
    setLoadState("loading");
    setConnection("connecting");
    setMessage(null);
    void refresh(planId, epoch)
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
      commitDetail(next);
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
      commitDetail(next);
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

  if (loadState === "loading") {
    return (
      <section className="dezin-generation-plan dezin-generation-plan--placeholder" aria-label="Generation Plan">
        <PlanCloseButton onClose={onClose} />
        <div className="dezin-generation-plan__placeholder-lines" aria-hidden><i /><i /><i /></div>
        <p role="status">Loading build plan…</p>
      </section>
    );
  }
  if (loadState === "empty") {
    return (
      <section className="dezin-generation-plan dezin-generation-plan--placeholder" aria-labelledby="empty-generation-plan-title">
        <PlanCloseButton onClose={onClose} />
        <div className="dezin-generation-plan__empty-mark" aria-hidden><i /><i /><i /></div>
        <h2 id="empty-generation-plan-title">No build plan yet</h2>
        <p>Approved generation work will appear here as a durable task sequence.</p>
      </section>
    );
  }
  if (loadState === "error" || detail === null) {
    return (
      <section className="dezin-generation-plan dezin-generation-plan--placeholder" aria-labelledby="unavailable-generation-plan-title">
        <PlanCloseButton onClose={onClose} />
        <h2 id="unavailable-generation-plan-title">Build plan unavailable</h2>
        <p role="alert">{message ?? "The Generation Plan could not be loaded."}</p>
        {plans.length > 1 ? (
          <label className="dezin-generation-plan__selector">
            <span>History</span>
            <select
              aria-label="Selected generation plan"
              value={selectedPlanId ?? ""}
              onChange={(event) => selectPlan(event.target.value)}
            >
              {plans.map((plan, index) => (
                <option key={plan.id} value={plan.id}>{shortPlanLabel(plan, index)}</option>
              ))}
            </select>
          </label>
        ) : null}
        {selectedPlanId !== null ? (
          <button type="button" onClick={() => selectPlan(selectedPlanId)} aria-label="Retry loading build plan">
            Try again
          </button>
        ) : null}
      </section>
    );
  }
  return (
    <div className="dezin-generation-plan__container">
      <GenerationPlanPanel
        projectId={projectId}
        plans={plans}
        detail={detail}
        connection={connection}
        busyAction={busyAction}
        onSelectPlan={selectPlan}
        onRetry={retry}
        onCancel={cancel}
        onClose={onClose}
      />
      {message ? <p className="dezin-generation-plan__action-error" role="alert">{message}</p> : null}
    </div>
  );
}
