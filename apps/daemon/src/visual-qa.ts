import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { unzlibSync } from "fflate";
import puppeteer from "puppeteer-core";
import type { QualityFinding, RenderFrameSpec, Settings } from "../../../packages/core/src/index.ts";
import { detectComputedFindings, markCorroboration, type ComputedContext, type ComputedElement as QualityComputedElement, type ComputedStyle } from "../../../packages/quality/src/index.ts";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";
import { applyArtifactThumbnailFrame, findChrome } from "./capture-cover.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { captureFullPageScreenshot } from "./full-page-capture.ts";

export interface VisualQaInput {
  htmlPath: string;
  projectRoot?: string;
  renderUrl?: string;
  settings: Settings;
  screenshotPath?: string;
  agentCommand?: string;
  model?: string;
  /** Model family ("gpt"|"gemini"|"claude"|"other") that GENERATED the artifact — for provider-fingerprint rules. */
  provider?: string;
  brief?: string;
  /** The chosen direction's spec (its Visual Language etc.) — the critic's aesthetic contract. */
  directionSpec?: string;
  /** When this build is a Sharingan clone: the captured SOURCE screenshot (absolute path) + a short
   *  asset summary, so the critic can judge fidelity to the source, not just generic quality. */
  sharinganReference?: { screenshotPath: string; assetsSummary?: string; renderMapPath?: string };
  /** True for a Sharingan clone — skips the computed anti-slop detector (taste/contrast/type rules)
   *  so faithful reproduction isn't penalized; structural geometry checks + the critic still run. */
  isSharingan?: boolean;
  /** Compact map of on-page elements (selector + text + box) so the critic can anchor each
   *  finding to a specific DOM element, and the repair can target it precisely. */
  criticElements?: CriticElement[];
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  consoleMessages?: VisualQaConsoleMessage[];
  /** Exact immutable Task Frames. When present every Frame is bridged, rendered, and captured. */
  renderFrames?: readonly RenderFrameSpec[];
  /** Prefix used to derive one bounded, deterministic attempt identity per Frame. */
  frameAttemptIdPrefix?: string;
  /** Runs exact Frame/runtime/capture checks without invoking the design critic. */
  runtimeOnly?: boolean;
  /** Exact Frame currently shown in screenshotPath when invoking the critic. */
  reviewFrame?: RenderFrameSpec & { frameAttemptId: string };
  signal?: AbortSignal;
}

export interface VisualQaFrameResult {
  frameId: string;
  frameAttemptId: string;
  width: number;
  height: number;
  status: "passed" | "failed";
  screenshotPath?: string;
  reviewed: boolean;
}

export interface VisualQaReport {
  findings: QualityFinding[];
  frames: VisualQaFrameResult[];
}

/** One on-page element the critic may target, derived from the geometry snapshot. */
export interface CriticElement {
  selector: string;
  tag: string;
  text: string;
  w: number;
  h: number;
  x: number;
  y: number;
}

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "textarea", "select", "label"]);
const LANDMARK_TAGS = new Set(["header", "nav", "main", "aside", "footer", "form", "dialog", "section"]);

/** Distil the raw geometry elements into a compact, identifiable set the critic can reference —
 *  interactive controls, landmarks, id/data-id'd nodes, and anything with visible text. */
function toCriticElements(elements: GeometryElement[]): CriticElement[] {
  const out: CriticElement[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    if (el.rect.width < 8 || el.rect.height < 8) continue;
    const identifiable =
      el.selector.startsWith("#") || el.selector.startsWith("[data-dezin-id") || INTERACTIVE_TAGS.has(el.tag) || LANDMARK_TAGS.has(el.tag);
    if (!identifiable && el.text.trim().length === 0) continue;
    if (seen.has(el.selector)) continue;
    seen.add(el.selector);
    out.push({
      selector: el.selector,
      tag: el.tag,
      text: el.text.replace(/\s+/g, " ").trim().slice(0, 60),
      w: Math.round(el.rect.width),
      h: Math.round(el.rect.height),
      x: Math.round(el.rect.left),
      y: Math.round(el.rect.top),
    });
    if (out.length >= 45) break;
  }
  return out;
}

export type VisualQaRunner = (input: VisualQaInput) => Promise<QualityFinding[]>;

