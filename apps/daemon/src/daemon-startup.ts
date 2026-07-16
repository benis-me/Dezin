export interface DaemonGenerationRecoveryLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonStartupOptions {
  readonly generationRecovery: DaemonGenerationRecoveryLifecycle;
  readonly listen: () => void;
  readonly rollback: () => void | Promise<void>;
  readonly signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Daemon startup aborted", "AbortError");
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Keeps HTTP admission behind durable Generation recovery. If recovery cannot
 * establish its lifecycle, abort it before releasing shared startup resources.
 */
export async function startDaemonAfterGenerationRecovery(
  options: DaemonStartupOptions,
): Promise<void> {
  let stopPromise: Promise<void> | null = null;
  const stopRecovery = (): Promise<void> => {
    stopPromise ??= Promise.resolve().then(() => options.generationRecovery.stop());
    return stopPromise;
  };
  const stopOnAbort = (): void => {
    void stopRecovery().catch(() => {});
  };
  options.signal?.addEventListener("abort", stopOnAbort, { once: true });
  try {
    checkAbort(options.signal);
    await options.generationRecovery.start();
    checkAbort(options.signal);
    options.listen();
  } catch (error) {
    await Promise.allSettled([stopRecovery()]);
    await options.rollback();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stopOnAbort);
  }
}
