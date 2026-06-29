/**
 * POST /api/runs — the keystone that wires the whole spine together:
 * compose prompt (@dezin/prompt) → generate with the closed loop (@dezin/agent +
 * @dezin/quality) → stream run events over SSE → persist run/messages/artifact
 * (@dezin/core Store) → write the artifact to disk so /projects/:id/preview/ serves it.
 */

import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { composeSystemPrompt } from "../../../packages/prompt/src/index.ts";
import {
  generateArtifact,
  runTurnWithRetry,
  ClaudeCodeRunner,
  GenericCliRunner,
  GENERIC_AGENTS,
  type GenerateEvent,
  type AgentRunner,
} from "../../../packages/agent/src/index.ts";
import { defaultRegistry } from "../../../packages/design/src/index.ts";
import { loadSkills, findSkill, type SkillInfo } from "../../../packages/skills/src/index.ts";
import { loadCraftSections } from "../../../packages/craft/src/index.ts";
import { lintScore } from "../../../packages/quality/src/index.ts";
import { generateImages } from "./image-gen.ts";
import { captureCover } from "./capture-cover.ts";
import { gitCommit } from "./project-runtime.ts";
import type { Settings } from "../../../packages/core/src/index.ts";
import { readJsonBody, sendError } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import type { AppDeps } from "./app.ts";

// Skills are scanned once and cached for the daemon process.
let cachedSkills: SkillInfo[] | null = null;
function skills(): SkillInfo[] {
  if (!cachedSkills) cachedSkills = loadSkills();
  return cachedSkills;
}

/** Build the production agent runner from settings (BYOK). */
export function buildRunner(settings: Settings, override: { agentCommand?: string; model?: string } = {}): AgentRunner {
  const command = override.agentCommand || settings.agentCommand || "claude";
  const model = override.model || settings.model || undefined;
  const base = command.split("/").pop() ?? command;

  // Claude gets the rich stream-json runner (live tool activity); other agents use
  // the generic CLI runner with their documented headless invocation.
  if (base === "claude") return new ClaudeCodeRunner({ command, model });

  const config = GENERIC_AGENTS[base] ?? {
    // Unknown CLI: best-effort positional prompt.
    buildArgs: (m: string | undefined, p: string) => [...(m ? ["--model", m] : []), p],
  };
  return new GenericCliRunner({ id: base, command, model, config });
}

/**
 * Poll the artifact file while the agent writes it and call onChange (with the
 * file's mtime) whenever it changes — drives live, streaming preview updates.
 * Returns a stop function.
 */
