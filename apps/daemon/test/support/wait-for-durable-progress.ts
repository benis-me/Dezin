import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export interface WaitForDurableProgressOptions<T> {
  readonly description: string;
  readonly read: () => T;
  readonly isSettled: (state: T) => boolean;
  readonly fingerprint: (state: T) => string;
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly wait?: (delayMs: number) => Promise<void>;
}

/**
 * Wait for a durable condition while distinguishing a slow, progressing flow
 * from one that has stopped making observable progress. The hard deadline is
 * never renewed, so a changing fingerprint cannot turn this into an unbounded
 * test wait.
 */
export async function waitForDurableProgress<T>(
  options: WaitForDurableProgressOptions<T>,
): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? ((delayMs: number) => delay(delayMs));
  const pollMs = options.pollMs ?? 10;
  const startedAt = now();
  let lastProgressAt = startedAt;
  let lastFingerprint: string | null = null;

  while (true) {
    const state = options.read();
    if (options.isSettled(state)) return state;

    const observedAt = now();
    const fingerprint = options.fingerprint(state);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastProgressAt = observedAt;
    }

    const elapsedMs = observedAt - startedAt;
    if (elapsedMs >= options.hardTimeoutMs) {
      throw new Error(
        `${options.description} exceeded the ${options.hardTimeoutMs} ms hard deadline`,
      );
    }
    const idleMs = observedAt - lastProgressAt;
    if (idleMs >= options.idleTimeoutMs) {
      throw new Error(
        `${options.description} made no durable progress for ${options.idleTimeoutMs} ms`,
      );
    }

    const remainingMs = Math.min(
      options.hardTimeoutMs - elapsedMs,
      options.idleTimeoutMs - idleMs,
    );
    await wait(Math.max(1, Math.min(pollMs, remainingMs)));
  }
}