export interface VisualQaConsoleMessage {
  type: "console" | "pageerror" | "requestfailed" | "response";
  level: string;
  text: string;
  url?: string;
  line?: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface GeometryElement {
  selector: string;
  tag: string;
  text: string;
  rect: Rect;
  position: string;
  overflowX: string;
  overflowY: string;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  directTextLength?: number;
  childElementCount?: number;
  /** Computed-style subset (color/type/spacing) read in the browser eval, for the computed-style detector. */
  style?: ComputedStyle;
}

/** Reshape the browser geometry snapshot into the pure detector's ComputedElement[] — drop
 *  zero-area nodes it cannot judge, map rect to x/y, and pass the computed style through. */
export function toComputedElements(elements: GeometryElement[]): QualityComputedElement[] {
  const out: QualityComputedElement[] = [];
  for (const el of elements) {
    if (el.rect.width < 8 || el.rect.height < 8) continue;
    out.push({
      selector: el.selector,
      tag: el.tag,
      text: el.text,
      rect: { x: el.rect.left, y: el.rect.top, width: el.rect.width, height: el.rect.height },
      style: el.style ?? {},
    });
    // Bound the work: the detector is O(elements); a pathological page can't blow it up.
    if (out.length >= 400) break;
  }
  return out;
}

/** De-duplicate computed findings by (id, selector) and cap them per-rule and overall, so a page
 *  with many small defects can't flood the repair loop or the Quality panel. */
export function boundComputedFindings(findings: QualityFinding[], perId = 3, total = 20): QualityFinding[] {
  const seen = new Set<string>();
  const perIdCount = new Map<string, number>();
  const out: QualityFinding[] = [];
  for (const f of findings) {
    const key = `${f.id}::${f.selector ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = perIdCount.get(f.id) ?? 0;
    if (n >= perId) continue;
    perIdCount.set(f.id, n + 1);
    out.push(f);
    if (out.length >= total) break;
  }
  return out;
}

interface GeometrySnapshot {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number };
  bodyTextLength?: number;
  elements: GeometryElement[];
  /** The page's opaque background (body, else html) — for the cream/sand-surface check. */
  pageBackground?: string;
  /** The page's declared design tokens (font families + resolved palette colors + radius scale) — for drift checks. */
  designTokens?: { fonts: string[]; colors: Array<{ r: number; g: number; b: number }>; radii?: number[] };
}

interface SourceRenderMapElement {
  selector: string;
  tag: string;
  text?: string;
  box?: { x: number; y: number; w: number; h: number };
  style?: { backgroundImage?: string; fontSize?: string; fontWeight?: string; color?: string };
}

interface SourceRenderMap {
  viewport?: { width: number; height: number };
  document?: { width: number; height: number };
  elements?: SourceRenderMapElement[];
}

const DEFAULT_VIEWPORTS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
] as const;

export function sourceViewportFromRenderMap(source: { viewport?: { width?: number; height?: number } } | null | undefined): { width: number; height: number } | undefined {
  const width = source?.viewport?.width;
  const height = source?.viewport?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width! < 320 || height! < 320 || width! > 3000 || height! > 3000) return undefined;
  return { width: Math.round(width!), height: Math.round(height!) };
}

function toRel(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/** Reject if `p` doesn't settle within `ms`, so a wedged headless page (blocked main thread,
 *  stuck WASM, perpetual animation) can never hang the capture and silently kill the critic. */
function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`visual capture step timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function agentReviewPrompt(input: VisualQaInput, screenshotPath: string): string {
  const projectDir = input.projectRoot ?? dirname(input.htmlPath);
  const artifactRel = toRel(projectDir, input.htmlPath);
  const screenshotRel = toRel(projectDir, screenshotPath);
  const ref = input.sharinganReference;
  const sourceRel = ref ? toRel(projectDir, ref.screenshotPath) : "";
  const sourceRenderMapRel = ref?.renderMapPath ? toRel(projectDir, ref.renderMapPath) : "";
  const brief = input.brief?.trim();
  const directionSpec = input.directionSpec?.trim();
  const reviewFrame = input.reviewFrame;
  let frameFixture = "";
  if (reviewFrame?.fixture !== undefined) {
    try {
      frameFixture = JSON.stringify(reviewFrame.fixture).slice(0, 4_000);
    } catch {
      frameFixture = "[unavailable]";
    }
  }
  const frameContext = reviewFrame
    ? [
        `Exact Task Frame: ${reviewFrame.id} (${reviewFrame.name}), ${reviewFrame.width}x${reviewFrame.height}`,
        reviewFrame.initialState ? `initial state: ${reviewFrame.initialState}` : "",
        frameFixture ? `fixture: ${frameFixture}` : "",
        reviewFrame.background ? `background: ${reviewFrame.background}` : "",
        `attempt: ${reviewFrame.frameAttemptId}`,
      ].filter(Boolean).join("; ")
    : "";
  const history = (input.conversationHistory ?? [])
    .map((m, index) => `[${index + 1}] ${m.role.toUpperCase()}:\n${m.content.trim()}`)
    .filter((line) => line.length > 12)
    .join("\n\n");
  const consoleMessages = (input.consoleMessages ?? [])
    .slice(0, 20)
    .map((m, index) => {
      const where = [m.url, typeof m.line === "number" ? `:${m.line}` : ""].filter(Boolean).join("");
      return `[${index + 1}] ${m.type}/${m.level}${where ? ` ${where}` : ""}: ${m.text}`;
    })
    .join("\n");
  const elementList = (input.criticElements ?? [])
    .map((e) => `- ${e.selector} — ${e.tag}${e.text ? ` "${e.text}"` : ""} ${e.w}x${e.h} at ${e.x},${e.y}`)
    .join("\n");
  const findingInstructions = ref
    ? [
        "Sharingan mode: report every visible source mismatch as a required reconstruction finding. Missing source details, wrong hierarchy, wrong type scale, palette drift, broken alignment, overflow, clipping, wrapping, missing image slots, and incorrect controls all matter when they differ from the source.",
        "Do not split findings into suggestions or ranked priorities. If the generated page visibly diverges from the source screenshot or render map, report it as a finding with a concrete patch target.",
        "For EVERY finding, set \"selector\" to the ONE element it is about, copied EXACTLY from the ON-PAGE ELEMENTS list above — this lets the fix target that element precisely. Omit selector only for a genuinely page-wide finding. Make each fix a concrete, verifiable change to that element.",
        "Report as many findings as genuinely matter — several, or none. Do NOT invent findings to hit a count.",
        'Return JSON only, exactly: {"findings":[{"kind":"defect","selector":"exact selector or omit","message":"...","fix":"..."}]}.',
      ]
    : [
        "Report findings in three clearly separated kinds — do not conflate them:",
        '- kind "defect" (severity P0/P1): an OBJECTIVE breakage you can PROVE from the pixels themselves. It must be one of: (1) overlap that makes something illegible or unusable; (2) text or a control sliced through its glyphs or bounds by a container edge; (3) an element the layout clearly means to show in the initial view (the primary action, the latest message, the composer) pushed off-screen or unreachable; (4) content wider than the viewport (horizontal overflow); (5) text unreadable from contrast or size; (6) a runtime/console error, broken image, or leaked placeholder (undefined, lorem, "no artifact"); (7) a copy bug in the text itself (duplicated, concatenated, or template tokens). Before filing a defect, apply this test: could a correct, deliberate implementation produce this exact screenshot? If yes, it is NOT a defect — at most an advisory improvement. Describe the visible breakage, never a cause you are inferring — do NOT file scroll position, mount behaviour, or "should be pinned to bottom": you cannot verify runtime scroll state from one static frame. Do NOT file taste, palette, or aesthetic preferences as defects — colour and style are the user\'s call, not a bug.',
        '- kind "contract" (severity P1): a directly visible contradiction of an EXPLICIT user brief requirement, must-have, must-avoid, or the CHOSEN DIRECTION. Quote the concrete contract in the message and name the visible contradiction. This is not a place for inferred intent or subjective taste: if the requirement was not explicit, classify it as an advisory improvement instead.',
        '- kind "improvement" (severity P2): concrete, actionable design SUGGESTIONS — hierarchy, spacing/rhythm, composition, type scale, restraint, positioning and scroll polish, affordance discoverability, and overall craft. These are ADVISORY and may include subjective taste; the user decides whether to take them. Be specific, never vague taste talk.',
        "For EVERY finding, set \"selector\" to the ONE element it is about, copied EXACTLY from the ON-PAGE ELEMENTS list above — this lets the fix target that element precisely. Omit selector only for a genuinely page-wide finding. Make each fix a concrete, verifiable change to that element.",
        "Report as many of each as genuinely matter — several, or none. Do NOT invent findings to hit a count; if nothing is objectively broken and nothing would clearly improve it, return an empty findings list.",
        'Return JSON only, exactly: {"findings":[{"kind":"defect|contract|improvement","severity":"P0|P1|P2","selector":"exact selector or omit","message":"...","fix":"..."}]}.',
      ];
  return [
    "You are a senior product designer reviewing the latest rendered result for the current Dezin conversation.",
    `Rendered screenshot (the captured visual surface used for review): ${screenshotRel}`,
    `Final artifact: ${artifactRel}`,
    ref ? `Source screenshot (the ORIGINAL site you are RECONSTRUCTING — the build should match its layout, hierarchy, image slots, type scale, and palette): ${sourceRel}` : "",
    sourceRenderMapRel ? `Source render map (browser-measured bounding boxes and computed styles for source-vs-result fidelity): ${sourceRenderMapRel}` : "",
    ref?.assetsSummary ? `Source image inventory: ${ref.assetsSummary}` : "",
    input.renderUrl ? `Rendered URL: ${input.renderUrl}` : "",
    frameContext,
    consoleMessages ? `Browser console / runtime signals:\n${consoleMessages}` : "",
    history ? `Current conversation context:\n${history}` : "",
    brief ? `USER BRIEF:\n${brief}` : "",
    directionSpec ? `CHOSEN DIRECTION (what the build was aiming for):\n${directionSpec}` : "",
    elementList
      ? `ON-PAGE ELEMENTS you can target — use these EXACT selector strings (tag "text" WxH at x,y):\n${elementList}`
      : "",
    "Use the screenshot as primary evidence. The capture attempts the full visual surface: a normal document is captured top-to-bottom, and a dominant vertical scroller in an app shell is temporarily expanded before capture, so the result is not limited to the initial viewport. Smaller nested panes, carousels, and secondary scrollers may remain at their current scroll position; do not infer hidden interaction state beyond the pixels. You may read the artifact and assets for context, but do not create, edit, or write files.",
    ...findingInstructions,
  ]
    .filter(Boolean)
    .join("\n");
}

function titleCase(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function rectSnippet(el: GeometryElement): string {
  const r = el.rect;
  return `${el.selector} (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)})`;
}

export function findingsFromGeometry(snapshot: GeometrySnapshot, label: string, options: { strictTextLayout?: boolean; sharinganSource?: SourceRenderMap | null } = {}): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const viewport = snapshot.viewport;
  const doc = snapshot.document;
  const overflowPx = Math.round(doc.scrollWidth - viewport.width);
  const strictTextLayout = Boolean(options.strictTextLayout);

  if (overflowPx > 8) {
    findings.push({
      severity: "P1",
      id: "visual-horizontal-overflow",
      message: `${titleCase(label)} viewport has horizontal overflow (${doc.scrollWidth}px content in ${viewport.width}px viewport).`,
      fix: "Constrain wide sections, media, and absolute elements with max-width: 100% and overflow-safe layout.",
    });
  }

  // A thin strip of content just below the fold is almost always a mis-placed element (an
  // orphaned header/footer, a grid without grid-template-rows) rather than intentional
  // scrolling — real long pages overflow by far more than one strip. Screenshots are a single
  // viewport, so this is the cheap deterministic catch for below-the-fold layout bugs.
  const verticalOverflowPx = Math.round(doc.scrollHeight - viewport.height);
  if (verticalOverflowPx > 8 && verticalOverflowPx <= 200) {
    findings.push({
      severity: "P1",
      id: "visual-below-fold-strip",
      message: `${titleCase(label)} has a ${verticalOverflowPx}px strip of content just below the fold — likely an element pushed out of the layout (an orphaned header/footer or a grid missing its rows), not intentional scrolling.`,
      fix: "Fix the top-level layout so every region sits in its intended place (e.g. give the app grid a grid-template-rows and assign the header/footer a grid-row) instead of overflowing below the viewport.",
    });
  }

  if ((snapshot.bodyTextLength ?? 0) < 3 && doc.scrollHeight <= viewport.height + 8) {
    findings.push({
      severity: "P0",
      id: "visual-blank-page",
      message: `${titleCase(label)} viewport appears blank or nearly empty.`,
      fix: "Make the initial rendered content visible without depending on a delayed animation or missing asset.",
    });
  }

  const fixedOffscreen = snapshot.elements.find((el) => {
    if (el.position !== "fixed" && el.position !== "sticky") return false;
    const r = el.rect;
    return r.left < -2 || r.top < -2 || r.right > viewport.width + 2 || r.bottom > viewport.height + 2;
  });
  if (fixedOffscreen) {
    findings.push({
      severity: "P1",
      id: "visual-fixed-offscreen",
      message: `${titleCase(label)} fixed or sticky element is clipped outside the viewport.`,
      fix: "Reposition fixed controls/popovers within the viewport and clamp their placement near screen edges.",
      snippet: rectSnippet(fixedOffscreen),
    });
  }

  const clippedText = snapshot.elements.find((el) => {
    if (!el.text.trim()) return false;
    if ((el.directTextLength ?? el.text.trim().length) < 2 && (el.childElementCount ?? 0) > 0) return false;
    if (isSourceEquivalentTextClip(el, snapshot, options.sharinganSource)) return false;
    const clipsX = (el.overflowX === "hidden" || el.overflowX === "clip") && el.scrollWidth > el.clientWidth + 2;
    const clipsY = (el.overflowY === "hidden" || el.overflowY === "clip") && el.scrollHeight > el.clientHeight + 2;
    return clipsX || clipsY;
  });
  if (clippedText) {
    findings.push({
      severity: strictTextLayout ? "P1" : "P2",
      id: "visual-text-clipped",
      message: `${titleCase(label)} text appears clipped in ${clippedText.selector}.`,
      fix: "Allow wrapping, increase the container height, or remove fixed dimensions that hide text.",
      snippet: rectSnippet(clippedText),
    });
  }

  return findings;
}

function isSourceEquivalentTextClip(el: GeometryElement, snapshot: GeometrySnapshot, source: SourceRenderMap | null | undefined): boolean {
  if (!source) return false;
  const sourceViewport = sourceViewportFromRenderMap(source);
  if (!sourceViewport || Math.abs(sourceViewport.width - snapshot.viewport.width) > 8 || Math.abs(sourceViewport.height - snapshot.viewport.height) > 8) return false;
  const text = normalizeText(el.text);
  if (text.length < 4) return false;
  const generated = generatedBox(el);
  const sourceElements = (source.elements ?? []).filter((candidate) => sourceVisibleBox(candidate, source));
  return sourceElements.some((src) => {
    if (!isSourceTextSignal(src) || isAggregateSourceText(src, sourceElements)) return false;
    if (normalizeText(src.text) !== text) return false;
    const box = sourceBox(src);
    if (!box) return false;
    return Math.abs(box.x - generated.x) <= 8 && Math.abs(box.y - generated.y) <= 8 && Math.abs(box.w - generated.w) <= 16 && Math.abs(box.h - generated.h) <= 8;
  });
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").replace(/(?:\s*[_|▍█]){1,3}$/g, "").trim().toLowerCase();
}

function hasCssUrl(value: string | undefined): boolean {
  return /url\(\s*['"]?[^'")]+['"]?\s*\)/i.test(value ?? "");
}

function isImageSlot(el: SourceRenderMapElement | GeometryElement): boolean {
  const tag = (el as { tag?: string }).tag;
  const style = (el as { style?: { backgroundImage?: string } }).style;
  return tag === "img" || tag === "picture" || tag === "video" || hasCssUrl(style?.backgroundImage);
}

function sourceBox(el: SourceRenderMapElement): { x: number; y: number; w: number; h: number } | null {
  const b = el.box;
  if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) return null;
  return b;
}

function sourceVisibleBox(el: SourceRenderMapElement, source: SourceRenderMap): { x: number; y: number; w: number; h: number } | null {
  const b = sourceBox(el);
  if (!b || b.w <= 1 || b.h <= 1) return null;
  const vw = source.viewport?.width ?? source.document?.width ?? 1440;
  const vh = source.viewport?.height ?? source.document?.height ?? 900;
  if (b.x + b.w <= 0 || b.x >= vw || b.y + b.h <= 0 || b.y >= vh) return null;
  const visibleW = Math.max(0, Math.min(b.x + b.w, vw) - Math.max(b.x, 0));
  const visibleH = Math.max(0, Math.min(b.y + b.h, vh) - Math.max(b.y, 0));
  const visibleRatio = (visibleW * visibleH) / Math.max(1, b.w * b.h);
  if ((b.x < 0 || b.x + b.w > vw) && b.w * b.h >= 4000 && visibleRatio < 0.18) return null;
  return b;
}

function generatedBox(el: GeometryElement): { x: number; y: number; w: number; h: number } {
  return { x: el.rect.left, y: el.rect.top, w: el.rect.width, h: el.rect.height };
}

function generatedVisibleBox(el: GeometryElement): { x: number; y: number; w: number; h: number } | null {
  const box = generatedBox(el);
  if (box.w <= 1 || box.h <= 1 || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) return null;
  return box;
}

function mediaSlotKey(box: { x: number; y: number; w: number; h: number }): string {
  return [box.x, box.y, box.w, box.h].map((value) => String(Math.round(value))).join(":");
}

function countImageSlots<T>(elements: T[], boxFor: (el: T) => { x: number; y: number; w: number; h: number } | null): number {
  const slots = new Set<string>();
  for (const el of elements) {
    if (!isImageSlot(el as SourceRenderMapElement | GeometryElement)) continue;
    const box = boxFor(el);
    if (!box) continue;
    slots.add(mediaSlotKey(box));
  }
  return slots.size;
}

const SOURCE_TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "button", "span", "li", "label"]);

