import {
  forgetPendingDesignWorkspaceTurn,
  peekPendingDesignWorkspaceTurn,
  setPendingDesignWorkspaceTurn,
  type PendingDesignWorkspaceRecoveryContextItem,
  type PendingDesignWorkspaceTurn,
} from "../lib/pending-brief.ts";
import type { WorkspaceAgentTurnInput } from "../lib/api.ts";

const LEGACY_TURN_KEY = "dezin.pending.design-workspace-turn";
const TURN_KEY_PREFIX = "dezin.pending.design-workspace-turn:";
const ACKNOWLEDGED_TURN_KEY_PREFIX = "dezin.pending.design-workspace-turn-ack:";
const INVALIDATED_TURN = "{\"invalidated\":true}";
const CANONICAL_TURN_ID = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let fallbackLifecycleLock: Promise<void> = Promise.resolve();

function storedRecord(key: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function invalidate(key: string): void {
  try {
    localStorage.setItem(key, INVALIDATED_TURN);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* The caller refuses submission when durable invalidation is unavailable. */
    }
  }
}

/**
 * Acknowledgement is an append-only marker keyed by the completed active turn.
 * It never deletes the project record, so a concurrent newer replacement cannot
 * be consumed by an older renderer's completion callback.
 */
export function acknowledgePendingDesignWorkspaceTurn(
  projectId: string,
  expectedActiveTurnId: string,
): boolean {
  if (!CANONICAL_TURN_ID.test(expectedActiveTurnId)) return false;
  const current = peekPendingDesignWorkspaceTurn(projectId);
  if (current === null
    || (current.supersededByTurnId ?? current.turnId) !== expectedActiveTurnId) return false;
  const key = `${ACKNOWLEDGED_TURN_KEY_PREFIX}${encodeURIComponent(projectId)}:${expectedActiveTurnId}`;
  try {
    localStorage.setItem(key, "1");
    if (localStorage.getItem(key) !== "1") return false;
  } catch {
    return false;
  }
  forgetPendingDesignWorkspaceTurn(projectId);
  return true;
}

/**
 * Persist the replacement before its outbox. If the write fails, invalidate the
 * durable ancestor so a renderer reload can never replay the retired Home turn.
 */
export function persistSupersedingPendingTurn(value: PendingDesignWorkspaceTurn): boolean {
  if (value.supersededByTurnId === undefined) {
    throw new TypeError("A superseding turn identity is required");
  }
  if (setPendingDesignWorkspaceTurn(value)) return true;

  const key = `${TURN_KEY_PREFIX}${encodeURIComponent(value.projectId)}`;
  const stored = storedRecord(key);
  const expectedPriorTurnId = value.recoveryRequest?.parentTurnId ?? value.turnId;
  if (stored?.projectId === value.projectId
    && stored.turnId === value.turnId
    && (stored.supersededByTurnId ?? stored.turnId) === expectedPriorTurnId) invalidate(key);
  const legacy = storedRecord(LEGACY_TURN_KEY);
  if (legacy?.projectId === value.projectId
    && legacy.supersededByTurnId === undefined
    && (legacy.turnId === undefined || legacy.turnId === value.turnId)) invalidate(LEGACY_TURN_KEY);
  forgetPendingDesignWorkspaceTurn(value.projectId);
  return false;
}

async function withPendingTurnLock<T>(projectId: string, action: () => T | Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks) {
    return locks.request(
      `dezin:pending-design-workspace-turn:${projectId}`,
      { mode: "exclusive" },
      action,
    );
  }
  const previous = fallbackLifecycleLock;
  let release!: () => void;
  fallbackLifecycleLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

/**
 * Claims the unsuperseded Home turn under a renderer-wide Web Lock. A competing
 * window that observes the winner cannot persist or submit a second replacement.
 */
export function claimSupersedingPendingTurn(value: PendingDesignWorkspaceTurn): Promise<boolean> {
  if (value.supersededByTurnId === undefined) {
    return Promise.reject(new TypeError("A superseding turn identity is required"));
  }
  return withPendingTurnLock(value.projectId, () => {
    const current = peekPendingDesignWorkspaceTurn(value.projectId);
    if (current === null
      || current.turnId !== value.turnId
      || current.supersededByTurnId !== undefined) return false;
    return persistSupersedingPendingTurn(value);
  });
}

