import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// Trae Agent — `trae-cli run <prompt>`, with provider/model usually configured in trae_config.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["run", p, ...(m ? ["--model", m] : [])],
};

/** ByteDance Trae Agent CLI. */
export const traeProvider: AgentProvider = {
  id: "trae",
  command: "trae-cli",
  label: "Trae CLI",
  seedModels: [],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "trae", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
