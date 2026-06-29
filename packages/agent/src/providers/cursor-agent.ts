import { GenericCliRunner, type GenericAgentConfig } from "../generic-runner.ts";
import { runCapture } from "./cli.ts";
import type { AgentProvider } from "./types.ts";

// Cursor agent CLI — `-p`/--print headless mode.
const config: GenericAgentConfig = {
  buildArgs: (m, p) => [...(m ? ["--model", m] : []), "-p", p],
};

/** Parse `cursor-agent models` output (one account-bound id per line). When the user isn't
 *  authed the CLI prints a sign-in TUI / "No models available" — neither parses, so → []. */
function parseCursorModels(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed || /no models available/i.test(trimmed)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of trimmed.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^(available models|models)$/i.test(line)) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._/:@-]*)(?:\s+-\s+.+)?$/.exec(line);
    const id = m?.[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Cursor Agent CLI. `cursor-agent models` lists the account's models when authed. */
export const cursorAgentProvider: AgentProvider = {
  id: "cursor-agent",
  command: "cursor-agent",
  label: "Cursor Agent",
  seedModels: ["auto", "sonnet-4", "gpt-5", "opus-4"],
  genericConfig: config,
  async discoverModels(command) {
    const r = await runCapture(command, ["models"], 5000);
    return r ? parseCursorModels(r.out) : [];
  },
  createRunner: ({ command, model }) => new GenericCliRunner({ id: "cursor-agent", command, model, config }),
  oneShotArgs: (model, prompt) => config.buildArgs(model, prompt),
};
