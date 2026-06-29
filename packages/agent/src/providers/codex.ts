import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import { runCapture, dedupModels } from "./cli.ts";
import type { AgentProvider } from "./types.ts";

// `codex exec` runs headless and applies edits directly.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", ...(m ? ["-m", m] : []), p],
};

/** OpenAI Codex CLI. Real models come from `codex debug models` (JSON, uses the CLI's login). */
export const codexProvider: AgentProvider = {
  id: "codex",
  command: "codex",
  label: "Codex",
  seedModels: ["gpt-5-codex", "gpt-5", "o3"],
  genericConfig: config,
  async discoverModels(command) {
    const r = await runCapture(command, ["debug", "models"], 10_000);
    if (!r) return [];
    const start = r.out.indexOf("{");
    if (start === -1) return [];
    try {
      const json = JSON.parse(r.out.slice(start)) as { models?: Array<{ slug?: string; visibility?: string }> };
      const models = Array.isArray(json.models) ? json.models : [];
      return dedupModels(models.filter((m) => m.slug && m.visibility !== "hide" && m.visibility !== "hidden").map((m) => m.slug!));
    } catch {
      return [];
    }
  },
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "codex", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
