import { types as nodeUtilTypes } from "node:util";
import {
  type CreateGenerationTaskAttemptInput,
  type GenerationPlan,
  type GenerationPlanDetail,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskExecutionMode,
  type GenerationTaskFailureClass,
  type GenerationTaskMaterializationFailure,
  type GenerationTaskMaterializationObservation,
  type GenerationTaskRetryContextPolicy,
  type GenerationTaskSourceBase,
  type RecordGenerationTaskMaterializationFailureInput,
} from "../../../../packages/core/src/index.ts";
import { BlockedContextError } from "../context/context-types.ts";
import { classifyGenerationTaskError } from "./generation-task-failure.ts";

export interface GenerationPlanStorePort {
  compileApprovedGenerationPlanForProject(projectId: string, planId: string): GenerationPlanDetail;
  listActiveGenerationPlanIdsForProject(projectId: string): string[];
  listGenerationTaskIdsReadyForMaterializationForProject(projectId: string, planId: string): string[];
  getGenerationPlanDetailForProject(projectId: string, planId: string): GenerationPlanDetail;
  observeGenerationTaskMaterializationForProject(
    projectId: string,
    planId: string,
    taskId: string,
  ): GenerationTaskMaterializationObservation;
  createGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    input: CreateGenerationTaskAttemptInput,
  ): GenerationTaskAttempt;
  recordGenerationTaskMaterializationFailureForProject(
    projectId: string,
    planId: string,
    input: RecordGenerationTaskMaterializationFailureInput,
  ): GenerationTaskMaterializationFailure;
  getGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    taskId: string,
    attempt: number,
  ): GenerationTaskAttempt | null;
}

export interface GenerationPlanProjectLookup {
  listProjectIds(): readonly string[];
  projectIdForPlan(planId: string): string;
}

export interface GenerationTaskContextRequest {
  [key: string]: unknown;
  projectId: string;
  planId: string;
  task: GenerationTask;
  observation: GenerationTaskMaterializationObservation;
}

export interface GenerationTaskContextResolver {
  resolve(input: GenerationTaskContextRequest, signal: AbortSignal): Promise<{ id: string }>;
}

export interface GenerationTaskSourceBaseRequest {
  [key: string]: unknown;
  projectId: string;
  planId: string;
  task: GenerationTask;
  observation: GenerationTaskMaterializationObservation;
}

export interface GenerationTaskSourceBaseResolver {
  resolve(input: GenerationTaskSourceBaseRequest, signal: AbortSignal): Promise<GenerationTaskSourceBase>;
}

export interface GenerationTaskRebaseReconciler {
  reconcileNeedsRebaseTasks(signal: AbortSignal): Promise<GenerationPlanMaterializationSummary>;
}

export interface GenerationPlanServiceOptions {
  store: GenerationPlanStorePort;
  projectLookup: GenerationPlanProjectLookup;
  contextResolver: GenerationTaskContextResolver;
  sourceBaseResolver: GenerationTaskSourceBaseResolver;
  rebaseReconciler: GenerationTaskRebaseReconciler;
  onError?: (error: unknown) => void;
}

export interface GenerationPlanMaterializationSummary {
  planIds: string[];
}

type MaterializationPhase = "observe" | "context" | "source-base" | "create";

const ACTIVE_PLAN_STATUSES = new Set<GenerationPlan["status"]>(["queued", "running"]);
const AGENT_TASK_KINDS = new Set<GenerationTask["kind"]>([
  "resource",
  "component",
  "page",
  "propagation-candidate",
]);
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Generation Plan maintenance aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function awaitWithAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let listener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(abortReason(signal));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    if (listener !== null) signal.removeEventListener("abort", listener);
  }
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeMaterializationError(error: unknown): Record<string, unknown> {
  if (error instanceof BlockedContextError) {
    return {
      name: error.name,
      message: error.message,
      refs: [...error.missing],
    };
  }
  if (error instanceof Error) {
    const code = Reflect.get(error, "code");
    return {
      name: error.name || "Error",
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function failureClassFor(error: unknown, phase: MaterializationPhase): GenerationTaskFailureClass {
  return classifyGenerationTaskError(error, phase === "context" ? "adapter" : "unknown");
}

function retryContextPolicy(task: GenerationTask): GenerationTaskRetryContextPolicy {
  return task.pendingContextPolicy ?? "same-context";
}

function isRebaseTask(task: GenerationTask): boolean {
  return task.status === "needs-rebase" || task.status === "awaiting-context-refresh";
}

function immutableSourceBase(
  value: unknown,
  label: string,
): Readonly<GenerationTaskSourceBase> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || nodeUtilTypes.isProxy(value)) {
      throw new Error("not a plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("not a plain object");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2
      || !keys.includes("sourceCommitHash")
      || !keys.includes("sourceTreeHash")
      || keys.some((key) => typeof key !== "string")) {
      throw new Error("not an exact Source Base object");
    }
    const readDataField = (key: "sourceCommitHash" | "sourceTreeHash"): string => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
        || typeof descriptor.value !== "string"
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(descriptor.value)) {
        throw new Error("not an exact Git object id");
      }
      return descriptor.value;
    };
    const sourceCommitHash = readDataField("sourceCommitHash");
    const sourceTreeHash = readDataField("sourceTreeHash");
    if (sourceCommitHash.length !== sourceTreeHash.length) {
      throw new Error("mixed Git object formats");
    }
    return Object.freeze({ sourceCommitHash, sourceTreeHash });
  } catch {
    throw new GenerationPlanServiceInvariantError(
      `${label} returned an invalid Source Base; expected exactly two lowercase Git object ids`,
    );
  }
}

