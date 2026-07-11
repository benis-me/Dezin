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
  subscribers: Set<SaveSubscriber>;
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

  reconcileServerNodes(boardId: string, serverNodes: MoodboardNode[]): SaveMoodboardNodeInput[] {
    const state = this.state(boardId);
    const serverInputs = nodeInputs(serverNodes);
    if (!state.pending || !state.latestInputs) {
      state.confirmedInputs = cloneInputs(serverInputs);
      state.latestInputs = cloneInputs(serverInputs);
      return cloneInputs(serverInputs);
    }

    const confirmedById = new Map(state.confirmedInputs.flatMap((input) => (input.id ? [[input.id, input] as const] : [])));
    const localById = new Map(state.latestInputs.flatMap((input) => (input.id ? [[input.id, input] as const] : [])));
    const locallyDeleted = new Set([...confirmedById.keys()].filter((id) => !localById.has(id)));
    const locallyChanged = new Map(
      [...localById].filter(([id, input]) => {
        const confirmed = confirmedById.get(id);
        return confirmed ? !sameInput(confirmed, input) : false;
      }),
    );
    const merged = serverInputs.flatMap((input): SaveMoodboardNodeInput[] => {
      if (input.id && locallyDeleted.has(input.id)) return [];
      return [input.id ? locallyChanged.get(input.id) ?? input : input];
    });
    const mergedIds = new Set(merged.flatMap((input) => (input.id ? [input.id] : [])));
    for (const input of state.latestInputs) {
      if (input.id && confirmedById.has(input.id)) continue;
      if (!input.id || !mergedIds.has(input.id)) merged.push(input);
    }
    state.confirmedInputs = cloneInputs(serverInputs);
    this.queue(boardId, merged, 0);
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
    if (state.subscribers.size > 0 || state.pending || state.inFlight || state.timer !== null) return;
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
