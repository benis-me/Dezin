import {
  GenerationTaskLeaseFenceError,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskAttemptLease,
  type GenerationTaskRecoverySummary,
} from "../../../../packages/core/src/index.ts";
import type { RuntimeScope } from "../runtime-supervisor.ts";
import {
  GenerationTaskDeadlineExceededError,
} from "./generation-task-failure.ts";
import {
  generationTaskCancellationCause,
  type GenerationTaskCancellationCause,
} from "./generation-task-cancellation.ts";

export interface GenerationSchedulerStore {
  recoverExpiredGenerationTaskAttempts(now: number, limit?: number): GenerationTaskRecoverySummary;
  listReadyGenerationTaskAttempts(limit?: number): GenerationTaskAttempt[];
  tryClaimGenerationTaskAttempt(input: {
    taskId: string;
    attempt: number;
    ownerId: string;
    now: number;
    leaseMs: number;
  }): GenerationTaskAttemptClaim | null;
  heartbeatGenerationTaskAttempt(
    lease: GenerationTaskAttemptLease,
    now: number,
    leaseMs: number,
  ): GenerationTaskAttemptClaim;
  releaseGenerationTaskAttemptClaims(lease: GenerationTaskAttemptLease): boolean;
}

export interface GenerationSchedulerPlanService {
  reconcileNeedsRebaseTasks(signal: AbortSignal): Promise<{ planIds: readonly string[] }>;
  materializeReadyTaskAttempts(signal: AbortSignal): Promise<{ planIds: readonly string[] }>;
}

