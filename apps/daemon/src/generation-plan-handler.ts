import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GenerationPlanNotFoundError,
  GenerationPlanOwnershipError,
  GenerationPlanStateConflictError,
  GenerationTaskMaterializationConflictError,
  GenerationTaskNotFoundError,
  type GenerationPlanDetail,
  type GenerationPlanEvent,
  type GenerationTaskAttemptStatus,
} from "../../../packages/core/src/index.ts";
import type { AppDeps } from "./app.ts";
import { HttpError, readJsonBody, sendJson } from "./http-util.ts";
import {
  requestGenerationPlanCancellation,
  wakeGenerationPlan,
} from "./orchestration/generation-plan-control.ts";

const EVENT_PAGE_LIMIT = 100;
const DURABLE_POLL_MS = 1_000;
const TERMINAL_PLAN_STATUSES = new Set([
  "succeeded",
  "compile-failed",
  "requires-new-impact",
  "cancelled",
]);

export interface GenerationPlanHttpCurrentAttempt {
  taskId: string;
  attempt: number;
  status: GenerationTaskAttemptStatus;
  candidateRevisionId: string | null;
  candidateResourceRevisionId: string | null;
  candidateEvidence: Record<string, unknown> | null;
  candidateEvidenceHash: string | null;
}

export interface GenerationPlanHttpDetail extends GenerationPlanDetail {
  currentAttempts: GenerationPlanHttpCurrentAttempt[];
}

type GenerationTaskAttemptReader = Pick<
  AppDeps["store"]["workspace"],
  "getGenerationTaskAttemptForProject"
>;

/**
 * Public Plan DTO. The durable Task pointer is resolved server-side so a
 * viewer never guesses a candidate from mutable Artifact Head state or from a
 * superseded Attempt.
 */
export function generationPlanHttpDetail(
  projectId: string,
  detail: GenerationPlanDetail,
  reader: GenerationTaskAttemptReader,
): GenerationPlanHttpDetail {
  const currentAttempts = detail.tasks.flatMap<GenerationPlanHttpCurrentAttempt>((task) => {
    if (task.currentAttempt === 0) return [];
    const attempt = reader.getGenerationTaskAttemptForProject(
      projectId,
      detail.plan.id,
      task.id,
      task.currentAttempt,
    );
    if (attempt === null
      || attempt.taskId !== task.id
      || attempt.planId !== detail.plan.id
      || attempt.workspaceId !== detail.plan.workspaceId
      || attempt.attempt !== task.currentAttempt) {
      throw new Error(`Generation Task ${task.id} current Attempt is unavailable`);
    }
    return [{
      taskId: attempt.taskId,
      attempt: attempt.attempt,
      status: attempt.status,
      candidateRevisionId: attempt.candidateRevisionId,
      candidateResourceRevisionId: attempt.candidateResourceRevisionId,
      candidateEvidence: attempt.candidateEvidence === null
        ? null
        : structuredClone(attempt.candidateEvidence),
      candidateEvidenceHash: attempt.candidateEvidenceHash,
    }];
  });
  return { ...detail, currentAttempts };
}

function requireProject(deps: AppDeps, projectId: string): void {
  const project = deps.store.getProject(projectId);
  if (project === null) throw new HttpError(404, "project not found");
  if (project.mode !== "standard") {
    throw new HttpError(409, "Generation Plans require a Standard project");
  }
}

function planNotFound(error: unknown): never {
  if (error instanceof GenerationPlanNotFoundError || error instanceof GenerationPlanOwnershipError) {
    throw new HttpError(404, "generation plan not found");
  }
  throw error;
}

function controlError(error: unknown): never {
  if (error instanceof GenerationPlanNotFoundError
    || error instanceof GenerationPlanOwnershipError
    || error instanceof GenerationTaskNotFoundError) {
    throw new HttpError(404, "generation plan task not found");
  }
  if (error instanceof GenerationPlanStateConflictError
    || error instanceof GenerationTaskMaterializationConflictError) {
    throw new HttpError(409, error.message);
  }
  throw error;
}