function isSourceTextSignal(el: SourceRenderMapElement): boolean {
  const text = normalizeText(el.text);
  if (text.length < 4 || text.length > 80) return false;
  if (SOURCE_TEXT_TAGS.has(el.tag)) return true;
  return text.length <= 48 && !["body", "main", "section", "article", "header", "footer", "nav"].includes(el.tag);
}

function centerInsideBox(inner: { x: number; y: number; w: number; h: number }, outer: { x: number; y: number; w: number; h: number }): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

function isAggregateSourceText(el: SourceRenderMapElement, sourceElements: SourceRenderMapElement[]): boolean {
  const text = normalizeText(el.text);
  const box = sourceBox(el);
  if (!box) return false;
  let contained = 0;
  for (const candidate of sourceElements) {
    if (candidate === el) continue;
    const childText = normalizeText(candidate.text);
    const childBox = sourceBox(candidate);
    if (childText.length < 2 || !childBox || !text.includes(childText)) continue;
    if (!centerInsideBox(childBox, box)) continue;
    if (childBox.w * childBox.h > box.w * box.h * 0.75) continue;
    if (childText === text) return true;
    contained += 1;
    if (contained >= 2) return true;
  }
  return false;
}

function findGeneratedTextMatch(src: SourceRenderMapElement, generatedElements: GeometryElement[]): GeometryElement | undefined {
  const text = normalizeText(src.text);
  const srcBox = sourceBox(src);
  const srcArea = srcBox ? Math.max(1, srcBox.w * srcBox.h) : 1;
  let best: { el: GeometryElement; score: number } | undefined;
  for (const el of generatedElements) {
    const candidate = normalizeText(el.text);
    if (candidate.length < 4) continue;
    if (candidate !== text && !candidate.includes(text) && !text.includes(candidate)) continue;
    if (candidate !== text && candidate.length > Math.max(text.length * 2, text.length + 40)) continue;
    const genArea = Math.max(1, el.rect.width * el.rect.height);
    const areaPenalty = Math.min(100, Math.abs(Math.log2(genArea / srcArea)) * 20);
    const distancePenalty = srcBox
      ? Math.min(200, (Math.abs(el.rect.left - srcBox.x) + Math.abs(el.rect.top - srcBox.y)) * 0.25)
      : 0;
    const score =
      (el.tag === src.tag ? 0 : 30) +
      (candidate === text ? 0 : 20) +
      Math.abs(candidate.length - text.length) +
      areaPenalty +
      distancePenalty;
    if (!best || score < best.score) best = { el, score };
  }
  return best?.el;
}

