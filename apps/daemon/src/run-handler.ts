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
import { lintArtifact, lintScore } from "../../../packages/quality/src/index.ts";
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

  const base = command.split("/").pop() ?? command;
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
    return await runner({ htmlPath, settings, agentCommand, model, brief, conversationHistory, ...options });
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
  // deps.runner is the test override; production builds from settings (live changes apply).
  const runner = deps.runner ?? buildRunner(settings, { agentCommand: body.agentCommand, model: body.model });

  const project = store.getProject(body.projectId);
  if (!project) return sendError(res, 404, "project not found");

  const conversation = body.conversationId
    ? store.getConversation(body.conversationId)
    : store.createConversation(project.id);
  if (!conversation) return sendError(res, 404, "conversation not found");
  if (conversation.projectId !== project.id) return sendError(res, 400, "conversation does not belong to project");

  const mainVariant = store.ensureMainVariant(project.id);
  const targetVariantId = body.variantId ?? store.getActiveVariantId(project.id) ?? mainVariant.id;
  const targetVariant = store.getVariant(targetVariantId);
  if (!targetVariant || targetVariant.projectId !== project.id) return sendError(res, 404, "variant not found");
  if (project.mode !== "standard" && body.variantId && body.variantId !== store.getActiveVariantId(project.id)) {
    return sendError(res, 409, "targeted variant runs are only supported in standard mode");
  }
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
    imageGen: Boolean(settings.imageApiKey && settings.imageApiBaseUrl),
    mode: project.mode,
  });

  const brief = body.brief.trim();
  const moodboardRefs = normalizeProjectMoodboardRefs(body.moodboardRefs);
  // Prior turns in this conversation become the agent's chat context (captured before we add
  // the new user message). System/process records are excluded.
  const history = store
    .listMessages(conversation.id)
    .flatMap(messageToAgentTurn);
  const run = store.createRun(project.id, conversation.id, targetVariantId);
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
      const beforeTree = await workingTreeFingerprint(dir);
      sse({ type: "turn-start", round: 0, isRepair: false });
      const result = await runTurnWithRetry(
        runner,
        {
          systemPrompt,
          message: agentBrief,
          projectDir: dir,
          history,
          onActivity: (activity) => {
            const visible = recordActivity(activity);
            if (visible) sse({ type: "activity", round: 0, activity: visible });
          },
          signal: ctrl.signal,
        },
        {
          onRetry: (attempt) =>
            sse({ type: "activity", round: 0, activity: { kind: "tool", name: "retry", summary: `Agent hiccup — retrying (attempt ${attempt + 1})…` } }),
        },
      );
      const asked = extractAskUserQuestion(result.text);
      const final = splitFinalSummary(asked.text);
      if (final.hadBoundary) summaryBoundarySeen = true;
      sse({ type: "turn-end", round: 0, text: final.summaryText, summaryBoundary: final.hadBoundary });
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
      const afterTree = await workingTreeFingerprint(dir);
      if (afterTree === beforeTree) throw new Error("The selected Agent finished without changing project files.");
      const commit = await gitCommit(dir, visibleBrief);
      if (!commit.changed) throw new Error("The selected Agent did not leave any project changes to save.");
      if (!commit.committed) throw new Error("Project files changed, but Dezin could not commit a version snapshot.");
      const visualConversation = [
        ...history,
        { role: "user" as const, content: visibleBrief },
        ...(final.summaryText ? [{ role: "assistant" as const, content: final.summaryText }] : []),
      ];
      const staticSurface = await collectStandardLintSurface(dir);
      const staticFindings = (staticSurface.trim() ? lintArtifact(staticSurface) : []) as QualityFinding[];
      if (staticFindings.length) sse({ type: "static-quality", findings: staticFindings });
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
          visualFindings = await runVisualQa(deps, join(dir, "index.html"), settings, runAgentCommand, runModel, visibleBrief, visualConversation, {
            projectRoot: dir,
            renderUrl,
          });
        }
        sse({ type: "visual-qa", enabled: settings.visualQaEnabled, findings: visualFindings });
      }
      const findings = [...staticFindings, ...visualFindings];
      const score = lintScore(findings);
      const passed = !findings.some((f) => f.severity === "P0");
      persistProcess();
      const assistantMessage = store.addMessage(conversation.id, "assistant", final.summaryText);
      persistSteps();
      const quality = `, quality ${score}/100`;
      const message = passed ? `Done${quality}. Updated the project; the dev preview reflects it live.` : `Done, with remaining visual issues${quality}.`;
      store.addMessage(conversation.id, "system", resultMessage(message, { passed, score, rounds: 0 }));
      store.updateRun(run.id, {
        status: "succeeded",
        repairRounds: 0,
        lintPassed: passed,
        score,
        findings,
        assistantMessageId: assistantMessage.id,
        commitHash: commit.commitHash,
        finishedAt: Date.now(),
      });
      sse({ type: "run-done", runId: run.id, passed, rounds: 0, score, mode: "standard", findings });
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
      lint: { maxRounds: body.maxRounds ?? 2 },
      signal: ctrl.signal,
      onEvent: (e: GenerateEvent) => {
        if (e.type === "activity") {
          const visible = recordActivity(e.activity);
          if (visible) sse({ ...e, activity: visible });
          return;
        }
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
    const assistantText = final.summaryText;
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
    const visualConversation = [
      ...history,
      { role: "user" as const, content: visibleBrief },
      ...(assistantText ? [{ role: "assistant" as const, content: assistantText }] : []),
    ];
    const visualFindings = await runVisualQa(
      deps,
      join(dir, result.artifactPath),
      settings,
      runAgentCommand,
      runModel,
      visibleBrief,
      visualConversation,
      { projectRoot: dir, renderUrl: origin ? `${origin}/projects/${project.id}/preview/` : undefined },
    );
    sse({ type: "visual-qa", enabled: settings.visualQaEnabled, findings: visualFindings });
    const finalFindings = [...result.findings, ...visualFindings];
    const passed = result.passed && !finalFindings.some((f) => f.severity === "P0");
    store.recordArtifact(project.id, result.artifactPath, passed);
    persistProcess();
    const assistantMessage = store.addMessage(conversation.id, "assistant", assistantText);
    persistSteps();
    const score = lintScore(finalFindings);
    const fixes = result.rounds ? ` after ${result.rounds} fix${result.rounds > 1 ? "es" : ""}` : "";
    const quality = `, quality ${score}/100`;
    const text = passed ? `Done${quality}${fixes}.` : `Done, with remaining issues${quality}.`;
    store.addMessage(
      conversation.id,
      "system",
      resultMessage(text, { passed, score, rounds: result.rounds, materialSources: generated > 0 ? [`Generated image assets (${generated})`] : [] }),
    );
    store.updateRun(run.id, {
      status: "succeeded",
      repairRounds: result.rounds,
      lintPassed: passed,
      score,
      findings: finalFindings,
      assistantMessageId: assistantMessage.id,
      finishedAt: Date.now(),
    });

    sse({
      type: "run-done",
      runId: run.id,
      passed,
      rounds: result.rounds,
      score,
      previewUrl: `/projects/${project.id}/preview/`,
      findings: finalFindings,
    });
    // Headless-screenshot the finished artifact as the gallery cover (best-effort, async).
    void captureCover(join(dir, result.artifactPath), join(dir, ".cover.png"));
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