function exactBody(
  value: unknown,
  label: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== fields.length
    || fields.some((field) => !keys.includes(field))) {
    throw new HttpError(400, `${label} fields are invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new HttpError(400, `${label}.${field} must be plain data`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

async function parseCancelBody(req: IncomingMessage): Promise<void> {
  exactBody(await readJsonBody(req), "Generation Plan cancellation", []);
}

async function parseRetryBody(req: IncomingMessage): Promise<"same-context" | "latest-context"> {
  const body = exactBody(await readJsonBody(req), "Generation Task retry", ["mode"]);
  if (body.mode !== "same-context" && body.mode !== "latest-context") {
    throw new HttpError(400, "Generation Task retry mode is invalid");
  }
  return body.mode;
}

function parseCursorValue(value: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new HttpError(400, `${label} is invalid`);
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new HttpError(400, `${label} is invalid`);
  return cursor;
}

function eventCursor(req: IncomingMessage): number {
  const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
  const unexpected = [...query.keys()].find((key) => key !== "after");
  if (unexpected !== undefined) {
    throw new HttpError(400, `Generation Plan events contain unexpected query: ${unexpected}`);
  }
  const afterValues = query.getAll("after");
  if (afterValues.length > 1) throw new HttpError(400, "Generation Plan events require at most one after cursor");
  const queryCursor = afterValues.length === 0 ? 0 : parseCursorValue(afterValues[0]!, "after cursor");
  const rawHeader = req.headers["last-event-id"];
  if (Array.isArray(rawHeader)) throw new HttpError(400, "Last-Event-ID is invalid");
  const headerCursor = rawHeader === undefined || rawHeader.trim().length === 0
    ? 0
    : parseCursorValue(rawHeader.trim(), "Last-Event-ID");
  return Math.max(queryCursor, headerCursor);
}

function sseEvent(event: GenerationPlanEvent): string {
  return `id: ${event.sequence}\nevent: generation-plan\ndata: ${JSON.stringify(event)}\n\n`;
}

function writeWithBackpressure(res: ServerResponse, chunk: string): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  if (res.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

export async function handleListGenerationPlans(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  sendJson(res, 200, deps.store.workspace.listGenerationPlans(projectId));
}

export async function handleGetLatestScopedArtifactGenerationPlan(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const plan = deps.store.workspace.getLatestScopedArtifactGenerationPlanForProject(
    projectId,
    params.artifactId!,
  );
  sendJson(res, 200, { planId: plan?.id ?? null });
}

export async function handleGetGenerationPlan(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  try {
    const detail = deps.store.workspace.getGenerationPlanDetailForProject(projectId, params.planId!);
    sendJson(
      res,
      200,
      generationPlanHttpDetail(projectId, detail, deps.store.workspace),
    );
  } catch (error) {
    planNotFound(error);
  }
}

export async function handleCancelGenerationPlan(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const planId = params.planId!;
  requireProject(deps, projectId);
  await parseCancelBody(req);
  try {
    const detail = deps.store.workspace.cancelGenerationPlanForProject(projectId, planId);
    requestGenerationPlanCancellation(deps.generationPlanRuntime, projectId, planId);
    wakeGenerationPlan(deps.generationPlanEvents, deps.generationPlanRuntime, planId);
    sendJson(res, 200, generationPlanHttpDetail(projectId, detail, deps.store.workspace));
  } catch (error) {
    controlError(error);
  }
}

export async function handleRetryGenerationTask(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const planId = params.planId!;
  requireProject(deps, projectId);
  const mode = await parseRetryBody(req);
  try {
    const detail = deps.store.workspace.retryGenerationTaskForProject(
      projectId,
      planId,
      params.taskId!,
      { mode },
    );
    wakeGenerationPlan(deps.generationPlanEvents, deps.generationPlanRuntime, planId);
    sendJson(res, 200, generationPlanHttpDetail(projectId, detail, deps.store.workspace));
  } catch (error) {
    controlError(error);
  }
}

export async function handleGenerationPlanEvents(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const planId = params.planId!;
  requireProject(deps, projectId);
  let cursor = eventCursor(req);
  try {
    // Validate ownership before committing SSE headers.
    deps.store.workspace.getGenerationPlanForProject(projectId, planId);
  } catch (error) {
    planNotFound(error);
  }

  const broker = deps.generationPlanEvents;
  if (broker === undefined) throw new Error("Generation Plan event broker is unavailable");
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  let ended = false;
  let draining = false;
  let requested = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let unsubscribe = (): void => {};

  const cleanup = (): void => {
    if (ended) return;
    ended = true;
    unsubscribe();
    if (poll !== null) clearInterval(poll);
    poll = null;
    req.off("aborted", cleanup);
    res.off("close", cleanup);
  };

  const end = (): void => {
    if (!res.destroyed && !res.writableEnded) res.end();
    cleanup();
  };

  const fail = (error: unknown): void => {
    if (!ended && !res.destroyed && !res.writableEnded) {
      const message = error instanceof Error ? error.message : "Generation Plan event replay failed";
      void writeWithBackpressure(res, `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
        .finally(end)
        .catch(cleanup);
      return;
    }
    cleanup();
  };

  const drain = async (): Promise<void> => {
    if (ended) return;
    if (draining) {
      requested = true;
      return;
    }
    draining = true;
    try {
      do {
        requested = false;
        let events: GenerationPlanEvent[];
        try {
          events = deps.store.workspace.listGenerationPlanEventsForProject(
            projectId,
            planId,
            { after: cursor, limit: EVENT_PAGE_LIMIT },
          );
        } catch (error) {
          planNotFound(error);
        }
        for (const event of events) {
          if (ended) return;
          await writeWithBackpressure(res, sseEvent(event));
          cursor = event.sequence;
        }
        if (events.length === EVENT_PAGE_LIMIT) requested = true;
        if (!requested) {
          const detail = deps.store.workspace.getGenerationPlanDetailForProject(projectId, planId);
          if (TERMINAL_PLAN_STATUSES.has(detail.plan.status)) {
            end();
            return;
          }
        }
      } while (requested && !ended);
    } finally {
      draining = false;
      if (requested && !ended) void drain().catch(fail);
    }
  };

  unsubscribe = broker.subscribe(planId, () => {
    requested = true;
    void drain().catch(fail);
  });
  req.once("aborted", cleanup);
  res.once("close", cleanup);
  poll = setInterval(() => {
    requested = true;
    void drain().catch(fail);
  }, DURABLE_POLL_MS);
  poll.unref?.();
  await drain();
}