export function sourceFidelityFindings(source: SourceRenderMap, generated: GeometrySnapshot): QualityFinding[] {
  const sourceElements = (source.elements ?? []).filter((el) => sourceVisibleBox(el, source));
  const generatedElements = generated.elements ?? [];
  const findings: QualityFinding[] = [];

  const sourceImages = countImageSlots(sourceElements, (el) => sourceVisibleBox(el, source));
  const generatedImages = countImageSlots(generatedElements, generatedVisibleBox);
  if (sourceImages > 0 && generatedImages < Math.max(1, Math.floor(sourceImages * 0.7))) {
    findings.push({
      severity: "P1",
      id: "visual-source-image-count",
      message: `Sharingan source has ${sourceImages} visible image/background slot${sourceImages === 1 ? "" : "s"}, but the generated render exposes ${generatedImages}.`,
      fix: "Add the missing source image/background slots using the captured /_assets paths, preserving their measured sizes and crops from render-map.json.",
    });
  }

  const generatedText = normalizeText(generatedElements.map((el) => el.text).join(" "));
  const sourceTextElements = sourceElements.filter((el) => isSourceTextSignal(el) && !isAggregateSourceText(el, sourceElements));
  const sourceText = sourceTextElements
    .map((el) => ({ raw: (el.text ?? "").replace(/\s+/g, " ").trim(), normalized: normalizeText(el.text) }))
    .filter((text) => text.normalized.length >= 4);
  const missingText = sourceText.find((text) => !generatedText.includes(text.normalized));
  if (missingText) {
    findings.push({
      severity: "P1",
      id: "visual-source-text-missing",
      message: `Sharingan source text is missing from the generated render: "${missingText.raw.slice(0, 80)}".`,
      fix: "Restore this exact source text in the matching region; do not replace it with generic marketing copy.",
    });
  }

  for (const src of sourceTextElements) {
    const text = normalizeText(src.text);
    if (text.length < 4) continue;
    const gen = findGeneratedTextMatch(src, generatedElements);
    if (!gen) continue;
    const a = sourceBox(src)!;
    const b = generatedBox(gen);
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    const dw = Math.abs(a.w - b.w);
    const dh = Math.abs(a.h - b.h);
    if (dx > 48 || dy > 48 || dw > 96 || dh > 48) {
      findings.push({
        severity: "P1",
        id: "visual-source-box-delta",
        selector: gen.selector,
        message: `Sharingan source element "${src.text?.slice(0, 60) ?? src.selector}" is measured at ${a.x},${a.y} ${a.w}x${a.h}, but the generated match is at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}.`,
        fix: `Patch this element toward the source measurement from render-map.json: x:${a.x}, y:${a.y}, size:${a.w}x${a.h}. Keep the patch local; do not redesign the whole page.`,
        snippet: `source ${src.selector} -> generated ${gen.selector}`,
      });
      break;
    }
  }

  return findings.slice(0, 4);
}

function readSourceRenderMap(path?: string): SourceRenderMap | null {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SourceRenderMap;
    const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!positive(parsed.viewport?.width) || !positive(parsed.viewport?.height)) return null;
    if (!positive(parsed.document?.width) || !positive(parsed.document?.height)) return null;
    if (!Array.isArray(parsed.elements) || parsed.elements.length === 0 || parsed.elements.length > 700) return null;
    const usable = parsed.elements.every((element) =>
      !!element
      && typeof element === "object"
      && typeof element.selector === "string"
      && element.selector.length > 0
      && typeof element.tag === "string"
      && element.tag.length > 0
      && typeof element.box?.x === "number"
      && Number.isFinite(element.box.x)
      && typeof element.box?.y === "number"
      && Number.isFinite(element.box.y)
      && positive(element.box?.w)
      && positive(element.box?.h)
      && !!element.style
      && typeof element.style === "object"
      && !Array.isArray(element.style));
    return usable ? parsed : null;
  } catch {
    return null;
  }
}

interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

function decodePng(path: string): DecodedPng | null {
  if (!existsSync(path)) return null;
  const data = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  if (data.subarray(0, 8).toString("hex") !== signature) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8] ?? 0;
      colorType = chunk[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(chunk));
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || !idat.length) return null;
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const inflated = Buffer.from(unzlibSync(Buffer.concat(idat)));
  const rgba = new Uint8Array(width * height * 4);
  let srcOffset = 0;
  const prev = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[srcOffset++];
    const raw = inflated.subarray(srcOffset, srcOffset + stride);
    srcOffset += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel]! : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= bytesPerPixel ? prev[x - bytesPerPixel]! : 0;
      const value = raw[x] ?? 0;
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = (value + left) & 0xff;
      else if (filter === 2) row[x] = (value + up) & 0xff;
      else if (filter === 3) row[x] = (value + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (value + paeth(left, up, upLeft)) & 0xff;
      else return null;
    }
    for (let x = 0; x < width; x++) {
      const src = x * bytesPerPixel;
      const dst = (y * width + x) * 4;
      rgba[dst] = row[src]!;
      rgba[dst + 1] = row[src + 1]!;
      rgba[dst + 2] = row[src + 2]!;
      rgba[dst + 3] = colorType === 6 ? row[src + 3]! : 255;
    }
    row.copy(prev);
  }
  return { width, height, rgba };
}

export function sourceScreenshotDiffFindings(sourcePath?: string, generatedPath?: string): QualityFinding[] {
  if (!sourcePath || !generatedPath) return [];
  let source: DecodedPng | null = null;
  try {
    source = decodePng(sourcePath);
  } catch {
    // Handled below as missing/corrupt source evidence.
  }
  if (!source) {
    return [
      {
        severity: "P0",
        id: "visual-source-evidence-invalid",
        message: "Sharingan source screenshot evidence is missing, unreadable, or not a supported PNG, so source fidelity cannot be verified.",
        fix: "Re-capture the Sharingan source page before accepting or repairing the generated artifact.",
      },
    ];
  }
  let generated: DecodedPng | null = null;
  try {
    generated = decodePng(generatedPath);
  } catch {
    // Handled below as missing/corrupt generated evidence.
  }
  if (!generated) {
    return [
      {
        severity: "P0",
        id: "visual-generated-evidence-invalid",
        message: "The generated QA screenshot is missing, unreadable, or not a supported PNG, so source fidelity cannot be verified.",
        fix: "Re-render and capture the generated artifact before accepting or repairing it.",
      },
    ];
  }
  const width = Math.min(source.width, generated.width);
  const height = Math.min(source.height, generated.height);
  if (width < 1 || height < 1) return [];
  const targetSamples = 450_000;
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / targetSamples)));
  let samples = 0;
  let mean = 0;
  let color32 = 0;
  let color64 = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const si = (y * source.width + x) * 4;
      const gi = (y * generated.width + x) * 4;
      const sr = source.rgba[si] ?? 0;
      const sg = source.rgba[si + 1] ?? 0;
      const sb = source.rgba[si + 2] ?? 0;
      const gr = generated.rgba[gi] ?? 0;
      const gg = generated.rgba[gi + 1] ?? 0;
      const gb = generated.rgba[gi + 2] ?? 0;
      // Per-channel RMS catches hue changes whose weighted luminance is equal (for example red
      // replaced by a darker green), which a signed luma delta cancels out almost completely.
      const diff = Math.sqrt(((sr - gr) ** 2 + (sg - gg) ** 2 + (sb - gb) ** 2) / 3);
      mean += diff;
      if (diff >= 32) color32 += 1;
      if (diff >= 64) color64 += 1;
      samples += 1;
    }
  }
  if (!samples) return [];
  const meanDiff = mean / samples;
  const pct32 = color32 / samples;
  const pct64 = color64 / samples;
  const sourceArea = source.width * source.height;
  const generatedArea = generated.width * generated.height;
  const sizeDrift = sourceArea > 0 ? Math.abs(sourceArea - generatedArea) / sourceArea : 0;
  const widthDrift = Math.abs(source.width - generated.width) / source.width;
  const heightDrift = Math.abs(source.height - generated.height) / source.height;
  if (pct32 < 0.08 && pct64 < 0.03 && meanDiff < 18 && sizeDrift < 0.04 && widthDrift < 0.04 && heightDrift < 0.04) return [];
  return [
    {
      severity: "P1",
      id: "visual-source-screenshot-diff",
      message: `Sharingan screenshot regression is too high: ${Math.round(pct32 * 1000) / 10}% of sampled pixels differ by >=32 color distance, ${Math.round(pct64 * 1000) / 10}% differ by >=64, mean color delta ${Math.round(meanDiff * 10) / 10}; width drift ${Math.round(widthDrift * 1000) / 10}%, height drift ${Math.round(heightDrift * 1000) / 10}%.`,
      fix: "Run a source-vs-result visual regression repair pass against the source screenshot: correct global layout first (viewport, top offsets, major section sizes), then patch the largest local regions without adding new content.",
    },
  ];
}

function pushConsoleMessage(messages: VisualQaConsoleMessage[], message: VisualQaConsoleMessage): void {
  if (messages.length >= 30) return;
  const text = message.text.replace(/\s+/g, " ").trim().slice(0, 700);
  if (!text) return;
  messages.push({ ...message, text });
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return JSON.parse(fenced.slice(start, end + 1));
}

function isSeverity(value: unknown): value is QualityFinding["severity"] {
  return value === "P0" || value === "P1" || value === "P2";
}

function screenshotReviewSummary(count: number, command?: string, model?: string): string {
  const reviewer = [command, model].filter(Boolean).join(" / ") || "Agent";
  if (count === 0) return `${reviewer} reviewed the screenshot and reported no visible layout issues.`;
  return `${reviewer} reviewed the screenshot and reported ${count} issue${count === 1 ? "" : "s"}.`;
}

