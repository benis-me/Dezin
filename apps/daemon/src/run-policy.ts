import { extractFinalSummary, getProvider } from "../../../packages/agent/src/index.ts";
import type { QualityFinding, Settings } from "../../../packages/core/src/index.ts";
import { lintScore, renderFindingsForAgent } from "../../../packages/quality/src/index.ts";

const DEFAULT_AUTO_IMPROVE_MAX_ROUNDS = 8;
// Normal Standard/Prototype runs only auto-repair real defects/slop. Sharingan overrides this:
// every source-fidelity finding is required because reconstruction quality is the product.
const AUTO_REPAIR_SEVERITIES = new Set<QualityFinding["severity"]>(["P0", "P1"]);
const QUALITY_INFRASTRUCTURE_FINDING_IDS = new Set([
  "visual-qa-failed",
  "visual-devserver-unavailable",
  "visual-chrome-unavailable",
  "visual-render-failed",
  "visual-screenshot-missing",
  "visual-agent-review-failed",
  "visual-artifact-missing",
  "visual-review-unassessed",
  "visual-source-evidence-missing",
  "visual-source-evidence-invalid",
  "visual-generated-evidence-invalid",
]);

export function isQualityInfrastructureFinding(finding: QualityFinding): boolean {
  return QUALITY_INFRASTRUCTURE_FINDING_IDS.has(finding.id);
}

/** Max bounded design-improvement (ceiling) rounds once the floor (defects/slop) is clean. */
export const CEILING_MAX_ROUNDS = 3;
/** How many times one advisory SUGGESTION is re-sent before we give up (the agent isn't taking it). */
export const IMPROVE_RECUR_LIMIT = 1;
/** How many times one objective DEFECT is retried before we give up — the model keeps failing to
 *  fix it, so spinning on it wastes rounds; stop, and surface it as unresolved instead. */
export const DEFECT_RECUR_LIMIT = 2;

/** Looser cross-round identity for a finding. The critic rephrases its prose every round, so the
 *  message is an unreliable key — the target SELECTOR is the stable anchor for "same issue on the
 *  same element". Falls back to a normalized message only when there's no selector. */
export function recurKey(f: QualityFinding): string {
  if (f.selector) return `sel:${f.selector.toLowerCase()}`;
  return `msg:${f.message.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40)}`;
}

/** Verify-applied: return the findings still worth re-sending (fed back fewer than `limit` times)
 *  and record this round's attempt in `history`. A finding the critic keeps re-raising unchanged
 *  is one the agent won't/can't apply — dropping it converges the loop (for suggestions) or gives
 *  up gracefully instead of spinning on a defect the model can't fix. */
export function freshFindings(findings: QualityFinding[], history: Map<string, number>, limit: number): QualityFinding[] {
  const fresh = findings.filter((f) => (history.get(recurKey(f)) ?? 0) < limit);
  for (const f of findings) history.set(recurKey(f), (history.get(recurKey(f)) ?? 0) + 1);
  return fresh;
}

/** The lint/FLOOR score — slop + defects only. The ceiling (advisory design improvements + the
 *  "reviewed" marker) is separate and must NOT drag the floor score down. */
export function floorScore(findings: QualityFinding[]): number {
  return lintScore(findings.filter((f) => !f.id.startsWith("visual-improve") && f.id !== "visual-reviewed"));
}

const SHARINGAN_LAYOUT_DEFECT_IDS = new Set([
  "visual-horizontal-overflow",
  "visual-below-fold-strip",
  "visual-fixed-offscreen",
  "visual-text-clipped",
]);

function isSharinganBlockingFinding(finding: QualityFinding): boolean {
  return finding.id !== "visual-reviewed";
}

export function standardRunPassed(findings: QualityFinding[], isSharingan: boolean | undefined): boolean {
  if (isSharingan) return !findings.some(isSharinganBlockingFinding);
  if (findings.some(isQualityInfrastructureFinding)) return false;
  if (findings.some((f) => AUTO_REPAIR_SEVERITIES.has(f.severity))) return false;
  return true;
}