export interface GenerationSchedulerRuntimeSupervisor {
  trackOperation<T>(
    scope: RuntimeScope,
    start: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<T>;
}

export interface GenerationSchedulerExecutor {
  execute(claim: GenerationTaskAttemptClaim, signal: AbortSignal): Promise<unknown>;
  acknowledgeCancellation?(
    claim: GenerationTaskAttemptClaim,
    cancellation: GenerationTaskCancellationCause,
  ): Promise<unknown>;
  acknowledgeDeadlineExceeded?(
    claim: GenerationTaskAttemptClaim,
    deadline: GenerationTaskDeadlineExceededError,
  ): Promise<unknown>;
}

export interface GenerationSchedulerEvents {
  notify(planId: string): void;
}

export interface GenerationSchedulerClock {
  now(): number;
}

export interface GenerationSchedulerOptions {
  store: GenerationSchedulerStore;
  planService: GenerationSchedulerPlanService;
  runtimeSupervisor: GenerationSchedulerRuntimeSupervisor;
  executor: GenerationSchedulerExecutor;
  events: GenerationSchedulerEvents;
  projectIdForWorkspace(workspaceId: string): string;
  ownerId: string;
  clock: GenerationSchedulerClock;
  leaseMs?: number;
  heartbeatMs?: number;
  abortSettlementMs?: number;
  pollMs?: number;
  readyLimit?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_ABORT_SETTLEMENT_MS = 5_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_READY_LIMIT = 100;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function operationScope(
  attempt: GenerationTaskAttempt,
  projectId: string,
): RuntimeScope {
  return {
    projectId,
    planId: attempt.planId,
    taskId: attempt.taskId,
    ...(attempt.target.type === "artifact" ? { artifactId: attempt.target.id } : {}),
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Generation maintenance aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export class GenerationTaskCancellationRequestedError extends Error {
  readonly cancellation: GenerationTaskCancellationCause;

  constructor(cancellation: GenerationTaskCancellationCause) {
    super("Generation Task cancellation requested");
    this.name = "GenerationTaskCancellationRequestedError";
    this.cancellation = cancellation;
  }
}

interface ActiveGenerationExecution {
  readonly controller: AbortController;
  readonly claim: GenerationTaskAttemptClaim;
  readonly projectId: string;
  cancellation: GenerationTaskCancellationCause | null;
  abortKind: "supervisor" | "cancellation" | "heartbeat" | "deadline" | null;
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

/**
 * Durable admission loop for Generation Task Attempts.
 *
 * SQLite owns capacity, writer exclusion, and execution fencing. This class only
 * orders maintenance, registers process lifecycle ownership before claiming, and
 * keeps an admitted lease alive while its executor is running.
 */
export class GenerationScheduler {
  private readonly options: GenerationSchedulerOptions;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly abortSettlementMs: number;
  private readonly pollMs: number;
  private readonly readyLimit: number;
  private readonly executions = new Set<Promise<unknown>>();
  private readonly executionControllers = new Map<AbortController, ActiveGenerationExecution>();
  private readonly maintenanceController = new AbortController();
  private tickPromise: Promise<void> | null = null;
  private tickRequested = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;

  constructor(options: GenerationSchedulerOptions) {
    this.options = options;
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS, "Generation lease duration");
    this.heartbeatMs = positiveInteger(
      options.heartbeatMs,
      DEFAULT_HEARTBEAT_MS,
      "Generation heartbeat interval",
    );
    this.abortSettlementMs = positiveInteger(
      options.abortSettlementMs,
      DEFAULT_ABORT_SETTLEMENT_MS,
      "Generation abort settlement interval",
    );
    this.pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS, "Generation poll interval");
    this.readyLimit = positiveInteger(options.readyLimit, DEFAULT_READY_LIMIT, "Generation ready limit");
    if (this.heartbeatMs >= this.leaseMs) {
      throw new Error("Generation heartbeat interval must be shorter than its lease duration");
    }
  }

  start(): void {
    if (this.stopped) throw new Error("GenerationScheduler cannot restart after stop");
    if (this.started) return;
    this.started = true;
    // Startup recovery owns the admission barrier. Wakes received before this
    // point are represented by the single bounded boolean and drained exactly
    // once now that the barrier has explicitly opened.
    this.tickRequested = true;
    void this.startTickLoop()
      .catch((error) => this.reportMaintenanceError(error))
      .finally(() => this.schedulePoll(this.pollMs));
  }

  requestTick(): void {
    if (this.stopped) return;
    this.tickRequested = true;
    if (!this.started) return;
    if (this.tickPromise === null) {
      void this.startTickLoop().catch((error) => this.reportMaintenanceError(error));
    }
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.tickPromise !== null) return this.tickPromise;
    this.tickRequested = true;
    if (!this.started) return Promise.resolve();
    return this.startTickLoop();
  }

  /**
   * Observes the just-committed durable cancel state through the exact live
   * lease before aborting a worker. A completed or substituted claim is left
   * alone, so an HTTP cancellation cannot turn a concurrently published Task
   * back into cancelled state.
   */
  requestCancellation(projectId: string, planId: string): void {
    for (const execution of this.executionControllers.values()) {
      if (execution.projectId !== projectId || execution.claim.attempt.planId !== planId) continue;
      if (execution.controller.signal.reason instanceof GenerationTaskDeadlineExceededError) continue;
      try {
        const cancellation = this.observeDurableCancellation(execution);
        if (cancellation !== null && !execution.controller.signal.aborted) {
          execution.abortKind = "cancellation";
          execution.controller.abort(new GenerationTaskCancellationRequestedError(cancellation));
        }
      } catch (error) {
        if (!(error instanceof GenerationTaskLeaseFenceError)) this.reportError(error);
      }
    }
    if (!this.stopped) this.requestTick();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.waitForSettlements();
      return;
    }
    this.stopped = true;
    this.started = false;
    this.tickRequested = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.maintenanceController.abort(new Error("GenerationScheduler stopped"));
    for (const execution of this.executionControllers.values()) {
      if (execution.controller.signal.aborted) continue;
      execution.abortKind = "supervisor";
      execution.controller.abort(new Error("GenerationScheduler stopped"));
    }
    await this.waitForSettlements();
  }

