import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { runTurnWithRetry } from "../../../packages/agent/src/index.ts";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import { buildAgentRunner } from "./agent-runner.ts";
import type { AppDeps } from "./app.ts";
import type { IncomingMessage } from "node:http";
import { designProjectPayload, getDesignProject, updateDesignProject } from "./design/design-project-store.ts";
import { projectDir } from "./serve-static.ts";

export interface TitleInput {
  projectId: string;
  brief: string;
  currentName: string;
  agentCommand?: string;
  model?: string;
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
  const runner = buildAgentRunner(settings, {
    agentCommand: input.agentCommand,
    model: input.model,
  });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  const dir = await mkdtemp(join(tmpdir(), "dezin-title-"));
  try {
    await writeFile(join(dir, "index.html"), "<!doctype html><title>Dezin project</title>");
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
  const design = await getDesignProject(deps.dataDir, params.id!);
  const sharingan = design ? null : deps.store.getProject(params.id!);
  if (!design && sharingan?.sharingan !== true) return sendError(res, 404, "project not found");
  const project = design ?? sharingan!;
  const projectId = design ? design.projectId : sharingan!.id;
  const body = (await readJsonBody(req).catch(() => ({}))) as {
    brief?: unknown;
    agentCommand?: unknown;
    model?: unknown;
  };
  const brief = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : project.name;
  const agentCommand = typeof body.agentCommand === "string" && body.agentCommand.trim()
    ? body.agentCommand.trim()
    : undefined;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  const generated = await (deps.titleGenerator ?? generateProjectTitle)({
    projectId,
    brief,
    currentName: project.name,
    ...(agentCommand ? { agentCommand } : {}),
    ...(model ? { model } : {}),
  }, deps);
  const title = generated?.trim();
  if (design) {
    const next = title && title !== design.name
      ? await updateDesignProject(deps.dataDir, design.projectId, { name: title })
      : design;
    return sendJson(res, 200, designProjectPayload(deps.dataDir, next));
  }
  const next = title && title !== sharingan!.name
    ? deps.store.updateProject(sharingan!.id, { name: title })
    : sharingan!;
  const { mode: _mode, ...visible } = next;
  sendJson(res, 200, { ...visible, projectPath: projectDir(deps.dataDir, next.id) });
}
