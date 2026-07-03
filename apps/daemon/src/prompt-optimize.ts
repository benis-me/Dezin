import { spawn } from "node:child_process";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";

export interface PromptOptimizeInput {
  prompt: string;
  agentCommand: string;
  model?: string;
  mode?: "prototype" | "standard";
  skillId?: string;
  designSystemId?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type PromptOptimizer = (input: PromptOptimizeInput) => Promise<string>;

function buildPrompt(input: PromptOptimizeInput): string {
  const mode = input.mode === "standard" ? "Standard Vite/React project" : input.mode === "prototype" ? "Prototype single-file artifact" : "the selected Dezin mode";
  return `You optimize user prompts for Dezin, a local-first design generation app.

Rewrite the user's prompt into a stronger launch prompt for ${mode}.

Rules:
- Return ONLY the improved prompt text. No preamble, no markdown fence, no explanation.
- Preserve the user's core intent, domain, language constraints, and any named technologies.
- Make vague requests concrete: name the experience, audience, sections, interaction/motion expectations, asset expectations, quality bar, and verification checks.
- Do not invent source URLs, local files, or claims that assets already exist.
- If the user asks for online assets, explicitly require real sourced assets and source notes.
- Keep it concise enough to paste into Dezin: normally 250-650 words.
- Prefer decisive instructions over optional suggestions.

Context:
- mode: ${input.mode ?? "selected"}
- skillId: ${input.skillId ?? "selected"}
- designSystemId: ${input.designSystemId ?? "selected"}

User prompt:
${input.prompt.trim()}`;
}

function cleanOptimizedPrompt(raw: string): string {
  const stripped = raw
    .replace(/```(?:text|markdown|md)?\s*([\s\S]*?)```/gi, "$1")
    .replace(/^\s*(?:optimized prompt|improved prompt|prompt)\s*:\s*/i, "")
    .trim();
  return stripped.replace(/\n{4,}/g, "\n\n").slice(0, 8000).trim();
}

function spawnText(command: string, args: string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
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
      reject(new Error("prompt optimization timed out"));
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
      else reject(new Error(stderr.trim().slice(0, 240) || `${command} exited with ${code}`));
    });
  });
}

export async function optimizePrompt(input: PromptOptimizeInput): Promise<string> {
  const provider = getProvider(input.agentCommand);
  const prompt = buildPrompt(input);
  const args = provider ? provider.oneShotArgs(input.model || provider.fastModel, prompt) : ["-p", prompt];
  const out = await spawnText(input.agentCommand, args, input.cwd, 120_000, input.env);
  const optimized = cleanOptimizedPrompt(out);
  if (!optimized) throw new Error("the agent returned an empty optimized prompt");
  return optimized;
}
