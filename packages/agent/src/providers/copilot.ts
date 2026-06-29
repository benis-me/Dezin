import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// GitHub Copilot CLI — headless `--allow-all-tools --output-format json`, prompt on stdin.
const config: GenericAgentConfig = {
  viaStdin: true,
  buildArgs: (m) => ["--allow-all-tools", "--output-format", "json", ...(m ? ["--model", m] : [])],
};

/** GitHub Copilot CLI. No model-list command; offers whatever the subscription exposes. */
export const copilotProvider: AgentProvider = {
  id: "copilot",
  command: "copilot",
  label: "GitHub Copilot",
  seedModels: ["claude-sonnet-4.6", "gpt-5.2", "gpt-5"],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "copilot", command, model, config }),
  // Generation pipes the prompt via stdin (config); the one-shot analyzer passes it inline.
  oneShotArgs: (model, prompt) => ["--allow-all-tools", "--output-format", "json", ...(model ? ["--model", model] : []), "-p", prompt],
};

