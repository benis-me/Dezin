export interface GenerationPlanEventsPort {
  notify(planId: string): void;
  subscribe(planId: string, onWake: () => void): () => void;
}

export interface GenerationPlanEventBrokerOptions {
  readonly onError?: (error: unknown) => void;
}

/**
 * Process-local wake broker for the durable Generation Plan event journal.
 *
 * Notifications deliberately carry no payload: subscribers always replay the
 * authoritative sequenced Store rows after their last cursor. A lost or
 * coalesced notification therefore changes latency only, never correctness.
 */
export class GenerationPlanEventBroker implements GenerationPlanEventsPort {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(options: GenerationPlanEventBrokerOptions = {}) {
    this.onError = options.onError;
  }

  subscribe(planId: string, onWake: () => void): () => void {
    if (typeof planId !== "string" || planId.length === 0) {
      throw new Error("Generation Plan wake subscription requires a Plan id");
    }
    if (typeof onWake !== "function") {
      throw new Error("Generation Plan wake subscription requires a listener");
    }
    const listeners = this.listeners.get(planId) ?? new Set<() => void>();
    listeners.add(onWake);
    this.listeners.set(planId, listeners);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.listeners.get(planId);
      current?.delete(onWake);
      if (current?.size === 0) this.listeners.delete(planId);
    };
  }

  notify(planId: string): void {
    const listeners = this.listeners.get(planId);
    if (listeners === undefined) return;
    // Snapshot before invocation. Reentrant subscribe/unsubscribe operations
    // affect the next wake, not delivery of the already-committed transition.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        try {
          this.onError?.(error);
        } catch {
          // Error reporting is observational and never owns wake delivery.
        }
      }
    }
  }
}
