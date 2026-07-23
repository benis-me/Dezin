import type {
  GenerationTaskRecoverySummary,
  ResourcePayloadRecoveryCursor,
} from "../../../../packages/core/src/index.ts";
import type { ArtifactCandidateRefRecoverySummary } from "./artifact-candidate-ref-recovery.ts";
import type {
  ResourceTaskPayloadRecoveryPort,
  ResourceTaskPayloadRecoveryResult,
} from "./resource-task-payload-recovery.ts";
import type {
  GenerationTaskEvidenceRecoverySummary,
} from "./generation-task-evidence-lifecycle.ts";
import {
  recoverGenerationPlans,
  type GenerationPlanRecoveryDeps,
} from "./recovery.ts";

export interface GenerationRuntimeScheduler {
  start(): void;
  stop(): Promise<void>;
}

export interface GenerationRuntimeArtifactRefRecovery {
  recover(signal: AbortSignal): Promise<ArtifactCandidateRefRecoverySummary>;
}

export interface GenerationRuntimeEvidenceRecovery {
  recover(signal: AbortSignal): Promise<GenerationTaskEvidenceRecoverySummary>;
}

export interface GenerationRuntimeTimerPort {
  schedule(delayMs: number, callback: () => void): { cancel(): void };
}

export type GenerationRuntimeRecoveryEvent =
  | {
    readonly phase: "startup-plan-recovery";
    readonly summary: GenerationTaskRecoverySummary;
  }
  | {
    readonly phase: "startup-artifact-ref-recovery" | "periodic-artifact-ref-recovery";
    readonly summary: ArtifactCandidateRefRecoverySummary;
  }
  | {
    readonly phase: "startup-resource-payload-recovery" | "periodic-resource-payload-recovery";
    readonly summary: ResourceTaskPayloadRecoveryResult;
  }
  | {
    readonly phase: "startup-generation-evidence-recovery" | "periodic-generation-evidence-recovery";
    readonly summary: GenerationTaskEvidenceRecoverySummary;
  };

export interface GenerationRuntimeErrorEvent {
  readonly operation:
    | "startup-artifact-ref-recovery"
    | "periodic-artifact-ref-recovery"
    | "startup-resource-payload-recovery"
    | "periodic-resource-payload-recovery"
    | "startup-generation-evidence-recovery"
    | "periodic-generation-evidence-recovery"
    | "startup"
    | "scheduler-stop"
    | "store-close";
  readonly error: unknown;
}

export interface GenerationRuntimeOptions {
  readonly planRecovery: GenerationPlanRecoveryDeps;
  readonly artifactRefRecovery: GenerationRuntimeArtifactRefRecovery;
  readonly resourcePayloadRecovery?: ResourceTaskPayloadRecoveryPort;
  readonly evidenceRecovery?: GenerationRuntimeEvidenceRecovery;
  readonly scheduler: GenerationRuntimeScheduler;
  /**
   * Optional ownership hook for standalone runtimes. The daemon production
   * composition deliberately omits it because daemon shutdown owns the shared
   * Store and must close it only after every subsystem has stopped.
   */
  readonly closeStore?: () => void | Promise<void>;
  readonly timers?: GenerationRuntimeTimerPort;
  readonly artifactRefRecoveryIntervalMs?: number;
  readonly resourcePayloadRecoveryLimit?: number;
  readonly onRecovery?: (event: GenerationRuntimeRecoveryEvent) => void;
  readonly onError?: (event: GenerationRuntimeErrorEvent) => void;
}

export interface GenerationRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_ARTIFACT_REF_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_RESOURCE_PAYLOAD_RECOVERY_LIMIT = 100;

const systemTimers: GenerationRuntimeTimerPort = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

function positiveInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_ARTIFACT_REF_RECOVERY_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error("Artifact ref recovery interval must be a positive safe integer");
  }
  return interval;
}

function resourceRecoveryLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RESOURCE_PAYLOAD_RECOVERY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Resource payload recovery limit must be a safe integer from 1 through 1000");
  }
  return limit;
}

function nextResourceCursor(
  value: ResourcePayloadRecoveryCursor | null,
): ResourcePayloadRecoveryCursor | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 2
    || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0
    || !Number.isSafeInteger(value.throughSequence) || value.throughSequence < 1
    || value.afterSequence > value.throughSequence) {
    throw new Error("Resource payload recovery returned an invalid cursor");
  }
  return Object.freeze({
    afterSequence: value.afterSequence,
    throughSequence: value.throughSequence,
  });
}

class DefaultGenerationRuntime implements GenerationRuntime {
  private readonly options: GenerationRuntimeOptions;
  private readonly timers: GenerationRuntimeTimerPort;
  private readonly recoveryIntervalMs: number;
  private readonly resourcePayloadRecoveryLimit: number;
  private readonly controller = new AbortController();
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private periodicRecovery: Promise<void> | null = null;
  private recoveryTimer: { cancel(): void } | null = null;
  private resourcePayloadCursor: ResourcePayloadRecoveryCursor | null = null;
  private state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";