function withScreenshotReviewMetadata(
  findings: QualityFinding[],
  input: VisualQaInput,
  screenshotPath: string,
  summary?: string,
): QualityFinding[] {
  const projectDir = input.projectRoot ?? dirname(input.htmlPath);
  const screenshotRel = toRel(projectDir, screenshotPath);
  // The visual-reviewed marker is a "did it run" signal, not an issue — exclude it from the count.
  const issueCount = findings.filter((f) => f.id !== "visual-reviewed").length;
  const reviewSummary = summary ?? screenshotReviewSummary(issueCount, input.agentCommand || input.settings.agentCommand, input.model || input.settings.model || undefined);
  return findings.map((finding) => ({
    ...finding,
    screenshotPath: finding.screenshotPath ?? screenshotRel,
    reviewSummary: finding.reviewSummary ?? reviewSummary,
  }));
}

export function parseVisualReview(text: string, options: { isSharingan?: boolean } = {}): QualityFinding[] {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(text);
  } catch {
    return [];
  }
  const obj = parsed as { findings?: unknown };
  const findingsRaw = obj?.findings;
  if (!Array.isArray(findingsRaw)) return [];
  type RawFinding = {
    severity?: unknown;
    message?: unknown;
    fix?: unknown;
    snippet?: unknown;
    kind?: unknown;
    selector?: unknown;
  };
  const parsedFindings: Array<{
    kind: "defect" | "contract" | "improvement";
    severity: QualityFinding["severity"];
    message: string;
    fix: string;
    selector?: string;
    snippet?: string;
  }> = [];
  for (const item of findingsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const finding = item as RawFinding;
    if (finding.kind !== "defect" && finding.kind !== "contract" && finding.kind !== "improvement") return [];
    if (typeof finding.message !== "string" || !finding.message.trim()) return [];
    if (typeof finding.fix !== "string" || !finding.fix.trim()) return [];
    if (finding.selector !== undefined && typeof finding.selector !== "string") return [];
    if (finding.snippet !== undefined && typeof finding.snippet !== "string") return [];

    let severity: QualityFinding["severity"];
    if (options.isSharingan) {
      if (finding.severity !== undefined && !isSeverity(finding.severity)) return [];
      severity = finding.severity === "P0" ? "P0" : "P1";
    } else {
      if (!isSeverity(finding.severity)) return [];
      if (finding.kind === "defect" && finding.severity === "P2") return [];
      if (finding.kind === "contract" && finding.severity !== "P1") return [];
      if (finding.kind === "improvement" && finding.severity !== "P2") return [];
      severity = finding.severity;
    }
    parsedFindings.push({
      kind: finding.kind,
      severity,
      message: finding.message.trim(),
      fix: finding.fix.trim(),
      selector: typeof finding.selector === "string" && finding.selector.trim() ? finding.selector.trim().slice(0, 200) : undefined,
      snippet: typeof finding.snippet === "string" && finding.snippet.trim() ? finding.snippet.trim() : undefined,
    });
  }

  const normalized: QualityFinding[] = [];
  let defectN = 0;
  let contractN = 0;
  let improveN = 0;
  for (const finding of parsedFindings) {
    // "A few" of each — however many genuinely matter (or none). Sane caps guard against a
    // runaway response, but there is no forced count. Defects (P0/P1) vs design improvements (P2).
    const isImprovement = !options.isSharingan && finding.kind === "improvement";
    if (isImprovement) {
      if (improveN >= 8) continue;
      improveN += 1;
      normalized.push({
        severity: "P2",
        id: `visual-improve-${improveN}`,
        message: finding.message,
        fix: finding.fix,
        selector: finding.selector,
        snippet: finding.snippet,
      });
    } else if (!options.isSharingan && finding.kind === "contract") {
      if (contractN >= 6) continue;
      contractN += 1;
      normalized.push({
        severity: "P1",
        id: `visual-contract-drift-${contractN}`,
        message: finding.message,
        fix: finding.fix,
        selector: finding.selector,
        snippet: finding.snippet,
      });
    } else {
      if (defectN >= 6) continue;
      defectN += 1;
      normalized.push({
        severity: finding.severity,
        id: `visual-ai-review-${defectN}`,
        message: finding.message,
        fix: finding.fix,
        selector: finding.selector,
        snippet: finding.snippet,
      });
    }
  }
  // A score-less marker that the critic actually ran and judged (present even when it found
  // nothing) — distinguishes "reviewed, clean" from "review failed / unparseable", without
  // quantifying design quality as a number. We do NOT rate design with a 0-100 score: it is
  // inflated, noisy, and imposes taste; objective defects gate the run, suggestions are advisory.
  normalized.push({ severity: "P2", id: "visual-reviewed", message: "Automated design review completed.", fix: "" });
  return normalized;
}

/** The computed anti-slop detector (color/type/contrast/spacing/component tells) is skipped for
 *  Sharingan clones — reproducing a source faithfully must not be flagged as slop. */
export function shouldRunComputedDetector(input: Pick<VisualQaInput, "isSharingan">): boolean {
  return !input.isSharingan;
}

interface GeometryFrameResult extends VisualQaFrameResult {
  criticElements: CriticElement[];
  consoleMessages: VisualQaConsoleMessage[];
}

interface GeometryViewport {
  label: string;
  width: number;
  height: number;
  primary: boolean;
  frame?: RenderFrameSpec;
  frameIndex?: number;
  frameAttemptId?: string;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Visual QA aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export function visualQaFrameAttemptId(prefix: string | undefined, frame: RenderFrameSpec, index: number): string {
  const safePrefix = (prefix?.trim() || "visual-qa").replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 64);
  const safeFrame = frame.id.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 48);
  return `${safePrefix}-${index}-${safeFrame}`.slice(0, 128);
}

function geometryViewports(
  sourceDesktopViewport: { width: number; height: number } | undefined,
  renderFrames: readonly RenderFrameSpec[],
  attemptPrefix: string | undefined,
): GeometryViewport[] {
  const planned = renderFrames.map((frame, index): GeometryViewport => ({
    label: `frame:${frame.id}`,
    width: frame.width,
    height: frame.height,
    primary: false,
    frame,
    frameIndex: index,
    frameAttemptId: visualQaFrameAttemptId(attemptPrefix, frame, index),
  }));
  if (!sourceDesktopViewport) {
    if (planned.length > 0) {
      planned[0] = { ...planned[0]!, primary: true };
      return planned;
    }
    return DEFAULT_VIEWPORTS.map((viewport, index) => ({ ...viewport, primary: index === 0 }));
  }
  const matchingFrameIndex = planned.findIndex((viewport) =>
    viewport.width === sourceDesktopViewport.width && viewport.height === sourceDesktopViewport.height);
  if (matchingFrameIndex >= 0) {
    planned[matchingFrameIndex] = { ...planned[matchingFrameIndex]!, primary: true };
    return [planned[matchingFrameIndex]!, ...planned.filter((_viewport, index) => index !== matchingFrameIndex)];
  }
  return [
    { label: "source", ...sourceDesktopViewport, primary: true },
    ...planned,
  ];
}

function frameScreenshotPath(base: string, frame: RenderFrameSpec, index: number, primary: boolean): string {
  if (primary) return base;
  const safeFrame = frame.id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || `frame-${index}`;
  return join(dirname(base), "frames", `${String(index).padStart(3, "0")}-${safeFrame}.png`);
}

function frameScopedFinding(finding: QualityFinding, frameId: string): QualityFinding {
  return {
    ...finding,
    id: `${finding.id}@${frameId}`,
    message: `[Frame ${frameId}] ${finding.message}`,
  };
}

