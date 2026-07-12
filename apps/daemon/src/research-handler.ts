/**
 * GET /api/projects/:id/research — the .research/ deliverables for the workspace's
 * Research tab: the synthesized report (markdown), machine-readable sources, the
 * candidate directions, and the collected asset filenames. Returns { exists: false }
 * when the active variant has no research yet, so the client can hide the tab.
 *
 * Also includes a `visual` section — the parallel visual-research track's report/
 * sources/assets + the synced moodboard's boardId (see visual-research-moodboard.ts).
 * Its `exists` is independent of product research, since the two tracks can finish at
 * different times. Top-level `exists` means that at least one track has durable output.
 *
 * Asset images are served (publicRead, traversal-safe) via the generic project-file
 * route at /api/projects/:id/research/assets/*rest (product) and
 * /api/projects/:id/research/visual/assets/*rest (visual) — see app.ts.
 */

import type { ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import type { AppDeps } from "./app.ts";
import { sendJson, sendError } from "./http-util.ts";
import { activeArtifactDir } from "./variant-workspaces.ts";
import {
  researchDir, researchExists, readReport, readSources, listDirections, listAssets, readChosenDirection, directionTitle,
  visualResearchExists, readVisualReport, readVisualSources, listVisualAssets, readVisualMoodboardId, validateResearchBundle,
} from "../../../packages/research/src/index.ts";

export async function handleGetResearch(res: ServerResponse, params: Record<string, string | undefined>, deps: AppDeps): Promise<void> {
  const project = deps.store.getProject(params.id ?? "");
  if (!project) return sendError(res, 404, "project not found");

  let dir: string;
  try {
    dir = await activeArtifactDir(deps, project);
  } catch {
    return sendJson(res, 200, { exists: false });
  }
  const productExists = researchExists(dir);
  const visualExists = visualResearchExists(dir);
  const partialBundleExists = existsSync(researchDir(dir));
  if (!partialBundleExists && !productExists && !visualExists) return sendJson(res, 200, { exists: false });

  const [report, sources, directions, assets, chosenSlug, validation] = await Promise.all([
    readReport(dir),
    readSources(dir).catch(() => []),
    listDirections(dir).catch(() => []),
    listAssets(dir).catch(() => []),
    readChosenDirection(dir).catch(() => null),
    validateResearchBundle(dir),
  ]);
  const [visualReport, visualSources, visualAssets, visualBoardId] = await Promise.all([
    readVisualReport(dir),
    readVisualSources(dir).catch(() => []),
    listVisualAssets(dir).catch(() => []),
    readVisualMoodboardId(dir).catch(() => null),
  ]);
  return sendJson(res, 200, {
    exists: true,
    complete: validation.complete,
    issues: validation.issues,
    report: report ?? "",
    sources,
    directions: directions.map((d) => ({ slug: d.slug, title: directionTitle(d.markdown), markdown: d.markdown })),
    assets,
    ...(chosenSlug ? { chosenSlug } : {}),
    visual: {
      exists: visualExists,
      report: visualReport ?? "",
      sources: visualSources,
      assets: visualAssets,
      ...(visualBoardId ? { boardId: visualBoardId } : {}),
    },
  });
}