export function standardRepairableDefects(findings: QualityFinding[], isSharingan: boolean | undefined): QualityFinding[] {
  if (isSharingan) return findings.filter((finding) => isSharinganBlockingFinding(finding) && !isQualityInfrastructureFinding(finding));
  return findings.filter((f) => {
    if (!AUTO_REPAIR_SEVERITIES.has(f.severity) || f.id.startsWith("visual-improve") || f.id === "visual-reviewed" || isQualityInfrastructureFinding(f)) return false;
    return true;
  });
}

/** Whether the critic actually ran and judged across the run (produced the visual-reviewed marker
 *  or any real finding) — as opposed to only render/capture failures. Lets us avoid reporting a
 *  clean "reviewed" pass when the ceiling never actually ran (e.g. headless render failed). */
export function producedDesignReview(visualFindings: QualityFinding[]): boolean {
  return visualFindings.some((f) => {
    const id = String(f.id);
    return id === "visual-reviewed" || id.startsWith("visual-ai-review") || id.startsWith("visual-contract-drift") || id.startsWith("visual-improve");
  });
}

export function autoImproveMaxRounds(settings: Settings, override?: number): number {
  const raw = typeof override === "number" ? override : settings.autoImproveMaxRounds;
  const value = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_AUTO_IMPROVE_MAX_ROUNDS;
  return Math.max(0, Math.min(20, value));
}

export function standardRepairPolicy(settings: Settings, isSharingan: boolean | undefined, override?: number): { enabled: boolean; maxRounds: number } {
  const configuredMaxRounds = autoImproveMaxRounds(settings, override);
  if (isSharingan) return { enabled: true, maxRounds: Math.max(3, configuredMaxRounds) };
  return { enabled: settings.autoImproveEnabled, maxRounds: configuredMaxRounds };
}

function builtInStructuredReviewer(command: string): "claude" | "codebuddy" | null {
  const providerId = getProvider(command)?.id;
  return providerId === "claude" || providerId === "codebuddy" ? providerId : null;
}

export function reviewerAgentCommand(settings: Settings, fallback: string): string {
  return builtInStructuredReviewer(settings.visualQaAgentCommand.trim())
    ?? builtInStructuredReviewer(fallback)
    ?? "claude";
}

export function reviewerModel(
  settings: Settings,
  fallback?: string,
  fallbackCommand: string = settings.agentCommand,
): string | undefined {
  const command = reviewerAgentCommand(settings, fallbackCommand);
  const configuredCommand = builtInStructuredReviewer(settings.visualQaAgentCommand.trim());
  const configuredModel = settings.visualQaModel.trim();
  if (configuredCommand === command && configuredModel) return configuredModel;
  if (builtInStructuredReviewer(fallbackCommand) !== command) return undefined;
  return fallback || settings.model || undefined;
}

export function researchAgentCommand(settings: Settings, fallback: string): string {
  return settings.researchAgentCommand.trim() || fallback || settings.agentCommand || "claude";
}

export function researchModel(settings: Settings, fallback?: string): string | undefined {
  return settings.researchModel.trim() || fallback || settings.model || undefined;
}

export function shouldAutoRepair(settings: Settings, findings: QualityFinding[], repairRounds: number, maxRounds: number): boolean {
  if (!settings.autoImproveEnabled || repairRounds >= maxRounds) return false;
  return findings.some((finding) => AUTO_REPAIR_SEVERITIES.has(finding.severity) && !isQualityInfrastructureFinding(finding));
}

export function withVisualScreenshotUrl(findings: QualityFinding[], screenshotUrl: string): QualityFinding[] {
  return findings.map((finding) =>
    finding.id.startsWith("visual-") && !finding.screenshotUrl ? { ...finding, screenshotUrl } : finding,
  );
}

export function markVisualReviewRound(findings: QualityFinding[], round: number): QualityFinding[] {
  return findings.map((finding) => (finding.id.startsWith("visual-") ? { ...finding, reviewStatus: "active", reviewRound: round } : finding));
}

function findingKey(finding: QualityFinding): string {
  return `${finding.id}\n${finding.message}`;
}

