import type { AppDeps } from "../app.ts";
import { startDesignMainAgentTurn } from "./design-http-handler.ts";
import type { DesignProjectBootstrapExecutionPorts } from "./design-project-bootstrap-http.ts";
import {
  ensureDesignCanvasAssetBatch,
  getDesignCanvas,
} from "./design-storage.ts";

/**
 * Bind the durable bootstrap coordinator to the existing Asset publication and
 * Main Agent authorities. The coordinator never reaches into storage internals;
 * both phases retain their own WAL/receipt semantics behind this adapter.
 */
export function createProductionDesignProjectBootstrapPorts(
  deps: AppDeps,
): DesignProjectBootstrapExecutionPorts {
  return {
    ensureAssetBatch: async (input) => {
      await ensureDesignCanvasAssetBatch(deps.dataDir, input.projectId, {
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        items: [...input.items],
      });
    },
    ensureMainTurn: async (input) => {
      const canvas = await getDesignCanvas(deps.dataDir, input.projectId);
      const started = await startDesignMainAgentTurn(deps, input.projectId, {
        message: input.prompt,
        contextNodeIds: canvas.nodeOrder,
        idempotencyKey: input.idempotencyKey,
        terminalReceiptPolicy: "retry-restart-interrupted",
        ...(input.agent?.agentCommand === undefined ? {} : { agentCommand: input.agent.agentCommand }),
        ...(input.agent?.model === undefined ? {} : { model: input.agent.model }),
      });
      return { jobId: started.job.id };
    },
  };
}