async function collectGeometry(
  htmlPath: string,
  screenshotPath?: string,
  renderUrl?: string,
  computedCtx: ComputedContext = {},
  runComputed = true,
  sourceDesktopViewport?: { width: number; height: number },
  strictTextLayout = false,
  sharinganSource?: SourceRenderMap | null,
  renderFrames: readonly RenderFrameSpec[] = [],
  signal: AbortSignal = new AbortController().signal,
  attemptPrefix?: string,
): Promise<{ findings: QualityFinding[]; consoleMessages: VisualQaConsoleMessage[]; elements: CriticElement[]; frames: GeometryFrameResult[]; desktopSnapshot?: GeometrySnapshot }> {
  const consoleMessages: VisualQaConsoleMessage[] = [];
  checkAbort(signal);
  const viewports = geometryViewports(sourceDesktopViewport, renderFrames, attemptPrefix);
  const executablePath = findChrome();
  if (!executablePath) {
    return {
      findings: [
        {
          severity: "P1",
          id: "visual-chrome-unavailable",
          message: "Visual QA could not run because Chrome was not found on this machine.",
          fix: "Install Chrome/Chromium or disable Visual QA in Settings for this environment.",
        },
      ],
      consoleMessages,
      elements: [],
      frames: viewports
        .filter((viewport) => viewport.frame && viewport.frameAttemptId)
        .map((viewport) => ({
          frameId: viewport.frame!.id,
          frameAttemptId: viewport.frameAttemptId!,
          width: viewport.width,
          height: viewport.height,
          status: "failed" as const,
          reviewed: false,
          criticElements: [],
          consoleMessages: [],
        })),
      desktopSnapshot: undefined,
    };
  }
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let elements: CriticElement[] = [];
  let computedFindings: QualityFinding[] = [];
  const frames: GeometryFrameResult[] = [];
  try {
    checkAbort(signal);
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
    checkAbort(signal);
    const all: QualityFinding[] = [];
    let desktopSnapshot: GeometrySnapshot | undefined;
    for (const viewport of viewports) {
      checkAbort(signal);
      const page = await browser.newPage();
      page.on("console", (msg) => {
        const location = msg.location();
        pushConsoleMessage(consoleMessages, {
          type: "console",
          level: msg.type(),
          text: msg.text(),
          url: location.url,
          line: location.lineNumber,
        });
      });
      page.on("pageerror", (err) => {
        pushConsoleMessage(consoleMessages, {
          type: "pageerror",
          level: "error",
          text: err instanceof Error ? err.stack || err.message : String(err),
        });
      });
      page.on("requestfailed", (request) => {
        pushConsoleMessage(consoleMessages, {
          type: "requestfailed",
          level: "error",
          text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`,
          url: request.url(),
        });
      });
      page.on("response", (response) => {
        if (response.status() < 400) return;
        pushConsoleMessage(consoleMessages, {
          type: "response",
          level: "error",
          text: `${response.status()} ${response.url()}`,
          url: response.url(),
        });
      });
      const consoleStart = consoleMessages.length;
      try {
        await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
        checkAbort(signal);
      // Use `domcontentloaded`, NOT `load`: on real apps a never-settling resource (async Shiki
      // WASM, the Vite HMR socket, a perpetual animation) can keep `load` from firing within the
      // timeout, so `goto` throws and the whole review fails (visual-render-failed → no screenshot
      // → the critic silently returns nothing and the run "passes" on lint alone). We do NOT need
      // `load`: we explicitly poll for real painted content next, which is what avoids the
      // pre-mount blank frame that motivated the earlier `load` switch.
        const targetUrl = renderUrl ?? pathToFileURL(htmlPath).href;
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        checkAbort(signal);
        if (viewport.frame && viewport.frameAttemptId) {
          await applyArtifactThumbnailFrame(page, targetUrl, {
            frameId: viewport.frame.id,
            frameAttemptId: viewport.frameAttemptId,
            initialState: viewport.frame.initialState,
            fixture: viewport.frame.fixture,
            background: viewport.frame.background,
          }, signal);
        }
        checkAbort(signal);
      await page
        .waitForFunction(
          () => {
            const body = (globalThis as any).document?.body;
            if (!body) return false;
            return body.scrollHeight > 40 && ((body as any).innerText ?? "").trim().length > 20;
          },
          { timeout: 5000, polling: 100 },
        )
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      // Freeze animations/transitions/caret so a perpetually-animating page (streaming carets,
      // infinite loaders) can't keep the full-page capture from settling.
      await withTimeout(4_000, page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important;}" })).catch(() => {});
      // Bound the geometry read: a page that has wedged its main thread (heavy sync work, a stuck
      // WASM load) makes page.evaluate hang forever, which would freeze the whole run with no
      // ceiling judgment. On timeout this throws and the outer catch records a graceful
      // visual-render-failed instead of hanging.
      const snapshot = await withTimeout(12_000, page.evaluate(() => {
        const win = globalThis as any;
        const doc = win.document;
        const escapeCss = (value: string) => {
          const css = win.CSS as { escape?: (input: string) => string } | undefined;
          return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        };
        const selectorFor = (el: any): string => {
          const id = el.getAttribute("id");
          if (id) return `#${escapeCss(id)}`;
          const dezinId = el.getAttribute("data-dezin-id");
          if (dezinId) return `[data-dezin-id="${dezinId.replace(/"/g, '\\"')}"]`;
          const cls = Array.from<string>(el.classList).slice(0, 2);
          const suffix = cls.length ? `.${cls.map(escapeCss).join(".")}` : "";
          return `${el.tagName.toLowerCase()}${suffix}`;
        };
        // The nearest OPAQUE painted backdrop behind an element, by walking ancestors. Returns null
        // (→ contrast skipped, no false positive) if a background-image/gradient is hit first or no
        // solid backdrop exists — we only judge provable solid-on-solid contrast.
        const effectiveBgOf = (start: any): string | null => {
          let node = start;
          let guard = 0;
          while (node && guard++ < 40) {
            const s = win.getComputedStyle(node);
            if (s.backgroundImage && s.backgroundImage !== "none") return null;
            const bg: string = s.backgroundColor || "";
            const m = /rgba?\(([^)]+)\)/.exec(bg);
            if (m) {
              const parts = (m[1] ?? "").split(/[\s,/]+/).map((n: string) => parseFloat(n));
              const alpha = parts.length >= 4 ? parts[3] ?? 1 : 1;
              if (alpha >= 1) return bg;
            }
            node = node.parentElement;
          }
          return null;
        };
        const elements = Array.from<any>(doc.body.querySelectorAll("*"))
          .map((el: any) => {
            const styles = win.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (styles.display === "none" || styles.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return null;
            const borderMaxPx = Math.max(
              parseFloat(styles.borderTopWidth) || 0,
              parseFloat(styles.borderRightWidth) || 0,
              parseFloat(styles.borderBottomWidth) || 0,
              parseFloat(styles.borderLeftWidth) || 0,
            );
            const directText = Array.from<any>(el.childNodes)
              .filter((node: any) => node.nodeType === 3)
              .map((node: any) => node.textContent ?? "")
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            return {
              selector: selectorFor(el),
              tag: el.tagName.toLowerCase(),
              text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
              rect: {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              },
              position: styles.position,
              overflowX: styles.overflowX,
              overflowY: styles.overflowY,
              scrollWidth: el.scrollWidth,
              scrollHeight: el.scrollHeight,
              clientWidth: el.clientWidth,
              clientHeight: el.clientHeight,
              directTextLength: directText.length,
              childElementCount: el.childElementCount,
              // Computed-style subset for the pure detector (colors normalized to rgb by the browser;
              // lengths resolved to px). Optional fields JSON-drop when absent.
              style: {
                color: styles.color,
                backgroundColor: styles.backgroundColor,
                backgroundImage: styles.backgroundImage,
                effectiveBg: effectiveBgOf(el) ?? undefined,
                fontSizePx: parseFloat(styles.fontSize) || undefined,
                fontFamily: styles.fontFamily,
                fontWeight: parseInt(styles.fontWeight, 10) || undefined,
                lineHeightPx: styles.lineHeight === "normal" ? null : parseFloat(styles.lineHeight) || null,
                letterSpacing: styles.letterSpacing,
                textTransform: styles.textTransform,
                borderRadius: styles.borderRadius,
                boxShadow: styles.boxShadow,
                paddingTopPx: parseFloat(styles.paddingTop) || 0,
                paddingRightPx: parseFloat(styles.paddingRight) || 0,
                paddingBottomPx: parseFloat(styles.paddingBottom) || 0,
                paddingLeftPx: parseFloat(styles.paddingLeft) || 0,
                marginTopPx: parseFloat(styles.marginTop) || 0,
                marginBottomPx: parseFloat(styles.marginBottom) || 0,
                borderMaxPx,
                cardLike: borderMaxPx >= 1 || (styles.boxShadow && styles.boxShadow !== "none") ? true : undefined,
                // querySelector is gated to tile-sized boxes so it isn't run on every node.
                hasIconChild:
                  rect.width >= 32 && rect.width <= 128 && rect.height >= 32 && rect.height <= 128 && el.querySelector('svg,[class*="icon" i]')
                    ? true
                    : undefined,
              },
            };
          })
          .filter(Boolean);
        const root = doc.documentElement;
        const body = doc.body;
        const opaqueBg = (c: string): boolean => {
          const m = /rgba?\(([^)]+)\)/.exec(c || "");
          if (!m) return false;
          const p = (m[1] ?? "").split(/[\s,/]+/).map((n: string) => parseFloat(n));
          return (p.length >= 4 ? p[3] ?? 1 : 1) >= 1;
        };
        const bodyBg = win.getComputedStyle(body).backgroundColor;
        const htmlBg = win.getComputedStyle(root).backgroundColor;
        // The page's OWN declared design tokens, read from :root — the reference the drift checks
        // compare the rendered result against (font families by name; colors resolved to rgb via a
        // hidden probe so the browser handles oklch/hsl/hex for us). Probe is added AFTER the element
        // sweep and removed before returning, so it never appears in `elements`.
        const rootStyle = win.getComputedStyle(root);
        const FONT_TOKENS = ["--font-display", "--font-body", "--font-mono", "--font-sans", "--font-serif", "--font-heading"];
        const COLOR_TOKENS = [
          "--bg", "--surface", "--surface-2", "--fg", "--fg-2", "--muted", "--border", "--border-strong",
          "--accent", "--accent-fg", "--accent-2", "--primary", "--secondary", "--success", "--warn", "--danger",
        ];
        const tokenFonts: string[] = [];
        for (const t of FONT_TOKENS) {
          const fam = (rootStyle.getPropertyValue(t).split(",")[0] ?? "").replace(/["']/g, "").trim().toLowerCase();
          if (fam && !tokenFonts.includes(fam)) tokenFonts.push(fam);
        }
        const probe = doc.createElement("span");
        probe.style.cssText = "position:absolute;left:-9999px;visibility:hidden;pointer-events:none";
        doc.body.appendChild(probe);
        const tokenColors: Array<{ r: number; g: number; b: number }> = [];
        for (const t of COLOR_TOKENS) {
          const v = rootStyle.getPropertyValue(t).trim();
          if (!v) continue;
          probe.style.color = "";
          probe.style.color = v;
          const m = /rgba?\(([^)]+)\)/.exec(win.getComputedStyle(probe).color);
          if (!m) continue;
          const p = (m[1] ?? "").split(/[\s,/]+/).map((n: string) => parseFloat(n));
          if (p.length >= 3 && (p[3] === undefined || p[3] >= 1)) tokenColors.push({ r: p[0]!, g: p[1]!, b: p[2]! });
        }
        const RADIUS_TOKENS = ["--radius", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--rounded", "--rounded-sm", "--rounded-lg"];
        const tokenRadii: number[] = [];
        for (const t of RADIUS_TOKENS) {
          const rm = /(-?\d*\.?\d+)(px|rem)/.exec(rootStyle.getPropertyValue(t).trim());
          if (rm) tokenRadii.push(rm[2] === "rem" ? parseFloat(rm[1]!) * 16 : parseFloat(rm[1]!));
        }
        doc.body.removeChild(probe);
        return {
          viewport: { width: win.innerWidth, height: win.innerHeight },
          document: {
            scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
            scrollHeight: Math.max(root.scrollHeight, body.scrollHeight),
          },
          bodyTextLength: (body.innerText ?? "").trim().length,
          pageBackground: opaqueBg(bodyBg) ? bodyBg : opaqueBg(htmlBg) ? htmlBg : undefined,
          designTokens: { fonts: tokenFonts, colors: tokenColors, radii: tokenRadii },
          elements,
        };
      }));
        checkAbort(signal);
        const exactSnapshot = snapshot as GeometrySnapshot;
        const currentGeometryFindings = findingsFromGeometry(exactSnapshot, viewport.label, { strictTextLayout, sharinganSource });
        all.push(...currentGeometryFindings);
        const currentElements = toCriticElements(exactSnapshot.elements ?? []);
        if (viewport.primary) {
          desktopSnapshot = exactSnapshot;
          const desktopElements = desktopSnapshot.elements ?? [];
          elements = currentElements;
        // Deterministic computed-style findings — contrast, type, spacing, component tells — run
        // on the desktop render only (viewport-independent) and are bounded so they can't flood repair.
        // Skipped entirely for Sharingan clones (runComputed=false): faithfully reproducing a
        // source's taste is not slop.
          computedFindings = runComputed
            ? boundComputedFindings(
                detectComputedFindings(toComputedElements(desktopElements), {
                  ...computedCtx,
                  pageBackground: exactSnapshot.pageBackground,
                  designTokens: exactSnapshot.designTokens,
                }),
              )
            : [];
        }
        let capturedPath: string | undefined;
        if (screenshotPath && (viewport.primary || viewport.frame)) {
          capturedPath = viewport.frame && viewport.frameIndex !== undefined
            ? frameScreenshotPath(screenshotPath, viewport.frame, viewport.frameIndex, viewport.primary)
            : screenshotPath;
          await mkdir(dirname(capturedPath), { recursive: true });
          // Bound each exact Frame capture — a wedged/animating page cannot hang the run.
          await withTimeout(15_000, captureFullPageScreenshot(page, { path: capturedPath }));
        }
        checkAbort(signal);
        if (viewport.frame && viewport.frameAttemptId) {
          const frameConsoleMessages = consoleMessages.slice(consoleStart);
          const runtimeMessages = frameConsoleMessages.filter((message) =>
            message.type === "pageerror"
            || message.type === "requestfailed"
            || message.type === "response"
            || (message.type === "console" && ["error", "assert"].includes(message.level)));
          if (runtimeMessages.length > 0) {
            all.push({
              severity: "P1",
              id: `visual-runtime-error@${viewport.frame.id}`,
              message: `[Frame ${viewport.frame.id}] Runtime error: ${runtimeMessages[0]!.text}`,
              fix: "Repair the application runtime error for this exact Frame state and fixture, then rerun Frame QA.",
            });
          }
          const geometryFailed = currentGeometryFindings.some((finding) =>
            finding.severity === "P0" || finding.severity === "P1");
          frames.push({
            frameId: viewport.frame.id,
            frameAttemptId: viewport.frameAttemptId,
            width: viewport.width,
            height: viewport.height,
            status: runtimeMessages.length === 0 && !geometryFailed && capturedPath ? "passed" : "failed",
            screenshotPath: capturedPath,
            reviewed: false,
            criticElements: currentElements,
            consoleMessages: frameConsoleMessages,
          });
        }
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (!viewport.frame || !viewport.frameAttemptId) throw error;
        all.push({
          severity: "P1",
          id: `visual-render-failed@${viewport.frame.id}`,
          message: `[Frame ${viewport.frame.id}] Visual QA could not render or apply the exact Frame: ${error instanceof Error ? error.message : "unknown render failure"}.`,
          fix: "Repair the preview/runtime bridge for this exact Frame and rerun Frame QA.",
        });
        frames.push({
          frameId: viewport.frame.id,
          frameAttemptId: viewport.frameAttemptId,
          width: viewport.width,
          height: viewport.height,
          status: "failed",
          reviewed: false,
          criticElements: [],
          consoleMessages: consoleMessages.slice(consoleStart),
        });
      } finally {
        await page.close().catch(() => {});
      }
    }
    const seen = new Set<string>();
    return {
      // Geometry findings dedupe by id (one per kind); computed findings are per-selector and
      // already bounded, so they append after rather than collapsing to one.
      findings: [
        ...all.filter((finding) => {
          if (seen.has(finding.id)) return false;
          seen.add(finding.id);
          return true;
        }),
        ...computedFindings,
      ],
      consoleMessages,
      elements,
      frames,
      desktopSnapshot,
    };
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    return {
      findings: [
        {
          severity: "P1",
          id: "visual-render-failed",
          message: `Visual QA could not render the final artifact in headless Chrome: ${error instanceof Error ? error.message : "unknown render failure"}.`,
          fix: "Open the preview and check for script errors, blocked local assets, or markup that prevents first paint.",
        },
      ],
      consoleMessages,
      elements,
      frames,
      desktopSnapshot: undefined,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function spawnAgentText(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const env = agentSpawnEnv(extraEnv);
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env, shell: process.platform === "win32" });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      rejectOnce(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOnce(new Error("agent visual review timed out"));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      rejectOnce(e);
    });
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) resolveOnce(stdout);
      else rejectOnce(new Error(stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200) || `${command} exited with ${code}`));
    });
  });
}