export class GenerationPlanServiceInvariantError extends Error {
  readonly failureClass = "unknown" as const;

  constructor(message: string) {
    super(message);
    this.name = "GenerationPlanServiceInvariantError";
  }
}

/**
 * Bridges durable Core Plan transactions with asynchronous Context resolution.
 *
 * Observation happens before any Context work and Core revalidates the complete
 * observation while inserting the immutable Attempt. Each Task has its own
 * failure boundary so one unavailable adapter cannot hold up independent work.
 */
export class GenerationPlanService {
  private readonly options: GenerationPlanServiceOptions;

  constructor(options: GenerationPlanServiceOptions) {
    this.options = options;
  }

  compileAndEnqueueApprovedShell(planId: string): GenerationPlan {
    const projectId = this.options.projectLookup.projectIdForPlan(planId);
    return this.options.store.compileApprovedGenerationPlanForProject(projectId, planId).plan;
  }

  async reconcileNeedsRebaseTasks(
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<GenerationPlanMaterializationSummary> {
    checkAbort(signal);
    const disposition = await awaitWithAbort(
      this.options.rebaseReconciler.reconcileNeedsRebaseTasks(signal),
      signal,
    );
    checkAbort(signal);
    // latest-context rebase is deliberately excluded from the generic pass:
    // it must first receive a dedicated durable disposition. Once the Core
    // reconciler has moved it to awaiting-context-refresh, resolve and CAS the
    // new Context/Source input here so it cannot remain ownerless forever.
    const refreshed = await this.materializeTasks(
      (_projectId, _planId, task) => task.status === "awaiting-context-refresh",
      signal,
    );
    return {
      planIds: [...new Set([...disposition.planIds, ...refreshed.planIds])].sort(compareBinary),
    };
  }

  async materializeReadyTaskAttempts(
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<GenerationPlanMaterializationSummary> {
    return this.materializeTasks((projectId, planId, task) => !this.taskRequiresRebaseReconciler(
      projectId,
      planId,
      task,
    ), signal);
  }

  private async materializeTasks(
    acceptsTask: (projectId: string, planId: string, task: GenerationTask) => boolean,
    signal: AbortSignal,
  ): Promise<GenerationPlanMaterializationSummary> {
    checkAbort(signal);
    const touchedPlanIds = new Set<string>();
    const projects = [...new Set(this.options.projectLookup.listProjectIds())].sort(compareBinary);
    for (const projectId of projects) {
      checkAbort(signal);
      const planIds = [...new Set(
        this.options.store.listActiveGenerationPlanIdsForProject(projectId),
      )].sort(compareBinary);
      for (const planId of planIds) {
        checkAbort(signal);
        const readyTaskIds = this.options.store
          .listGenerationTaskIdsReadyForMaterializationForProject(projectId, planId);
        if (readyTaskIds.length === 0) continue;
        const detail = this.options.store.getGenerationPlanDetailForProject(projectId, planId);
        const taskById = new Map(detail.tasks.map((task) => [task.id, task]));
        const tasks = [...new Set(readyTaskIds)]
          .map((taskId) => taskById.get(taskId))
          .filter((task): task is GenerationTask => task !== undefined
            && acceptsTask(projectId, planId, task));
        if (tasks.length === 0) continue;
        touchedPlanIds.add(planId);
        for (const task of tasks) {
          checkAbort(signal);
          await this.materializeTask(projectId, planId, task, signal);
        }
      }
    }
    return { planIds: [...touchedPlanIds].sort(compareBinary) };
  }

  private taskRequiresRebaseReconciler(
    projectId: string,
    planId: string,
    task: GenerationTask,
  ): boolean {
    if (isRebaseTask(task)) return true;
    if (task.status !== "retry-wait" || task.currentAttempt === 0) return false;
    try {
      return this.options.store.getGenerationTaskAttemptForProject(
        projectId,
        planId,
        task.id,
        task.currentAttempt,
      )?.status === "needs-rebase";
    } catch (error) {
      // Fail closed: a Task with ambiguous rebase lineage must never be turned
      // into a fresh full generation by the generic materializer.
      this.reportError(error);
      return true;
    }
  }

  private async materializeTask(
    projectId: string,
    planId: string,
    task: GenerationTask,
    signal: AbortSignal,
  ): Promise<void> {
    let phase: MaterializationPhase = "observe";
    let observedExecutionEpoch: number | null = null;
    try {
      checkAbort(signal);
      const observation = this.options.store.observeGenerationTaskMaterializationForProject(
        projectId,
        planId,
        task.id,
      );
      observedExecutionEpoch = observation.executionEpoch ?? 0;
      const policy = retryContextPolicy(task);
      const previousAttempt = task.currentAttempt > 0
        ? this.options.store.getGenerationTaskAttemptForProject(
          projectId,
          planId,
          task.id,
          task.currentAttempt,
        )
        : null;
      const executionMode: GenerationTaskExecutionMode = "full";

      let contextPackId: string | null = null;
      if (AGENT_TASK_KINDS.has(task.kind)) {
        if (policy === "same-context" && task.currentAttempt > 0) {
          if (previousAttempt?.contextPackId === null || previousAttempt === null) {
            throw new GenerationPlanServiceInvariantError(
              `Generation Task ${task.id} cannot reuse a missing prior Context Pack`,
            );
          }
          contextPackId = previousAttempt.contextPackId;
        } else {
          phase = "context";
          checkAbort(signal);
          const pack = await awaitWithAbort(
            this.options.contextResolver.resolve({ projectId, planId, task, observation }, signal),
            signal,
          );
          if (typeof pack.id !== "string" || pack.id.length === 0) {
            throw new GenerationPlanServiceInvariantError(
              `Generation Task ${task.id} Context resolver returned an invalid Pack identity`,
            );
          }
          contextPackId = pack.id;
        }
      }

      let sourceBase: Readonly<GenerationTaskSourceBase> | null = null;
      if (task.target.type === "artifact") {
        phase = "source-base";
        checkAbort(signal);
        const resolved = await awaitWithAbort(
          this.options.sourceBaseResolver.resolve({
            projectId,
            planId,
            task,
            observation,
          }, signal),
          signal,
        );
        sourceBase = immutableSourceBase(resolved, `Generation Task ${task.id} Source Base resolver`);
      }

      phase = "create";
      checkAbort(signal);
      this.options.store.createGenerationTaskAttemptForProject(projectId, planId, {
        ...observation,
        contextPackId,
        sourceCommitHash: sourceBase?.sourceCommitHash ?? null,
        sourceTreeHash: sourceBase?.sourceTreeHash ?? null,
        retryContextPolicy: policy,
        executionMode,
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (this.taskWasAdvanced(projectId, planId, task, observedExecutionEpoch)) return;
      try {
        this.options.store.recordGenerationTaskMaterializationFailureForProject(projectId, planId, {
          taskId: task.id,
          expectedFailureCount: task.materializationFailures,
          failureClass: failureClassFor(error, phase),
          error: serializeMaterializationError(error),
          // Core owns the exact 1s/4s/16s backoff and validates overrides.
          nextEligibleAt: null,
        });
      } catch (recordError) {
        if (!this.taskWasAdvanced(projectId, planId, task, observedExecutionEpoch)) {
          this.reportError(recordError);
        }
      }
      this.reportError(error);
    }
  }

  private taskWasAdvanced(
    projectId: string,
    planId: string,
    observed: GenerationTask,
    observedExecutionEpoch: number | null,
  ): boolean {
    try {
      const detail = this.options.store.getGenerationPlanDetailForProject(projectId, planId);
      if (!ACTIVE_PLAN_STATUSES.has(detail.plan.status)) return true;
      if (observedExecutionEpoch !== null
        && (detail.plan.executionEpoch ?? 0) !== observedExecutionEpoch) return true;
      const current = detail.tasks.find((task) => task.id === observed.id);
      if (current === undefined) return true;
      return current.currentAttempt !== observed.currentAttempt
        || current.materializationFailures !== observed.materializationFailures
        || current.status !== observed.status;
    } catch (error) {
      if (error instanceof Error && error.name === "GenerationPlanNotFoundError") return true;
      this.reportError(error);
      return false;
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting cannot change durable materialization semantics.
    }
  }
}
