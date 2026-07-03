/**
 * POST /api/runs — the keystone that wires the whole spine together:
 * compose prompt (@dezin/prompt) → generate with the closed loop (@dezin/agent +
 * @dezin/quality) → stream run events over SSE → persist run/messages/artifact
 * (@dezin/core Store) → write the artifact to disk so /projects/:id/preview/ serves it.
 */

import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { composeSystemPrompt } from "../../../packages/prompt/src/index.ts";
import {
  generateArtifact,
  runTurnWithRetry,
  GenericCliRunner,
  getProvider,
  extractAskUserQuestion,
  extractFinalSummary,
  isAbortError,
  type GenerateEvent,
  type AgentRunner,
} from "../../../packages/agent/src/index.ts";
import { defaultRegistry } from "../../../packages/design/src/index.ts";
import { loadSkills, findSkill, type SkillInfo } from "../../../packages/skills/src/index.ts";
import { loadCraftSections } from "../../../packages/craft/src/index.ts";
import { lintArtifact, lintScore, renderFindingsForAgent } from "../../../packages/quality/src/index.ts";
import { generateImages } from "./image-gen.ts";
import { captureCover, captureCoverUrl } from "./capture-cover.ts";
import { auditVisualArtifact, type VisualQaInput } from "./visual-qa.ts";
import { ensureDevServer, gitCommit, workingTreeFingerprint } from "./project-runtime.ts";
import type { QualityFinding, Settings } from "../../../packages/core/src/index.ts";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import { standardVariantArtifactDir, variantRuntimeKey } from "./variant-workspaces.ts";
import { createRun, pushEvent, finishRun, cancelRun, subscribe } from "./run-manager.ts";
import { appendMoodboardReferenceLine, buildProjectMoodboardContext, normalizeProjectMoodboardRefs } from "./project-moodboard-context.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { providerRuntimeConfig } from "./provider-profile-config.ts";
import { createProviderFetch } from "./provider-fetch.ts";
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

  // Each agent's runner (stream-json for Claude/CodeBuddy, generic CLI for the rest) is
  // defined by its provider; an unknown CLI falls back to a best-effort positional prompt.
  const provider = getProvider(command);
  if (provider) return provider.createRunner({ command, model });

  const base = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  return new GenericCliRunner({ id: base, command, model, config: { buildArgs: (m, p) => [...(m ? ["--model", m] : []), p] } });
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

const STANDARD_LINT_EXTENSIONS = new Set([".css", ".html", ".js", ".jsx", ".ts", ".tsx"]);
const STANDARD_LINT_SKIP_DIRS = new Set([".git", "dist", "node_modules", "version-worktrees"]);

async function collectStandardLintSurface(root: string, maxBytes = 2_000_000): Promise<string> {
  const chunks: string[] = [];
  let used = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (used >= maxBytes) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!STANDARD_LINT_SKIP_DIRS.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!STANDARD_LINT_EXTENSIONS.has(ext)) continue;
      const text = await readFile(path, "utf8").catch(() => "");
      if (!text) continue;
      const budget = maxBytes - used;
      const clipped = text.slice(0, budget);
      used += clipped.length;
      chunks.push(`\n/* file: ${relative(root, path)} */\n${clipped}`);
    }
  };
  await walk(root);
  return chunks.join("\n");
}

interface RunBody {
  projectId?: string;
  brief?: string;
  conversationId?: string;
  maxRounds?: number;
  agentCommand?: string;
  model?: string;
  variantId?: string;
  moodboardRefs?: unknown;
}

type ProcessItem = { type: "text"; text: string } | { type: "tool"; summary: string };

const DEFAULT_AUTO_IMPROVE_MAX_ROUNDS = 8;
const AUTO_REPAIR_SEVERITIES = new Set<QualityFinding["severity"]>(["P0", "P1"]);

