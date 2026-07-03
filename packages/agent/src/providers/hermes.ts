import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// Hermes Agent — one-shot final response, auto-approve prompts, optional model override.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["--yolo", ...(m ? ["-m", m] : []), "-z", p],
};

/** Hermes Agent CLI. */
export const hermesProvider: AgentProvider = {
  id: "hermes",
  command: "hermes",
  label: "Hermes",
  seedModels: [],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "hermes", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
