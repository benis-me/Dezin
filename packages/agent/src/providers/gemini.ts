import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import { dedupModels } from "./cli.ts";
import type { AgentProvider } from "./types.ts";

// `-p` non-interactive, `--yolo` auto-approves tool calls.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => ["--yolo", ...(m ? ["-m", m] : []), "-p", p],
};

/** Gemini CLI. The CLI has no model-list command; the Generative Language API does, so we
 *  use it when GEMINI_API_KEY/GOOGLE_API_KEY is set, otherwise the seed. */
export const geminiProvider: AgentProvider = {
  id: "gemini",
  command: "gemini",
  label: "Gemini CLI",
  seedModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  genericConfig: config,
  async discoverModels() {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) return [];
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      return dedupModels((json.models ?? []).map((m) => (m.name ?? "").replace(/^models\//, "")).filter((n) => /gemini|gemma/i.test(n)));
    } catch {
      return [];
    }
  },
  createRunner: ({ command, model, enforceArtifactUpdate }) => new GenericCliRunner({ id: "gemini", command, model, config, enforceArtifactUpdate }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