  private async runTick(): Promise<void> {
    const signal = this.maintenanceController.signal;
    checkAbort(signal);
    const recovered = this.options.store.recoverExpiredGenerationTaskAttempts(this.options.clock.now());
    this.notifyPlans(recovered.planIds);
    checkAbort(signal);

    const reconciled = await awaitWithAbort(
      this.options.planService.reconcileNeedsRebaseTasks(signal),
      signal,
    );
    this.notifyPlans(reconciled.planIds);
    checkAbort(signal);

    const materialized = await awaitWithAbort(
      this.options.planService.materializeReadyTaskAttempts(signal),
      signal,
    );
    this.notifyPlans(materialized.planIds);
    checkAbort(signal);

    const ready = this.options.store.listReadyGenerationTaskAttempts(this.readyLimit);
    for (const attempt of ready) {
      if (this.stopped) break;
      this.registerAttempt(attempt);
    }
  }

  private registerAttempt(attempt: GenerationTaskAttempt): void {
    let operation: Promise<unknown>;
    try {
      const projectId = this.options.projectIdForWorkspace(attempt.workspaceId);
      operation = this.options.runtimeSupervisor.trackOperation(
        operationScope(attempt, projectId),
        async (supervisorSignal) => {
          if (this.stopped || supervisorSignal.aborted) return;
          const claim = this.options.store.tryClaimGenerationTaskAttempt({
            taskId: attempt.taskId,
            attempt: attempt.attempt,
            ownerId: this.options.ownerId,
            now: this.options.clock.now(),
            leaseMs: this.leaseMs,
          });
          if (claim === null) return;
          await this.executeWithHeartbeat(claim, projectId, supervisorSignal, () => {
            this.notifyPlan(claim.attempt.planId);
          });
        },
      );
    } catch (error) {
      this.reportError(error);
      return;
    }
    this.executions.add(operation);
    void operation.catch((error) => this.reportError(error)).finally(() => {
      this.executions.delete(operation);
    });
  }