  constructor(options: GenerationRuntimeOptions) {
    this.options = options;
    this.timers = options.timers ?? systemTimers;
    this.recoveryIntervalMs = positiveInterval(options.artifactRefRecoveryIntervalMs);
    this.resourcePayloadRecoveryLimit = resourceRecoveryLimit(options.resourcePayloadRecoveryLimit);
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise;
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(new Error("GenerationRuntime cannot restart after stop"));
    }
    this.state = "starting";
    this.startPromise = this.performStart();
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.state = "stopping";
    this.controller.abort(new Error("GenerationRuntime stopped"));
    this.recoveryTimer?.cancel();
    this.recoveryTimer = null;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStart(): Promise<void> {
    const planSummary = await recoverGenerationPlans(this.options.planRecovery);
    this.observeRecovery({ phase: "startup-plan-recovery", summary: planSummary });
    if (this.controller.signal.aborted) return;

    await this.runArtifactRefRecovery(
      "startup-artifact-ref-recovery",
      "startup-artifact-ref-recovery",
    );
    if (this.controller.signal.aborted) return;

    await this.runResourcePayloadRecovery(
      "startup-resource-payload-recovery",
      "startup-resource-payload-recovery",
    );
    if (this.controller.signal.aborted) return;

    await this.runEvidenceRecovery(
      "startup-generation-evidence-recovery",
      "startup-generation-evidence-recovery",
    );
    if (this.controller.signal.aborted) return;

    this.options.scheduler.start();
    this.state = "running";
    this.schedulePeriodicRecovery();
  }

  private async performStop(): Promise<void> {
    if (this.startPromise !== null) {
      try {
        await this.startPromise;
      } catch (error) {
        this.reportError({ operation: "startup", error });
      }
    }

    try {
      await this.options.scheduler.stop();
    } catch (error) {
      this.reportError({ operation: "scheduler-stop", error });
    }

    if (this.periodicRecovery !== null) {
      await Promise.allSettled([this.periodicRecovery]);
    }

    if (this.options.closeStore !== undefined) {
      try {
        await this.options.closeStore();
      } catch (error) {
        this.reportError({ operation: "store-close", error });
      }
    }
    this.state = "stopped";
  }

  private schedulePeriodicRecovery(): void {
    if (this.state !== "running" || this.controller.signal.aborted || this.recoveryTimer !== null) return;
    this.recoveryTimer = this.timers.schedule(this.recoveryIntervalMs, () => {
      this.recoveryTimer = null;
      if (this.state !== "running" || this.controller.signal.aborted || this.periodicRecovery !== null) return;
      const recovery = this.runPeriodicRecovery().finally(() => {
        if (this.periodicRecovery === recovery) this.periodicRecovery = null;
        this.schedulePeriodicRecovery();
      });
      this.periodicRecovery = recovery;
      void recovery;
    });
  }

  private async runPeriodicRecovery(): Promise<void> {
    await this.runArtifactRefRecovery(
      "periodic-artifact-ref-recovery",
      "periodic-artifact-ref-recovery",
    );
    if (this.controller.signal.aborted) return;
    await this.runResourcePayloadRecovery(
      "periodic-resource-payload-recovery",
      "periodic-resource-payload-recovery",
    );
    if (this.controller.signal.aborted) return;
    await this.runEvidenceRecovery(
      "periodic-generation-evidence-recovery",
      "periodic-generation-evidence-recovery",
    );
  }

  private async runArtifactRefRecovery(
    phase: "startup-artifact-ref-recovery" | "periodic-artifact-ref-recovery",
    operation: GenerationRuntimeErrorEvent["operation"],
  ): Promise<void> {
    try {
      const summary = await this.options.artifactRefRecovery.recover(this.controller.signal);
      if (!this.controller.signal.aborted) this.observeRecovery({ phase, summary });
    } catch (error) {
      if (!this.controller.signal.aborted) this.reportError({ operation, error });
    }
  }

  private async runResourcePayloadRecovery(
    phase: "startup-resource-payload-recovery" | "periodic-resource-payload-recovery",
    operation: GenerationRuntimeErrorEvent["operation"],
  ): Promise<void> {
    if (this.options.resourcePayloadRecovery === undefined) return;
    try {
      const summary = await this.options.resourcePayloadRecovery.recover({
        cursor: this.resourcePayloadCursor,
        limit: this.resourcePayloadRecoveryLimit,
        signal: this.controller.signal,
      });
      if (this.controller.signal.aborted) return;
      this.resourcePayloadCursor = nextResourceCursor(summary.nextCursor);
      this.observeRecovery({ phase, summary });
    } catch (error) {
      if (!this.controller.signal.aborted) this.reportError({ operation, error });
    }
  }

  private async runEvidenceRecovery(
    phase: "startup-generation-evidence-recovery" | "periodic-generation-evidence-recovery",
    operation: GenerationRuntimeErrorEvent["operation"],
  ): Promise<void> {
    if (this.options.evidenceRecovery === undefined) return;
    try {
      const summary = await this.options.evidenceRecovery.recover(this.controller.signal);
      if (!this.controller.signal.aborted) this.observeRecovery({ phase, summary });
    } catch (error) {
      if (!this.controller.signal.aborted) this.reportError({ operation, error });
    }
  }

  private observeRecovery(event: GenerationRuntimeRecoveryEvent): void {
    try {
      this.options.onRecovery?.(event);
    } catch {
      // Lifecycle observation is best-effort and cannot own admission.
    }
  }

  private reportError(event: GenerationRuntimeErrorEvent): void {
    try {
      this.options.onError?.(event);
    } catch {
      // Error observation is best-effort and cannot own shutdown.
    }
  }
}

/**
 * Creates one process-lifetime Generation runtime. Restart recovery is achieved
 * by constructing a new instance against the same durable Store and Git refs.
 */
export function createGenerationRuntime(options: GenerationRuntimeOptions): GenerationRuntime {
  return new DefaultGenerationRuntime(options);
}
