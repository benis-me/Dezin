import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";

// Qwen Code is a Gemini-CLI fork — same `--yolo` non-interactive mode + `-m`/`-p`.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["--yolo", ...(m ? ["-m", m] : []), "-p", p],
};

/** Qwen Code CLI (Alibaba). No model-list command → seed. */
export const qwenProvider: AgentProvider = {
  id: "qwen",
  command: "qwen",
  label: "Qwen Code",
  seedModels: ["qwen3-coder-plus", "qwen3-coder-flash"],
  genericConfig: config,
  createRunner: ({ command, model, enforceArtifactUpdate }) => new GenericCliRunner({ id: "qwen", command, model, config, enforceArtifactUpdate }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
