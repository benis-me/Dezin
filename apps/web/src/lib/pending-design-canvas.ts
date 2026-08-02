export interface PendingDesignCanvasContext {
  kind: "project-version";
  title: string;
  sourceProjectId: string;
  sourceNodeId: string;
  sourceVersionId: string;
}

export interface PendingDesignCanvasIntent {
  projectId: string;
  prompt: string;
  agentCommand?: string;
  model?: string;
  context: PendingDesignCanvasContext[];
}

const PREFIX = "dezin.design-canvas.intent.";
const PROGRESS_SUFFIX = ".progress";
const memory = new Map<string, PendingDesignCanvasIntent>();
const progressMemory = new Map<string, number[]>();
const inFlight = new Map<string, string>();

export interface PendingDesignCanvasClaim {
  projectId: string;
  token: string;
  intent: PendingDesignCanvasIntent;
  completedContextIndexes: number[];
}

function key(projectId: string): string {
  return `${PREFIX}${projectId}`;
}

function progressKey(projectId: string): string {
  return `${key(projectId)}${PROGRESS_SUFFIX}`;
}

function exactIntent(value: unknown, projectId: string): PendingDesignCanvasIntent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<PendingDesignCanvasIntent>;
  if (input.projectId !== projectId || typeof input.prompt !== "string" || !Array.isArray(input.context)) return null;
  const context = input.context.filter((item): item is PendingDesignCanvasContext => {
    if (item === null || typeof item !== "object") return false;
    return item.kind === "project-version"
      && typeof item.title === "string"
      && typeof item.sourceProjectId === "string"
      && typeof item.sourceNodeId === "string"
      && typeof item.sourceVersionId === "string";
  });
  if (context.length !== input.context.length) return null;
  return {
    projectId,
    prompt: input.prompt,
    ...(typeof input.agentCommand === "string" && input.agentCommand ? { agentCommand: input.agentCommand } : {}),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    context,
  };
}

export function setPendingDesignCanvasIntent(intent: PendingDesignCanvasIntent): boolean {
  memory.set(intent.projectId, intent);
  progressMemory.delete(intent.projectId);
  inFlight.delete(intent.projectId);
  try {
    sessionStorage.setItem(key(intent.projectId), JSON.stringify(intent));
    sessionStorage.removeItem(progressKey(intent.projectId));
    return true;
  } catch {
    // The in-memory handoff still covers the immediate route transition.
    return true;
  }
}

export function peekPendingDesignCanvasIntent(projectId: string): PendingDesignCanvasIntent | null {
  const inMemory = memory.get(projectId) ?? null;
  let persisted: PendingDesignCanvasIntent | null = null;
  try {
    const raw = sessionStorage.getItem(key(projectId));
    persisted = raw === null ? null : exactIntent(JSON.parse(raw), projectId);
    if (raw !== null && persisted === null) {
      sessionStorage.removeItem(key(projectId));
      sessionStorage.removeItem(progressKey(projectId));
    }
  } catch {
    persisted = null;
    try {
      sessionStorage.removeItem(key(projectId));
      sessionStorage.removeItem(progressKey(projectId));
    } catch {
      // Storage can be unavailable; the in-memory handoff remains authoritative.
    }
  }
  return inMemory ?? persisted;
}

export function claimPendingDesignCanvasIntent(projectId: string): PendingDesignCanvasClaim | null {
  if (inFlight.has(projectId)) return null;
  const intent = peekPendingDesignCanvasIntent(projectId);
  if (!intent) return null;
  const token = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  inFlight.set(projectId, token);
  return {
    projectId,
    token,
    intent,
    completedContextIndexes: readProgress(projectId, intent.context.length),
  };
}

export function markPendingDesignCanvasContextComplete(
  claim: PendingDesignCanvasClaim,
  contextIndex: number,
): boolean {
  if (inFlight.get(claim.projectId) !== claim.token) return false;
  if (!Number.isInteger(contextIndex) || contextIndex < 0 || contextIndex >= claim.intent.context.length) return false;
  const indexes = [...new Set([...readProgress(claim.projectId, claim.intent.context.length), contextIndex])]
    .sort((left, right) => left - right);
  progressMemory.set(claim.projectId, indexes);
  try {
    sessionStorage.setItem(progressKey(claim.projectId), JSON.stringify(indexes));
  } catch {
    // In-memory progress still prevents duplicate imports during this session.
  }
  return true;
}

export function completePendingDesignCanvasIntent(claim: PendingDesignCanvasClaim): boolean {
  if (inFlight.get(claim.projectId) !== claim.token) return false;
  discardPendingDesignCanvasIntent(claim.projectId);
  return true;
}

export function releasePendingDesignCanvasIntent(claim: PendingDesignCanvasClaim): boolean {
  if (inFlight.get(claim.projectId) !== claim.token) return false;
  inFlight.delete(claim.projectId);
  return true;
}

export function discardPendingDesignCanvasIntent(projectId: string): void {
  memory.delete(projectId);
  progressMemory.delete(projectId);
  inFlight.delete(projectId);
  try {
    sessionStorage.removeItem(key(projectId));
    sessionStorage.removeItem(progressKey(projectId));
  } catch {
    // Best-effort route handoff cleanup.
  }
}

function readProgress(projectId: string, contextCount: number): number[] {
  const inMemory = progressMemory.get(projectId);
  if (inMemory) return [...inMemory];
  try {
    const raw = sessionStorage.getItem(progressKey(projectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const indexes = [...new Set(parsed.filter((value): value is number => (
      Number.isInteger(value) && value >= 0 && value < contextCount
    )))].sort((left, right) => left - right);
    progressMemory.set(projectId, indexes);
    return [...indexes];
  } catch {
    return [];
  }
}
