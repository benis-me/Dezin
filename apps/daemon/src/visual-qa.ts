import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import type { QualityFinding, Settings } from "../../../packages/core/src/index.ts";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";
import { findChrome } from "./capture-cover.ts";
import { buildAgentEnv } from "./agent-env.ts";

export interface VisualQaInput {
  htmlPath: string;
  projectRoot?: string;
  renderUrl?: string;
  settings: Settings;
  screenshotPath?: string;
  agentCommand?: string;
  model?: string;
  brief?: string;
  /** The chosen direction's spec (its Visual Language etc.) — the critic's aesthetic contract. */
  directionSpec?: string;
  /** Compact map of on-page elements (selector + text + box) so the critic can anchor each
   *  finding to a specific DOM element, and the repair can target it precisely. */
  criticElements?: CriticElement[];
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  consoleMessages?: VisualQaConsoleMessage[];
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

interface GeometryElement {
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
}

interface GeometrySnapshot {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number };
  bodyTextLength?: number;
  elements: GeometryElement[];
}

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
] as const;

function toRel(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/** Reject if `p` doesn't settle within `ms`, so a wedged headless page (blocked main thread,
 *  stuck WASM, perpetual animation) can never hang the capture and silently kill the critic. */
function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`visual capture step timed out after ${ms}ms`)), ms)),
  ]);
}

