import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// opencode — `run <prompt>` headless.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["run", ...(m ? ["--model", m] : []), p],
};

/** opencode CLI. No model-list command → seed (empty: it's provider/model-agnostic). */
export const opencodeProvider: AgentProvider = {
  id: "opencode",
  command: "opencode",
  label: "opencode",
  seedModels: [],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "opencode", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
