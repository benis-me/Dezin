import type {
  GenerationRuntimeArtifactRefRecovery,
  GenerationRuntimeEvidenceRecovery,
  GenerationRuntimeErrorEvent,
  GenerationRuntimeRecoveryEvent,
  GenerationRuntimeTimerPort,
} from "./generation-runtime.ts";
import type { ResourcePayloadRecoveryCursor } from "../../../../packages/core/src/index.ts";
import type {
  ResourceTaskPayloadRecoveryPort,
  ResourceTaskPayloadRecoveryResult,
} from "./resource-task-payload-recovery.ts";

export interface GenerationRecoveryBarrier {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface GenerationRecoveryBarrierOptions {
  readonly artifactRefRecovery: GenerationRuntimeArtifactRefRecovery;
  readonly resourcePayloadRecovery: ResourceTaskPayloadRecoveryPort;
  readonly evidenceRecovery?: GenerationRuntimeEvidenceRecovery;
  readonly timers?: GenerationRuntimeTimerPort;
  readonly intervalMs?: number;
  readonly resourcePayloadRecoveryLimit?: number;
  readonly onRecovery?: (event: GenerationRuntimeRecoveryEvent) => void;
  readonly onError?: (event: GenerationRuntimeErrorEvent) => void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_RESOURCE_LIMIT = 100;

const systemTimers: GenerationRuntimeTimerPort = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

function safePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function cleanupLimit(value: number | undefined): number {
  const limit = safePositiveInteger(value, DEFAULT_RESOURCE_LIMIT, "Resource payload recovery limit");
  if (limit > 1_000) throw new Error("Resource payload recovery limit must not exceed 1000");
  return limit;
}

function exactCursor(
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

class DefaultGenerationRecoveryBarrier implements GenerationRecoveryBarrier {
  readonly #options: GenerationRecoveryBarrierOptions;
  readonly #timers: GenerationRuntimeTimerPort;
  readonly #intervalMs: number;
  readonly #resourceLimit: number;
  readonly #controller = new AbortController();
  #state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #maintenancePromise: Promise<void> | null = null;
  #timer: { cancel(): void } | null = null;
  #resourceCursor: ResourcePayloadRecoveryCursor | null = null;

  constructor(options: GenerationRecoveryBarrierOptions) {
    this.#options = options;
    this.#timers = options.timers ?? systemTimers;
    this.#intervalMs = safePositiveInteger(
      options.intervalMs,
      DEFAULT_INTERVAL_MS,
      "Generation recovery interval",
    );
    this.#resourceLimit = cleanupLimit(options.resourcePayloadRecoveryLimit);
  }

  start(): Promise<void> {
    if (this.#startPromise !== null) return this.#startPromise;
    if (this.#state === "stopping" || this.#state === "stopped") {
      return Promise.reject(new Error("GenerationRecoveryBarrier cannot restart after stop"));
    }
    this.#state = "starting";
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#state = "stopping";
    this.#controller.abort(new Error("GenerationRecoveryBarrier stopped"));
    this.#timer?.cancel();
    this.#timer = null;
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #start(): Promise<void> {
    await this.#recoverArtifactRefs("startup-artifact-ref-recovery");
    if (this.#controller.signal.aborted) return;
    await this.#recoverResourcePayloads("startup-resource-payload-recovery");
    if (this.#controller.signal.aborted) return;
    await this.#recoverEvidence("startup-generation-evidence-recovery");
    if (this.#controller.signal.aborted) return;
    this.#state = "running";
    this.#schedule();
  }

  async #stop(): Promise<void> {
    if (this.#startPromise !== null) await Promise.allSettled([this.#startPromise]);
    if (this.#maintenancePromise !== null) {
      await Promise.allSettled([this.#maintenancePromise]);
    }
    this.#state = "stopped";
  }

  #schedule(): void {
    if (this.#state !== "running" || this.#controller.signal.aborted || this.#timer !== null) return;
    this.#timer = this.#timers.schedule(this.#intervalMs, () => {
      this.#timer = null;
      if (this.#state !== "running" || this.#controller.signal.aborted
        || this.#maintenancePromise !== null) return;
      const maintenance = this.#runMaintenance().finally(() => {
        if (this.#maintenancePromise === maintenance) this.#maintenancePromise = null;
        this.#schedule();
      });
      this.#maintenancePromise = maintenance;
      void maintenance;
    });
  }

  async #runMaintenance(): Promise<void> {
    await this.#recoverArtifactRefs("periodic-artifact-ref-recovery");
    if (this.#controller.signal.aborted) return;
    await this.#recoverResourcePayloads("periodic-resource-payload-recovery");
    if (this.#controller.signal.aborted) return;
    await this.#recoverEvidence("periodic-generation-evidence-recovery");
  }

  async #recoverArtifactRefs(
    phase: "startup-artifact-ref-recovery" | "periodic-artifact-ref-recovery",
  ): Promise<void> {
    try {
      const summary = await this.#options.artifactRefRecovery.recover(this.#controller.signal);
      if (!this.#controller.signal.aborted) this.#observe({ phase, summary });
    } catch (error) {
      if (!this.#controller.signal.aborted) this.#report({ operation: phase, error });
    }
  }

  async #recoverResourcePayloads(
    phase: "startup-resource-payload-recovery" | "periodic-resource-payload-recovery",
  ): Promise<void> {
    try {
      const summary: ResourceTaskPayloadRecoveryResult = await this.#options.resourcePayloadRecovery.recover({
        cursor: this.#resourceCursor,
        limit: this.#resourceLimit,
        signal: this.#controller.signal,
      });
      if (this.#controller.signal.aborted) return;
      this.#resourceCursor = exactCursor(summary.nextCursor);
      this.#observe({ phase, summary });
    } catch (error) {
      if (!this.#controller.signal.aborted) this.#report({ operation: phase, error });
    }
  }

  async #recoverEvidence(
    phase: "startup-generation-evidence-recovery" | "periodic-generation-evidence-recovery",
  ): Promise<void> {
    if (this.#options.evidenceRecovery === undefined) return;
    try {
      const summary = await this.#options.evidenceRecovery.recover(this.#controller.signal);
      if (!this.#controller.signal.aborted) this.#observe({ phase, summary });
    } catch (error) {
      if (!this.#controller.signal.aborted) this.#report({ operation: phase, error });
    }
  }

  #observe(event: GenerationRuntimeRecoveryEvent): void {
    try { this.#options.onRecovery?.(event); } catch { /* best-effort observation */ }
  }

  #report(event: GenerationRuntimeErrorEvent): void {
    try { this.#options.onError?.(event); } catch { /* best-effort observation */ }
  }
}

export function createGenerationRecoveryBarrier(
  options: GenerationRecoveryBarrierOptions,
): GenerationRecoveryBarrier {
  return new DefaultGenerationRecoveryBarrier(options);
}
