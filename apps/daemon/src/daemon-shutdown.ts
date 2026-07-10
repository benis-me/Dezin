import type http from "node:http";
import type { RuntimeSupervisor } from "./runtime-supervisor.ts";

export interface DaemonShutdownOptions {
  server: http.Server;
  runtimeSupervisor: RuntimeSupervisor;
  closeStore: () => void;
  timeoutMs?: number;
}

function settleBeforeDeadline(promise: Promise<boolean>, deadlineAt: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve(false);
    }, Math.max(0, deadlineAt - Date.now()));
    void promise.then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** Stop admission immediately, then bound every remaining shutdown layer by one deadline. */
export async function shutdownDaemon(options: DaemonShutdownOptions): Promise<boolean> {
  const deadlineAt = Date.now() + (options.timeoutMs ?? 5_000);
  let serverClosed = !options.server.listening;
  const serverSettlement = serverClosed
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        options.server.close((error?: Error) => {
          serverClosed = true;
          resolve(!error);
        });
      });

  try {
    const [runtimeSettled, connectionsSettled] = await Promise.all([
      options.runtimeSupervisor.shutdown(deadlineAt).catch(() => false),
      settleBeforeDeadline(serverSettlement, deadlineAt),
    ]);
    if (!connectionsSettled) options.server.closeAllConnections();
    return runtimeSettled && connectionsSettled;
  } finally {
    if (!serverClosed) options.server.closeAllConnections();
    options.closeStore();
  }
}