/** True when the critic actually ran and judged this pass (produced the visual-reviewed marker),
 *  as opposed to returning nothing parseable. */
function wasReviewed(findings: QualityFinding[]): boolean {
  return findings.some((f) => f.id === "visual-reviewed");
}

/**
 * The critic occasionally returns nothing parseable for a round (e.g. its output wasn't valid
 * JSON). Retry once when a pass produced no review at all; keep the retry only if it then judged
 * (or surfaced more). A clean review still carries the visual-reviewed marker, so it never retries.
 */
export async function reviewWithRetry(reviewOnce: () => Promise<QualityFinding[]>): Promise<QualityFinding[]> {
  const first = await reviewOnce();
  if (wasReviewed(first)) return first;
  const second = await reviewOnce();
  if (wasReviewed(second)) return second;
  return [
    {
      severity: "P1",
      id: "visual-review-unassessed",
      message: "Automated design review returned malformed or empty output twice, so this artifact was not visually assessed.",
      fix: "Rerun Visual QA with a working reviewer before treating the design as passed.",
    },
  ];
}

export async function reviewScreenshotWithAgent(input: VisualQaInput, screenshotPath: string): Promise<QualityFinding[]> {
  if (input.signal?.aborted) throw abortReason(input.signal);
  if (!input.settings.visualQaEnabled) return [];
  if (!existsSync(screenshotPath)) {
    return withScreenshotReviewMetadata(
      [
        {
          severity: "P1",
          id: "visual-screenshot-missing",
          message: "Agent visual review could not run because the rendered screenshot was not produced.",
          fix: "Open Preview and check whether the page can be captured, then rerun the generation.",
        },
      ],
      input,
      screenshotPath,
      "Agent visual review could not run because the rendered screenshot was not produced.",
    );
  }
  const projectDir = input.projectRoot ?? dirname(input.htmlPath);
  const command = input.agentCommand || input.settings.agentCommand || "claude";
  const provider = getProvider(command);
  const model = input.model || input.settings.model || undefined;
  const prompt = agentReviewPrompt(input, screenshotPath);
  const args = provider ? provider.oneShotArgs(model, prompt) : ["-p", prompt];
  try {
    const findings = await reviewWithRetry(async () =>
      parseVisualReview(await spawnAgentText(
        command,
        args,
        projectDir,
        120_000,
        buildAgentEnv(input.settings, command),
        input.signal,
      ), { isSharingan: input.isSharingan }),
    );
    return withScreenshotReviewMetadata(findings, input, screenshotPath);
  } catch (err) {
    if (input.signal?.aborted) throw abortReason(input.signal);
    return withScreenshotReviewMetadata(
      [
        {
          severity: "P1",
          id: "visual-agent-review-failed",
          message: `Agent visual review failed: ${err instanceof Error ? err.message : "request error"}.`,
          fix: "Check that the selected Agent can read the generated screenshot and project files, or disable Visual QA in Settings.",
        },
      ],
      input,
      screenshotPath,
      `Agent visual review failed: ${err instanceof Error ? err.message : "request error"}.`,
    );
  }
}

