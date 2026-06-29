import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// Aider — one-shot `--message`, auto-confirm, leave git to Dezin.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["--yes-always", "--no-auto-commits", ...(m ? ["--model", m] : []), "--message", p],
};

/** Aider CLI. No model-list command → seed. */
export const aiderProvider: AgentProvider = {
  id: "aider",
  command: "aider",
  label: "Aider",
  seedModels: [],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "aider", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