function autoImproveMaxRounds(settings: Settings, override?: number): number {
  const raw = typeof override === "number" ? override : settings.autoImproveMaxRounds;
  const value = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_AUTO_IMPROVE_MAX_ROUNDS;
  return Math.max(0, Math.min(20, value));
}

function reviewerAgentCommand(settings: Settings, fallback: string): string {
  return settings.visualQaAgentCommand.trim() || fallback || settings.agentCommand || "claude";
}

function reviewerModel(settings: Settings, fallback?: string): string | undefined {
  return settings.visualQaModel.trim() || fallback || settings.model || undefined;
}

function shouldAutoRepair(settings: Settings, findings: QualityFinding[], repairRounds: number, maxRounds: number): boolean {
  if (!settings.autoImproveEnabled || repairRounds >= maxRounds) return false;
  return findings.some((finding) => AUTO_REPAIR_SEVERITIES.has(finding.severity));
}

function standardRepairPrompt(findings: QualityFinding[], round: number, maxRounds: number, score: number): string | null {
  const lintBlock = renderFindingsForAgent(findings);
  if (!lintBlock) return null;
  return [
    `Automatic quality repair round ${round}/${maxRounds}.`,
    "You are editing the existing Standard-mode Vite project in this directory. Preserve the user's concept and the current visual direction, but fix the concrete quality findings below.",
    "Do not ask a follow-up question. Edit the actual project files, then stop.",
    `Current quality score: ${score}/100.`,
    lintBlock,
  ].join("\n\n");
}

function prototypeRepairPrompt(findings: QualityFinding[], round: number, maxRounds: number, score: number): string | null {
  const lintBlock = renderFindingsForAgent(findings);
  if (!lintBlock) return null;
  return [
    `Automatic quality repair round ${round}/${maxRounds}.`,
    "You are repairing the current single-file Dezin prototype. Preserve the user's concept and visual direction, but return a complete corrected HTML artifact.",
    "Do not ask a follow-up question. Rewrite the artifact to fix the concrete findings below, then stop.",
    `Current quality score: ${score}/100.`,
    lintBlock,
  ].join("\n\n");
}

function splitFinalSummary(text: string): ReturnType<typeof extractFinalSummary> {
  return extractFinalSummary(text);
}

function resultMessage(text: string, meta: Record<string, unknown>): string {
  return JSON.stringify({ result: { text, meta } });
}

function questionMessage(text: string, runId: string): string {
  return JSON.stringify({ question: { text, runId } });
}

function processMessage(items: ProcessItem[], elapsedMs?: number): string {
  return JSON.stringify({ process: { items, elapsedMs } });
}

function messageToAgentTurn(m: { role: string; content: string }): { role: "user" | "assistant"; content: string }[] {
  if (m.role === "user" || m.role === "assistant") return [{ role: m.role, content: m.content }];
  if (m.role !== "system") return [];
  try {
    const parsed = JSON.parse(m.content) as { question?: { text?: unknown } };
    const question = parsed.question?.text;
    return typeof question === "string" && question.trim() ? [{ role: "assistant", content: question.trim() }] : [];
  } catch {
    return [];
  }
}

function requestOrigin(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  return typeof host === "string" && host ? `http://${host}` : undefined;
}

async function runVisualQa(
  deps: AppDeps,
  htmlPath: string,
  settings: Settings,
  agentCommand: string,
  model: string | undefined,
  brief: string,
  conversationHistory: VisualQaInput["conversationHistory"],
  options: Pick<VisualQaInput, "projectRoot" | "renderUrl"> = {},
): Promise<QualityFinding[]> {
  if (!settings.visualQaEnabled) return [];
  try {
    const runner = deps.visualQa ?? auditVisualArtifact;
    return await runner({
      htmlPath,
      settings,
      agentCommand: reviewerAgentCommand(settings, agentCommand),
      model: reviewerModel(settings, model),
      brief,
      conversationHistory,
      ...options,
    });
  } catch (err) {
    return [
      {
        severity: "P2",
        id: "visual-qa-failed",
        message: `Visual QA failed: ${err instanceof Error ? err.message : "unknown error"}.`,
        fix: "Open Preview and inspect the generated layout manually.",
      },
    ];
  }
}

