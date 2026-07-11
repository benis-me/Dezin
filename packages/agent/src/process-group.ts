export class ProcessGroupCleanupError extends Error {
  readonly code = "PROCESS_GROUP_CLEANUP_FAILED";
  readonly groupStillAlive = true;

  constructor(label: string) {
    super(`${label} process group remained alive after SIGKILL`);
    this.name = "ProcessGroupCleanupError";
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
      const timer = setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      timer.unref?.();
    });
  }
  return !options.isAlive();
}

/** TERM, then KILL, and reject instead of claiming cleanup while the group is still alive. */
export async function terminateOwnedProcessGroup(options: OwnedProcessGroupOptions): Promise<void> {
  options.signal("SIGTERM");
  if (await waitUntilGone(options, options.termGraceMs)) return;
  options.signal("SIGKILL");
  if (await waitUntilGone(options, options.killGraceMs)) return;
  throw new ProcessGroupCleanupError(options.label);
}
