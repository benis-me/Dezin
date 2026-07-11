import type { ApiClient, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";

interface SaveSubscriber {
  onPending?: (inputs: SaveMoodboardNodeInput[]) => void;
  onSaved?: (nodes: MoodboardNode[]) => void;
  onError?: () => void;
}

interface BoardSaveState {
  confirmedInputs: SaveMoodboardNodeInput[];
  latestInputs: SaveMoodboardNodeInput[] | null;
  version: number;
  pending: boolean;
  timer: number | null;
  inFlight: Promise<boolean> | null;
  inFlightVersion: number | null;
  retryCount: number;
  detachedRetryBudget: number;
  activeServerMutations: number;
  subscribers: Set<SaveSubscriber>;
}

export interface MoodboardServerMutation {
  readonly boardId: string;
  readonly baselineInputs: SaveMoodboardNodeInput[];
  release(): void;
}

function cloneInputs(inputs: SaveMoodboardNodeInput[]): SaveMoodboardNodeInput[] {
  return inputs.map((input) => ({ ...input, data: input.data ? { ...input.data } : {} }));
}

function nodeInputs(nodes: MoodboardNode[]): SaveMoodboardNodeInput[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    zIndex: node.zIndex,
    data: { ...node.data },
  }));
}

function sameInput(left: SaveMoodboardNodeInput, right: SaveMoodboardNodeInput): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    (left.rotation ?? 0) === (right.rotation ?? 0) &&
    (left.zIndex ?? 0) === (right.zIndex ?? 0) &&
    JSON.stringify(left.data ?? {}) === JSON.stringify(right.data ?? {})
  );
}