function unavailableFrameResults(input: VisualQaInput): VisualQaFrameResult[] {
  return (input.renderFrames ?? []).map((frame, index) => ({
    frameId: frame.id,
    frameAttemptId: visualQaFrameAttemptId(input.frameAttemptIdPrefix, frame, index),
    width: frame.width,
    height: frame.height,
    status: "failed",
    reviewed: false,
  }));
}

export async function auditVisualArtifactReport(input: VisualQaInput): Promise<VisualQaReport> {
  if (!input.settings.visualQaEnabled && !input.runtimeOnly) return { findings: [], frames: [] };
  const signal = input.signal ?? new AbortController().signal;
  checkAbort(signal);
  const projectDir = input.projectRoot ?? dirname(input.htmlPath);
  const screenshotPath = input.screenshotPath ?? join(projectDir, ".visual-qa", "screenshot.png");
  // A screenshot is evidence for exactly one audit attempt. Clear the mutable capture target
  // before every enabled audit so a failed render cannot be reviewed or persisted as if it were
  // the current artifact.
  await rm(screenshotPath, { force: true });
  await rm(join(dirname(screenshotPath), "frames"), { recursive: true, force: true });
  checkAbort(signal);
  if (input.isSharingan && !input.sharinganReference) {
    return {
      findings: [{
        severity: "P0",
        id: "visual-source-evidence-missing",
        message: "Sharingan source screenshot and render-map evidence are unavailable, so reconstruction fidelity cannot be verified.",
        fix: "Re-capture the intended Sharingan source entry before generating or accepting a reconstruction.",
      }],
      frames: unavailableFrameResults(input),
    };
  }
  if (!existsSync(input.htmlPath)) {
    return {
      findings: [{
        severity: "P1",
        id: "visual-artifact-missing",
        message: "Visual QA could not run because the final artifact file is missing.",
        fix: "Rerun generation and confirm the selected Agent writes the expected project files.",
      }],
      frames: unavailableFrameResults(input),
    };
  }
  const sourceMap = input.isSharingan ? readSourceRenderMap(input.sharinganReference?.renderMapPath) : null;
  if (input.isSharingan) {
    let sourceScreenshotValid = false;
    try {
      sourceScreenshotValid = !!decodePng(input.sharinganReference?.screenshotPath ?? "");
    } catch {
      sourceScreenshotValid = false;
    }
    if (!sourceMap || !sourceScreenshotValid) {
      return {
        findings: [{
          severity: "P0",
          id: "visual-source-evidence-invalid",
          message: "Sharingan source screenshot or render-map evidence is missing, corrupt, or structurally unusable, so reconstruction fidelity cannot be verified.",
          fix: "Re-capture the intended Sharingan source entry before generating, repairing, or accepting the reconstruction.",
        }],
        frames: unavailableFrameResults(input),
      };
    }
  }
  const geometry = await collectGeometry(
    input.htmlPath,
    screenshotPath,
    input.renderUrl,
    { provider: input.provider },
    !input.runtimeOnly && shouldRunComputedDetector(input),
    sourceViewportFromRenderMap(sourceMap),
    Boolean(input.isSharingan),
    sourceMap,
    input.renderFrames ?? [],
    signal,
    input.frameAttemptIdPrefix,
  );
  checkAbort(signal);
  if (input.runtimeOnly) {
    return {
      findings: geometry.findings,
      frames: geometry.frames.map(({
        criticElements: _criticElements,
        consoleMessages: _consoleMessages,
        ...frame
      }) => frame),
    };
  }
  const sourceFindings = sourceMap && geometry.desktopSnapshot ? sourceFidelityFindings(sourceMap, geometry.desktopSnapshot) : [];
  const screenshotFindings = input.isSharingan
    ? sourceScreenshotDiffFindings(input.sharinganReference?.screenshotPath, screenshotPath)
    : [];
  // Blind dual-assessment: the agent critic never sees deterministic findings. Exact Task
  // Frames are each reviewed from their own screenshot and state-specific element map.
  const ai: QualityFinding[] = [];
  let reportFrames = geometry.frames.map(({
    criticElements: _criticElements,
    consoleMessages: _consoleMessages,
    ...frame
  }) => frame);
  if ((input.renderFrames?.length ?? 0) > 0) {
    const updated: VisualQaFrameResult[] = [];
    const reviewMarkers: QualityFinding[] = [];
    for (const frame of geometry.frames) {
      checkAbort(signal);
      // A runtime/geometry failure is itself a design signal, not a reason to skip
      // visual assessment. Review every Frame that produced current screenshot
      // evidence; only an uncaptured Frame is genuinely unassessable.
      if (!frame.screenshotPath) {
        const {
          criticElements: _criticElements,
          consoleMessages: _consoleMessages,
          ...publicFrame
        } = frame;
        updated.push(publicFrame);
        continue;
      }
      const frameReview = await reviewScreenshotWithAgent({
        ...input,
        consoleMessages: frame.consoleMessages,
        criticElements: frame.criticElements,
        reviewFrame: {
          ...structuredClone(input.renderFrames!.find((candidate) => candidate.id === frame.frameId)!),
          frameAttemptId: frame.frameAttemptId,
        },
      }, frame.screenshotPath);
      checkAbort(signal);
      const marker = frameReview.find((finding) => finding.id === "visual-reviewed");
      if (marker) reviewMarkers.push(marker);
      ai.push(...frameReview
        .filter((finding) => finding.id !== "visual-reviewed")
        .map((finding) => frameScopedFinding(finding, frame.frameId)));
      updated.push({
        frameId: frame.frameId,
        frameAttemptId: frame.frameAttemptId,
        width: frame.width,
        height: frame.height,
        status: frame.status,
        screenshotPath: frame.screenshotPath,
        reviewed: marker !== undefined,
      });
    }
    reportFrames = updated;
    if (updated.length === input.renderFrames!.length && updated.every((frame) => frame.reviewed)) {
      ai.push(reviewMarkers[0]!);
    }
  } else {
    ai.push(...await reviewScreenshotWithAgent({
      ...input,
      consoleMessages: geometry.consoleMessages,
      criticElements: geometry.elements,
    }, screenshotPath));
    checkAbort(signal);
  }
  const synthesized = markCorroboration(geometry.findings, ai);
  return {
    findings: [...sourceFindings, ...screenshotFindings, ...synthesized.deterministic, ...synthesized.agent],
    frames: reportFrames,
  };
}

export async function auditVisualArtifact(input: VisualQaInput): Promise<QualityFinding[]> {
  return (await auditVisualArtifactReport(input)).findings;
}