export function withResolvedVisualReviewHistory(finalFindings: QualityFinding[], history: QualityFinding[]): QualityFinding[] {
  if (!history.length) return finalFindings;
  const active = new Set(finalFindings.map(findingKey));
  const seen = new Set<string>();
  const resolved = history.flatMap((finding): QualityFinding[] => {
    const key = findingKey(finding);
    if (active.has(key) || seen.has(key)) return [];
    seen.add(key);
    return [{ ...finding, reviewStatus: "resolved" }];
  });
  return resolved.length ? [...finalFindings, ...resolved] : finalFindings;
}

export function visualQaStartPayload(
  round: number,
  settings: Settings,
  agentCommand: string,
  model: string | undefined,
  screenshotUrl: string,
): Record<string, unknown> {
  return {
    type: "visual-qa-start",
    round,
    enabled: true,
    agentCommand: reviewerAgentCommand(settings, agentCommand),
    model: reviewerModel(settings, model, agentCommand),
    screenshotUrl,
  };
}

function hasSourceFidelityFindings(findings: QualityFinding[]): boolean {
  return findings.some((finding) => finding.id.startsWith("visual-source-"));
}

function hasMeasuredLayoutFindings(findings: QualityFinding[]): boolean {
  return findings.some((finding) => SHARINGAN_LAYOUT_DEFECT_IDS.has(finding.id));
}

export function standardRepairPrompt(
  findings: QualityFinding[],
  round: number,
  maxRounds: number,
  score: number,
  intent?: string,
  options: { isSharingan?: boolean } = {},
): string | null {
  const lintBlock = renderFindingsForAgent(findings, { unranked: options.isSharingan });
  if (!lintBlock) return null;
  const sourceFidelityGuard = hasSourceFidelityFindings(findings)
    ? "Source-fidelity repair mode: visual-source-* findings are source-vs-result measurements. Apply measured local patches to the named element/region only. Do not redesign or re-layout the whole page to chase one delta; preserve the captured source hierarchy, text, assets, and palette."
    : "";
  const measuredLayoutGuard = hasMeasuredLayoutFindings(findings)
    ? "Measured layout repair mode: fix only the named overflow, clipping, or offscreen layout defects. Do not add new content, infer missing sections, or reinterpret the page structure."
    : "";
  const taskLine = options.isSharingan
    ? "You are editing the existing Standard-mode Vite project in this directory. Sharingan reconstruction mode: fix every finding below as a required source-fidelity issue. Complete the full list before stopping."
    : "You are editing the existing Standard-mode Vite project in this directory. Apply the findings below — defects are bugs to fix; improvements are concrete design upgrades to make.";
  return [
    `Automatic quality repair round ${round}/${maxRounds}.`,
    taskLine,
    intent ? `Stay true to the original request and the chosen direction — do not drift:\n${intent}` : "Preserve the user's concept and the current visual direction.",
    "Do NOT undo or oscillate on earlier fixes; if a finding is ambiguous, make the choice a senior designer would and keep it. Do not ask a follow-up question. Edit the actual project files, then stop.",
    sourceFidelityGuard,
    measuredLayoutGuard,
    `Current quality score: ${score}/100.`,
    lintBlock,
  ].filter(Boolean).join("\n\n");
}

export function prototypeRepairPrompt(findings: QualityFinding[], round: number, maxRounds: number, score: number, intent?: string): string | null {
  const lintBlock = renderFindingsForAgent(findings);
  if (!lintBlock) return null;
  return [
    `Automatic quality repair round ${round}/${maxRounds}.`,
    "You are repairing the current single-file Dezin prototype. Apply the findings below — defects are bugs to fix; improvements are concrete design upgrades. Return a complete corrected HTML artifact.",
    intent ? `Stay true to the original request and the chosen direction — do not drift:\n${intent}` : "Preserve the user's concept and visual direction.",
    "Do NOT undo or oscillate on earlier fixes; make a senior designer's choice on ambiguous findings and keep it. Do not ask a follow-up question. Rewrite the artifact, then stop.",
    `Current quality score: ${score}/100.`,
    lintBlock,
  ].join("\n\n");
}

export function splitFinalSummary(text: string): ReturnType<typeof extractFinalSummary> {
  return extractFinalSummary(text);
}