function sameInputs(left: SaveMoodboardNodeInput[], right: SaveMoodboardNodeInput[]): boolean {
  return left.length === right.length && left.every((input, index) => sameInput(input, right[index]!));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeData(
  baseline: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined,
  server: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const baselineData = baseline ?? {};
  const localData = local ?? {};
  const merged = { ...(server ?? {}) };
  for (const key of new Set([...Object.keys(baselineData), ...Object.keys(localData)])) {
    const baselineHasKey = Object.hasOwn(baselineData, key);
    const localHasKey = Object.hasOwn(localData, key);
    if (baselineHasKey && !localHasKey) {
      delete merged[key];
      continue;
    }
    if (localHasKey && (!baselineHasKey || !sameValue(localData[key], baselineData[key]))) {
      merged[key] = localData[key];
    }
  }
  return merged;
}

function mergeChangedFields(
  baseline: SaveMoodboardNodeInput,
  local: SaveMoodboardNodeInput,
  server: SaveMoodboardNodeInput,
): SaveMoodboardNodeInput {
  const changed = (key: keyof SaveMoodboardNodeInput): boolean => {
    const normalize = (input: SaveMoodboardNodeInput): unknown =>
      key === "rotation" || key === "zIndex" ? input[key] ?? 0 : input[key];
    return !sameValue(normalize(local), normalize(baseline));
  };
  return {
    id: server.id ?? local.id,
    type: changed("type") ? local.type : server.type,
    x: changed("x") ? local.x : server.x,
    y: changed("y") ? local.y : server.y,
    width: changed("width") ? local.width : server.width,
    height: changed("height") ? local.height : server.height,
    rotation: changed("rotation") ? local.rotation : server.rotation,
    zIndex: changed("zIndex") ? local.zIndex : server.zIndex,
    data: mergeData(baseline.data, local.data, server.data),
  };
}

function mergeServerWithLocalChanges(
  baselineInputs: SaveMoodboardNodeInput[],
  localInputs: SaveMoodboardNodeInput[],
  serverInputs: SaveMoodboardNodeInput[],
): SaveMoodboardNodeInput[] {
  const baselineById = new Map(baselineInputs.flatMap((input) => (input.id ? [[input.id, input] as const] : [])));
  const localById = new Map(localInputs.flatMap((input) => (input.id ? [[input.id, input] as const] : [])));
  const serverIds = new Set(serverInputs.flatMap((input) => (input.id ? [input.id] : [])));
  const merged = serverInputs.flatMap((server): SaveMoodboardNodeInput[] => {
    if (!server.id) return [server];
    const baseline = baselineById.get(server.id);
    const local = localById.get(server.id);
    if (baseline && !local) return [];
    if (!local) return [server];
    if (!baseline) return [local];
    return [mergeChangedFields(baseline, local, server)];
  });

  for (const local of localInputs) {
    if (!local.id) {
      merged.push(local);
      continue;
    }
    if (serverIds.has(local.id)) continue;
    const baseline = baselineById.get(local.id);
    if (!baseline || !sameInput(baseline, local)) merged.push(local);
  }
  return merged;
}

export class MoodboardSaveCoordinator {
  private readonly states = new Map<string, BoardSaveState>();

  constructor(private readonly api: ApiClient) {}

  private state(boardId: string): BoardSaveState {
    let state = this.states.get(boardId);
    if (!state) {
      state = {
        confirmedInputs: [],
        latestInputs: null,
        version: 0,
        pending: false,
        timer: null,
        inFlight: null,
        inFlightVersion: null,
        retryCount: 0,
        detachedRetryBudget: 0,
        activeServerMutations: 0,
        subscribers: new Set(),
      };
      this.states.set(boardId, state);
    }
    return state;
  }

  hydrate(boardId: string, serverNodes: MoodboardNode[]): SaveMoodboardNodeInput[] {
    const state = this.state(boardId);
    state.confirmedInputs = nodeInputs(serverNodes);
    if (!state.pending || !state.latestInputs) state.latestInputs = cloneInputs(state.confirmedInputs);
    return cloneInputs(state.latestInputs);
  }

  beginServerMutation(boardId: string): MoodboardServerMutation {
    const state = this.state(boardId);
    state.activeServerMutations += 1;
    let released = false;
    return {
      boardId,
      baselineInputs: cloneInputs(state.latestInputs ?? state.confirmedInputs),
      release: () => {
        if (released) return;
        released = true;
        state.activeServerMutations = Math.max(0, state.activeServerMutations - 1);
        this.releaseIfIdle(boardId, state);
      },
    };
  }

  reconcileServerNodes(
    boardId: string,
    serverNodes: MoodboardNode[],
    mutation?: MoodboardServerMutation,
  ): SaveMoodboardNodeInput[] {
    const state = this.state(boardId);
    const serverInputs = nodeInputs(serverNodes);
    const baselineInputs = mutation?.boardId === boardId ? mutation.baselineInputs : state.confirmedInputs;
    const localInputs = state.latestInputs ?? state.confirmedInputs;
    const merged = mergeServerWithLocalChanges(baselineInputs, localInputs, serverInputs);
    state.confirmedInputs = cloneInputs(serverInputs);
    if (state.pending || !sameInputs(merged, serverInputs)) this.queue(boardId, merged, 0);
    else state.latestInputs = cloneInputs(serverInputs);
    return cloneInputs(merged);
  }

  latest(boardId: string, fallback: SaveMoodboardNodeInput[] = []): SaveMoodboardNodeInput[] {
    return cloneInputs(this.state(boardId).latestInputs ?? fallback);
  }

  subscribe(boardId: string, subscriber: SaveSubscriber): () => void {
    const state = this.state(boardId);
    state.subscribers.add(subscriber);
    state.detachedRetryBudget = 0;
    if (state.pending && state.timer === null && state.inFlight === null) this.schedule(boardId, 0);
    return () => {
      state.subscribers.delete(subscriber);
      if (state.subscribers.size === 0 && state.pending) state.detachedRetryBudget = Math.max(state.detachedRetryBudget, 1);
      this.releaseIfIdle(boardId, state);
    };
  }

  queue(boardId: string, inputs: SaveMoodboardNodeInput[], delay = 350): number {
    const state = this.state(boardId);
    state.latestInputs = cloneInputs(inputs);
    state.version += 1;
    state.pending = true;
    state.retryCount = 0;
    if (state.subscribers.size === 0) state.detachedRetryBudget = Math.max(state.detachedRetryBudget, 1);
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    this.schedule(boardId, delay);
    const queuedVersion = state.version;
    const queuedInputs = cloneInputs(state.latestInputs);
    queueMicrotask(() => {
      if (state.version !== queuedVersion) return;
      for (const subscriber of state.subscribers) subscriber.onPending?.(cloneInputs(queuedInputs));
    });
    return queuedVersion;
  }

  append(boardId: string, additions: SaveMoodboardNodeInput[], fallback: SaveMoodboardNodeInput[]): SaveMoodboardNodeInput[] {
    const state = this.state(boardId);
    const next = [...cloneInputs(state.latestInputs ?? fallback), ...cloneInputs(additions)];
    this.queue(boardId, next, 0);
    return next;
  }

  private schedule(boardId: string, delay: number): void {
    const state = this.state(boardId);
    if (state.timer !== null || !state.pending) return;
    state.timer = window.setTimeout(() => {
      state.timer = null;
      void this.flush(boardId);
    }, delay);
  }

  private scheduleRetry(boardId: string, state: BoardSaveState): void {
    if (!state.pending || state.timer !== null) return;
    if (state.subscribers.size === 0) {
      if (state.detachedRetryBudget <= 0) return;
      state.detachedRetryBudget -= 1;
    }
    state.retryCount += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(state.retryCount - 1, 5));
    this.schedule(boardId, delay);
  }

  async flush(boardId: string): Promise<boolean> {
    const state = this.state(boardId);
    if (state.inFlight) {
      const inFlightVersion = state.inFlightVersion;
      const succeeded = await state.inFlight;
      if (state.pending && state.version !== inFlightVersion) return this.flush(boardId);
      if (succeeded && state.pending && state.timer === null) return this.flush(boardId);
      return succeeded;
    }
    if (!state.pending || !state.latestInputs) return true;
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    const version = state.version;
    const inputs = cloneInputs(state.latestInputs);
    const save = this.api
      .saveMoodboardNodes(boardId, inputs)
      .then((saved) => {
        if (state.version === version) {
          state.confirmedInputs = nodeInputs(saved);
          state.latestInputs = nodeInputs(saved);
          state.pending = false;
          state.retryCount = 0;
          state.detachedRetryBudget = 0;
          for (const subscriber of state.subscribers) subscriber.onSaved?.(saved);
        }
        return true;
      })
      .catch(() => {
        if (state.retryCount === 0) {
          for (const subscriber of state.subscribers) subscriber.onError?.();
        }
        this.scheduleRetry(boardId, state);
        return false;
      })
      .finally(() => {
        state.inFlight = null;
        state.inFlightVersion = null;
      });
    state.inFlight = save;
    state.inFlightVersion = version;
    const succeeded = await save;
    if (succeeded && state.pending) return this.flush(boardId);
    this.releaseIfIdle(boardId, state);
    return succeeded;
  }

  private releaseIfIdle(boardId: string, state: BoardSaveState): void {
    if (state.subscribers.size > 0 || state.activeServerMutations > 0 || state.pending || state.inFlight || state.timer !== null) return;
    this.states.delete(boardId);
  }
}

const coordinators = new WeakMap<ApiClient, MoodboardSaveCoordinator>();

export function getMoodboardSaveCoordinator(api: ApiClient): MoodboardSaveCoordinator {
  let coordinator = coordinators.get(api);
  if (!coordinator) {
    coordinator = new MoodboardSaveCoordinator(api);
    coordinators.set(api, coordinator);
  }
  return coordinator;
}
