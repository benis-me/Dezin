/**
 * A tiny module-level handoff for the initial brief: HomeScreen creates a project
 * and navigates to its workspace; the workspace picks up the brief on mount and
 * kicks off the first run. Keeps the flow simple without query params or a store.
 */

let pending: string | null = null;

export function setPendingBrief(brief: string): void {
  pending = brief;
}

export function takePendingBrief(): string | null {
  const b = pending;
  pending = null;
  return b;
}

/** Reference images (e.g. a dropped screenshot) handed to the new project's first run. */
export interface PendingImage {
  name: string;
  /** base64 (no data: prefix). */
  base64: string;
}

let pendingImages: PendingImage[] = [];

export function setPendingImages(images: PendingImage[]): void {
  pendingImages = images;
}

export function takePendingImages(): PendingImage[] {
  const i = pendingImages;
  pendingImages = [];
  return i;
}

/** Agent + model chosen on the home composer, used for the new project's first run. */
let pendingAgent: string | null = null;
let pendingModel: string | null = null;

export function setPendingAgent(command: string, model?: string): void {
  pendingAgent = command;
  pendingModel = model ?? null;
}

export function takePendingAgent(): string | null {
  const a = pendingAgent;
  pendingAgent = null;
  return a;
}

export function takePendingModel(): string | null {
  const m = pendingModel;
  pendingModel = null;
  return m;
}

export interface PendingDesignWorkspaceTurn {
  projectId: string;
  brief: string;
  agentCommand?: string;
  model?: string;
}

const PENDING_DESIGN_WORKSPACE_TURN_KEY = "dezin.pending.design-workspace-turn";
let pendingDesignWorkspaceTurn: PendingDesignWorkspaceTurn | null = null;

function storedPendingDesignWorkspaceTurn(): PendingDesignWorkspaceTurn | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_DESIGN_WORKSPACE_TURN_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.projectId !== "string" || typeof value.brief !== "string") return null;
    if (value.agentCommand !== undefined && typeof value.agentCommand !== "string") return null;
    if (value.model !== undefined && typeof value.model !== "string") return null;
    return {
      projectId: value.projectId,
      brief: value.brief,
      ...(typeof value.agentCommand === "string" ? { agentCommand: value.agentCommand } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Project-scoped one-shot handoff for a newly created Standard workspace.
 * Binding the payload after project creation prevents failed creates or unrelated
 * project navigation from inheriting another composer's Agent selection.
 */
export function setPendingDesignWorkspaceTurn(value: PendingDesignWorkspaceTurn): void {
  pendingDesignWorkspaceTurn = value;
  try {
    localStorage.setItem(PENDING_DESIGN_WORKSPACE_TURN_KEY, JSON.stringify(value));
  } catch {
    /* localStorage may be unavailable */
  }
}

export function takePendingDesignWorkspaceTurn(projectId: string): PendingDesignWorkspaceTurn | null {
  const value = pendingDesignWorkspaceTurn ?? storedPendingDesignWorkspaceTurn();
  if (value?.projectId !== projectId) return null;
  pendingDesignWorkspaceTurn = null;
  try {
    localStorage.removeItem(PENDING_DESIGN_WORKSPACE_TURN_KEY);
  } catch {
    /* localStorage may be unavailable */
  }
  return value;
}

/** Other projects referenced on the home composer — their artifact is uploaded as a
 *  read-only reference on the new project's first run so the agent reads the real design. */
export interface PendingRef {
  /** Source project name, used to label the uploaded reference file. */
  name: string;
  /** index.html of the referenced project, base64 (no data: prefix). */
  base64: string;
}

let pendingRefs: PendingRef[] = [];

export function setPendingRefs(refs: PendingRef[]): void {
  pendingRefs = refs;
}

export function takePendingRefs(): PendingRef[] {
  const r = pendingRefs;
  pendingRefs = [];
  return r;
}
