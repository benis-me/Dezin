/**
 * Preference distillation — a local agent reflection pass over the user's 👍/👎
 * feedback that proposes concise preference lines to add to their design instructions.
 * Human-in-loop: this only SUGGESTS; the user approves what gets applied. Nothing is
 * uploaded. Mirrors the headless one-shot spawn used by prompt-optimize / visual-qa.
 */

import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";
import { sendJson, sendError } from "./http-util.ts";
import { buildAgentEnv } from "./agent-env.ts";
import type { AppDeps } from "./app.ts";

export interface FeedbackSignal {
  verdict: "up" | "down";
  gap?: string;
  skill?: string;
}

/** Pure: build the reflection prompt from the feedback signals + current instructions. */
export function buildPreferenceReflectionPrompt(signals: FeedbackSignal[], currentInstructions: string): string {
  const rows = signals
    .map((s) => `- ${s.verdict === "up" ? "KEPT" : "REJECTED"}${s.gap ? ` (off: ${s.gap})` : ""}${s.skill ? ` [${s.skill}]` : ""}`)
    .join("\n");
  return `You are distilling a designer's taste from their feedback on generated designs.

Below is their recent feedback: which designs they KEPT (liked) and which they REJECTED
(with the aspect that was off, and the kind of artifact). Infer their DURABLE preferences
and propose 3–6 concise, specific preference lines to add to their design instructions.

Rules:
- Return ONLY the lines, each starting with "- ". No preamble, no explanation, no fences.
- Be specific and actionable ("Prefer generous whitespace and one restrained accent" — not
  "make it good"). Ground each line in the actual pattern below; invent nothing the feedback
  does not support.
- Do not repeat anything the current instructions already say. If the feedback is too thin to
  support any confident preference, return nothing.

Current instructions:
${currentInstructions.trim() || "(none)"}

Feedback (most recent first):
${rows || "(no feedback yet)"}`;
}

export type PreferenceSuggester = (input: PreferenceSuggestInput) => Promise<string>;

export interface PreferenceSuggestInput {
  signals: FeedbackSignal[];
  currentInstructions: string;
  agentCommand: string;
  model?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Clean the agent's output to bullet lines only. */
export function cleanPreferenceSuggestion(raw: string): string {
  const lines = raw
    .replace(/```[a-z]*\n?|```/gi, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && l.length > 3);
  return lines.slice(0, 6).join("\n");
}

export async function suggestPreferences(input: PreferenceSuggestInput): Promise<string> {
  if (input.signals.length === 0) return "";
  const prompt = buildPreferenceReflectionPrompt(input.signals, input.currentInstructions);
  const provider = getProvider(input.agentCommand);
  const args = provider ? provider.oneShotArgs(input.model, prompt) : ["-p", prompt];
  const out = await spawnText(input.agentCommand, args, input.cwd, 120_000, input.env ?? {});
  return cleanPreferenceSuggestion(out);
}

/** POST /api/preferences/suggest — reflect over feedback, return proposed preference lines. */
export async function handlePreferenceSuggest(_req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const settings = deps.store.getSettings();
  const signals: FeedbackSignal[] = deps.store
    .listFeedbackRuns(50)
    .flatMap((r) => (r.feedback ? [{ verdict: r.feedback.verdict, gap: r.feedback.gap, skill: r.skillId ?? undefined }] : []));
  if (signals.length === 0) return sendJson(res, 200, { suggestion: "", signals: 0 });
  const command = settings.agentCommand || "claude";
  try {
    const suggest = deps.preferenceSuggester ?? suggestPreferences;
    const suggestion = await suggest({
      signals,
      currentInstructions: settings.customInstructions,
      agentCommand: command,
      model: settings.model || undefined,
      cwd: deps.dataDir,
      env: buildAgentEnv(settings, command),
    });
    sendJson(res, 200, { suggestion, signals: signals.length });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "preference reflection failed");
  }
}

function spawnText(command: string, args: string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = agentSpawnEnv(extraEnv);
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env, shell: process.platform === "win32" });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("preference reflection timed out"));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) resolve(stdout);
      else reject(new Error(stderr.trim().slice(0, 200) || `${command} exited with ${code}`));
    });
  });
}
