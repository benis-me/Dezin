import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import type { QualityFinding, Settings } from "../../../packages/core/src/index.ts";
import { getProvider } from "../../../packages/agent/src/index.ts";
import { findChrome } from "./capture-cover.ts";

export interface VisualQaInput {
  htmlPath: string;
  settings: Settings;
  screenshotPath?: string;
  agentCommand?: string;
  model?: string;
  brief?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export type VisualQaRunner = (input: VisualQaInput) => Promise<QualityFinding[]>;

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

function agentReviewPrompt(input: VisualQaInput, screenshotPath: string): string {
  const projectDir = dirname(input.htmlPath);
  const artifactRel = toRel(projectDir, input.htmlPath);
  const screenshotRel = toRel(projectDir, screenshotPath);
  const brief = input.brief?.trim();
  const history = (input.conversationHistory ?? [])
    .map((m, index) => `[${index + 1}] ${m.role.toUpperCase()}:\n${m.content.trim()}`)
    .filter((line) => line.length > 12)
    .join("\n\n");
  return [
    "You are reviewing the latest rendered result for the current Dezin conversation.",
    `Rendered screenshot: ${screenshotRel}`,
    `Final artifact: ${artifactRel}`,
    history ? `Current conversation context:\n${history}` : "",
    brief ? `Current user request:\nUSER: ${brief}` : "",
    "Use the screenshot as the primary evidence. Use the conversation context to judge whether the visual result matches the user's intent.",
    "You may read the artifact and assets in this project directory for extra context, but do not create, edit, or write files.",
    'Return JSON only with this exact shape: {"findings":[{"severity":"P0|P1|P2","message":"...","fix":"...","snippet":"optional"}]}.',
    "Check only visible layout defects: overlap, clipping, offscreen controls/popovers, blank or hidden content, broken spacing, unreadable text, and obvious alignment problems.",
    'Ignore subjective style preferences. Use at most 5 findings. If the screenshot is visually clean, return {"findings":[]}.',
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

export function parseVisualReview(text: string): QualityFinding[] {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(text);
  } catch {
    return [];
  }
  const findings = (parsed as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) return [];
  const normalized: QualityFinding[] = [];
  for (const item of findings) {
    const f = item as { severity?: unknown; message?: unknown; fix?: unknown; snippet?: unknown };
    if (!isSeverity(f.severity) || typeof f.message !== "string") continue;
    normalized.push({
      severity: f.severity,
      id: `visual-ai-review-${normalized.length + 1}`,
      message: f.message,
      fix: typeof f.fix === "string" && f.fix ? f.fix : "Adjust the layout and visual hierarchy in the screenshot.",
      snippet: typeof f.snippet === "string" ? f.snippet : undefined,
    });
    if (normalized.length >= 5) break;
  }
  return normalized;
}

async function collectGeometry(htmlPath: string, screenshotPath?: string): Promise<QualityFinding[]> {
  const executablePath = findChrome();
  if (!executablePath) return [];
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
    const all: QualityFinding[] = [];
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded", timeout: 10000 });
      await new Promise((r) => setTimeout(r, 400));
      const snapshot = await page.evaluate(() => {
        const win = globalThis as any;
        const doc = win.document;
        const escapeCss = (value: string) => {
          const css = win.CSS as { escape?: (input: string) => string } | undefined;
          return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        };
        const selectorFor = (el: any): string => {
          const id = el.getAttribute("id");
          if (id) return `#${escapeCss(id)}`;
          const od = el.getAttribute("data-od-id");
          if (od) return `[data-od-id="${od.replace(/"/g, '\\"')}"]`;
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
      });
      all.push(...findingsFromGeometry(snapshot as GeometrySnapshot, viewport.label));
      if (viewport.label === "desktop" && screenshotPath) {
        await mkdir(dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath as `${string}.png`, type: "png", clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } });
      }
      await page.close().catch(() => {});
    }
    const seen = new Set<string>();
    return all.filter((finding) => {
      if (seen.has(finding.id)) return false;
      seen.add(finding.id);
      return true;
    });
  } catch {
    return [
      {
        severity: "P2",
        id: "visual-render-failed",
        message: "Visual QA could not render the final artifact in headless Chrome.",
        fix: "Open the preview and check for script errors, blocked local assets, or markup that prevents first paint.",
      },
    ];
  } finally {
    await browser?.close().catch(() => {});
  }
}

function spawnAgentText(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      IMPECCABLE_HOOK_DISABLED: "1",
      IMPECCABLE_HOOK_QUIET: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
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

export async function reviewScreenshotWithAgent(input: VisualQaInput, screenshotPath: string): Promise<QualityFinding[]> {
  if (!input.settings.visualQaEnabled || !existsSync(screenshotPath)) return [];
  const projectDir = dirname(input.htmlPath);
  const command = input.agentCommand || input.settings.agentCommand || "claude";
  const provider = getProvider(command);
  const model = input.model || input.settings.model || undefined;
  const prompt = agentReviewPrompt(input, screenshotPath);
  const args = provider ? provider.oneShotArgs(model, prompt) : ["-p", prompt];
  try {
    const out = await spawnAgentText(command, args, projectDir, 120_000);
    return parseVisualReview(out);
  } catch (err) {
    return [
      {
        severity: "P2",
        id: "visual-agent-review-failed",
        message: `Agent visual review failed: ${err instanceof Error ? err.message : "request error"}.`,
        fix: "Check that the selected Agent can read the generated screenshot and project files, or disable Visual QA in Settings.",
      },
    ];
  }
}

export async function auditVisualArtifact(input: VisualQaInput): Promise<QualityFinding[]> {
  if (!existsSync(input.htmlPath)) return [];
  const screenshotPath = input.screenshotPath ?? join(dirname(input.htmlPath), ".visual-qa", "screenshot.png");
  const geometry = await collectGeometry(input.htmlPath, screenshotPath);
  const ai = await reviewScreenshotWithAgent(input, screenshotPath);
  return [...geometry, ...ai];
}
