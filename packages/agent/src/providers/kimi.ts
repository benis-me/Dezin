import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// Kimi Code CLI — print-mode one-shot, auto-approve tool calls, optional model override.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["--quiet", "--yolo", ...(m ? ["-m", m] : []), "-p", p],
};

/** Kimi Code CLI. Models are configured in the CLI, so Dezin uses the default unless overridden. */
export const kimiProvider: AgentProvider = {
  id: "kimi",
  command: "kimi",
  label: "Kimi CLI",
  seedModels: [],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "kimi", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
