/**
 * The Research phase — a pre-design agent turn that does designer-grade DeepResearch
 * and writes the project's .research/ directory (report + local assets + provenance +
 * candidate directions). It spawns a headless stream-json agent turn and surfaces its
 * live activity (searching / fetching / downloading / writing) so the workspace can show
 * a Research card. Success is measured by the files the agent produced, not its stdout.
 *
 * There is NO wall-clock timeout by default: enabling research is an explicit opt-in to
 * spend time, so we let it run to completion. The user can still Stop the run (abort
 * signal), and a caller may pass an explicit cap. See docs/DESIGN-PROCESS.md.
 */

import { spawn } from "node:child_process";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";
import {
  buildResearchPrompt,
  ensureResearchScaffold,
  researchExists,
  parseResearchActivity,
  type ResearchActivity,
} from "../../../packages/research/src/index.ts";

export interface ResearchPhaseInput {
  /** The project/variant directory the .research/ tree is written into. */
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
  /** Live steps from the research agent, for the workspace's Research card. */
  onActivity?: (activity: ResearchActivity) => void;
  /** Optional wall-clock cap. Omitted = no timeout (research is an explicit opt-in). */
  timeoutMs?: number;
}

export interface ResearchPhaseResult {
  /** Whether the agent turn actually ran (false = research already existed). */
  ran: boolean;
  /** Whether .research/research.md exists after the phase. */
  produced: boolean;
  error?: string;
}

/** Injectable research runner (AppDeps.researchPhase) so tests can skip the real agent. */
export type ResearchPhaseRunner = (input: ResearchPhaseInput) => Promise<ResearchPhaseResult>;

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
  // Stream-json so we can surface the agent's live steps as they happen; the (long)
  // prompt still rides in argv via oneShotArgs.
  const baseArgs = provider ? provider.oneShotArgs(input.model, prompt) : ["-p", prompt];
  const args = [...baseArgs, "--output-format", "stream-json", "--verbose"];

  try {
    const { code, stderr } = await spawnResearch(input.agentCommand, args, input.dir, {
      env: input.env ?? {},
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      onActivity: input.onActivity,
    });
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

interface SpawnResearchOpts {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onActivity?: (activity: ResearchActivity) => void;
}

function spawnResearch(
  command: string,
  args: string[],
  cwd: string,
  opts: SpawnResearchOpts,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error("research phase aborted"));
    const env = agentSpawnEnv(opts.env);
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env, shell: process.platform === "win32" });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    let stderr = "";
    let stdoutBuffer = "";
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // No timeout unless a caller explicitly asks for one — research is opt-in.
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            cleanup();
            reject(new Error("research phase timed out"));
          }, opts.timeoutMs)
        : null;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    if (opts.onActivity) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        stdoutBuffer += d;
        let nl: number;
        while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
          const line = stdoutBuffer.slice(0, nl);
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
          for (const a of parseResearchActivity(line)) opts.onActivity?.(a);
        }
      });
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      if (opts.signal?.aborted) return reject(new Error("research phase aborted"));
      resolve({ code, stderr });
    });
  });
}
