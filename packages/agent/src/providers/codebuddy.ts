import { ClaudeCodeRunner } from "../claude-runner.ts";
import { runCapture, dedupModels } from "./cli.ts";
import type { AgentProvider } from "./types.ts";

/** CodeBuddy — a Claude-Code fork that speaks the same stream-json protocol, so it reuses
 *  ClaudeCodeRunner. Its real account model list is printed in `--help`. */
export const codebuddyProvider: AgentProvider = {
  id: "codebuddy",
  command: "codebuddy",
  label: "CodeBuddy",
  seedModels: ["claude-opus-4.8", "claude-sonnet-4.6", "claude-haiku-4.5"],
  fastModel: "claude-haiku-4.5",
  async discoverModels(command) {
    const r = await runCapture(command, ["--help"], 4000);
    if (!r) return [];
    const m = /Currently supported:\s*\(([^)]+)\)/i.exec(r.out);
    if (!m || !m[1]) return [];
    return dedupModels(m[1].split(",").map((s) => s.trim()));
  },
  createRunner: ({ command, model }) => new ClaudeCodeRunner({ command, model }),
  oneShotArgs: (model, prompt) => ["-p", prompt, "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : [])],
};
