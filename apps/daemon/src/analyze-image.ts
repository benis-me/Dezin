/**
 * Quick design analysis for the browser extension: run the configured agent's fast model
 * over a captured screenshot and return a one-paragraph recreation brief. The image is
 * written to a throwaway temp dir as `reference.png`; the agent reads it and prints the
 * brief to stdout. Best-effort and bounded by a timeout — the caller falls back to a
 * plain brief if this fails.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";

const ANALYZE_PROMPT =
  "Look at the design screenshot saved as reference.png in this folder. Write ONE concise paragraph (2 to 4 sentences, plain text, no preamble, no markdown, no lists, no code) describing it as a recreation brief for rebuilding it as a responsive web page: its overall layout, type treatment, colour system, key components, and mood. Do not create, edit, or write any files — only print the paragraph.";

export async function analyzeImage(command: string, base64: string, model?: string, timeoutMs = 90_000): Promise<string> {
  const provider = getProvider(command);
  const m = model ?? provider?.fastModel;
  const args = provider ? provider.oneShotArgs(m, ANALYZE_PROMPT) : ["-p", ANALYZE_PROMPT];
  const dir = await mkdtemp(join(tmpdir(), "dezin-analyze-"));
  try {
    await writeFile(join(dir, "reference.png"), Buffer.from(base64, "base64"));
    const out = await spawnText(command, args, dir, timeoutMs);
    const brief = cleanBrief(out);
    if (!brief) throw new Error("the agent returned no brief");
    return brief;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnText(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = agentSpawnEnv();
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("analysis timed out"));
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

/** Strip code fences and pick the longest plain paragraph the agent printed. */
function cleanBrief(raw: string): string {
  const noFences = raw.replace(/```[\s\S]*?```/g, " ");
  const paras = noFences
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 40);
  const best = paras.sort((a, b) => b.length - a.length)[0] ?? noFences.replace(/\s+/g, " ").trim();
  return best.slice(0, 800);
}
