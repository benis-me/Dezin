/**
 * The Research phase — a pre-design agent turn that does designer-grade DeepResearch
 * and writes the project's research/ directory (report + local assets + provenance +
 * candidate directions). It reuses the same headless-agent spawn primitive as visual
 * QA (oneShotArgs bypass-permissions turn), but success is measured by the files the
 * agent produced, not its stdout. Additive and opt-in: callers gate it behind an
 * explicit flag so the shipped single-shot path is unaffected. See docs/DESIGN-PROCESS.md.
 */

import { spawn } from "node:child_process";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";
import { buildResearchPrompt, ensureResearchScaffold, researchExists } from "../../../packages/research/src/index.ts";

export interface ResearchPhaseInput {
  /** The project/variant directory the research/ tree is written into. */
  dir: string;
  /** The (visible) brief to research. */
  brief: string;
  /** The selected skill, with research angles if the skill provides them. */
  skill?: { id: string; name: string; researchAngles?: string[] };
  /** Active design system name — research within the brand's spirit. */
  designSystemName?: string;
  /** Whether the user attached their own references (moodboard/files). */
  hasUserReferences?: boolean;
  agentCommand: string;
  model?: string;
  /** Agent env (API keys etc.), from buildAgentEnv(settings, command). */
  env?: NodeJS.ProcessEnv;
  /** Aborts the phase (run cancellation). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ResearchPhaseResult {
  /** Whether the agent turn actually ran (false = research already existed). */
  ran: boolean;
  /** Whether research/research.md exists after the phase. */
  produced: boolean;
  error?: string;
}

/** Web research + downloads + writing several files legitimately takes minutes. */
const DEFAULT_RESEARCH_TIMEOUT_MS = 8 * 60_000;

export async function runResearchPhase(input: ResearchPhaseInput): Promise<ResearchPhaseResult> {
  if (researchExists(input.dir)) return { ran: false, produced: true };
  await ensureResearchScaffold(input.dir);

  const prompt = buildResearchPrompt({
    brief: input.brief,
    skill: input.skill,
    designSystemName: input.designSystemName,
    hasUserReferences: input.hasUserReferences,
  });
  const provider = getProvider(input.agentCommand);
  const args = provider ? provider.oneShotArgs(input.model, prompt) : ["-p", prompt];

  try {
    const { code, stderr } = await spawnResearch(
      input.agentCommand,
      args,
      input.dir,
      input.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS,
      input.env ?? {},
      input.signal,
    );
    const produced = researchExists(input.dir);
    return {
      ran: true,
      produced,
      error: produced ? undefined : stderr.trim().slice(0, 200) || `${input.agentCommand} exited with ${code}`,
    };
  } catch (err) {
    return {
      ran: true,
      produced: researchExists(input.dir),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function spawnResearch(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("research phase aborted"));
    const env = agentSpawnEnv(extraEnv);
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"], env, shell: process.platform === "win32" });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    let stderr = "";
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("research phase timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted) return reject(new Error("research phase aborted"));
      resolve({ code, stderr });
    });
  });
}
