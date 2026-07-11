/**
 * POST /api/runs — the keystone that wires the whole spine together:
 * compose prompt (@dezin/prompt) → generate with the closed loop (@dezin/agent +
 * @dezin/quality) → stream run events over SSE → persist run/messages/artifact
 * (@dezin/core Store) → write the artifact to disk so /projects/:id/preview/ serves it.
 */

import { appendFile, mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { composeSystemPrompt, inferDials } from "../../../packages/prompt/src/index.ts";
import {
  generateArtifact,
  runTurnWithRetry,
  GenericCliRunner,
  getProvider,
  providerFamily,
  extractAskUserQuestion,
  isAbortError,
  abortError,
  type GenerateEvent,
  type AgentRunner,
} from "../../../packages/agent/src/index.ts";
import { defaultRegistry } from "../../../packages/design/src/index.ts";
import { loadSkills, findSkill, selectSkill, defaultSkillsDir, type SkillInfo } from "../../../packages/skills/src/index.ts";
import { loadCraftSections } from "../../../packages/craft/src/index.ts";
import { lintArtifact, applyIgnores } from "../../../packages/quality/src/index.ts";
import { generateImages } from "./image-gen.ts";
import { captureCover, captureCoverUrl } from "./capture-cover.ts";
import { auditVisualArtifact, type VisualQaInput } from "./visual-qa.ts";
import { ensureDevServer, releaseVariantRuntime, workingTreeFingerprint } from "./project-runtime.ts";
import { bestVersion } from "./best-version.ts";
import type { QualityFinding, Run, Settings } from "../../../packages/core/src/index.ts";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import { projectDir } from "./serve-static.ts";
import { standardVariantArtifactDir, variantRuntimeKey } from "./variant-workspaces.ts";
import {
  StandardRunSourceDirtyError,
  assertStandardRunSourceClean,
  beginStandardRunTransaction,
  type StandardRunTransaction,
} from "./standard-run-transaction.ts";
import { createRun, pushEvent, finishRun, cancelRun, subscribe } from "./run-manager.ts";
import { RunExecution, type RunSettlementPatch } from "./run-execution.ts";
import { BoundedEventBuffer, RUN_JOURNAL_MAX_BYTES, RUN_JOURNAL_MAX_EVENTS, RUN_JOURNAL_TRUNCATED } from "./bounded-buffer.ts";
import { appendMoodboardReferenceLine, buildProjectMoodboardContext, normalizeProjectMoodboardRefs } from "./project-moodboard-context.ts";
import { appendEffectReferenceLine, buildProjectEffectContext, normalizeProjectEffectRefs } from "./project-effect-context.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { runResearchPhase } from "./research-phase.ts";
import { syncVisualResearchMoodboard } from "./visual-research-moodboard.ts";
import {
  buildResearchContext,
  directionPath,
  directionTitle,
  directionBlurb,
  listDirections,
  listAssets,
  readSources,
  researchExists,
  writeChosenDirection,
  readChosenDirection,
  listVisualAssets,
  readVisualSources,
} from "../../../packages/research/src/index.ts";
import { providerRuntimeConfig } from "./provider-profile-config.ts";
import { createProviderFetch } from "./provider-fetch.ts";
import { ensureCaptured, capturedPageCount, releaseSharinganProject, sharinganRunCaptureId } from "./sharingan-handler.ts";
import { buildSharinganContext, buildSharinganSystemPrompt } from "./sharingan-context.ts";
import { writeProbeCli } from "./sharingan-probe-cli.ts";
import { sharinganReviewReference } from "./sharingan-capture.ts";
import { SHARINGAN_PAGE_BUDGET } from "./sharingan-browser.ts";
import {
  CEILING_MAX_ROUNDS,
  DEFECT_RECUR_LIMIT,
  IMPROVE_RECUR_LIMIT,
  autoImproveMaxRounds,
  floorScore,
  freshFindings,
  markVisualReviewRound,
  producedDesignReview,
  prototypeRepairPrompt,
  recurKey,
  researchAgentCommand,
  researchModel,
  reviewerAgentCommand,
  reviewerModel,
  shouldAutoRepair,
  splitFinalSummary,
  standardRepairableDefects,
  standardRepairPolicy,
  standardRepairPrompt,
  standardRunPassed,
  visualQaStartPayload,
  withResolvedVisualReviewHistory,
  withVisualScreenshotUrl,
} from "./run-policy.ts";
import {
  appendSharinganRegionIntegrationContext,
  runSharinganRegionSubagents,
  sharinganMainIntegrationRetryPrompt,
  syncSharinganCaptureBundle,
  type SharinganRegionBuild,
} from "./sharingan-region-runner.ts";
import type { AppDeps, DevServerLease } from "./app.ts";

export {
  freshFindings,
  recurKey,
  standardRepairableDefects,
  standardRepairPolicy,
  standardRepairPrompt,
  standardRunPassed,
};

// Skills are scanned once and cached for the daemon process.
let cachedSkills: SkillInfo[] | null = null;
function skills(): SkillInfo[] {
  if (!cachedSkills) cachedSkills = loadSkills();
  return cachedSkills;
}

/** Build the production agent runner from settings (BYOK). */
export function buildRunner(
  settings: Settings,
  override: { agentCommand?: string; model?: string } = {},
  options: { enforceArtifactUpdate?: boolean } = {},
): AgentRunner {
  const command = override.agentCommand || settings.agentCommand || "claude";
  const model = override.model || settings.model || undefined;
  const enforceArtifactUpdate = options.enforceArtifactUpdate ?? true;

  // Each agent's runner (stream-json for Claude/CodeBuddy, generic CLI for the rest) is
  // defined by its provider; an unknown CLI falls back to a best-effort positional prompt.
  const provider = getProvider(command);
  if (provider) return provider.createRunner({ command, model, enforceArtifactUpdate });

  const base = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  return new GenericCliRunner({
    id: base,
    command,
    model,
    config: { buildArgs: (m, p) => [...(m ? ["--model", m] : []), p] },
    enforceArtifactUpdate,
  });
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
const STANDARD_LINT_SKIP_DIRS = new Set([".git", ".sharingan", "dist", "node_modules", "version-worktrees"]);

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
  effectRefs?: unknown;
  /** Opt-in: run the pre-design Research phase (writes research/) before building. */
  research?: boolean;
  /** Chosen direction slug — skips the direction gate; the build uses this direction. */
  directionSlug?: string;
}

type ProcessItem = { type: "text"; text: string } | { type: "tool"; summary: string };

/**
 * In-memory guard that closes the TOCTOU window between findActiveRun and createRun: the DB row that
 * makes a concurrent request lose the race isn't inserted until createRun, and there are awaits in
 * between, so two near-simultaneous run POSTs could both pass the DB check. A synchronous check+add
 * keyed by project:variant prevents that (the daemon is single-process). Held until handleRun's
 * outermost finally so failures before or after durable row creation cannot strand or overlap a start.
 */
const startingRuns = new Set<string>();

function resultMessage(text: string, meta: Record<string, unknown>): string {
  return JSON.stringify({ result: { text, meta } });
}

function questionMessage(text: string, runId: string): string {
  return JSON.stringify({ question: { text, runId } });
}

function directionGateMessage(directions: Array<{ slug: string; title: string; markdown: string }>, runId: string, brief: string): string {
  return JSON.stringify({ directionGate: { directions, runId, brief } });
}

/** What the Research phase produced on disk — powers the workspace's Research card. */
export interface ResearchSummary {
  produced: boolean;
  error?: string;
  report: boolean;
  sources: number;
  assets: number;
  directions: Array<{ slug: string; title: string; summary: string }>;
  /** The parallel visual-research track's counts, so the card can show both tracks. */
  visual: { produced: boolean; assets: number; sources: number };
}

/** Read the .research/ tree into a compact summary for the UI (best-effort). */
async function summarizeResearch(dir: string, visualProduced: boolean): Promise<Omit<ResearchSummary, "produced" | "error">> {
  const [sources, assets, directions, visualAssets, visualSources] = await Promise.all([
    readSources(dir).catch(() => []),
    listAssets(dir).catch(() => []),
    listDirections(dir).catch(() => []),
    listVisualAssets(dir).catch(() => []),
    readVisualSources(dir).catch(() => []),
  ]);
  return {
    report: researchExists(dir),
    sources: sources.length,
    assets: assets.length,
    directions: directions.map((d) => ({ slug: d.slug, title: directionTitle(d.markdown), summary: directionBlurb(d.markdown) })),
    visual: { produced: visualProduced, assets: visualAssets.length, sources: visualSources.length },
  };
}

/** Persisted system message so the Research card survives reattach / history restore. */
function researchSummaryMessage(summary: ResearchSummary): string {
  return JSON.stringify({ research: summary });
}

/** The live (running) research card — persisted from research-start + updated per activity so its
 *  Product/Visual lanes survive the user navigating away and back (history restore rehydrates them). */
function researchCardMessage(activities: Array<{ kind: string; text: string; track?: "product" | "visual" }>): string {
  return JSON.stringify({ research: { status: "running", activities } });
}

type PersistedResearchActivity = { kind: string; text: string; track?: "product" | "visual"; seq?: number };

function clampUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const marker = Buffer.from("…", "utf8");
  let end = Math.max(0, maxBytes - marker.length);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return Buffer.concat([bytes.subarray(0, end), marker]).toString("utf8");
}

