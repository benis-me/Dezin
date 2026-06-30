import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { runTurnWithRetry } from "../../../packages/agent/src/index.ts";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import { buildRunner } from "./run-handler.ts";
import type { AppDeps } from "./app.ts";
import type { IncomingMessage } from "node:http";

export interface TitleInput {
  projectId: string;
  brief: string;
  currentName: string;
}

export type TitleGenerator = (input: TitleInput, deps: AppDeps) => Promise<string | null>;

function cleanTitle(value: string): string | null {
  const title = value
    .split("\n")
    .map((line) => line.replace(/^(title|project title)\s*:\s*/i, "").trim())
    .find(Boolean)
    ?.replace(/^["'`]+|["'`.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;
  return title.length > 48 ? title.slice(0, 48).trim() : title;
}

export async function generateProjectTitle(input: TitleInput, deps: AppDeps): Promise<string | null> {
  const settings = deps.store.getSettings();
  const runner = buildRunner(settings);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  const dir = await mkdtemp(join(tmpdir(), "dezin-title-"));
  try {
    const result = await runTurnWithRetry(
      runner,
      {
        projectDir: dir,
        signal: ctrl.signal,
        systemPrompt:
          "You name Dezin projects. Return only a concise, specific project title, 2 to 5 words. No quotes. No punctuation at the end.",
        message: `Brief:\n${input.brief}\n\nTemporary title:\n${input.currentName}`,
      },
      { maxAttempts: 1 },
    );
    return cleanTitle(result.text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function handleGenerateProjectTitle(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const project = deps.store.getProject(params.id!);
  if (!project) return sendError(res, 404, "project not found");
  const body = (await readJsonBody(req).catch(() => ({}))) as { brief?: unknown };
  const brief = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : project.name;
  const generated = await (deps.titleGenerator ?? generateProjectTitle)({ projectId: project.id, brief, currentName: project.name }, deps);
  const title = generated?.trim();
  const next = title && title !== project.name ? deps.store.updateProject(project.id, { name: title }) : project;
  sendJson(res, 200, next);
}
