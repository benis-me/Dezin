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
  type RecordGenerationTaskMaterializationFailureInput,
} from "../../../../packages/core/src/index.ts";
import { BlockedContextError } from "../context/context-types.ts";
import { classifyGenerationTaskError } from "./generation-task-failure.ts";

export interface GenerationPlanStorePort {
  compileApprovedGenerationPlanForProject(projectId: string, planId: string): GenerationPlanDetail;
  listGenerationPlans(projectId: string): GenerationPlan[];
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
  resolve(input: GenerationTaskContextRequest): Promise<{ id: string }>;
}

export interface GenerationTaskRebaseReconciler {
  reconcileNeedsRebaseTasks(): Promise<GenerationPlanMaterializationSummary>;
}

export interface GenerationPlanServiceOptions {
  store: GenerationPlanStorePort;
  projectLookup: GenerationPlanProjectLookup;
  contextResolver: GenerationTaskContextResolver;
  rebaseReconciler: GenerationTaskRebaseReconciler;
  onError?: (error: unknown) => void;
}

export interface GenerationPlanMaterializationSummary {
  planIds: string[];
}

type MaterializationPhase = "observe" | "context" | "create";

const ACTIVE_PLAN_STATUSES = new Set<GenerationPlan["status"]>(["queued", "running"]);
const AGENT_TASK_KINDS = new Set<GenerationTask["kind"]>([
  "resource",
  "component",
  "page",
  "propagation-candidate",
]);

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

  async reconcileNeedsRebaseTasks(): Promise<GenerationPlanMaterializationSummary> {
    const summary = await this.options.rebaseReconciler.reconcileNeedsRebaseTasks();
    return { planIds: [...new Set(summary.planIds)].sort(compareBinary) };
  }

  async materializeReadyTaskAttempts(): Promise<GenerationPlanMaterializationSummary> {
    return this.materializeTasks((projectId, planId, task) => !this.taskRequiresRebaseReconciler(
      projectId,
      planId,
      task,
    ));
  }

  private async materializeTasks(
    acceptsTask: (projectId: string, planId: string, task: GenerationTask) => boolean,
  ): Promise<GenerationPlanMaterializationSummary> {
    const touchedPlanIds = new Set<string>();
    const projects = [...new Set(this.options.projectLookup.listProjectIds())].sort(compareBinary);
    for (const projectId of projects) {
      const plans = this.options.store.listGenerationPlans(projectId)
        .filter((plan) => plan.constructionSealed && ACTIVE_PLAN_STATUSES.has(plan.status))
        .sort((left, right) => compareBinary(left.id, right.id));
      for (const plan of plans) {
        const readyTaskIds = this.options.store
          .listGenerationTaskIdsReadyForMaterializationForProject(projectId, plan.id);
        if (readyTaskIds.length === 0) continue;
        const detail = this.options.store.getGenerationPlanDetailForProject(projectId, plan.id);
        const taskById = new Map(detail.tasks.map((task) => [task.id, task]));
        const tasks = [...new Set(readyTaskIds)]
          .map((taskId) => taskById.get(taskId))
          .filter((task): task is GenerationTask => task !== undefined
            && acceptsTask(projectId, plan.id, task));
        if (tasks.length === 0) continue;
        touchedPlanIds.add(plan.id);
        for (const task of tasks) {
          await this.materializeTask(projectId, plan.id, task);
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
  ): Promise<void> {
    let phase: MaterializationPhase = "observe";
    try {
      const observation = this.options.store.observeGenerationTaskMaterializationForProject(
        projectId,
        planId,
        task.id,
      );
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
          const pack = await this.options.contextResolver.resolve({ projectId, planId, task, observation });
          if (typeof pack.id !== "string" || pack.id.length === 0) {
            throw new GenerationPlanServiceInvariantError(
              `Generation Task ${task.id} Context resolver returned an invalid Pack identity`,
            );
          }
          contextPackId = pack.id;
        }
      }

      phase = "create";
      this.options.store.createGenerationTaskAttemptForProject(projectId, planId, {
        ...observation,
        contextPackId,
        retryContextPolicy: policy,
        executionMode,
      });
    } catch (error) {
      if (phase !== "context" && this.taskWasAdvanced(projectId, planId, task)) return;
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
        if (!this.taskWasAdvanced(projectId, planId, task)) this.reportError(recordError);
      }
      this.reportError(error);
    }
  }

  private taskWasAdvanced(projectId: string, planId: string, observed: GenerationTask): boolean {
    try {
      const detail = this.options.store.getGenerationPlanDetailForProject(projectId, planId);
      if (!ACTIVE_PLAN_STATUSES.has(detail.plan.status)) return true;
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