function startPreviewPoller(file: string, onChange: (mtimeMs: number) => void): () => void {
  let active = true;
  let last = "";
  void (async () => {
    while (active) {
      try {
        const s = await stat(file);
        const sig = `${s.size}:${s.mtimeMs}`;
        if (sig !== last) {
          last = sig;
          onChange(s.mtimeMs);
        }
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  })();
  return () => {
    active = false;
  };
}

interface RunBody {
  projectId?: string;
  brief?: string;
  conversationId?: string;
  maxRounds?: number;
  agentCommand?: string;
  model?: string;
}

export async function handleRun(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = (await readJsonBody(req)) as RunBody;

  if (typeof body.projectId !== "string" || !body.projectId) return sendError(res, 400, "projectId is required");
  if (typeof body.brief !== "string" || !body.brief.trim()) return sendError(res, 400, "brief is required");

  const { store } = deps;
  const settings = store.getSettings();
  // deps.runner is the test override; production builds from settings (live changes apply).
  const runner = deps.runner ?? buildRunner(settings, { agentCommand: body.agentCommand, model: body.model });

  const project = store.getProject(body.projectId);
  if (!project) return sendError(res, 404, "project not found");

  const conversation = body.conversationId
    ? store.getConversation(body.conversationId)
    : store.createConversation(project.id);
  if (!conversation) return sendError(res, 404, "conversation not found");

  // Resolve the active design system (the project's, else the settings default).
  const registry = deps.designRegistry ?? defaultRegistry();
  const designSystemId = project.designSystemId ?? settings.defaultDesignSystemId;
  const designSystem = registry.get(designSystemId) ?? registry.default();

  // Resolve the active skill (artifact shape), tolerating a missing/unknown id.
  const skill = project.skillId ? findSkill(skills(), project.skillId) : null;

  // Craft = the union of the skill's required sections and the brand's applied ones.
  const craftSlugs = Array.from(new Set([...(skill?.craft ?? []), ...(designSystem.craft?.applies ?? [])]));
  const craft = loadCraftSections(craftSlugs);

  const systemPrompt = composeSystemPrompt({
    designSystem,
    skill: skill ? { name: skill.name, body: skill.body, mode: skill.mode } : undefined,
    userInstructions: settings.customInstructions || undefined,
    craft: craft || undefined,
    imageGen: Boolean(settings.imageApiKey && settings.imageApiBaseUrl),
    mode: project.mode,
  });

  const brief = body.brief.trim();
  store.addMessage(conversation.id, "user", brief);
  const run = store.createRun(project.id, conversation.id);
  store.updateRun(run.id, { status: "running" });

  // Open the SSE stream.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const sse = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  sse({ type: "run-start", runId: run.id, conversationId: conversation.id });

  const dir = projectDir(deps.dataDir, project.id);
  await mkdir(dir, { recursive: true });

  // Record the agent's tool steps so the conversation keeps a permanent process record.
  const steps: string[] = [];
  const recordStep = (activity: unknown): void => {
    const a = activity as { kind?: string; summary?: string } | undefined;
    if (a?.kind === "tool" && a.summary && steps[steps.length - 1] !== a.summary) steps.push(a.summary);
  };
  const persistProcess = (): void => {
    if (steps.length) store.addMessage(conversation.id, "system", JSON.stringify({ steps }));
  };

  // Standard mode: the agent edits a real Vite project (src/*), not a single HTML.
  // No closed lint loop on one file; run a turn, commit the diff to git as a version.
  if (project.mode === "standard") {
    try {
      sse({ type: "turn-start", round: 0, isRepair: false });
      const result = await runTurnWithRetry(
        runner,
        {
          systemPrompt,
          message: brief,
          projectDir: dir,
          onActivity: (activity) => {
            recordStep(activity);
            sse({ type: "activity", round: 0, activity });
          },
        },
        {
          onRetry: (attempt) =>
            sse({ type: "activity", round: 0, activity: { kind: "tool", name: "retry", summary: `Agent hiccup — retrying (attempt ${attempt + 1})…` } }),
        },
      );
      sse({ type: "turn-end", round: 0, text: result.text });
      await gitCommit(dir, brief);
      store.addMessage(conversation.id, "assistant", result.text);
      persistProcess();
      store.updateRun(run.id, { status: "succeeded", repairRounds: 0, lintPassed: true, score: null, finishedAt: Date.now() });
      sse({ type: "run-done", runId: run.id, passed: true, rounds: 0, score: null, mode: "standard", findings: [] });
    } catch (err) {
      store.updateRun(run.id, { status: "failed", finishedAt: Date.now() });
      sse({ type: "run-error", runId: run.id, message: err instanceof Error ? err.message : "generation failed" });
    } finally {
      res.end();
    }
    return;
  }

  // Stream the preview live: emit an event whenever the agent rewrites index.html.
  const previewUrl = `/projects/${project.id}/preview/`;
  const stopPoll = startPreviewPoller(join(dir, "index.html"), (t) => sse({ type: "preview-update", previewUrl, t }));

  try {
    const result = await generateArtifact({
      runner,
      systemPrompt,
      brief,
      projectDir: dir,
      lint: { maxRounds: body.maxRounds ?? 2 },
      onEvent: (e: GenerateEvent) => {
        if (e.type === "activity") recordStep(e.activity);
        sse(e);
      },
    });
    stopPoll();

    // Generate any media the agent requested (data-gen-prompt placeholders → assets/).
    const { html: finalHtml, generated } = await generateImages(
      result.html,
      { baseUrl: settings.imageApiBaseUrl, apiKey: settings.imageApiKey, model: settings.imageModel },
      join(dir, "assets"),
      fetch,
    );
    if (generated > 0) sse({ type: "images", count: generated });

    // Persist the final artifact to disk + a per-run snapshot (for version history).
    await writeFile(join(dir, result.artifactPath), finalHtml, "utf8");
    await mkdir(join(dir, ".versions"), { recursive: true });
    await writeFile(join(dir, ".versions", `${run.id}.html`), finalHtml, "utf8");
    store.recordArtifact(project.id, result.artifactPath, result.passed);
    store.addMessage(conversation.id, "assistant", result.turns.at(-1)?.text ?? "");
    persistProcess();
    store.updateRun(run.id, {
      status: "succeeded",
      repairRounds: result.rounds,
      lintPassed: result.passed,
      score: lintScore(result.findings),
      finishedAt: Date.now(),
    });

    sse({
      type: "run-done",
      runId: run.id,
      passed: result.passed,
      rounds: result.rounds,
      score: lintScore(result.findings),
      previewUrl: `/projects/${project.id}/preview/`,
      findings: result.findings,
    });
    // Headless-screenshot the finished artifact as the gallery cover (best-effort, async).
    void captureCover(join(dir, result.artifactPath), join(dir, ".cover.png"));
  } catch (err) {
    store.updateRun(run.id, { status: "failed", finishedAt: Date.now() });
    sse({ type: "run-error", runId: run.id, message: err instanceof Error ? err.message : "generation failed" });
  } finally {
    stopPoll();
    res.end();
  }
}
