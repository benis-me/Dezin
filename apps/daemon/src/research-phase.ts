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
import { mkdir, rm } from "node:fs/promises";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";
import {
  buildResearchPrompt,
  buildVisualResearchPrompt,
  buildSynthesisPrompt,
  ensureResearchScaffold,
  resetResearchBundle,
  directionsDir,
  chosenPath,
  visualAssetsDir,
  validateResearchBundle,
  parseResearchActivity,
  type ResearchActivity,
  type ResearchBundleIssue,
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
  onActivity?: (activity: TrackedResearchActivity) => void;
  /** Optional wall-clock cap. Omitted = no timeout (research is an explicit opt-in). */
  timeoutMs?: number;
  /** Explicit user refresh: discard the prior generated bundle and research this brief again. */
  force?: boolean;
}

/** A research activity tagged with which track (product/visual) produced it. */
export type TrackedResearchActivity = ResearchActivity & { track: "product" | "visual" };

export interface ResearchPhaseResult {
  /** Whether the agent turn actually ran (false = research already existed). */
  ran: boolean;
  /** Whether .research/research.md exists after the phase. */
  produced: boolean;
  /** Whether .research/visual/visual.md exists after the phase. */
  visualProduced: boolean;
  /** Whether the full evidence bundle is safe to consume as a build input. */
  complete: boolean;
  /** Concrete product, visual, or direction gaps that keep the bundle incomplete. */
  issues: ResearchBundleIssue[];
  error?: string;
}

/** Injectable research runner (AppDeps.researchPhase) so tests can skip the real agent. */
export type ResearchPhaseRunner = (input: ResearchPhaseInput) => Promise<ResearchPhaseResult>;

export interface SpawnResearchOpts {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onActivity?: (activity: ResearchActivity) => void;
}

/** Injectable spawn function — matches spawnResearch's signature — so tests can fake the agent. */
export type SpawnResearchFn = (
  command: string,
  args: string[],
  cwd: string,
  opts: SpawnResearchOpts,
) => Promise<{ code: number | null; stderr: string }>;

export async function runResearchPhase(
  input: ResearchPhaseInput,
  spawner: SpawnResearchFn = spawnResearch,
): Promise<ResearchPhaseResult> {
  if (input.force) await resetResearchBundle(input.dir);
  const initialValidation = await validateResearchBundle(input.dir);
  const areaComplete = (issues: ResearchBundleIssue[], area: ResearchBundleIssue["area"]): boolean =>
    !issues.some((issue) => issue.area === area);
  const productDone = areaComplete(initialValidation.issues, "product");
  const visualDone = areaComplete(initialValidation.issues, "visual");
  if (initialValidation.complete) {
    return { ran: false, produced: true, visualProduced: true, complete: true, issues: [] };
  }
  await ensureResearchScaffold(input.dir);
  await mkdir(visualAssetsDir(input.dir), { recursive: true });
  if (!productDone || !visualDone) {
    await Promise.all([
      rm(directionsDir(input.dir), { recursive: true, force: true }),
      rm(chosenPath(input.dir), { force: true }),
    ]);
    await mkdir(directionsDir(input.dir), { recursive: true });
  }

  const provider = getProvider(input.agentCommand);
  // Stream-json so we can surface the agent's live steps as they happen; the (long)
  // prompt still rides in argv via oneShotArgs.
  const argsFor = (prompt: string): string[] => {
    const base = provider ? provider.oneShotArgs(input.model, prompt) : ["-p", prompt];
    return [...base, "--output-format", "stream-json", "--verbose"];
  };
  const MAX_ATTEMPTS = 2; // shared by the tracks and the synthesis step

  // Research is non-deterministic: some turns the agent detaches the work to background
  // sub-agents and returns before they write anything, leaving the tree empty. Retry once if a
  // turn produced no report (unless the user aborted). Roughly squares the per-turn success rate.
  const runTrack = async (
    track: "product" | "visual",
    prompt: string,
    alreadyDone: boolean,
  ): Promise<{ produced: boolean; reason?: string }> => {
    const exists = async (): Promise<boolean> => {
      const validation = await validateResearchBundle(input.dir);
      return areaComplete(validation.issues, track);
    };
    if (alreadyDone) return { produced: true };
    // Last-seen failure reason, so a track that never produces still explains why (thrown error
    // message, or a non-zero exit's reason) instead of surfacing silence.
    let lastReason: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (input.signal?.aborted) break;
      try {
        const { code, stderr } = await spawner(input.agentCommand, argsFor(prompt), input.dir, {
          env: input.env ?? {},
          signal: input.signal,
          timeoutMs: input.timeoutMs,
          onActivity: input.onActivity ? (a) => input.onActivity!({ ...a, track }) : undefined,
        });
        if (code !== 0) {
          lastReason = `${input.agentCommand} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`;
        }
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        if (await exists()) return { produced: true };
        if (err instanceof Error && /aborted/i.test(err.message)) break;
      }
      if (await exists()) return { produced: true };
      if (attempt < MAX_ATTEMPTS && !input.signal?.aborted) {
        input.onActivity?.({ kind: "note", text: `${track} research produced nothing — retrying once.`, track });
      }
    }
    const produced = await exists();
    if (produced) return { produced: true };
    const validation = await validateResearchBundle(input.dir);
    const issueReason = validation.issues.filter((issue) => issue.area === track).map((issue) => issue.message).join("; ");
    return { produced: false, reason: lastReason ?? (issueReason || undefined) };
  };

  const [product, visual] = await Promise.all([
    runTrack(
      "product",
      buildResearchPrompt({
        brief: input.brief,
        skill: input.skill,
        designSystemName: input.designSystemName,
        hasUserReferences: input.hasUserReferences,
      }),
      productDone,
    ),
    runTrack("visual", buildVisualResearchPrompt({ brief: input.brief, designSystemName: input.designSystemName }), visualDone),
  ]);

  // Synthesis: read BOTH reports + the brief and produce the candidate directions from the
  // comprehensive understanding. Sequential (needs both tracks). Does not re-open the images.
  let directionsComplete = areaComplete((await validateResearchBundle(input.dir)).issues, "directions");
  if (!directionsComplete && product.produced && visual.produced && !input.signal?.aborted) {
    const synthArgs = argsFor(
      buildSynthesisPrompt({
        brief: input.brief,
        skill: input.skill,
        designSystemName: input.designSystemName,
      }),
    );
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (input.signal?.aborted) break;
      try {
        await spawner(input.agentCommand, synthArgs, input.dir, {
          env: input.env ?? {},
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        });
      } catch (err) {
        directionsComplete = areaComplete((await validateResearchBundle(input.dir)).issues, "directions");
        if (directionsComplete) break;
        if (err instanceof Error && /aborted/i.test(err.message)) break;
      }
      directionsComplete = areaComplete((await validateResearchBundle(input.dir)).issues, "directions");
      if (directionsComplete) break;
    }
  }

  // A project can now be visual-only (or product-only): report a per-track reason so a failed
  // track always explains why, even when the other track succeeded.
  const reasons = [
    !product.produced ? `product: ${product.reason ?? "no report was produced"}` : null,
    !visual.produced ? `visual: ${visual.reason ?? "no report was produced"}` : null,
  ].filter((r): r is string => r !== null);
  const validation = await validateResearchBundle(input.dir);
  return {
    ran: true,
    produced: areaComplete(validation.issues, "product"),
    visualProduced: areaComplete(validation.issues, "visual"),
    complete: validation.complete,
    issues: validation.issues,
    error: reasons.length ? reasons.join("; ") : undefined,
  };
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