  private async executeWithHeartbeat(
    claim: GenerationTaskAttemptClaim,
    projectId: string,
    supervisorSignal: AbortSignal,
    beforeExecute: () => void,
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = claim.task.resourceLimits.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Claimed Generation Task timeout must be a positive safe integer");
    }
    const deadline = new GenerationTaskDeadlineExceededError({
      taskId: claim.task.id,
      attempt: claim.attempt.attempt,
      timeoutMs,
    });
    const execution: ActiveGenerationExecution = {
      controller,
      claim,
      projectId,
      cancellation: null,
      abortKind: null,
    };
    this.executionControllers.set(controller, execution);
    const forwardAbort = (): void => {
      if (controller.signal.aborted) return;
      execution.abortKind = "supervisor";
      controller.abort(supervisorSignal.reason);
    };
    if (supervisorSignal.aborted) forwardAbort();
    else supervisorSignal.addEventListener("abort", forwardAbort, { once: true });

    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let abortSettlementTimer: ReturnType<typeof setTimeout> | null = null;
    let abortSettlementListener: (() => void) | null = null;
    let settled = false;
    let cancellationAcknowledged = false;
    let deadlineAcknowledged = false;
    let deadlineLeaseValidated = false;
    const acknowledgeCancellation = async (): Promise<boolean> => {
      const cancellation = execution.cancellation;
      if (cancellation === null) return false;
      if (cancellationAcknowledged) return true;
      const acknowledge = this.options.executor.acknowledgeCancellation;
      if (acknowledge === undefined) {
        throw new GenerationTaskCancellationRequestedError(cancellation);
      }
      cancellationAcknowledged = true;
      await acknowledge.call(this.options.executor, claim, cancellation);
      return true;
    };
    const acknowledgeDeadline = async (): Promise<boolean> => {
      if (controller.signal.reason !== deadline) return false;
      if (!deadlineLeaseValidated) return true;
      if (deadlineAcknowledged) return true;
      const acknowledge = this.options.executor.acknowledgeDeadlineExceeded;
      if (acknowledge === undefined) throw deadline;
      deadlineAcknowledged = true;
      try {
        await acknowledge.call(this.options.executor, claim, deadline);
      } catch (error) {
        if (!this.isExactLeaseFence(error, claim)) throw error;
      }
      return true;
    };
    const scheduleHeartbeat = (): void => {
      if (settled || controller.signal.aborted) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        if (settled || controller.signal.aborted) return;
        try {
          const renewed = this.options.store.heartbeatGenerationTaskAttempt(
            claim.lease,
            this.options.clock.now(),
            this.leaseMs,
          );
          const cancellation = this.recordDurableCancellation(execution, renewed);
          if (cancellation !== null) {
            execution.abortKind = "cancellation";
            controller.abort(new GenerationTaskCancellationRequestedError(cancellation));
            return;
          }
          scheduleHeartbeat();
        } catch (error) {
          // Any failed renewal means the process can no longer prove ownership.
          // Fence errors are expected during takeover; other heartbeat failures
          // are reported, but both must stop the executor before further writes.
          if (!(error instanceof GenerationTaskLeaseFenceError)) this.reportError(error);
          execution.abortKind = "heartbeat";
          controller.abort(error);
        }
      }, this.heartbeatMs);
      unrefTimer(heartbeatTimer);
    };
    const deadlineReached = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        if (settled || controller.signal.aborted) return;
        if (heartbeatTimer !== null) {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }
        try {
          const cancellation = this.observeDurableCancellation(execution);
          if (cancellation !== null) {
            execution.abortKind = "cancellation";
            controller.abort(new GenerationTaskCancellationRequestedError(cancellation));
            return;
          }
          deadlineLeaseValidated = true;
        } catch (error) {
          if (!this.isExactLeaseFence(error, claim)) {
            execution.abortKind = "heartbeat";
            controller.abort(error);
            reject(error);
            return;
          }
          // The timeout still stops the stale leaf, but cannot publish after
          // exact ownership has already been lost.
        }
        execution.abortKind = "deadline";
        controller.abort(deadline);
        reject(deadline);
      }, timeoutMs);
      unrefTimer(deadlineTimer);
    });
    const abortSettlementReached = new Promise<never>((_resolve, reject) => {
      abortSettlementListener = () => {
        if (controller.signal.reason === deadline || abortSettlementTimer !== null) return;
        abortSettlementTimer = setTimeout(() => {
          abortSettlementTimer = null;
          reject(abortReason(controller.signal));
        }, this.abortSettlementMs);
      };
      if (controller.signal.aborted) abortSettlementListener();
      else controller.signal.addEventListener("abort", abortSettlementListener, { once: true });
    });
    try {
      // Register the controller before invoking any external wake-up callback.
      // A synchronous stop/abort from that callback must see and fence this
      // already-claimed operation before an executor can begin.
      beforeExecute();
      if (controller.signal.aborted) {
        await acknowledgeCancellation();
        return;
      }
      if (this.stopped) return;
      scheduleHeartbeat();
      try {
        const executorExecution = Promise.resolve()
          .then(() => this.options.executor.execute(claim, controller.signal));
        await Promise.race([executorExecution, deadlineReached, abortSettlementReached]);
      } catch (error) {
        if (controller.signal.reason === deadline) {
          await acknowledgeDeadline();
          return;
        }
        if (execution.cancellation === null && this.isExactLeaseFence(error, claim)) {
          try {
            this.observeDurableCancellation(execution);
          } catch (observationError) {
            if (!(observationError instanceof GenerationTaskLeaseFenceError)) {
              this.reportError(observationError);
            }
          }
        }
        if (execution.cancellation === null) {
          if (execution.abortKind === "supervisor" || execution.abortKind === "heartbeat") return;
          throw error;
        }
      }
      if (controller.signal.reason === deadline) {
        await acknowledgeDeadline();
        return;
      }
      await acknowledgeCancellation();
    } finally {
      settled = true;
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (abortSettlementTimer !== null) clearTimeout(abortSettlementTimer);
      if (abortSettlementListener !== null) {
        controller.signal.removeEventListener("abort", abortSettlementListener);
      }
      supervisorSignal.removeEventListener("abort", forwardAbort);
      this.executionControllers.delete(controller);
      try {
        this.options.store.releaseGenerationTaskAttemptClaims(claim.lease);
      } finally {
        // Wake readers after every settlement, including commit-then-response-
        // lost publication errors and aborts after candidate staging.
        this.notifyPlan(claim.attempt.planId);
      }
    }
  }

  private notifyPlans(planIds: readonly string[]): void {
    for (const planId of new Set(planIds)) this.notifyPlan(planId);
  }

  private recordDurableCancellation(
    execution: ActiveGenerationExecution,
    current: GenerationTaskAttemptClaim,
  ): GenerationTaskCancellationCause | null {
    const cancellation = generationTaskCancellationCause(current);
    if (cancellation !== null && execution.cancellation === null) {
      execution.cancellation = cancellation;
    }
    return execution.cancellation;
  }

  private observeDurableCancellation(
    execution: ActiveGenerationExecution,
  ): GenerationTaskCancellationCause | null {
    const current = this.options.store.heartbeatGenerationTaskAttempt(
      execution.claim.lease,
      this.options.clock.now(),
      this.leaseMs,
    );
    return this.recordDurableCancellation(execution, current);
  }

  private isExactLeaseFence(
    error: unknown,
    claim: GenerationTaskAttemptClaim,
  ): error is GenerationTaskLeaseFenceError {
    return error instanceof GenerationTaskLeaseFenceError
      && error.taskId === claim.attempt.taskId
      && error.attempt === claim.attempt.attempt;
  }

  private notifyPlan(planId: string): void {
    try {
      this.options.events.notify(planId);
    } catch (error) {
      // Notifications are only wake-ups. Durable Plan events remain replayable,
      // so a listener failure must never interrupt recovery or claimed work.
      this.reportError(error);
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.started || this.stopped || this.pollTimer !== null) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.tick()
        .catch((error) => this.reportMaintenanceError(error))
        .finally(() => this.schedulePoll(this.pollMs));
    }, delayMs);
    unrefTimer(this.pollTimer);
  }

  private startTickLoop(): Promise<void> {
    // Defer the first pass until tickPromise is installed so synchronous
    // recovery/listener callbacks cannot re-enter a second loop.
    const running = Promise.resolve()
      .then(() => this.drainRequestedTicks())
      .catch((error: unknown) => {
        // stop() owns the maintenance abort. Existing callers await tick() as a
        // settlement barrier, so an intentional stop resolves that barrier
        // while genuine maintenance failures retain their rejection semantics.
        if (!this.isMaintenanceStopAbort(error)) throw error;
      });
    const tracked = running.finally(() => {
      if (this.tickPromise === tracked) this.tickPromise = null;
      if (this.tickRequested && this.started && !this.stopped && this.tickPromise === null) {
        void this.startTickLoop().catch((error) => this.reportMaintenanceError(error));
      }
    });
    this.tickPromise = tracked;
    return tracked;
  }

  private async drainRequestedTicks(): Promise<void> {
    while (this.tickRequested && this.started && !this.stopped) {
      this.tickRequested = false;
      await this.runTick();
    }
  }

  private async waitForSettlements(): Promise<void> {
    const tick = this.tickPromise;
    if (tick !== null) await Promise.allSettled([tick]);
    while (this.executions.size > 0) {
      await Promise.allSettled([...this.executions]);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting is observational and cannot own scheduler correctness.
    }
  }

  private reportMaintenanceError(error: unknown): void {
    if (this.isMaintenanceStopAbort(error)) return;
    this.reportError(error);
  }

  private isMaintenanceStopAbort(error: unknown): boolean {
    return this.stopped
      && this.maintenanceController.signal.aborted
      && error === this.maintenanceController.signal.reason;
  }
}