export function agentReviewPrompt(input: VisualQaInput, screenshotPath: string): string {
  const projectDir = input.projectRoot ?? dirname(input.htmlPath);
  const artifactRel = toRel(projectDir, input.htmlPath);
  const screenshotRel = toRel(projectDir, screenshotPath);
  const brief = input.brief?.trim();
  const directionSpec = input.directionSpec?.trim();
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
  return [
    "You are a senior product designer reviewing the latest rendered result for the current Dezin conversation.",
    `Rendered screenshot (full page, top to bottom): ${screenshotRel}`,
    `Final artifact: ${artifactRel}`,
    input.renderUrl ? `Rendered URL: ${input.renderUrl}` : "",
    consoleMessages ? `Browser console / runtime signals:\n${consoleMessages}` : "",
    history ? `Current conversation context:\n${history}` : "",
    brief ? `USER BRIEF:\n${brief}` : "",
    directionSpec ? `CHOSEN DIRECTION (what the build was aiming for):\n${directionSpec}` : "",
    elementList
      ? `ON-PAGE ELEMENTS you can target — use these EXACT selector strings (tag "text" WxH at x,y):\n${elementList}`
      : "",
    "Use the full-page screenshot as primary evidence (it shows below-the-fold content too). You may read the artifact and assets for context, but do not create, edit, or write files.",
    "Report findings in two clearly separated kinds — do not conflate them:",
    '- kind "defect" (severity P0/P1): OBJECTIVE, verifiable problems only — overlap, clipping, elements offscreen or orphaned, content overflowing below the fold, broken or negative spacing, unreadable text (contrast/size), misalignment, or a runtime/console error. These are things that are measurably wrong. Do NOT file taste, palette, or aesthetic preferences as defects — colour and style are the user\'s call, not a bug.',
    '- kind "improvement" (severity P2): concrete, actionable design SUGGESTIONS — hierarchy, spacing/rhythm, composition, type scale, restraint, and how well the result matches the brief and chosen direction (e.g. if the direction implies near-monochrome and the build leans on a saturated accent, suggest the change). These are ADVISORY — the user decides whether to take them. Be specific, never vague taste talk.',
    "For EVERY finding, set \"selector\" to the ONE element it is about, copied EXACTLY from the ON-PAGE ELEMENTS list above — this lets the fix target that element precisely. Omit selector only for a genuinely page-wide finding. Make each fix a concrete, verifiable change to that element.",
    "Report as many of each as genuinely matter — several, or none. Do NOT invent findings to hit a count; if nothing is objectively broken and nothing would clearly improve it, return an empty findings list.",
    'Return JSON only, exactly: {"findings":[{"kind":"defect|improvement","severity":"P0|P1|P2","selector":"exact selector or omit","message":"...","fix":"..."}]}.',
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

export function findingsFromGeometry(snapshot: GeometrySnapshot, label: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const viewport = snapshot.viewport;
  const doc = snapshot.document;
  const overflowPx = Math.round(doc.scrollWidth - viewport.width);

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
    const clipsX = (el.overflowX === "hidden" || el.overflowX === "clip") && el.scrollWidth > el.clientWidth + 2;
    const clipsY = (el.overflowY === "hidden" || el.overflowY === "clip") && el.scrollHeight > el.clientHeight + 2;
    return clipsX || clipsY;
  });
  if (clippedText) {
    findings.push({
      severity: "P2",
      id: "visual-text-clipped",
      message: `${titleCase(label)} text appears clipped in ${clippedText.selector}.`,
      fix: "Allow wrapping, increase the container height, or remove fixed dimensions that hide text.",
      snippet: rectSnippet(clippedText),
    });
  }

  return findings;
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

export function parseVisualReview(text: string): QualityFinding[] {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(text);
  } catch {
    return [];
  }
  const obj = parsed as { findings?: unknown };
  const findingsRaw = obj?.findings;
  if (!Array.isArray(findingsRaw)) return [];
  const normalized: QualityFinding[] = [];
  let defectN = 0;
  let improveN = 0;
  for (const item of findingsRaw) {
    const f = item as { severity?: unknown; message?: unknown; fix?: unknown; snippet?: unknown; kind?: unknown; selector?: unknown };
    if (!isSeverity(f.severity) || typeof f.message !== "string") continue;
    const selector = typeof f.selector === "string" && f.selector.trim() ? f.selector.trim().slice(0, 200) : undefined;
    // "A few" of each — however many genuinely matter (or none). Sane caps guard against a
    // runaway response, but there is no forced count. Defects (P0/P1) vs design improvements (P2).
    const isImprovement = f.kind === "improvement" || (f.kind !== "defect" && f.severity === "P2");
    if (isImprovement) {
      if (improveN >= 8) continue;
      improveN += 1;
      normalized.push({
        severity: "P2",
        id: `visual-improve-${improveN}`,
        message: f.message,
        fix: typeof f.fix === "string" && f.fix ? f.fix : "Apply the design improvement described.",
        selector,
        snippet: typeof f.snippet === "string" ? f.snippet : undefined,
      });
    } else {
      if (defectN >= 6) continue;
      defectN += 1;
      normalized.push({
        severity: f.severity,
        id: `visual-ai-review-${defectN}`,
        message: f.message,
        fix: typeof f.fix === "string" && f.fix ? f.fix : "Adjust the layout and visual hierarchy in the screenshot.",
        selector,
        snippet: typeof f.snippet === "string" ? f.snippet : undefined,
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

async function collectGeometry(
  htmlPath: string,
  screenshotPath?: string,
  renderUrl?: string,
): Promise<{ findings: QualityFinding[]; consoleMessages: VisualQaConsoleMessage[]; elements: CriticElement[] }> {
  const consoleMessages: VisualQaConsoleMessage[] = [];
  const executablePath = findChrome();
  if (!executablePath) {
    return {
      findings: [
        {
          severity: "P2",
          id: "visual-chrome-unavailable",
          message: "Visual QA could not run because Chrome was not found on this machine.",
          fix: "Install Chrome/Chromium or disable Visual QA in Settings for this environment.",
        },
      ],
      consoleMessages,
      elements: [],
    };
  }
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let elements: CriticElement[] = [];
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
    const all: QualityFinding[] = [];
    for (const viewport of VIEWPORTS) {
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
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
      // Use `domcontentloaded`, NOT `load`: on real apps a never-settling resource (async Shiki
      // WASM, the Vite HMR socket, a perpetual animation) can keep `load` from firing within the
      // timeout, so `goto` throws and the whole review fails (visual-render-failed → no screenshot
      // → the critic silently returns nothing and the run "passes" on lint alone). We do NOT need
      // `load`: we explicitly poll for real painted content next, which is what avoids the
      // pre-mount blank frame that motivated the earlier `load` switch.
      await page.goto(renderUrl ?? pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded", timeout: 15000 });
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
        const elements = Array.from<any>(doc.body.querySelectorAll("*"))
          .map((el: any) => {
            const styles = win.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (styles.display === "none" || styles.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return null;
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
            };
          })
          .filter(Boolean);
        const root = doc.documentElement;
        const body = doc.body;
        return {
          viewport: { width: win.innerWidth, height: win.innerHeight },
          document: {
            scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
            scrollHeight: Math.max(root.scrollHeight, body.scrollHeight),
          },
          bodyTextLength: (body.innerText ?? "").trim().length,
          elements,
        };
      }));
      all.push(...findingsFromGeometry(snapshot as GeometrySnapshot, viewport.label));
      if (viewport.label === "desktop") {
        elements = toCriticElements((snapshot as GeometrySnapshot).elements ?? []);
        if (screenshotPath) {
          await mkdir(dirname(screenshotPath), { recursive: true });
          // Bound the capture too — full-page screenshot of a wedged/animating page can hang.
          await withTimeout(15_000, page.screenshot({ path: screenshotPath as `${string}.png`, type: "png", fullPage: true }));
        }
      }
      await page.close().catch(() => {});
    }
    const seen = new Set<string>();
    return {
      findings: all.filter((finding) => {
        if (seen.has(finding.id)) return false;
        seen.add(finding.id);
        return true;
      }),
      consoleMessages,
      elements,
    };
  } catch {
    return {
      findings: [
        {
          severity: "P2",
          id: "visual-render-failed",
          message: "Visual QA could not render the final artifact in headless Chrome.",
          fix: "Open the preview and check for script errors, blocked local assets, or markup that prevents first paint.",
        },
      ],
      consoleMessages,
      elements,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function spawnAgentText(command: string, args: string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = agentSpawnEnv(extraEnv);
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env, shell: process.platform === "win32" });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("agent visual review timed out"));
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
  return wasReviewed(second) || second.length > first.length ? second : first;
}

export async function reviewScreenshotWithAgent(input: VisualQaInput, screenshotPath: string): Promise<QualityFinding[]> {
  if (!input.settings.visualQaEnabled) return [];
  if (!existsSync(screenshotPath)) {
    return withScreenshotReviewMetadata(
      [
        {
          severity: "P2",
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
      parseVisualReview(await spawnAgentText(command, args, projectDir, 120_000, buildAgentEnv(input.settings, command))),
    );
    return withScreenshotReviewMetadata(findings, input, screenshotPath);
  } catch (err) {
    return withScreenshotReviewMetadata(
      [
        {
          severity: "P2",
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

export async function auditVisualArtifact(input: VisualQaInput): Promise<QualityFinding[]> {
  if (!input.settings.visualQaEnabled) return [];
  if (!existsSync(input.htmlPath)) {
    return [
      {
        severity: "P2",
        id: "visual-artifact-missing",
        message: "Visual QA could not run because the final artifact file is missing.",
        fix: "Rerun generation and confirm the selected Agent writes the expected project files.",
      },
    ];
  }
  const projectDir = input.projectRoot ?? dirname(input.htmlPath);
  const screenshotPath = input.screenshotPath ?? join(projectDir, ".visual-qa", "screenshot.png");
  const geometry = await collectGeometry(input.htmlPath, screenshotPath, input.renderUrl);
  const ai = await reviewScreenshotWithAgent({ ...input, consoleMessages: geometry.consoleMessages, criticElements: geometry.elements }, screenshotPath);
  return [...geometry.findings, ...ai];
}