export async function handleRun(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = (await readJsonBody(req)) as RunBody;

  if (typeof body.projectId !== "string" || !body.projectId) return sendError(res, 400, "projectId is required");
  if (typeof body.brief !== "string" || !body.brief.trim()) return sendError(res, 400, "brief is required");

  const { store } = deps;
  const settings = store.getSettings();
  const runAgentCommand = body.agentCommand || settings.agentCommand || "claude";
  const runModel = body.model || settings.model || undefined;
  const agentEnv = buildAgentEnv(settings, runAgentCommand);
  const imageRuntime = providerRuntimeConfig(settings, settings.aiProviderId);
  const imageBaseUrl = imageRuntime.baseUrl || settings.imageApiBaseUrl;
  const imageApiKey = imageRuntime.apiKey || settings.imageApiKey;
  // deps.runner is the test override; production builds from settings (live changes apply).
  const runner = deps.runner ?? buildRunner(settings, { agentCommand: body.agentCommand, model: body.model });

  const project = store.getProject(body.projectId);
  if (!project) return sendError(res, 404, "project not found");

  let conversation = body.conversationId ? store.getConversation(body.conversationId) : null;
  if (body.conversationId && !conversation) return sendError(res, 404, "conversation not found");
  if (conversation && conversation.projectId !== project.id) return sendError(res, 400, "conversation does not belong to project");

  const mainVariant = store.ensureMainVariant(project.id);
  const targetVariantId = body.variantId ?? store.getActiveVariantId(project.id) ?? mainVariant.id;
  const targetVariant = store.getVariant(targetVariantId);
  if (!targetVariant || targetVariant.projectId !== project.id) return sendError(res, 404, "variant not found");
  if (project.mode !== "standard" && body.variantId && body.variantId !== store.getActiveVariantId(project.id)) {
    return sendError(res, 409, "targeted variant runs are only supported in standard mode");
  }
  const activeRun = store.findActiveRun(project.id, targetVariantId);
  if (activeRun) return sendError(res, 409, "run already in progress for this project variant");
  conversation ??= store.createConversation(project.id);
  let dir: string;
  try {
    dir = project.mode === "standard" ? await standardVariantArtifactDir(deps, project.id, targetVariantId) : projectDir(deps.dataDir, project.id);
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return sendError(res, 409, err instanceof Error ? err.message : "variant workspace unavailable");
  }

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
    skill: skill ? { name: skill.name, body: skill.body, mode: skill.mode, libraries: skill.libraries } : undefined,
    userInstructions: settings.customInstructions || undefined,
    craft: craft || undefined,
    imageGen: Boolean(imageApiKey && imageBaseUrl),
    mode: project.mode,
  });

  const brief = body.brief.trim();
  const moodboardRefs = normalizeProjectMoodboardRefs(body.moodboardRefs);
  // Prior turns in this conversation become the agent's chat context (captured before we add
  // the new user message). System/process records are excluded.
  const history = store
    .listMessages(conversation.id)
    .flatMap(messageToAgentTurn);
  const run = store.createRun(project.id, conversation.id, targetVariantId, undefined, deps.daemonOwnerId);
  const moodboardContext = buildProjectMoodboardContext({
    store,
    dataDir: deps.dataDir,
    runId: run.id,
    refs: moodboardRefs,
    request: brief,
  });
  const visibleBrief = appendMoodboardReferenceLine(brief, moodboardContext.labels);
  const agentBrief = moodboardContext.promptBlock ? `${visibleBrief}\n\n${moodboardContext.promptBlock}` : visibleBrief;
  const userMessage = store.addMessage(conversation.id, "user", visibleBrief);
  store.updateRun(run.id, { status: "running", userMessageId: userMessage.id });

  // Open the SSE stream + register the run with the broker. Events are buffered + persisted to
  // a per-run log so another client can reattach (after navigating away, or an app restart) and
  // replay what the run reached. The run continues regardless of THIS client's connection — it
  // ends only on completion, an explicit cancel, or the daemon exiting.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const ctrl = createRun({ runId: run.id, conversationId: conversation.id, dataDir: deps.dataDir });
  const unsubscribe = subscribe(
    run.id,
    deps.dataDir,
    (ev) => {
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        /* socket closed */
      }
    },
    () => {},
  );
  // On disconnect just stop writing — do NOT cancel; the run keeps going for reattach.
  req.on("close", unsubscribe);
  const sse = (event: unknown): void => pushEvent(run.id, event);
  sse({ type: "run-start", runId: run.id, conversationId: conversation.id, variantId: targetVariantId });

  const origin = requestOrigin(req);

  // Record the agent's interleaved process so the conversation can be restored after
  // navigation/restart without losing streamed text or the original tool order.
  const steps: string[] = [];
  const processItems: ProcessItem[] = [];
  let summaryBoundarySeen = false;
  const recordActivity = (activity: unknown): unknown | null => {
    const a = activity as { kind?: string; summary?: string } | undefined;
    if (a?.kind === "tool" && a.summary) {
      if (steps[steps.length - 1] !== a.summary) steps.push(a.summary);
      const last = processItems[processItems.length - 1];
      if (!(last?.type === "tool" && last.summary === a.summary)) processItems.push({ type: "tool", summary: a.summary });
      return activity;
    }
    const t = (activity as { kind?: string; text?: string } | undefined)?.text;
    if (a?.kind === "text" && t) {
      const final = splitFinalSummary(t);
      const processText = final.hadBoundary ? final.processText : t;
      if (final.hadBoundary) summaryBoundarySeen = true;
      if (!processText.trim()) return null;
      const last = processItems[processItems.length - 1];
      if (last?.type === "text") last.text += processText;
      else processItems.push({ type: "text", text: processText });
      return { kind: "text", text: processText };
    }
    return activity;
  };
  const processAssistantText = (): string =>
    processItems
      .filter((i): i is { type: "text"; text: string } => i.type === "text")
      .map((i) => i.text)
      .join("")
      .trim();
  const processRecordItems = (includeText: boolean): ProcessItem[] =>
    processItems.filter((item) => includeText || item.type === "tool");
  const persistProcess = (includeText = summaryBoundarySeen): void => {
    const items = processRecordItems(includeText);
    if (items.length) store.addMessage(conversation.id, "system", processMessage(items, Math.max(0, Date.now() - run.createdAt)));
  };
  const persistSteps = (): void => {
    if (steps.length) store.addMessage(conversation.id, "system", JSON.stringify({ steps }));
  };

  // Standard mode: the agent edits a real Vite project (src/*), not a single HTML.
  // No closed lint loop on one file; run a turn, commit the diff to git as a version.
  if (project.mode === "standard") {
    try {
      const ensureStandardDevServer = deps.ensureDevServer ?? ensureDevServer;
      const maxRepairRounds = autoImproveMaxRounds(settings, body.maxRounds);
      const turnHistory: Array<{ role: "user" | "assistant"; content: string }> = [...history];
      let round = 0;
      let repairRounds = 0;
      let turnMessage = agentBrief;
      let finalAssistantText = "";
      let commitHash: string | null = null;
      let findings: QualityFinding[] = [];
      let score = 100;
      let passed = true;

      while (true) {
        const isRepair = round > 0;
        const beforeTree = await workingTreeFingerprint(dir);
        sse({ type: "turn-start", round, isRepair });
        const result = await runTurnWithRetry(
          runner,
          {
            systemPrompt,
            message: turnMessage,
            projectDir: dir,
            history: turnHistory,
            isRepair,
            onActivity: (activity) => {
              const visible = recordActivity(activity);
              if (visible) sse({ type: "activity", round, activity: visible });
            },
            signal: ctrl.signal,
            env: agentEnv,
          },
          {
            onRetry: (attempt) =>
              sse({
                type: "activity",
                round,
                activity: { kind: "tool", name: "retry", summary: `Agent hiccup — retrying (attempt ${attempt + 1})…` },
              }),
          },
        );
        const asked = extractAskUserQuestion(result.text);
        const final = splitFinalSummary(asked.text);
        if (final.hadBoundary) summaryBoundarySeen = true;
        sse({ type: "turn-end", round, text: final.summaryText, summaryBoundary: final.hadBoundary });
        if (asked.question) {
          persistProcess();
          if (asked.text) store.addMessage(conversation.id, "assistant", asked.text);
          persistSteps();
          store.addMessage(conversation.id, "system", questionMessage(asked.question, run.id));
          store.updateRun(run.id, { status: "cancelled", finishedAt: Date.now() });
          sse({ type: "ask-user-question", runId: run.id, question: asked.question });
          sse({ type: "run-cancelled", runId: run.id, reason: "question" });
          return;
        }

        finalAssistantText = final.summaryText;
        turnHistory.push({ role: "user", content: turnMessage });
        if (final.summaryText) turnHistory.push({ role: "assistant", content: final.summaryText });
        if (isRepair) repairRounds = Math.max(repairRounds, round);

        const afterTree = await workingTreeFingerprint(dir);
        if (afterTree === beforeTree) {
          if (!isRepair) throw new Error("The selected Agent finished without changing project files.");
          break;
        }
        const commit = await gitCommit(dir, isRepair ? `Auto-improve round ${round}: ${visibleBrief}` : visibleBrief);
        if (!commit.changed) {
          if (!isRepair) throw new Error("The selected Agent did not leave any project changes to save.");
          break;
        }
        if (!commit.committed) throw new Error("Project files changed, but Dezin could not commit a version snapshot.");
        commitHash = commit.commitHash;

        const staticSurface = await collectStandardLintSurface(dir);
        const staticFindings = (staticSurface.trim() ? lintArtifact(staticSurface) : []) as QualityFinding[];
        if (staticFindings.length) sse({ type: "static-quality", round, findings: staticFindings });
        let visualFindings: QualityFinding[] = [];
        if (settings.visualQaEnabled) {
          let renderUrl: string | undefined;
          if (!deps.visualQa) {
            try {
              renderUrl = (await ensureStandardDevServer(project.id, dir, variantRuntimeKey(project.id, targetVariantId))).url;
            } catch (err) {
              visualFindings = [
                {
                  severity: "P2",
                  id: "visual-devserver-unavailable",
                  message: `Visual QA could not open the standard project preview: ${err instanceof Error ? err.message : "dev server unavailable"}.`,
                  fix: "Wait for dependencies to finish installing, refresh the preview, and rerun visual QA.",
                },
              ];
            }
          }
          if (!visualFindings.length) {
            visualFindings = await runVisualQa(deps, join(dir, "index.html"), settings, runAgentCommand, runModel, visibleBrief, turnHistory, {
              projectRoot: dir,
              renderUrl,
            });
          }
          sse({ type: "visual-qa", round, enabled: settings.visualQaEnabled, findings: visualFindings });
        }
        findings = [...staticFindings, ...visualFindings];
        score = lintScore(findings);
        passed = !findings.some((f) => f.severity === "P0");

        if (!shouldAutoRepair(settings, findings, repairRounds, maxRepairRounds)) break;
        const nextRound = repairRounds + 1;
        const repairPrompt = standardRepairPrompt(findings, nextRound, maxRepairRounds, score);
        if (!repairPrompt) break;
        round = nextRound;
        turnMessage = repairPrompt;
      }

      persistProcess();
      const assistantMessage = store.addMessage(conversation.id, "assistant", finalAssistantText);
      persistSteps();
      const quality = `, quality ${score}/100`;
      const fixes = repairRounds ? ` after ${repairRounds} fix${repairRounds > 1 ? "es" : ""}` : "";
      const message = passed ? `Done${quality}${fixes}. Updated the project; the dev preview reflects it live.` : `Done, with remaining visual issues${quality}.`;
      store.addMessage(conversation.id, "system", resultMessage(message, { passed, score, rounds: repairRounds }));
      store.updateRun(run.id, {
        status: "succeeded",
        repairRounds,
        lintPassed: passed,
        score,
        findings,
        assistantMessageId: assistantMessage.id,
        commitHash,
        finishedAt: Date.now(),
      });
      sse({ type: "run-done", runId: run.id, passed, rounds: repairRounds, score, mode: "standard", findings });
      const activeForCover = store.getActiveVariantId(project.id) ?? mainVariant.id;
      if (targetVariantId === activeForCover) {
        void (async () => {
          try {
            const { url } = await ensureStandardDevServer(project.id, dir, variantRuntimeKey(project.id, targetVariantId));
            await (deps.captureCoverUrl ?? captureCoverUrl)(url, join(projectDir(deps.dataDir, project.id), ".cover.png"));
          } catch {
            // Covers are best-effort; the successful run is already persisted.
          }
        })();
      }
    } catch (err) {
      const cancelled = ctrl.signal.aborted || isAbortError(err);
      store.updateRun(run.id, { status: cancelled ? "cancelled" : "failed", finishedAt: Date.now() });
      persistProcess();
      const partial = processAssistantText();
      if (cancelled && partial) store.addMessage(conversation.id, "assistant", partial);
      persistSteps();
      const message = cancelled ? "Stopped." : `The run failed: ${err instanceof Error ? err.message : "generation failed"}`;
      store.addMessage(conversation.id, "system", resultMessage(message, cancelled ? {} : { error: true }));
      sse(cancelled ? { type: "run-cancelled", runId: run.id } : { type: "run-error", runId: run.id, message: err instanceof Error ? err.message : "generation failed" });
    } finally {
      finishRun(run.id);
      unsubscribe();
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
      brief: agentBrief,
      projectDir: dir,
      history,
      lint: { maxRounds: settings.autoImproveEnabled ? autoImproveMaxRounds(settings, body.maxRounds) : 0 },
      signal: ctrl.signal,
      env: agentEnv,
      onEvent: (e: GenerateEvent) => {
        if (e.type === "activity") {
          const visible = recordActivity(e.activity);
          if (visible) sse({ ...e, activity: visible });
          return;
        }
        if (e.type === "done") return;
        if (e.type === "turn-end" && typeof e.text === "string") {
          const stripped = extractAskUserQuestion(e.text);
          const final = splitFinalSummary(stripped.text);
          if (final.hadBoundary) summaryBoundarySeen = true;
          sse({ ...e, text: final.summaryText, summaryBoundary: final.hadBoundary });
        } else {
          sse(e);
        }
      },
    });
    stopPoll();

    const rawAssistantText = result.turns.at(-1)?.text ?? "";
    const asked = extractAskUserQuestion(rawAssistantText);
    const final = splitFinalSummary(asked.text);
    if (final.hadBoundary) summaryBoundarySeen = true;
    let assistantText = final.summaryText;
    if (asked.question) {
      persistProcess();
      if (assistantText) store.addMessage(conversation.id, "assistant", assistantText);
      persistSteps();
      store.addMessage(conversation.id, "system", questionMessage(asked.question, run.id));
      store.updateRun(run.id, { status: "cancelled", finishedAt: Date.now() });
      sse({ type: "ask-user-question", runId: run.id, question: asked.question });
      sse({ type: "run-cancelled", runId: run.id, reason: "question" });
      return;
    }

    let artifactPath = result.artifactPath;
    let currentHtml = result.html;
    let generatedTotal = 0;
    let repairRounds = result.rounds;
    let finalFindings: QualityFinding[] = result.findings as QualityFinding[];
    let score = lintScore(finalFindings);
    const maxRepairRounds = autoImproveMaxRounds(settings, body.maxRounds);
    const repairHistory: Array<{ role: "user" | "assistant"; content: string }> = [
      ...history,
      { role: "user" as const, content: agentBrief },
      ...(assistantText ? [{ role: "assistant" as const, content: assistantText }] : []),
    ];
    const renderUrl = origin ? `${origin}/projects/${project.id}/preview/` : undefined;
    const writeCurrentArtifact = async (): Promise<void> => {
      const media = await generateImages(
        currentHtml,
        {
          baseUrl: imageBaseUrl,
          apiKey: imageApiKey,
          model: settings.imageModel,
          providerId: settings.aiProviderId,
          apiVersion: imageRuntime.organization || settings.aiProviderOrganization,
        },
        join(dir, "assets"),
        createProviderFetch(),
      );
      currentHtml = media.html;
      generatedTotal += media.generated;
      if (media.generated > 0) sse({ type: "images", count: media.generated });
      await writeFile(join(dir, artifactPath), currentHtml, "utf8");
      await mkdir(join(dir, ".versions"), { recursive: true });
      await writeFile(join(dir, ".versions", `${run.id}.html`), currentHtml, "utf8");
    };
    const reviewCurrentArtifact = async (round: number, staticFindings: QualityFinding[]): Promise<void> => {
      const visualFindings = await runVisualQa(deps, join(dir, artifactPath), settings, runAgentCommand, runModel, visibleBrief, repairHistory, {
        projectRoot: dir,
        renderUrl,
      });
      sse({ type: "visual-qa", round, enabled: settings.visualQaEnabled, findings: visualFindings });
      finalFindings = [...staticFindings, ...visualFindings];
      score = lintScore(finalFindings);
    };

    await writeCurrentArtifact();
    await reviewCurrentArtifact(0, result.findings as QualityFinding[]);

    while (shouldAutoRepair(settings, finalFindings, repairRounds, maxRepairRounds)) {
      const nextRound = repairRounds + 1;
      const repairPrompt = prototypeRepairPrompt(finalFindings, nextRound, maxRepairRounds, score);
      if (!repairPrompt) break;
      sse({ type: "turn-start", round: nextRound, isRepair: true });
      const repaired = await runTurnWithRetry(
        runner,
        {
          systemPrompt,
          message: repairPrompt,
          projectDir: dir,
          history: repairHistory,
          isRepair: true,
          onActivity: (activity) => {
            const visible = recordActivity(activity);
            if (visible) sse({ type: "activity", round: nextRound, activity: visible });
          },
          signal: ctrl.signal,
          env: agentEnv,
        },
        {
          onRetry: (attempt) =>
            sse({
              type: "activity",
              round: nextRound,
              activity: { kind: "tool", name: "retry", summary: `Agent hiccup — retrying (attempt ${attempt + 1})…` },
            }),
        },
      );
      const repairedAsked = extractAskUserQuestion(repaired.text);
      const repairedFinal = splitFinalSummary(repairedAsked.text);
      if (repairedFinal.hadBoundary) summaryBoundarySeen = true;
      sse({ type: "turn-end", round: nextRound, text: repairedFinal.summaryText, summaryBoundary: repairedFinal.hadBoundary });
      if (repairedAsked.question) {
        persistProcess();
        if (repairedFinal.summaryText) store.addMessage(conversation.id, "assistant", repairedFinal.summaryText);
        persistSteps();
        store.addMessage(conversation.id, "system", questionMessage(repairedAsked.question, run.id));
        store.updateRun(run.id, { status: "cancelled", finishedAt: Date.now() });
        sse({ type: "ask-user-question", runId: run.id, question: repairedAsked.question });
        sse({ type: "run-cancelled", runId: run.id, reason: "question" });
        return;
      }

      assistantText = repairedFinal.summaryText;
      repairHistory.push({ role: "user", content: repairPrompt });
      if (assistantText) repairHistory.push({ role: "assistant", content: assistantText });
      artifactPath = repaired.artifactPath ?? artifactPath;
      currentHtml = repaired.artifactHtml || currentHtml;
      repairRounds = nextRound;
      await writeCurrentArtifact();
      const staticFindings = lintArtifact(currentHtml) as QualityFinding[];
      await reviewCurrentArtifact(nextRound, staticFindings);
    }

    const passed = !finalFindings.some((f) => f.severity === "P0");
    store.recordArtifact(project.id, artifactPath, passed);
    persistProcess();
    const assistantMessage = store.addMessage(conversation.id, "assistant", assistantText);
    persistSteps();
    const fixes = repairRounds ? ` after ${repairRounds} fix${repairRounds > 1 ? "es" : ""}` : "";
    const quality = `, quality ${score}/100`;
    const text = passed ? `Done${quality}${fixes}.` : `Done, with remaining issues${quality}.`;
    store.addMessage(
      conversation.id,
      "system",
      resultMessage(text, { passed, score, rounds: repairRounds, materialSources: generatedTotal > 0 ? [`Generated image assets (${generatedTotal})`] : [] }),
    );
    store.updateRun(run.id, {
      status: "succeeded",
      repairRounds,
      lintPassed: passed,
      score,
      findings: finalFindings,
      assistantMessageId: assistantMessage.id,
      finishedAt: Date.now(),
    });

    sse({ type: "done", rounds: repairRounds, passed });
    sse({
      type: "run-done",
      runId: run.id,
      passed,
      rounds: repairRounds,
      score,
      previewUrl: `/projects/${project.id}/preview/`,
      findings: finalFindings,
    });
    // Headless-screenshot the finished artifact as the gallery cover (best-effort, async).
    void captureCover(join(dir, artifactPath), join(dir, ".cover.png"));
  } catch (err) {
    const cancelled = ctrl.signal.aborted || isAbortError(err);
    store.updateRun(run.id, { status: cancelled ? "cancelled" : "failed", finishedAt: Date.now() });
    persistProcess(); // keep the partial process record + whatever the agent wrote to disk
    const partial = processAssistantText();
    if (cancelled && partial) store.addMessage(conversation.id, "assistant", partial);
    persistSteps();
    const message = cancelled ? "Stopped." : `The run failed: ${err instanceof Error ? err.message : "generation failed"}`;
    store.addMessage(conversation.id, "system", resultMessage(message, cancelled ? {} : { error: true }));
    sse(cancelled ? { type: "run-cancelled", runId: run.id } : { type: "run-error", runId: run.id, message: err instanceof Error ? err.message : "generation failed" });
  } finally {
    stopPoll();
    finishRun(run.id);
    unsubscribe();
    res.end();
  }
}

/** GET /api/runs/:id/stream — reattach to a run: replays buffered/persisted events, then live. */
export function handleRunStream(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps): void {
  const runId = params.id!;
  const after = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("after") ?? 0);
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const unsub = subscribe(
    runId,
    deps.dataDir,
    (ev) => {
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        /* socket closed */
      }
    },
    () => {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    },
    { afterSeq: Number.isFinite(after) ? after : 0 },
  );
  req.on("close", unsub);
}

/** POST /api/runs/:id/cancel — explicit Stop; aborts the agent + ends the run. */
export function handleCancelRun(res: ServerResponse, params: Record<string, string>): void {
  sendJson(res, 200, { cancelled: cancelRun(params.id!) });
}
