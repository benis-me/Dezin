import {
  GenerationTaskLeaseFenceError,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskAttemptLease,
  type GenerationTaskRecoverySummary,
} from "../../../../packages/core/src/index.ts";
import type { RuntimeScope } from "../runtime-supervisor.ts";

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
  ): unknown;
  releaseGenerationTaskAttemptClaims(lease: GenerationTaskAttemptLease): boolean;
}

export interface GenerationSchedulerPlanService {
  reconcileNeedsRebaseTasks(): Promise<{ planIds: readonly string[] }>;
  materializeReadyTaskAttempts(): Promise<{ planIds: readonly string[] }>;
}

export interface GenerationSchedulerRuntimeSupervisor {
  trackOperation<T>(
    scope: RuntimeScope,
    start: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<T>;
}

export interface GenerationSchedulerExecutor {
  execute(claim: GenerationTaskAttemptClaim, signal: AbortSignal): Promise<unknown>;
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
  pollMs?: number;
  readyLimit?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
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
  private readonly pollMs: number;
  private readonly readyLimit: number;
  private readonly executions = new Set<Promise<unknown>>();
  private readonly executionControllers = new Set<AbortController>();
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
    this.schedulePoll(0);
  }

  requestTick(): void {
    if (this.stopped) return;
    this.tickRequested = true;
    if (this.tickPromise === null) {
      void this.startTickLoop().catch((error) => this.reportError(error));
    }
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.tickPromise !== null) return this.tickPromise;
    this.tickRequested = true;
    return this.startTickLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.waitForSettlements();
      return;
    }
    this.stopped = true;
    this.started = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const controller of this.executionControllers) {
      controller.abort(new Error("GenerationScheduler stopped"));
    }
    await this.waitForSettlements();
  }

  private async runTick(): Promise<void> {
    const recovered = this.options.store.recoverExpiredGenerationTaskAttempts(this.options.clock.now());
    this.notifyPlans(recovered.planIds);
    if (this.stopped) return;

    const reconciled = await this.options.planService.reconcileNeedsRebaseTasks();
    this.notifyPlans(reconciled.planIds);
    if (this.stopped) return;

    const materialized = await this.options.planService.materializeReadyTaskAttempts();
    this.notifyPlans(materialized.planIds);
    if (this.stopped) return;

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
          await this.executeWithHeartbeat(claim, supervisorSignal, () => {
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
    supervisorSignal: AbortSignal,
    beforeExecute: () => void,
  ): Promise<void> {
    const controller = new AbortController();
    this.executionControllers.add(controller);
    const forwardAbort = (): void => controller.abort(supervisorSignal.reason);
    if (supervisorSignal.aborted) forwardAbort();
    else supervisorSignal.addEventListener("abort", forwardAbort, { once: true });

    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const scheduleHeartbeat = (): void => {
      if (settled || controller.signal.aborted) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        if (settled || controller.signal.aborted) return;
        try {
          this.options.store.heartbeatGenerationTaskAttempt(
            claim.lease,
            this.options.clock.now(),
            this.leaseMs,
          );
          scheduleHeartbeat();
        } catch (error) {
          // Any failed renewal means the process can no longer prove ownership.
          // Fence errors are expected during takeover; other heartbeat failures
          // are reported, but both must stop the executor before further writes.
          if (!(error instanceof GenerationTaskLeaseFenceError)) this.reportError(error);
          controller.abort(error);
        }
      }, this.heartbeatMs);
      unrefTimer(heartbeatTimer);
    };
    try {
      // Register the controller before invoking any external wake-up callback.
      // A synchronous stop/abort from that callback must see and fence this
      // already-claimed operation before an executor can begin.
      beforeExecute();
      if (this.stopped || controller.signal.aborted) return;
      scheduleHeartbeat();
      await this.options.executor.execute(claim, controller.signal);
    } finally {
      settled = true;
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      supervisorSignal.removeEventListener("abort", forwardAbort);
      this.executionControllers.delete(controller);
      this.options.store.releaseGenerationTaskAttemptClaims(claim.lease);
    }
  }

  private notifyPlans(planIds: readonly string[]): void {
    for (const planId of new Set(planIds)) this.notifyPlan(planId);
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
        .catch((error) => this.reportError(error))
        .finally(() => this.schedulePoll(this.pollMs));
    }, delayMs);
    unrefTimer(this.pollTimer);
  }

  private startTickLoop(): Promise<void> {
    // Defer the first pass until tickPromise is installed so synchronous
    // recovery/listener callbacks cannot re-enter a second loop.
    const running = Promise.resolve().then(() => this.drainRequestedTicks());
    const tracked = running.finally(() => {
      if (this.tickPromise === tracked) this.tickPromise = null;
      if (this.tickRequested && !this.stopped && this.tickPromise === null) {
        void this.startTickLoop().catch((error) => this.reportError(error));
      }
    });
    this.tickPromise = tracked;
    return tracked;
  }

  private async drainRequestedTicks(): Promise<void> {
    do {
      this.tickRequested = false;
      await this.runTick();
    } while (this.tickRequested && !this.stopped);
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
}