export interface PendingTurnReplacementReservation {
  fingerprint: string;
  request: Omit<WorkspaceAgentTurnInput, "turnId">;
  contextItems: PendingDesignWorkspaceRecoveryContextItem[];
}

export type PendingTurnReplacementClaim =
  | {
      status: "claimed" | "reused";
      turn: PendingDesignWorkspaceTurn;
      turnId: string;
    }
  | { status: "conflict" | "persistence-failed" };

function newReplacementTurnId(): string {
  return `turn-${globalThis.crypto.randomUUID().toLowerCase()}`;
}

/**
 * Compare-and-swap the active recovery turn after the hook has resolved the
 * exact request facts. Identical facts reuse the same idempotency key; any
 * changed prompt, Context, selection, Agent/model, or graph Revision appends a
 * new child identity before the outbox or network request can be written.
 */
export function claimPendingTurnReplacement(input: {
  projectId: string;
  expectedActiveTurnId: string;
  /**
   * Immutable facts already attempted under a legacy pre-reserved active turn.
   * A failed Agent outbox is authoritative for this value even when an older
   * pending-turn record predates recoveryRequest persistence.
   */
  activeRequestFingerprint?: string;
  reservation: PendingTurnReplacementReservation;
}): Promise<PendingTurnReplacementClaim> {
  return withPendingTurnLock(input.projectId, () => {
    const current = peekPendingDesignWorkspaceTurn(input.projectId);
    if (current === null
      || (current.supersededByTurnId ?? current.turnId) !== input.expectedActiveTurnId) {
      return { status: "conflict" };
    }
    if (current.recoveryRequest?.fingerprint === input.reservation.fingerprint
      && current.recoveryRequest.turnId === input.expectedActiveTurnId) {
      return {
        status: "reused",
        turn: current,
        turnId: input.expectedActiveTurnId,
      };
    }

    const legacyActiveFingerprint = current.supersededByTurnId === input.expectedActiveTurnId
      && current.recoveryRequest === undefined
      ? input.activeRequestFingerprint
      : undefined;
    const bindsPreviouslyReservedTurn = current.supersededByTurnId !== undefined
      && current.recoveryRequest === undefined
      && (legacyActiveFingerprint === undefined
        || legacyActiveFingerprint === input.reservation.fingerprint);
    const turnId = bindsPreviouslyReservedTurn
      ? current.supersededByTurnId!
      : newReplacementTurnId();
    const parentTurnId = bindsPreviouslyReservedTurn
      ? current.turnId
      : input.expectedActiveTurnId;
    const request: WorkspaceAgentTurnInput = {
      ...input.reservation.request,
      turnId,
    };
    const lineage = [
      ...(current.supersessionLineage ?? []),
      ...(!bindsPreviouslyReservedTurn
        && current.supersededByTurnId !== undefined
        && current.recoveryRequest === undefined
        && legacyActiveFingerprint !== undefined
        ? [{
            turnId: current.supersededByTurnId,
            parentTurnId: current.turnId,
            fingerprint: legacyActiveFingerprint,
          }]
        : []),
      {
        turnId,
        parentTurnId,
        fingerprint: input.reservation.fingerprint,
      },
    ].slice(-32);
    const turn: PendingDesignWorkspaceTurn = {
      projectId: current.projectId,
      turnId: current.turnId,
      supersededByTurnId: turnId,
      brief: request.message,
      ...(request.agentCommand === undefined ? {} : { agentCommand: request.agentCommand }),
      ...(request.model === undefined ? {} : { model: request.model }),
      attachmentCount: current.attachmentCount,
      attachmentsStaged: current.attachmentsStaged,
      ...(current.attachments === undefined ? {} : { attachments: current.attachments }),
      recoveryRequest: {
        turnId,
        parentTurnId,
        fingerprint: input.reservation.fingerprint,
        request,
        contextItems: input.reservation.contextItems,
      },
      supersessionLineage: lineage,
    };
    if (!persistSupersedingPendingTurn(turn)) return { status: "persistence-failed" };
    return { status: "claimed", turn, turnId };
  });
}