function createResearchActivityPersistence(input: {
  dataDir: string;
  runId: string;
  updateSnapshot: (activities: Array<{ kind: string; text: string; track?: "product" | "visual" }>) => void;
}): {
  append(activity: { kind: string; text: string; track?: "product" | "visual" }): PersistedResearchActivity;
  flush(): Promise<void>;
} {
  const snapshot = new BoundedEventBuffer(200, 256 * 1024);
  const journal = new BoundedEventBuffer(RUN_JOURNAL_MAX_EVENTS, RUN_JOURNAL_MAX_BYTES, "research-activity-truncated");
  const journalPath = join(input.dataDir, ".runs", input.runId, "research-activity.jsonl");
  let seq = 0;
  let writeQueue: Promise<void> = mkdir(join(input.dataDir, ".runs", input.runId), { recursive: true }).then(() => {});
  let pendingJournalLines: string[] = [];
  let journalTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  const snapshotValues = (): Array<{ kind: string; text: string; track?: "product" | "visual" }> =>
    snapshot.values().map((value) => {
      const event = value as Partial<PersistedResearchActivity> & { type?: string };
      if (event.type === RUN_JOURNAL_TRUNCATED) return { kind: "text", text: "Earlier research activity was truncated." };
      return {
        kind: typeof event.kind === "string" ? event.kind : "text",
        text: typeof event.text === "string" ? event.text : "Research activity",
        ...(event.track === "product" || event.track === "visual" ? { track: event.track } : {}),
      };
    });

  const persistSnapshot = (): void => {
    try {
      input.updateSnapshot(snapshotValues());
    } catch {
      // Research activity is diagnostic; message persistence cannot fail the Run.
    }
  };

  const scheduleSnapshot = (): void => {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      persistSnapshot();
    }, 250);
    snapshotTimer.unref?.();
  };

  const flushJournal = (): Promise<void> => {
    if (journal.truncated) {
      pendingJournalLines = [];
      const boundedSnapshot = journal.toJsonl();
      writeQueue = writeQueue
        .catch(() => {})
        .then(() => writeFile(journalPath, boundedSnapshot, "utf8"))
        .catch(() => {});
    } else if (pendingJournalLines.length > 0) {
      const chunk = pendingJournalLines.join("");
      pendingJournalLines = [];
      writeQueue = writeQueue
        .catch(() => {})
        .then(() => appendFile(journalPath, chunk, "utf8"))
        .catch(() => {});
    }
    return writeQueue;
  };

  const scheduleJournal = (): void => {
    if (journalTimer) return;
    journalTimer = setTimeout(() => {
      journalTimer = undefined;
      void flushJournal();
    }, 50);
    journalTimer.unref?.();
  };

  return {
    append(activity) {
      const clamped: PersistedResearchActivity = {
        kind: clampUtf8(String(activity.kind || "text"), 64),
        text: clampUtf8(String(activity.text || ""), 8 * 1024),
        ...(activity.track === "product" || activity.track === "visual" ? { track: activity.track } : {}),
        seq: ++seq,
      };
      snapshot.push(clamped);
      journal.push(clamped);
      const line = `${JSON.stringify(clamped)}\n`;
      if (journal.truncated) pendingJournalLines = [];
      else pendingJournalLines.push(line);
      scheduleJournal();
      scheduleSnapshot();
      return clamped;
    },
    async flush() {
      if (journalTimer) {
        clearTimeout(journalTimer);
        journalTimer = undefined;
      }
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = undefined;
      }
      await flushJournal().catch(() => {});
      persistSnapshot();
    },
  };
}

/** A compact HTML snippet of a kept design from any project, for cross-project exemplars. */
function exemplarSnippet(dataDir: string, projectId: string, runId: string): string | null {
  const path = join(projectDir(dataDir, projectId), ".versions", `${runId}.html`);
  if (!existsSync(path)) return null;
  try {
    const html = readFileSync(path, "utf8");
    const body = html.length > 1600 ? `${html.slice(0, 1600)}\n<!-- …truncated -->` : html;
    return `\`\`\`html\n${body}\n\`\`\``;
  } catch {
    return null;
  }
}

function processMessage(items: ProcessItem[], elapsedMs?: number): string {
  return JSON.stringify({ process: { items, elapsedMs } });
}

