import type { RunSummary, Variant } from "../lib/api.ts";

export const UNASSIGNED_VARIANT_ID = "__unassigned__";

export interface VersionGroup {
  id: string;
  name: string;
  active: boolean;
  runs: RunSummary[];
}

export function activeVariantIdOf(variants: Variant[]): string | null {
  return variants.find((variant) => variant.active)?.id ?? variants[0]?.id ?? null;
}

export function buildVersionGroups(runs: RunSummary[], variants: Variant[]): VersionGroup[] {
  const fallbackVariantId = activeVariantIdOf(variants) ?? UNASSIGNED_VARIANT_ID;
  const byVariant = new Map<string, RunSummary[]>();
  for (const run of sortRunsNewestFirst(runs)) {
    const variantId = run.variantId ?? fallbackVariantId;
    const groupRuns = byVariant.get(variantId);
    if (groupRuns) groupRuns.push(run);
    else byVariant.set(variantId, [run]);
  }

  const known = new Set<string>();
  const groups = variants.map((variant) => {
    known.add(variant.id);
    return { id: variant.id, name: variant.name, active: !!variant.active, runs: byVariant.get(variant.id) ?? [] };
  });
  for (const [id, groupRuns] of byVariant) {
    if (!known.has(id)) {
      groups.push({ id, name: id === UNASSIGNED_VARIANT_ID ? "Unassigned" : "Archived branch", active: false, runs: groupRuns });
    }
  }

  return groups.filter((group) => group.runs.length > 0 || group.active || variants.length > 1);
}

export function versionLabel(group: VersionGroup, index: number): string {
  return `v${group.runs.length - index}`;
}

export function findVersionSelection(
  groups: VersionGroup[],
  runId: string | null,
): { group: VersionGroup; run: RunSummary; label: string } | null {
  if (!runId) return null;
  for (const group of groups) {
    const index = group.runs.findIndex((run) => run.id === runId);
    if (index >= 0) return { group, run: group.runs[index]!, label: versionLabel(group, index) };
  }
  return null;
}

export function sortRunsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => {
    const created = b.createdAt - a.createdAt;
    if (created !== 0) return created;
    return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
  });
}

export function cacheBustPreviewUrl(url: string, t = Date.now()): string {
  return `${url.split("?")[0]}?t=${t}`;
}

export function isVersionPreviewSrc(projectId: string, src: string | null): boolean {
  return !!src && src.includes(`/api/projects/${projectId}/versions/`);
}
