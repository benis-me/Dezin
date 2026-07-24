import { ClaudeCodeRunner } from "../claude-runner.ts";
import type { AgentProvider } from "./types.ts";

/** Claude Code — the rich stream-json runner. No model-list command, so offer its stable
 *  aliases (opus/sonnet/haiku resolve to the latest). */
export const claudeProvider: AgentProvider = {
  id: "claude",
  command: "claude",
  label: "Claude Code",
  seedModels: ["opus", "sonnet", "haiku"],
  fastModel: "haiku",
  createRunner: ({ command, model, enforceArtifactUpdate, spawner, buildArgs }) =>
    new ClaudeCodeRunner({ command, model, enforceArtifactUpdate, spawner, buildArgs }),
  oneShotArgs: (model, prompt) => ["-p", prompt, "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : [])],
};
