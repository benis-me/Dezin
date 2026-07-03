import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// Pi coding agent — one-shot prompt mode, optional model override.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["-p", p, ...(m ? ["--model", m] : [])],
};

/** Pi coding-agent CLI. */
export const piProvider: AgentProvider = {
  id: "pi",
  command: "pi",
  label: "Pi",
  seedModels: [],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "pi", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