function visualReviewMessage(input: {
  runId: string;
  round: number;
  enabled: boolean;
  settings: Settings;
  agentCommand: string;
  model?: string;
  screenshotUrl?: string;
  screenshotPath?: string;
  findings: QualityFinding[];
}): string {
  const agentCommand = reviewerAgentCommand(input.settings, input.agentCommand);
  const model = reviewerModel(input.settings, input.model);
  const reviewer = [agentCommand, model].filter((value): value is string => !!value && value.trim().length > 0).join(" / ") || "selected reviewer";
  const summary = input.findings.find((finding) => typeof finding.reviewSummary === "string" && finding.reviewSummary.trim())?.reviewSummary;
  return JSON.stringify({
    visualReview: {
      status: "complete",
      runId: input.runId,
      enabled: input.enabled,
      round: input.round,
      agentCommand,
      model,
      screenshotUrl: input.screenshotUrl,
      screenshotPath: input.screenshotPath,
      summary,
      findings: input.findings,
      process: [
        { type: "tool", summary: input.screenshotUrl || input.screenshotPath ? "Captured preview screenshot" : "Preparing preview screenshot" },
        { type: "tool", summary: `Reviewing screenshot with ${reviewer}` },
      ],
    },
  });
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
  options: Pick<VisualQaInput, "projectRoot" | "renderUrl" | "directionSpec" | "sharinganReference" | "isSharingan"> = {},
): Promise<QualityFinding[]> {
  if (!settings.visualQaEnabled) return [];
  try {
    const runner = deps.visualQa ?? auditVisualArtifact;
    return await runner({
      htmlPath,
      settings,
      agentCommand: reviewerAgentCommand(settings, agentCommand),
      model: reviewerModel(settings, model),
      // The fingerprint is about who GENERATED the artifact, not who reviews it.
      provider: providerFamily(getProvider(agentCommand)?.id, model),
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
  // The generating model family — enables provider-fingerprint quality rules (GPT/Gemini tells).
  const runProviderFamily = providerFamily(getProvider(runAgentCommand)?.id, runModel);
  const agentEnv = buildAgentEnv(settings, runAgentCommand, deps.security?.token);
  const imageRuntime = providerRuntimeConfig(settings, settings.aiProviderId);
  const imageBaseUrl = imageRuntime.baseUrl || settings.imageApiBaseUrl;
  const imageApiKey = imageRuntime.apiKey || settings.imageApiKey;
  const project = store.getProject(body.projectId);
  if (!project) return sendError(res, 404, "project not found");
  // Persistent false-positive suppression — drop findings the user has dismissed on prior runs.
  const qualityIgnores = store.listQualityIgnores(project.id);
  const suppress = (findings: QualityFinding[]): QualityFinding[] => applyIgnores(findings, qualityIgnores) as QualityFinding[];
  // deps.runner is the test override; production builds from settings (live changes apply).
  const runner =
    deps.runner ??
    buildRunner(
      settings,
      { agentCommand: body.agentCommand, model: body.model },
      { enforceArtifactUpdate: project.mode !== "standard" },
    );

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
  // Also guard the window before createRun's row exists (see startingRuns) — synchronous check+add.
  const startKey = `${project.id}:${targetVariantId}`;
  if (startingRuns.has(startKey)) return sendError(res, 409, "run already in progress for this project variant");
  startingRuns.add(startKey);
  let durableRun: Run | null = null;
  let execution: RunExecution | null = null;
  let ctrl: AbortController | null = null;
  let unsubscribe = (): void => {};
  let brokerRegistered = false;
  let streamSubscribed = false;
  let stopPoll: (() => void) | null = null;
  let dir!: string;
  let standardSourceDir: string | null = null;
  let standardSourceError: unknown = null;
  let standardTransaction: StandardRunTransaction | null = null;
  let sharinganCaptureId: string | null = null;

  try {
    if (project.mode === "standard") {
      try {
        standardSourceDir = await standardVariantArtifactDir(deps, project.id, targetVariantId);
        await assertStandardRunSourceClean(standardSourceDir);
      } catch (error) {
        if (error instanceof StandardRunSourceDirtyError) {
          sendError(res, 409, error.message);
          return;
        }
        standardSourceError = error;
      }
    } else {
      standardSourceDir = null;
    }
    conversation ??= store.createConversation(project.id);

  // Resolve the active design system (the project's, else the settings default).
  // Sharingan reconstructs from captured source pixels/assets, so it must not inherit
  // a project/default design system or brand craft guidance.
  const registry = deps.designRegistry ?? defaultRegistry();
  const designSystemId = project.sharingan ? undefined : (project.designSystemId ?? settings.defaultDesignSystemId);
  const designSystem = designSystemId ? (registry.get(designSystemId) ?? registry.default()) : null;

  // Best-guess skill: an explicit project.skillId pins it; otherwise the brief's
  // top trigger match. This is NOT forced on the agent — it only seeds craft
  // selection, research angles, and attribution. Skills are chosen at RUNTIME:
  // the agent gets the full catalog (below) and reads whichever playbook(s) fit,
  // on demand — like Claude Code / Agent Skills, not a single skill picked upfront.
  const skill = project.skillId ? findSkill(skills(), project.skillId) : selectSkill(body.brief.trim(), skills());

  // Craft = the union of the best-guess skill's required sections and the brand's applied ones.
  const craftSlugs = project.sharingan ? [] : Array.from(new Set([...(skill?.craft ?? []), ...(designSystem?.craft?.applies ?? [])]));
  const craft = project.sharingan ? null : loadCraftSections(craftSlugs);

  const systemPrompt = project.sharingan
    ? buildSharinganSystemPrompt()
    : composeSystemPrompt({
        designSystem: designSystem ?? registry.default(),
        // The whole catalog, for on-demand loading. A pinned project.skillId is
        // surfaced first and flagged, but the agent still judges + reads on its own.
        skills: skills().map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          triggers: s.triggers,
          mode: s.mode,
          libraries: s.libraries,
          pinned: project.skillId ? s.id === project.skillId : false,
        })),
        skillsDir: defaultSkillsDir(),
        userInstructions: settings.customInstructions || undefined,
        craft: craft || undefined,
        imageGen: Boolean(imageApiKey && imageBaseUrl),
        mode: project.mode,
        // Variance/motion/density inferred from the brief — bind the design to explicit targets.
        dials: inferDials(body.brief.trim()),
      });

  const brief = body.brief.trim();
  const moodboardRefs = normalizeProjectMoodboardRefs(body.moodboardRefs);
  const effectRefs = normalizeProjectEffectRefs(body.effectRefs);
  const origin = requestOrigin(req);
  // Prior turns in this conversation become the agent's chat context (captured before we add
  // the new user message). System/process records are excluded.
  const history = store
    .listMessages(conversation.id)
    .flatMap(messageToAgentTurn);
  const run = store.createRun(project.id, conversation.id, targetVariantId, undefined, deps.daemonOwnerId, {
    model: runModel ?? null,
    agentCommand: runAgentCommand,
    skillId: skill?.id ?? null,
  });
  durableRun = run;
  if (standardSourceError) throw standardSourceError;
  if (project.mode === "standard") {
    standardTransaction = await beginStandardRunTransaction(
      { dataDir: deps.dataDir, runtimeSupervisor: deps.runtimeSupervisor },
      {
        projectId: project.id,
        variantId: targetVariantId,
        runId: run.id,
        sourceDir: standardSourceDir!,
      },
    );
    dir = standardTransaction.dir;
  } else {
    dir = projectDir(deps.dataDir, project.id);
  }
  await mkdir(dir, { recursive: true });
  const openStream = (): void => {
    if (res.headersSent) return;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  };
  const writeStreamEvent = (event: unknown): void => {
    try {
      openStream();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* socket closed */
    }
  };
  const emitBrokerEvent = (event: unknown): void => {
    if (!brokerRegistered) throw new Error("Run broker is not registered");
    pushEvent(run.id, event);
    if (!streamSubscribed) throw new Error("Run stream is not subscribed");
  };
  const emitRunEvent = (event: unknown): void => {
    try {
      emitBrokerEvent(event);
    } catch {
      writeStreamEvent(event);
    }
  };
  execution = new RunExecution({
    store,
    runId: run.id,
    emit: emitBrokerEvent,
    fallbackEmit: writeStreamEvent,
    finish: () => {
      if (brokerRegistered) finishRun(run.id);
    },
    unsubscribe: () => unsubscribe(),
    closeStream: () => {
      if (!res.writableEnded) res.end();
    },
  });
  ctrl = createRun({
    runId: run.id,
    conversationId: conversation.id,
    projectId: project.id,
    variantId: targetVariantId,
    dataDir: deps.dataDir,
    runtimeSupervisor: deps.runtimeSupervisor,
  });
  brokerRegistered = true;

  const moodboardContext = buildProjectMoodboardContext({
    store,
    dataDir: deps.dataDir,
    runId: run.id,
    refs: moodboardRefs,
    request: brief,
  });
  const effectContext = buildProjectEffectContext({
    store,
    refs: effectRefs,
    request: brief,
    origin: origin ?? "",
  });
  const visibleBrief = appendEffectReferenceLine(appendMoodboardReferenceLine(brief, moodboardContext.labels), effectContext.labels);
  let agentBrief = [visibleBrief, moodboardContext.promptBlock, effectContext.promptBlock].filter(Boolean).join("\n\n");
  // The chosen direction's spec, if research produced one — handed to the critic as its aesthetic
  // contract so it judges palette/soul alignment, not just micro-polish.
  let chosenDirectionSpec: string | undefined;
  // Building a pre-chosen direction is a CONTINUATION of the original brief that already researched
  // on the prior run. Re-persisting its user message and re-running research here would surface the
  // user message + the research card TWICE on reload — so detect it and skip that duplicate work.
  const buildingChosenDirection = !!body.directionSlug?.trim();
  const researchOnDisk = researchExists(dir);
  const alreadyResearched = buildingChosenDirection && researchOnDisk;
  const userMessage = alreadyResearched ? null : store.addMessage(conversation.id, "user", visibleBrief);
  store.updateRun(run.id, userMessage ? { status: "running", userMessageId: userMessage.id } : { status: "running" });

  // Open the SSE stream + register the run with the broker. Events are buffered + persisted to
  // a per-run log so another client can reattach (after navigating away, or an app restart) and
  // replay what the run reached. The run continues regardless of THIS client's connection — it
  // ends only on completion, an explicit cancel, or the daemon exiting.
  openStream();
  unsubscribe = subscribe(
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
  streamSubscribed = true;
  // On disconnect just stop writing — do NOT cancel; the run keeps going for reattach.
  req.on("close", unsubscribe);
  const sse = emitRunEvent;
  sse({ type: "run-start", runId: run.id, conversationId: conversation.id, variantId: targetVariantId });

  const checkpointChosenDirection = async (chosenDirection: string): Promise<void> => {
    await writeChosenDirection(dir, chosenDirection);
    if (!standardTransaction || !standardSourceDir) return;
    if (!(await workingTreeFingerprint(standardTransaction.dir))) return;

    ctrl!.signal.throwIfAborted();
    await standardTransaction.commit(`Dezin: choose research direction ${chosenDirection}`);
    const chosenCommit = await standardTransaction.publish();
    // The direction choice is now durable. Metadata is secondary and cannot undo that checkpoint.
    try { store.updateRun(run.id, { commitHash: chosenCommit }); } catch { /* best-effort */ }
    await standardTransaction.dispose();
    standardTransaction = null;

    ctrl!.signal.throwIfAborted();
    standardTransaction = await beginStandardRunTransaction(
      { dataDir: deps.dataDir, runtimeSupervisor: deps.runtimeSupervisor },
      {
        projectId: project.id,
        variantId: targetVariantId,
        runId: run.id,
        sourceDir: standardSourceDir,
      },
    );
    dir = standardTransaction.dir;
  };

  // Optional pre-design Research phase (opt-in via body.research). It writes the
  // research/ directory, then its report is prepended to the brief so the build is
  // grounded in real discovery. Idempotent; a soft failure just proceeds without it.
  // Auto-Research (Settings toggle / env) runs ONLY on a project not yet researched. A follow-up
  // turn on an already-researched project must not auto-re-enter it: research would only flash
  // "Researching" (the phase early-returns since the report/directions already exist), then
  // re-surface the old direction gate and cancel the run. An explicit body.research === true still
  // forces it. Sharingan projects skip Research entirely — the URL brief is not a research topic.
  const autoResearch = (settings.researchEnabled || process.env.DEZIN_RESEARCH === "1") && !researchOnDisk;
  if (!alreadyResearched && body.research !== false && (body.research === true || autoResearch) && !project.sharingan) {
    sse({ type: "research-start", runId: run.id });
    // Persist the research card from the START (not just its done-summary), updated per activity, so
    // its live Product/Visual lanes survive navigating away and back — history restore rehydrates them.
    const researchCardMsg = store.addMessage(conversation.id, "system", researchCardMessage([]));
    const researchActivity = createResearchActivityPersistence({
      dataDir: deps.dataDir,
      runId: run.id,
      updateSnapshot: (activities) => store.updateMessage(researchCardMsg.id, researchCardMessage(activities)),
    });
    let research: Awaited<ReturnType<typeof runResearchPhase>>;
    try {
      research = await (deps.researchPhase ?? runResearchPhase)({
        dir,
        brief: visibleBrief,
        skill: skill ? { id: skill.id, name: skill.name } : undefined,
        designSystemName: (designSystem ?? registry.default()).name,
        hasUserReferences: moodboardContext.labels.length > 0 || effectContext.labels.length > 0,
        agentCommand: researchAgentCommand(settings, runAgentCommand),
        model: researchModel(settings, runModel),
        env: agentEnv,
        signal: ctrl.signal,
        onActivity: (activity) => {
          const persisted = researchActivity.append(activity);
          sse({ type: "research-activity", runId: run.id, kind: persisted.kind, text: persisted.text, track: persisted.track });
        },
      });
    } finally {
      // Flush the bounded JSONL + message snapshot before any direction/question/terminal path.
      await researchActivity.flush();
    }
    // Best-effort: fold any visual-track assets into the project's "Visual research" moodboard
    // so the workspace can show them immediately. Idempotent (reuses the board via a pointer
    // file) and safe to run on every research pass, independent of whether the product track
    // gates on a direction pick below — a missing/empty visual track is harmless.
    await syncVisualResearchMoodboard({ store: deps.store, dataDir: deps.dataDir, projectDir: dir }).catch(() => {});
    const researchSummary: ResearchSummary = {
      produced: research.produced,
      error: research.error,
      ...(await summarizeResearch(dir, research.visualProduced)),
    };
    sse({ type: "research-done", runId: run.id, ...researchSummary });
    // Finalize the SAME card (created at research-start) with the done-summary — not a new message,
    // so the card isn't duplicated on reload.
    store.updateMessage(researchCardMsg.id, researchSummaryMessage(researchSummary));
    if (research.produced) {
      const chosenDirection = body.directionSlug?.trim() || undefined;
      // Direction gate: when research produced 2+ candidate directions and the caller
      // hasn't chosen one, surface them and end the run (like the ask-user question). The
      // user's next run passes directionSlug to build the chosen direction.
      const directions = chosenDirection ? [] : await listDirections(dir);
      if (directions.length >= 2) {
        const options = directions.map((d) => ({ slug: d.slug, title: directionTitle(d.markdown), markdown: d.markdown }));
        if (standardTransaction) {
          if (await workingTreeFingerprint(standardTransaction.dir)) {
            await standardTransaction.commit("Dezin: save research directions");
          }
          const publishedResearch = await standardTransaction.publish();
          dir = standardSourceDir!;
          store.updateRun(run.id, { commitHash: publishedResearch });
        }
        store.addMessage(conversation.id, "system", directionGateMessage(options, run.id, visibleBrief));
        sse({ type: "direction-gate", runId: run.id, directions: options, brief: visibleBrief });
        execution.settle("cancelled", {
          finishedAt: Date.now(),
          event: { type: "run-cancelled", runId: run.id, reason: "direction" },
        });
        return;
      }
      // Record the pick so the workspace can show which direction was chosen (survives reload).
      if (chosenDirection) await checkpointChosenDirection(chosenDirection);
      if (chosenDirection) chosenDirectionSpec = await readFile(directionPath(dir, chosenDirection), "utf8").catch(() => undefined);
      const researchContext = await buildResearchContext(dir, chosenDirection);
      if (researchContext) agentBrief = `${researchContext}\n\n---\n\n${agentBrief}`;
    }
  } else if (alreadyResearched) {
    // The prior run already researched + produced the directions. Wire the chosen direction into
    // THIS build (its spec for the critic + the research context in the brief) WITHOUT re-running
    // research — re-running it re-persists the user message + research card and redoes the work.
    const chosenDirection = body.directionSlug!.trim();
    await checkpointChosenDirection(chosenDirection);
    chosenDirectionSpec = await readFile(directionPath(dir, chosenDirection), "utf8").catch(() => undefined);
    const researchContext = await buildResearchContext(dir, chosenDirection);
    if (researchContext) agentBrief = `${researchContext}\n\n---\n\n${agentBrief}`;
  } else if (researchOnDisk) {
    // A follow-up turn on an already-researched project: we deliberately did NOT re-run research
    // above (that would re-surface the direction gate and cancel the run). But still re-wire the
    // previously-chosen direction's spec (the critic's aesthetic contract) and the research context
    // into this build, so follow-ups stay grounded in the same direction/discovery as the first build.
    const chosenDirection = (await readChosenDirection(dir).catch(() => null)) ?? undefined;
    if (chosenDirection) chosenDirectionSpec = await readFile(directionPath(dir, chosenDirection), "utf8").catch(() => undefined);
    const researchContext = await buildResearchContext(dir, chosenDirection);
    if (researchContext) agentBrief = `${researchContext}\n\n---\n\n${agentBrief}`;
  }

  // Sharingan: capture the entry page (idempotent — a no-op once already "captured") before the
  // build turn, then hand the agent the reconstruct-from-capture context (the .sharingan/ bundle
  // location + the live browser-control probe endpoints). Runs once per build, not per repair
  // round — this sits before turnMessage is first derived from agentBrief, so the FIRST build
  // turn already sees it.
  if (project.sharingan) {
    await syncSharinganCaptureBundle(projectDir(deps.dataDir, project.id), dir).catch(() => {});
  }
  if (project.sharingan && project.sourceUrl) {
    sharinganCaptureId = sharinganRunCaptureId(project.id, run.id);
    const sharinganSignal = ctrl.signal;
    // Best-effort: never fail the build on a capture hiccup — the agent can still probe live.
    await ensureCaptured(sharinganCaptureId, deps.dataDir, project.sourceUrl, {
      signal: sharinganSignal,
      keepSessionForProbe: true,
      artifactDir: dir,
      open: deps.sharinganOpen,
    }).catch((error) => {
      if (sharinganSignal.aborted || isAbortError(error)) throw error;
    });
    // Write the dezin-probe CLI into .sharingan/ so the agent drives capture with a real tool, not curl.
    const probeBase = `${(origin ?? "").replace(/\/+$/, "")}/api/sharingan/${project.id}`;
    try { writeProbeCli(dir, probeBase, run.id); } catch { /* best-effort */ }
    agentBrief = [
      agentBrief,
      buildSharinganContext({
        sourceUrl: project.sourceUrl,
        budget: SHARINGAN_PAGE_BUDGET,
        capturedCount: capturedPageCount(sharinganCaptureId),
      }).promptBlock,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  // Exemplar retrieval: reference the user's previously-kept (👍) designs so the build
  // matches the caliber and direction they have already approved.
  if (project.mode !== "standard") {
    const kept = store
      .listUpvotedRuns(project.id, 2)
      .filter((r) => r.id !== run.id && existsSync(join(dir, ".versions", `${r.id}.html`)));
    if (kept.length) {
      const refs = kept.map((r) => `\`.versions/${r.id}.html\``).join(", ");
      agentBrief = `The user KEPT these earlier designs in this project — open and study them, and match their caliber and direction (evolve, do not copy verbatim): ${refs}.\n\n---\n\n${agentBrief}`;
    }
  }

  // Cross-project exemplars: designs the user kept for this SAME kind of work in other
  // projects, injected as compact snippets to teach caliber and voice.
  if (project.mode !== "standard" && skill?.id) {
    const snippets = store
      .listExemplarRuns({ skillId: skill.id, excludeProjectId: project.id, limit: 1 })
      .map((r) => exemplarSnippet(deps.dataDir, r.projectId, r.id))
      .filter((s): s is string => Boolean(s));
    if (snippets.length) {
      agentBrief = `You have kept designs of this kind before — match their caliber and voice (evolve, do not copy):\n\n${snippets.join("\n\n")}\n\n---\n\n${agentBrief}`;
    }
  }

  // Record the agent's interleaved process so the conversation can be restored after
  // navigation/restart without losing streamed text or the original tool order.
  const steps: string[] = [];
  const processItems: ProcessItem[] = [];
  const visualReviewRecords: string[] = [];
  let summaryBoundarySeen = false;
  let processStartedAt = run.createdAt;
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
    if (items.length) store.addMessage(run.conversationId, "system", processMessage(items, Math.max(0, Date.now() - processStartedAt)));
    processItems.splice(0);
    summaryBoundarySeen = false;
  };
  const persistSteps = (): void => {
    if (steps.length) store.addMessage(run.conversationId, "system", JSON.stringify({ steps }));
    steps.splice(0);
  };
  const queueVisualReviewRecord = (round: number, enabled: boolean, findings: QualityFinding[], screenshotUrl?: string, screenshotPath?: string): void => {
    if (!enabled) return;
    visualReviewRecords.push(visualReviewMessage({ runId: run.id, round, enabled, settings, agentCommand: runAgentCommand, model: runModel, screenshotUrl, screenshotPath, findings }));
  };
  const persistVisualReviews = (): void => {
    for (const record of visualReviewRecords.splice(0)) store.addMessage(run.conversationId, "system", record);
  };
  const persistTranscript = (assistantText?: string): string | null => {
    persistProcess();
    const trimmed = assistantText?.trim() ?? "";
    const assistantMessage = trimmed ? store.addMessage(run.conversationId, "assistant", trimmed) : null;
    persistSteps();
    persistVisualReviews();
    return assistantMessage?.id ?? null;
  };

  // Standard mode: the agent edits a real Vite project (src/*), not a single HTML.
  // No closed lint loop on one file; run a turn, commit the diff to git as a version.
  if (project.mode === "standard") {
    let publishedSuccessPatch: RunSettlementPatch | null = null;
    let livePreviewLease: DevServerLease | null = null;
    let handedOffLivePreviewLease = false;
    const settlePublishedSuccess = (patch: RunSettlementPatch): void => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          execution!.settle("succeeded", patch);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };
    try {
      const ensureStandardDevServer = deps.ensureDevServer ?? ensureDevServer;
      const repairPolicy = standardRepairPolicy(settings, project.sharingan, body.maxRounds);
      const visualQaEnabledForRun = settings.visualQaEnabled || project.sharingan;
      const visualQaSettings = visualQaEnabledForRun === settings.visualQaEnabled ? settings : { ...settings, visualQaEnabled: true };
      const maxRepairRounds = repairPolicy.maxRounds;
      const turnHistory: Array<{ role: "user" | "assistant"; content: string }> = [...history];
      let round = 0;
      let repairRounds = 0;
      let turnMessage = agentBrief;
      let finalAssistantText = "";
      let commitHash: string | null = null;
      let findings: QualityFinding[] = [];
      let visualReviewHistory: QualityFinding[] = [];
      let score = 100;
      let passed = true;
      const repairSnapshotCommits = new Set<string>();
      let livePreviewUrl: string | null = null;
      let sharinganRegionSubagentsRan = false;
      let sharinganRegionBuildsForRun: SharinganRegionBuild[] = [];
      let sharinganMainNoopRetried = false;
      // Convergence state: don't grind. Track prior tree states (oscillation), the best floor
      // score (marginal-gain), and the bounded design-improvement (ceiling) phase.
      const convergenceTrees = new Set<string>();
      let bestFloorScore = 0;
      // Every committed round's score — so the loop can RETURN the best-scoring version, not the last
      // (a repair round can regress the score and the give-up/stall guard leaves the tree on it).
      const versions: { score: number; commitHash: string; findings: QualityFinding[]; passed: boolean }[] = [];
      let floorStalled = 0;
      let improvementRounds = 0;
      const improvementHistory = new Map<string, number>(); // suggestion key → times fed back (verify-applied)
      const defectHistory = new Map<string, number>(); // defect key → times retried (give-up guard)
      const stuckDefectKeys = new Set<string>(); // defects the agent repeatedly failed to fix
      const emitStandardPreviewUpdate = async (eventRound: number): Promise<void> => {
        try {
          const nextLease = await ensureStandardDevServer(
            project.id,
            dir,
            variantRuntimeKey(project.id, targetVariantId),
            ctrl!.signal,
            deps.previewLeaseManager,
          );
          const previousLease = livePreviewLease;
          livePreviewLease = nextLease;
          livePreviewUrl = nextLease.url;
          await previousLease?.release?.();
          sse({
            type: "preview-update",
            runId: run.id,
            mode: "standard",
            variantId: targetVariantId,
            previewUrl: nextLease.url,
            leaseId: nextLease.leaseId,
            expiresAt: nextLease.expiresAt,
            t: Date.now(),
            round: eventRound,
          });
        } catch (err) {
          sse({
            type: "preview-update",
            runId: run.id,
            mode: "standard",
            variantId: targetVariantId,
            t: Date.now(),
            round: eventRound,
          });
          sse({
            type: "activity",
            round: eventRound,
            activity: {
              kind: "tool",
              name: "preview",
              summary: `Preview server is not ready yet - ${err instanceof Error ? err.message : "dev server unavailable"}`,
            },
          });
        }
      };

      while (true) {
        const isRepair = round > 0;
        let regionBuildsThisTurn = 0;
        if (project.sharingan && !isRepair && !sharinganRegionSubagentsRan) {
          sharinganRegionSubagentsRan = true;
          const sharinganRegionBuilds = await runSharinganRegionSubagents({
            runner,
            projectDir: dir,
            runId: run.id,
            signal: ctrl.signal,
            env: agentEnv,
            emit: sse,
            onActivity: (activity, region) => {
              const visible = recordActivity(activity);
              if (visible) sse({ type: "activity", round, sharinganRegionId: region.id, activity: visible });
            },
          });
          sharinganRegionBuildsForRun = sharinganRegionBuilds;
          regionBuildsThisTurn = sharinganRegionBuilds.length;
          if (sharinganRegionBuilds.length) turnMessage = appendSharinganRegionIntegrationContext(turnMessage, sharinganRegionBuilds);
        }
        const beforeTree = await workingTreeFingerprint(dir);
        processStartedAt = Date.now();
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
          persistTranscript(asked.text);
          store.addMessage(conversation.id, "system", questionMessage(asked.question, run.id));
          sse({ type: "ask-user-question", runId: run.id, question: asked.question });
          execution.settle("cancelled", {
            finishedAt: Date.now(),
            event: { type: "run-cancelled", runId: run.id, reason: "question" },
          });
          return;
        }

        finalAssistantText = final.summaryText;
        turnHistory.push({ role: "user", content: turnMessage });
        if (final.summaryText) turnHistory.push({ role: "assistant", content: final.summaryText });
        if (isRepair) repairRounds = Math.max(repairRounds, round);

        const afterTree = await workingTreeFingerprint(dir);
        const unchangedInitialSharinganTurn = project.sharingan && !isRepair && regionBuildsThisTurn === 0 && afterTree === beforeTree;
        if (afterTree === beforeTree && !unchangedInitialSharinganTurn) {
          if (!isRepair && project.sharingan && regionBuildsThisTurn > 0 && !sharinganMainNoopRetried) {
            sharinganMainNoopRetried = true;
            round = 1;
            turnMessage = sharinganMainIntegrationRetryPrompt(sharinganRegionBuildsForRun);
            continue;
          }
          if (!isRepair || !commitHash) throw new Error("The selected Agent finished without changing project files.");
          break;
        }
        if (!unchangedInitialSharinganTurn) {
          commitHash = await standardTransaction!.commit(isRepair ? `Auto-improve round ${round}: ${visibleBrief}` : visibleBrief);
          store.updateRun(run.id, { commitHash, repairRounds });
        }
        await emitStandardPreviewUpdate(round);

        const staticSurface = await collectStandardLintSurface(dir);
        const staticFindings = suppress((staticSurface.trim() ? lintArtifact(staticSurface, { mode: "standard", provider: runProviderFamily, isSharingan: project.sharingan }) : []) as QualityFinding[]);
        if (staticFindings.length) sse({ type: "static-quality", round, findings: staticFindings });
        let visualFindings: QualityFinding[] = [];
        if (visualQaEnabledForRun) {
          const screenshotUrl = `/api/projects/${project.id}/variants/${targetVariantId}/preview/.visual-qa/screenshot.png`;
          sse({ ...visualQaStartPayload(round, visualQaSettings, runAgentCommand, runModel, screenshotUrl), runId: run.id });
          let renderUrl: string | undefined;
          let temporaryQaLease: DevServerLease | undefined;
          if (!deps.visualQa) {
            try {
              if (livePreviewUrl) renderUrl = livePreviewUrl;
              else {
                temporaryQaLease = await ensureStandardDevServer(
                  project.id,
                  dir,
                  variantRuntimeKey(project.id, targetVariantId),
                  ctrl.signal,
                  deps.previewLeaseManager,
                );
                renderUrl = temporaryQaLease.url;
              }
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
          try {
            if (!visualFindings.length) {
              visualFindings = await runVisualQa(deps, join(dir, "index.html"), visualQaSettings, runAgentCommand, runModel, visibleBrief, turnHistory, {
                projectRoot: dir,
                renderUrl,
                directionSpec: chosenDirectionSpec,
                sharinganReference: project.sharingan ? sharinganReviewReference(dir) : undefined,
                isSharingan: project.sharingan,
              });
            }
          } finally {
            await temporaryQaLease?.release?.();
          }
          visualFindings = suppress(markVisualReviewRound(withVisualScreenshotUrl(visualFindings, screenshotUrl), round));
          visualReviewHistory = [...visualReviewHistory, ...visualFindings];
          sse({ type: "visual-qa", runId: run.id, round, enabled: visualQaEnabledForRun, findings: visualFindings });
          queueVisualReviewRecord(round, visualQaEnabledForRun, visualFindings, screenshotUrl);
        }
        findings = [...staticFindings, ...visualFindings];
        score = floorScore(findings);
        passed = standardRunPassed(findings, project.sharingan);
        if (commitHash) versions.push({ score, commitHash, findings, passed });
        store.updateRun(run.id, {
          commitHash,
          repairRounds,
          lintPassed: passed,
          score,
          findings: withResolvedVisualReviewHistory(findings, visualReviewHistory),
        });
        await emitStandardPreviewUpdate(round);

        // Converge, don't grind. Oscillation guard: if the working tree returns to a state we
        // already produced, we're cycling (the ellipsis↔wrap flip-flop) — stop. Normal Standard
        // runs repair floor defects first, then optional design-improvement ceiling rounds.
        // Sharingan treats all non-marker findings as required reconstruction issues.
        if (afterTree && convergenceTrees.has(afterTree)) break;
        if (afterTree) convergenceTrees.add(afterTree);
        if (!repairPolicy.enabled || repairRounds >= maxRepairRounds) break;

        const defects = standardRepairableDefects(findings, project.sharingan);
        const improvements = project.sharingan ? [] : findings.filter((f) => f.id.startsWith("visual-improve"));
        // Give-up guard: a defect the critic keeps re-raising unchanged is one the model can't fix
        // — record it as stuck (surfaced to the user) and stop retrying it so the loop doesn't spin.
        for (const d of defects) if ((defectHistory.get(recurKey(d)) ?? 0) >= DEFECT_RECUR_LIMIT) stuckDefectKeys.add(recurKey(d));
        const liveDefects = freshFindings(defects, defectHistory, DEFECT_RECUR_LIMIT);
        const freshImps = freshFindings(improvements, improvementHistory, IMPROVE_RECUR_LIMIT);

        let repairFindings: QualityFinding[] | null = null;
        if (liveDefects.length > 0) {
          // Floor phase — the objective GATE: fix the defects the model can still make progress on,
          // but stop if the lint score stalls for 2 rounds.
          if (score > bestFloorScore) {
            bestFloorScore = score;
            floorStalled = 0;
          } else {
            floorStalled += 1;
          }
          if (floorStalled < 2) repairFindings = project.sharingan ? liveDefects : liveDefects.concat(freshImps.slice(0, 3));
        } else if (!project.sharingan && freshImps.length > 0 && improvementRounds < CEILING_MAX_ROUNDS) {
          // Ceiling phase — ADVISORY design suggestions, verify-applied. Converges when nothing
          // FRESH remains (or the cap / oscillation guard trips). No design SCORE.
          improvementRounds += 1;
          repairFindings = freshImps;
        }
        if (!repairFindings || !repairFindings.length) break;

        const nextRound = repairRounds + 1;
        const repairPrompt = standardRepairPrompt(repairFindings, nextRound, maxRepairRounds, score, visibleBrief, { isSharingan: project.sharingan });
        if (!repairPrompt) break;
        if (commitHash && !repairSnapshotCommits.has(commitHash)) {
          repairSnapshotCommits.add(commitHash);
          store.createImportedRun(project.id, conversation.id, {
            variantId: targetVariantId,
            userMessageId: userMessage?.id,
            commitHash,
            status: "succeeded",
            repairRounds,
            lintPassed: passed,
            score,
            findings: withResolvedVisualReviewHistory(findings, visualReviewHistory),
            createdAt: Math.max(0, run.createdAt - (maxRepairRounds - round + 1)),
            finishedAt: Date.now(),
            model: runModel ?? null,
            agentCommand: runAgentCommand,
            skillId: skill?.id ?? null,
          });
          await emitStandardPreviewUpdate(round);
        }
        if (visualReviewRecords.length) persistTranscript(finalAssistantText);
        round = nextRound;
        turnMessage = repairPrompt;
      }

      // Return the BEST-scoring version, not just the last round. If an earlier round scored higher,
      // restore its files (history-preserving) so the live preview + the returned run reflect it.
      const best = bestVersion(versions);
      if (best && best.commitHash !== commitHash) {
        const restored = await standardTransaction!.restoreBest(best.commitHash).then(() => true, () => false);
        if (restored) {
          commitHash = standardTransaction!.head;
          score = best.score;
          passed = best.passed;
          findings = best.findings;
          await emitStandardPreviewUpdate(round);
        }
      }

      if (ctrl.signal.aborted) throw abortError();
      if (!commitHash) throw new Error("The selected Agent did not leave any project changes to publish.");
      commitHash = await standardTransaction!.publish();
      // Establish the published-success recovery invariant immediately after the irreversible
      // filesystem boundary. If any later computation throws, the catch path can only settle this
      // same success (or surface a persistence error), never manufacture a failed Run.
      publishedSuccessPatch = {
        repairRounds,
        lintPassed: passed,
        score,
        findings,
        commitHash,
        finishedAt: Date.now(),
        event: { type: "run-done", runId: run.id, passed, rounds: repairRounds, score, mode: "standard", findings },
      };
      dir = standardSourceDir!;
      // Publication is the irreversible success boundary. Everything below is secondary metadata,
      // transcript, preview, or cover work and must not turn an already-published Run into a failure.
      try { store.updateRun(run.id, { commitHash, repairRounds }); } catch { /* best-effort after publication */ }
      await emitStandardPreviewUpdate(round).catch(() => {});
      let assistantMessageId: string | null = null;
      try { assistantMessageId = persistTranscript(finalAssistantText); } catch { /* best-effort after publication */ }
      // Design review was ON but never actually judged (headless render/screenshot failed every
      // round) — don't let the run read as a clean "reviewed" pass; the floor (anti-slop) passed,
      // the ceiling simply didn't run, and the user must know.
      const designReviewSkipped = visualQaEnabledForRun && !producedDesignReview(visualReviewHistory);
      const quality = `, quality ${score}/100`;
      const fixes = repairRounds ? ` after ${repairRounds} fix${repairRounds > 1 ? "es" : ""}` : "";
      const reviewNote = designReviewSkipped
        ? " Note: the automated design review could not render this project, so only the anti-slop checks ran — design quality was not assessed."
        : "";
      const stuckNote = stuckDefectKeys.size
        ? ` ${stuckDefectKeys.size} issue${stuckDefectKeys.size > 1 ? "s" : ""} the auto-fixer couldn't resolve after repeated tries — see Quality for the specifics.`
        : "";
      const message =
        (passed ? `Done${quality}${fixes}. Updated the project; the dev preview reflects it live.` : `Done, with remaining visual issues${quality}.`) + reviewNote + stuckNote;
      try {
        store.addMessage(conversation.id, "system", resultMessage(message, { passed, score, rounds: repairRounds, designReviewed: !designReviewSkipped, unresolved: stuckDefectKeys.size }));
      } catch { /* best-effort after publication */ }
      const persistedFindings = withResolvedVisualReviewHistory(findings, visualReviewHistory);
      publishedSuccessPatch = {
        repairRounds,
        lintPassed: passed,
        score,
        findings: persistedFindings,
        assistantMessageId,
        commitHash,
        finishedAt: Date.now(),
        event: { type: "run-done", runId: run.id, passed, rounds: repairRounds, score, mode: "standard", designReviewed: !designReviewSkipped, findings: persistedFindings },
      };
      settlePublishedSuccess(publishedSuccessPatch);
      handedOffLivePreviewLease = true;
      const activeForCover = store.getActiveVariantId(project.id) ?? mainVariant.id;
      if (targetVariantId === activeForCover) {
        const cover = deps.runtimeSupervisor!.trackOperation(
          { projectId: project.id, variantId: targetVariantId, runId: run.id },
          async (signal) => {
            const lease = await ensureStandardDevServer(
              project.id,
              dir,
              variantRuntimeKey(project.id, targetVariantId),
              signal,
              deps.previewLeaseManager,
            );
            try {
              signal.throwIfAborted();
              await (deps.captureCoverUrl ?? captureCoverUrl)(
                lease.url,
                join(projectDir(deps.dataDir, project.id), ".cover.png"),
                signal,
              );
            } finally {
              await lease.release?.();
            }
          },
        );
        // Covers are best-effort; the successful run is already persisted.
        void cover.catch(() => {});
      }
    } catch (err) {
      if (publishedSuccessPatch) {
        try {
          settlePublishedSuccess(publishedSuccessPatch);
        } catch (settlementError) {
          // The commit is already published. Surface an operational persistence failure without
          // manufacturing a false failed Run or invoking the agent/publisher again.
          sse({
            type: "run-persistence-error",
            runId: run.id,
            published: true,
            message: settlementError instanceof Error ? settlementError.message : "published Run success could not be persisted",
          });
        }
        return;
      }
      const cancelled = ctrl.signal.aborted || isAbortError(err);
      const errorMessage = err instanceof Error ? err.message : "generation failed";
      const settled = execution.settle(cancelled ? "cancelled" : "failed", {
        finishedAt: Date.now(),
        event: cancelled ? { type: "run-cancelled", runId: run.id } : { type: "run-error", runId: run.id, message: errorMessage },
      });
      if (!settled.changed) return;
      const partial = processAssistantText();
      persistProcess();
      if (cancelled && partial) store.addMessage(conversation.id, "assistant", partial);
      persistSteps();
      persistVisualReviews();
      const message = cancelled ? "Stopped." : `The run failed: ${errorMessage}`;
      store.addMessage(conversation.id, "system", resultMessage(message, cancelled ? {} : { error: true }));
    } finally {
      if (!handedOffLivePreviewLease) await (livePreviewLease as DevServerLease | null)?.release?.();
    }
    return;
  }

  // Stream the preview live: emit an event whenever the agent rewrites index.html.
  const previewUrl = `/projects/${project.id}/preview/`;
  stopPoll = startPreviewPoller(join(dir, "index.html"), (t) => sse({ type: "preview-update", previewUrl, t }));

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
        if (e.type === "turn-start") processStartedAt = Date.now();
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
      persistTranscript(assistantText);
      store.addMessage(conversation.id, "system", questionMessage(asked.question, run.id));
      sse({ type: "ask-user-question", runId: run.id, question: asked.question });
      execution.settle("cancelled", {
        finishedAt: Date.now(),
        event: { type: "run-cancelled", runId: run.id, reason: "question" },
      });
      return;
    }

    let artifactPath = result.artifactPath;
    let currentHtml = result.html;
    let generatedTotal = 0;
    let repairRounds = result.rounds;
    let finalFindings: QualityFinding[] = result.findings as QualityFinding[];
    let visualReviewHistory: QualityFinding[] = [];
    let score = floorScore(finalFindings);
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
      const screenshotUrl = `${previewUrl}.visual-qa/screenshot.png`;
      if (settings.visualQaEnabled) sse({ ...visualQaStartPayload(round, settings, runAgentCommand, runModel, screenshotUrl), runId: run.id });
      const visualFindings = suppress(markVisualReviewRound(withVisualScreenshotUrl(await runVisualQa(deps, join(dir, artifactPath), settings, runAgentCommand, runModel, visibleBrief, repairHistory, {
        projectRoot: dir,
        renderUrl,
        directionSpec: chosenDirectionSpec,
      }), screenshotUrl), round));
      visualReviewHistory = [...visualReviewHistory, ...visualFindings];
      sse({ type: "visual-qa", runId: run.id, round, enabled: settings.visualQaEnabled, findings: visualFindings });
      queueVisualReviewRecord(round, settings.visualQaEnabled, visualFindings, screenshotUrl);
      finalFindings = [...staticFindings, ...visualFindings];
      score = floorScore(finalFindings);
    };

    await writeCurrentArtifact();
    await reviewCurrentArtifact(0, result.findings as QualityFinding[]);

    while (shouldAutoRepair(settings, finalFindings, repairRounds, maxRepairRounds)) {
      const nextRound = repairRounds + 1;
      const repairPrompt = prototypeRepairPrompt(finalFindings, nextRound, maxRepairRounds, score, visibleBrief);
      if (!repairPrompt) break;
      if (visualReviewRecords.length) persistTranscript(assistantText);
      processStartedAt = Date.now();
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
        persistTranscript(repairedFinal.summaryText);
        store.addMessage(conversation.id, "system", questionMessage(repairedAsked.question, run.id));
        sse({ type: "ask-user-question", runId: run.id, question: repairedAsked.question });
        execution.settle("cancelled", {
          finishedAt: Date.now(),
          event: { type: "run-cancelled", runId: run.id, reason: "question" },
        });
        return;
      }

      assistantText = repairedFinal.summaryText;
      repairHistory.push({ role: "user", content: repairPrompt });
      if (assistantText) repairHistory.push({ role: "assistant", content: assistantText });
      artifactPath = repaired.artifactPath ?? artifactPath;
      currentHtml = repaired.artifactHtml || currentHtml;
      repairRounds = nextRound;
      await writeCurrentArtifact();
      const staticFindings = suppress(lintArtifact(currentHtml, { provider: runProviderFamily, isSharingan: project.sharingan }) as QualityFinding[]);
      await reviewCurrentArtifact(nextRound, staticFindings);
    }

    if (ctrl.signal.aborted) throw abortError();
    const passed = !finalFindings.some((f) => f.severity === "P0");
    store.recordArtifact(project.id, artifactPath, passed);
    const assistantMessageId = persistTranscript(assistantText);
    const designReviewSkipped = settings.visualQaEnabled && !producedDesignReview(visualReviewHistory);
    const fixes = repairRounds ? ` after ${repairRounds} fix${repairRounds > 1 ? "es" : ""}` : "";
    const quality = `, quality ${score}/100`;
    const reviewNote = designReviewSkipped
      ? " Note: the automated design review could not render this artifact, so only the anti-slop checks ran — design quality was not assessed."
      : "";
    const text = (passed ? `Done${quality}${fixes}.` : `Done, with remaining issues${quality}.`) + reviewNote;
    store.addMessage(
      conversation.id,
      "system",
      resultMessage(text, { passed, score, rounds: repairRounds, designReviewed: !designReviewSkipped, materialSources: generatedTotal > 0 ? [`Generated image assets (${generatedTotal})`] : [] }),
    );
    const persistedFindings = withResolvedVisualReviewHistory(finalFindings, visualReviewHistory);
    sse({ type: "done", rounds: repairRounds, passed });
    execution.settle("succeeded", {
      repairRounds,
      lintPassed: passed,
      score,
      findings: persistedFindings,
      assistantMessageId,
      finishedAt: Date.now(),
      event: {
        type: "run-done",
        runId: run.id,
        passed,
        rounds: repairRounds,
        score,
        designReviewed: !designReviewSkipped,
        previewUrl: `/projects/${project.id}/preview/`,
        findings: persistedFindings,
      },
    });
    // Headless-screenshot the finished artifact as the gallery cover (best-effort, async).
    const cover = deps.runtimeSupervisor!.trackOperation(
      { projectId: project.id, variantId: targetVariantId, runId: run.id },
      (signal) => (deps.captureCover ?? captureCover)(
        join(dir, artifactPath),
        join(dir, ".cover.png"),
        signal,
      ),
    );
    void cover.catch(() => {});
  } catch (err) {
    const cancelled = ctrl.signal.aborted || isAbortError(err);
    const errorMessage = err instanceof Error ? err.message : "generation failed";
    const settled = execution.settle(cancelled ? "cancelled" : "failed", {
      finishedAt: Date.now(),
      event: cancelled ? { type: "run-cancelled", runId: run.id } : { type: "run-error", runId: run.id, message: errorMessage },
    });
    if (!settled.changed) return;
    const partial = processAssistantText();
    persistProcess(); // keep the partial process record + whatever the agent wrote to disk
    if (cancelled && partial) store.addMessage(conversation.id, "assistant", partial);
    persistSteps();
    persistVisualReviews();
    const message = cancelled ? "Stopped." : `The run failed: ${errorMessage}`;
    store.addMessage(conversation.id, "system", resultMessage(message, cancelled ? {} : { error: true }));
  }
  } catch (err) {
    const message = err instanceof Error ? err.message : "generation failed";
    if (err instanceof StandardRunSourceDirtyError) {
      if (durableRun) {
        store.terminalizeRun(durableRun.id, "failed", { finishedAt: Date.now() });
      }
      if (!res.headersSent) sendError(res, 409, message);
      else if (!res.writableEnded) res.end();
      return;
    }
    if (durableRun && !execution) {
      store.terminalizeRun(durableRun.id, "failed", { finishedAt: Date.now() });
      if (!res.headersSent) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
      }
      if (!res.writableEnded) res.end(`data: ${JSON.stringify({ type: "run-error", runId: durableRun.id, message })}\n\n`);
      return;
    }
    if (!execution || !durableRun) {
      if (!res.headersSent) sendError(res, 500, message);
      else if (!res.writableEnded) res.end();
      return;
    }
    const cancelled = ctrl?.signal.aborted === true || isAbortError(err);
    const settled = execution.settle(cancelled ? "cancelled" : "failed", {
      finishedAt: Date.now(),
      event: cancelled
        ? { type: "run-cancelled", runId: durableRun.id }
        : { type: "run-error", runId: durableRun.id, message },
    });
    if (settled.changed) {
      try {
        store.addMessage(durableRun.conversationId, "system", resultMessage(cancelled ? "Stopped." : `The run failed: ${message}`, cancelled ? {} : { error: true }));
      } catch {
        // The terminal Run and event are already durable/best-effort; message persistence is secondary.
      }
    }
  } finally {
    startingRuns.delete(startKey);
    try {
      stopPoll?.();
      if (sharinganCaptureId) {
        await releaseSharinganProject(sharinganCaptureId, { dataDir: deps.dataDir, profileCleanup: "capture" }).catch(() => {});
      }
      if (standardTransaction) {
        if (dir === standardTransaction.dir) {
          await releaseVariantRuntime(project.id, targetVariantId, durableRun ? [durableRun.id] : []);
        }
        await standardTransaction.dispose();
      }
    } finally {
      execution?.dispose();
    }
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

/** POST /api/runs/:id/feedback — record 👍/👎 + an optional gap tag (or clear it). */
export async function handleRunFeedback(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const runId = params.id!;
  if (!deps.store.getRun(runId)) return sendError(res, 404, "run not found");
  const body = (await readJsonBody(req)) as { verdict?: unknown; gap?: unknown; clear?: unknown };
  if (body.clear === true || body.verdict == null) {
    return sendJson(res, 200, { run: deps.store.setRunFeedback(runId, null) });
  }
  const verdict = body.verdict;
  if (verdict !== "up" && verdict !== "down") return sendError(res, 400, "verdict must be 'up' or 'down'");
  const gap = typeof body.gap === "string" && body.gap.trim() ? body.gap.trim() : undefined;
  sendJson(res, 200, { run: deps.store.setRunFeedback(runId, { verdict, gap }) });
}
