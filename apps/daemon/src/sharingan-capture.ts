import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SharinganSession, VIEWPORTS } from "./sharingan-browser.ts";

export interface CaptureStep { at: number; kind: "navigate" | "screenshot" | "dom" | "styles" | "links" | "login-required" | "done"; text: string }
export interface CapturedPage { url: string; title: string; screenshots: Record<string, string>; dom: string; styles: string }

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|account)(\/|\?|$)/i;

export function detectLoginWall(input: { status: number; finalUrl: string; hasPasswordField: boolean; textLength: number }): boolean {
  if (input.status === 401 || input.status === 403) return true;
  if (LOGIN_URL_RE.test(input.finalUrl)) return true;
  if (input.hasPasswordField && input.textLength < 80) return true;
  return false;
}

function pageDir(url: string): string {
  // NOTE (Phase 4): this slug is not collision-safe — two distinct URLs can collapse to the
  // same dir after stripping non-alphanumerics and truncating to 60 chars. Harmless in Phase 1
  // (single entry-page capture); add a short URL-hash suffix when multi-page probing lands.
  const slug = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
  return slug;
}

export async function capturePage(
  session: SharinganSession,
  projectDir: string,
  url: string,
  onStep: (s: CaptureStep) => void,
): Promise<{ page: CapturedPage | null; loginRequired: boolean }> {
  const step = (kind: CaptureStep["kind"], text: string) => onStep({ at: Date.now(), kind, text });

  step("navigate", `Navigating to ${url}`);
  const nav = await session.navigate(url);

  const dom = await session.readDom(400);
  const hasPasswordField = await session.hasPasswordField();
  const textLength = dom.reduce((a, n) => a + n.text.length, 0);

  if (detectLoginWall({ status: nav.status, finalUrl: nav.finalUrl, hasPasswordField, textLength })) {
    step("login-required", `This page needs a login (${nav.finalUrl}). Sign in, then continue.`);
    return { page: null, loginRequired: true };
  }

  const rel = join(".sharingan", pageDir(url));
  mkdirSync(join(projectDir, rel), { recursive: true });

  const screenshots: Record<string, string> = {};
  for (const v of VIEWPORTS) {
    await session.setViewport(v);
    step("screenshot", `Capturing ${v.label} (${v.width}px)`);
    const shot = await session.screenshot({ fullPage: true });
    const shotRel = join(rel, `shot-${v.label}.png`);
    writeFileSync(join(projectDir, shotRel), shot);
    screenshots[v.label] = shotRel;
  }

  step("dom", "Reading DOM structure");
  const domRel = join(rel, "dom.json");
  writeFileSync(join(projectDir, domRel), JSON.stringify(dom, null, 0));

  step("styles", "Reading computed style tokens");
  const styleRel = join(rel, "styles.json");
  writeFileSync(join(projectDir, styleRel), JSON.stringify(await session.styleTokens(), null, 0));

  step("links", "Discovering same-origin links");
  await session.discoverLinks();

  const title = (dom.find((n) => n.tag === "h1")?.text || url).slice(0, 80);
  step("done", "Capture complete");
  return { page: { url, title, screenshots, dom: domRel, styles: styleRel }, loginRequired: false };
}
