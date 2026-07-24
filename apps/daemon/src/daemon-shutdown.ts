import type http from "node:http";
import type { GenerationRuntime } from "./orchestration/generation-runtime.ts";
import type { RuntimeSupervisor } from "./runtime-supervisor.ts";
import { abortAgentScans } from "./agents-handler.ts";

export interface DaemonShutdownOptions {
  server: http.Server;
  generationRuntime?: Pick<GenerationRuntime, "stop">;
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
  const agentScanSettlement = abortAgentScans().then(() => true, () => false);
  let serverClosed = !options.server.listening;
  const serverSettlement = serverClosed
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        options.server.close((error?: Error) => {
          serverClosed = true;
          resolve(!error);
        });
      });

  // Stop Generation admission first. RuntimeSupervisor shutdown is invoked
  // immediately afterwards so both layers share the same deadline and can
  // cooperatively abort already-admitted work without permitting a new poll.
  let generationSettlement: Promise<boolean>;
  try {
    generationSettlement = options.generationRuntime === undefined
      ? Promise.resolve(true)
      : Promise.resolve(options.generationRuntime.stop()).then(() => true, () => false);
  } catch {
    generationSettlement = Promise.resolve(false);
  }
  const runtimeSettlement = options.runtimeSupervisor.shutdown(deadlineAt).catch(() => false);

  try {
    const [agentScansSettled, generationSettled, runtimeSettled, connectionsSettled] = await Promise.all([
      settleBeforeDeadline(agentScanSettlement, deadlineAt),
      settleBeforeDeadline(generationSettlement, deadlineAt),
      settleBeforeDeadline(runtimeSettlement, deadlineAt),
      settleBeforeDeadline(serverSettlement, deadlineAt),
    ]);
    if (!connectionsSettled) options.server.closeAllConnections();
    return agentScansSettled && generationSettled && runtimeSettled && connectionsSettled;
  } finally {
    if (!serverClosed) options.server.closeAllConnections();
    options.closeStore();
  }
}
