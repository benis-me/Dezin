import type {
  GenerationPlanDetail,
  GenerationTask,
  GenerationTaskStatus,
} from "../../lib/api.ts";

export type GenerationTargetPhase =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "blocked"
  | "cancelled";

export interface GenerationTargetState {
  state: GenerationTargetPhase;
  planId: string;
  taskId: string;
  taskKind: GenerationTask["kind"];
  message: string | null;
}

export interface GenerationTargetStates {
  artifacts: Record<string, GenerationTargetState>;
  resources: Record<string, GenerationTargetState>;
}

export function generationPlanResultKey(detail: GenerationPlanDetail): string | null {
  const results = detail.tasks.flatMap((task) => {
    const identities = [
      task.resultRevisionId,
      task.resultResourceRevisionId,
      task.resultSnapshotId,
    ];
    return identities.some((value) => value !== null)
      ? [`${task.id}:${identities.join(":")}`]
      : [];
  });
  return results.length > 0 ? `${detail.plan.id}:${results.join("|")}` : null;
}

const LOCAL_FAILURE_PATH =
  /\/(?:Users|home|private|tmp|var|opt|usr|Applications|Volumes)(?:\/[^\s/]+)+/g;

function publicFailureMessage(value: string): string {
  return value.replace(LOCAL_FAILURE_PATH, (matchedPath) => {
    const trailing = matchedPath.endsWith(".")
      ? "."
      : matchedPath.match(/[),;:'"]+$/)?.[0] ?? "";
    const path = trailing ? matchedPath.slice(0, -trailing.length) : matchedPath;
    const name = path.split("/").at(-1) ?? "";
    return `${/^[a-zA-Z0-9._-]{1,80}$/.test(name) ? name : "local path"}${trailing}`;
  });
}

function targetPhase(status: GenerationTaskStatus): GenerationTargetPhase {
  switch (status) {
    case "succeeded":
      return "complete";
    case "failed":
      return "failed";
    case "blocked":
    case "blocked-context":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "running":
    case "candidate-ready":
    case "needs-rebase":
    case "awaiting-context-refresh":
    case "cancel-requested":
      return "running";
    case "materialization-pending":
    case "retry-wait":
    case "queued":
      return "queued";
  }
}

function taskMessage(task: GenerationTask): string | null {
  const message = task.error?.message;
  if (typeof message === "string" && message.trim()) {
    return publicFailureMessage(message.trim());
  }
  const blockedReason = task.blockedReason?.trim();
  return blockedReason ? publicFailureMessage(blockedReason) : null;
}

function isDirectTargetTask(task: GenerationTask): boolean {
  if (task.target.type === "resource") return task.kind === "resource";
  if (task.target.type === "artifact") {
    return task.kind === "page" || task.kind === "component";
  }
  return false;
}

function newerTask(next: GenerationTask, current: GenerationTask | undefined): boolean {
  if (!current) return true;
  return next.ordinal > current.ordinal
    || (next.ordinal === current.ordinal && next.currentAttempt > current.currentAttempt)
    || (next.ordinal === current.ordinal
      && next.currentAttempt === current.currentAttempt
      && next.createdAt > current.createdAt);
}

export function buildGenerationTargetStates(
  detail: GenerationPlanDetail | null,
): GenerationTargetStates {
  if (detail === null) return { artifacts: {}, resources: {} };
  const directTasks = new Map<string, GenerationTask>();
  for (const task of detail.tasks) {
    if (!isDirectTargetTask(task)) continue;
    const key = `${task.target.type}:${task.target.id}`;
    if (newerTask(task, directTasks.get(key))) directTasks.set(key, task);
  }

  const states: GenerationTargetStates = { artifacts: {}, resources: {} };
  for (const task of directTasks.values()) {
    if (task.target.type === "workspace") continue;
    const state: GenerationTargetState = {
      state: targetPhase(task.status),
      planId: detail.plan.id,
      taskId: task.id,
      taskKind: task.kind,
      message: taskMessage(task),
    };
    if (task.target.type === "artifact") states.artifacts[task.target.id] = state;
    else states.resources[task.target.id] = state;
  }
  return states;
}
