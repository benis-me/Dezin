import type { Run, RunStatus, Store } from "../../../packages/core/src/index.ts";

export type TerminalRunStatus = Extract<RunStatus, "succeeded" | "failed" | "cancelled">;

export type RunSettlementPatch = Partial<
  Pick<Run, "repairRounds" | "lintPassed" | "score" | "findings" | "finishedAt" | "userMessageId" | "assistantMessageId" | "commitHash">
> & {
  event: unknown;
};

export interface RunExecutionOptions {
  store: Store;
  runId: string;
  emit: (event: unknown) => void;
  fallbackEmit: (event: unknown) => void;
  finish: () => void;
  unsubscribe: () => void;
  closeStream: () => void;
}

/** Owns the exactly-once terminal transition and idempotent runtime cleanup for one Run. */
export class RunExecution {
  private disposed = false;
  private terminalEventDelivered = false;
  private pendingTerminalStatus: TerminalRunStatus | null = null;
  private pendingTerminalEvent: unknown;
  private readonly options: RunExecutionOptions;

  constructor(options: RunExecutionOptions) {
    this.options = options;
  }

  settle(status: TerminalRunStatus, patch: RunSettlementPatch): { changed: boolean; run: Run } {
    const { event, ...runPatch } = patch;
    // Record the intended event before the Store call. A Store adapter can durably transition and
    // still throw before returning; a retry must then emit the same terminal event exactly once.
    if (!this.terminalEventDelivered) {
      this.pendingTerminalStatus = status;
      this.pendingTerminalEvent = event;
    }
    const result = this.options.store.terminalizeRun(this.options.runId, status, runPatch);
    if (result.changed) {
      this.pendingTerminalStatus = status;
      this.pendingTerminalEvent = event;
    }
    if (
      result.run.status === status &&
      this.pendingTerminalStatus === status &&
      !this.terminalEventDelivered
    ) {
      const terminalEvent = this.pendingTerminalEvent;
      try {
        this.options.emit(terminalEvent);
        this.terminalEventDelivered = true;
      } catch (primaryError) {
        try {
          this.options.fallbackEmit(terminalEvent);
          this.terminalEventDelivered = true;
        } catch (fallbackError) {
          throw new AggregateError([primaryError, fallbackError], "Failed to emit terminal Run event");
        }
      }
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of [this.options.finish, this.options.unsubscribe, this.options.closeStream]) {
      try {
        cleanup();
      } catch {
        // Cleanup is best-effort and independent: one failed step must not skip the others.
      }
    }
  }
}
