export class ProcessGroupCleanupError extends Error {
  readonly code = "PROCESS_GROUP_CLEANUP_FAILED";
  readonly groupStillAlive = true;
  readonly whenGone: Promise<void>;

  constructor(label: string, whenGone: Promise<void>) {
    super(`${label} process group remained alive after SIGKILL`);
    this.name = "ProcessGroupCleanupError";
    this.whenGone = whenGone;
  }
}

export interface OwnedProcessGroupOptions {
  label: string;
  signal(value: NodeJS.Signals): void;
  isAlive(): boolean;
  termGraceMs: number;
  killGraceMs: number;
  pollMs?: number;
}

async function waitUntilGone(options: OwnedProcessGroupOptions, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const pollMs = Math.max(1, options.pollMs ?? 10);
  while (options.isAlive() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      // This bounded wait is part of the caller's cleanup contract. Keeping it
      // referenced prevents Node from exiting after the child closes while the
      // caller is still awaiting confirmation that its process group is gone.
      setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    });
  }
  return !options.isAlive();
}

async function waitUntilEventuallyGone(options: OwnedProcessGroupOptions): Promise<void> {
  // Let the caller observe the cleanup error before this becomes a background,
  // unref'ed reaper. This keeps immediate `whenGone` consumers deterministic
  // without making a permanently stuck process group hold the daemon open.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pollMs = Math.max(50, options.pollMs ?? 100);
  while (options.isAlive()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      timer.unref?.();
    });
  }
}

/** TERM, then KILL, and reject instead of claiming cleanup while the group is still alive. */
export async function terminateOwnedProcessGroup(options: OwnedProcessGroupOptions): Promise<void> {
  options.signal("SIGTERM");
  if (await waitUntilGone(options, options.termGraceMs)) return;
  options.signal("SIGKILL");
  if (await waitUntilGone(options, options.killGraceMs)) return;
  const whenGone = waitUntilEventuallyGone(options);
  void whenGone.catch(() => {});
  throw new ProcessGroupCleanupError(options.label, whenGone);
}
