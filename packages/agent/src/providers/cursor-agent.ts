import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// Cursor agent CLI — `-p`/--print headless mode.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => [...(m ? ["--model", m] : []), "-p", p],
};

/** Cursor Agent CLI. No model-list command → seed. */
export const cursorAgentProvider: AgentProvider = {
  id: "cursor-agent",
  command: "cursor-agent",
  label: "Cursor Agent",
  seedModels: ["gpt-5", "sonnet-4", "opus-4"],
  genericConfig: config,
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "cursor-agent", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
