import type { IncomingMessage, ServerResponse } from "node:http";
import { BUILT_IN_EFFECTS, createCustomEffectScaffold, getBuiltInEffect, normalizeEffectQuery, type EffectDefinition } from "../../../packages/effects/src/index.ts";
import type { Effect as CustomEffect, EffectParamDefinition, EffectPreset } from "../../../packages/core/src/index.ts";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import type { AppDeps } from "./app.ts";

type EffectCard = Pick<EffectDefinition, "id" | "name" | "origin" | "category" | "summary" | "previewUrl">;

function asEffectDefinition(effect: CustomEffect): EffectDefinition {
  return {
    id: effect.id,
    name: effect.name,
    origin: "custom",
    category: effect.category,
    summary: effect.summary,
    parameters: effect.parameters,
    presets: effect.presets,
    code: effect.code,
    createdAt: effect.createdAt,
    updatedAt: effect.updatedAt,
  };
}

function asCard(effect: EffectDefinition): EffectCard {
  return { id: effect.id, name: effect.name, origin: effect.origin, category: effect.category, summary: effect.summary, previewUrl: effect.previewUrl };
}

function matchesQuery(effect: EffectCard, query: string): boolean {
  if (!query) return true;
  const haystack = normalizeEffectQuery([effect.name, effect.category, effect.summary, effect.id].join(" "));
  return haystack.includes(query);
}

function allEffects(deps: AppDeps): EffectDefinition[] {
  return [...BUILT_IN_EFFECTS, ...deps.store.listEffects().map(asEffectDefinition)];
}

export function handleListEffects(req: IncomingMessage, res: ServerResponse, deps: AppDeps): void {
  const query = normalizeEffectQuery(new URL(req.url ?? "", "http://localhost").searchParams.get("query") ?? "");
  sendJson(
    res,
    200,
    allEffects(deps)
      .map(asCard)
      .filter((effect) => matchesQuery(effect, query)),
  );
}

export function handleGetEffect(res: ServerResponse, params: Record<string, string>, deps: AppDeps): void {
  const id = params.id ?? "";
  const effect = getBuiltInEffect(id) ?? deps.store.getEffect(id);
  if (!effect) return sendError(res, 404, "effect not found");
  sendJson(res, 200, effect);
}

export async function handleCreateEffect(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const body = (await readJsonBody(req)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return sendError(res, 400, "name is required");
  const scaffold = createCustomEffectScaffold(name);
  sendJson(res, 201, deps.store.createEffect(scaffold));
}

export async function handleUpdateEffect(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, deps: AppDeps): Promise<void> {
  const id = params.id ?? "";
  if (getBuiltInEffect(id)) return sendError(res, 409, "built-in effects cannot be edited");
  if (!deps.store.getEffect(id)) return sendError(res, 404, "effect not found");
  const body = (await readJsonBody(req)) as {
    name?: unknown;
    category?: unknown;
    summary?: unknown;
    code?: unknown;
    parameters?: unknown;
    presets?: unknown;
  } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return sendError(res, 400, "effect body must be an object");
  sendJson(
    res,
    200,
    deps.store.updateEffect(id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.category === "string" ? { category: body.category } : {}),
      ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
      ...(typeof body.code === "string" ? { code: body.code } : {}),
      ...(Array.isArray(body.parameters) ? { parameters: body.parameters as EffectParamDefinition[] } : {}),
      ...(Array.isArray(body.presets) ? { presets: body.presets as EffectPreset[] } : {}),
    }),
  );
}
