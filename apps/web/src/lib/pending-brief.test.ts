import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  discardPendingDesignWorkspaceTurn,
  peekPendingDesignWorkspaceTurn,
  setPendingDesignWorkspaceTurn,
} from "./pending-brief.ts";
import {
  acknowledgePendingDesignWorkspaceTurn,
  claimPendingTurnReplacement,
  claimSupersedingPendingTurn,
  persistSupersedingPendingTurn,
} from "../project-studio/pending-turn-supersession.ts";
import { workspaceAgentRequestFingerprint } from "./workspace-agent-request-fingerprint.ts";

const TURN_ONE = "turn-00000000-0000-4000-8000-000000000001";
const TURN_TWO = "turn-00000000-0000-4000-8000-000000000002";
const TURN_THREE = "turn-00000000-0000-4000-8000-000000000003";

function storageKey(projectId: string): string {
  return `dezin.pending.design-workspace-turn:${encodeURIComponent(projectId)}`;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.resetModules();
});

test("a pending Design Workspace turn is project-scoped and consumed once", () => {
  const pending = {
    projectId: "project-new",
    turnId: TURN_ONE,
    brief: "Build a complete music workspace",
    agentCommand: "codebuddy",
    model: "hunyuan",
    attachmentCount: 0,
    attachmentsStaged: true,
  };
  setPendingDesignWorkspaceTurn(pending);

  expect(peekPendingDesignWorkspaceTurn("project-unrelated")).toBeNull();
  expect(peekPendingDesignWorkspaceTurn("project-new")).toEqual(pending);
  expect(acknowledgePendingDesignWorkspaceTurn("project-new", TURN_ONE)).toBe(true);
  expect(peekPendingDesignWorkspaceTurn("project-new")).toBeNull();
});

test("a pending Design Workspace turn survives a renderer reload and is still consumed once", async () => {
  const pending = {
    projectId: "project-reload",
    turnId: TURN_ONE,
    brief: "Build a complete editorial workspace",
    agentCommand: "codebuddy",
    model: "gpt-5.6-sol",
    attachmentCount: 2,
    attachmentsStaged: true,
    attachments: [
      {
        title: "reference.png",
        uploadedFileId: ".refs/reference.png",
        preview: true,
      },
      {
        title: "Existing editorial",
        uploadedFileId: ".refs/reference-existing-editorial.html",
      },
    ],
  };
  const beforeReload = await import("./pending-brief.ts");
  beforeReload.setPendingDesignWorkspaceTurn(pending);

  vi.resetModules();
  const afterReload = await import("./pending-brief.ts");
  const afterReloadLifecycle = await import("../project-studio/pending-turn-supersession.ts");

  expect(afterReload.peekPendingDesignWorkspaceTurn("project-unrelated")).toBeNull();
  expect(afterReload.peekPendingDesignWorkspaceTurn("project-reload")).toEqual(pending);
  expect(afterReload.peekPendingDesignWorkspaceTurn("project-reload")).toEqual(pending);
  expect(afterReloadLifecycle.acknowledgePendingDesignWorkspaceTurn("project-unrelated", TURN_ONE)).toBe(false);
  expect(afterReloadLifecycle.acknowledgePendingDesignWorkspaceTurn("project-reload", TURN_ONE)).toBe(true);

  vi.resetModules();
  const afterConsumptionReload = await import("./pending-brief.ts");
  expect(afterConsumptionReload.peekPendingDesignWorkspaceTurn("project-reload")).toBeNull();
});

test("a superseding Workspace Agent turn survives reload and must use a distinct canonical identity", async () => {
  const pending = {
    projectId: "project-superseded",
    turnId: TURN_ONE,
    supersededByTurnId: TURN_TWO,
    brief: "Build the original direction",
    attachmentCount: 0,
    attachmentsStaged: true,
  };

  expect(setPendingDesignWorkspaceTurn(pending)).toBe(true);
  vi.resetModules();
  const afterReload = await import("./pending-brief.ts");
  expect(afterReload.peekPendingDesignWorkspaceTurn("project-superseded")).toEqual(pending);

  expect(() => afterReload.setPendingDesignWorkspaceTurn({
    ...pending,
    supersededByTurnId: TURN_ONE,
  })).toThrow("Pending Design Workspace turn is invalid");
  expect(() => afterReload.setPendingDesignWorkspaceTurn({
    ...pending,
    supersededByTurnId: "replacement-turn",
  })).toThrow("Pending Design Workspace turn is invalid");
});

test("an older completion cannot acknowledge a newer superseding turn", () => {
  const pending = {
    projectId: "project-compare-delete",
    turnId: TURN_ONE,
    supersededByTurnId: TURN_TWO,
    brief: "Build the replacement direction",
    attachmentCount: 0,
    attachmentsStaged: true,
  };
  expect(setPendingDesignWorkspaceTurn(pending)).toBe(true);

  expect(acknowledgePendingDesignWorkspaceTurn("project-compare-delete", TURN_ONE)).toBe(false);
  expect(peekPendingDesignWorkspaceTurn("project-compare-delete")).toEqual(pending);
  expect(acknowledgePendingDesignWorkspaceTurn("project-compare-delete", TURN_TWO)).toBe(true);
  expect(peekPendingDesignWorkspaceTurn("project-compare-delete")).toBeNull();
});

test("a failed durable supersession invalidates the stored original before renderer reload", async () => {
  const availableStorage = localStorage;
  expect(setPendingDesignWorkspaceTurn({
    projectId: "project-failed-supersession",
    turnId: TURN_ONE,
    brief: "Build the original direction",
    attachmentCount: 0,
    attachmentsStaged: true,
  })).toBe(true);
  vi.stubGlobal("localStorage", {
    getItem: availableStorage.getItem.bind(availableStorage),
    removeItem: availableStorage.removeItem.bind(availableStorage),
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  });

  expect(persistSupersedingPendingTurn({
    projectId: "project-failed-supersession",
    turnId: TURN_ONE,
    supersededByTurnId: TURN_TWO,
    brief: "Build the original direction",
    attachmentCount: 0,
    attachmentsStaged: true,
  })).toBe(false);
  expect(peekPendingDesignWorkspaceTurn("project-failed-supersession")).toBeNull();
  expect(availableStorage.getItem(storageKey("project-failed-supersession"))).toBeNull();

  vi.resetModules();
  const afterReload = await import("./pending-brief.ts");
  expect(afterReload.peekPendingDesignWorkspaceTurn("project-failed-supersession")).toBeNull();
  vi.stubGlobal("localStorage", availableStorage);
});

test("a failed supersession cannot invalidate a newer replacement written by another renderer", async () => {
  const availableStorage = localStorage;
  const newerReplacement = {
    projectId: "project-concurrent-supersession",
    turnId: TURN_ONE,
    supersededByTurnId: TURN_TWO,
    brief: "Keep the already durable replacement",
    attachmentCount: 0,
    attachmentsStaged: true,
  };
  expect(setPendingDesignWorkspaceTurn(newerReplacement)).toBe(true);
  const durableBefore = availableStorage.getItem(storageKey(newerReplacement.projectId));
  vi.stubGlobal("localStorage", {
    getItem: availableStorage.getItem.bind(availableStorage),
    removeItem: availableStorage.removeItem.bind(availableStorage),
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  });

  expect(persistSupersedingPendingTurn({
    ...newerReplacement,
    supersededByTurnId: TURN_THREE,
    brief: "A competing replacement that could not be persisted",
  })).toBe(false);
  expect(availableStorage.getItem(storageKey(newerReplacement.projectId))).toBe(durableBefore);

  vi.stubGlobal("localStorage", availableStorage);
  vi.resetModules();
  const afterReload = await import("./pending-brief.ts");
  expect(afterReload.peekPendingDesignWorkspaceTurn(newerReplacement.projectId)).toEqual(newerReplacement);
});

test("acknowledging an older completion never deletes a concurrently written replacement", async () => {
  const original = {
    projectId: "project-concurrent-ack",
    turnId: TURN_ONE,
    brief: "Build the original direction",
    attachmentCount: 0,
    attachmentsStaged: true,
  };
  expect(setPendingDesignWorkspaceTurn(original)).toBe(true);
  expect(peekPendingDesignWorkspaceTurn(original.projectId)).toEqual(original);

  const replacement = {
    ...original,
    supersededByTurnId: TURN_TWO,
    brief: "Build the replacement direction",
  };
  localStorage.setItem(storageKey(original.projectId), JSON.stringify(replacement));

  expect(acknowledgePendingDesignWorkspaceTurn(original.projectId, TURN_ONE)).toBe(false);
  expect(peekPendingDesignWorkspaceTurn(original.projectId)).toEqual(replacement);

  vi.resetModules();
  const afterReload = await import("./pending-brief.ts");
  expect(afterReload.peekPendingDesignWorkspaceTurn(original.projectId)).toEqual(replacement);
});

test("only one concurrent renderer may claim an unsuperseded Home turn", async () => {
  const original = {
    projectId: "project-concurrent-claim",
    turnId: TURN_ONE,
    brief: "Build the original direction",
    attachmentCount: 0,
    attachmentsStaged: true,
  };
  expect(setPendingDesignWorkspaceTurn(original)).toBe(true);

  const [first, second] = await Promise.all([
    claimSupersedingPendingTurn({
      ...original,
      supersededByTurnId: TURN_TWO,
      brief: "Build replacement A",
    }),
    claimSupersedingPendingTurn({
      ...original,
      supersededByTurnId: TURN_THREE,
      brief: "Build replacement B",
    }),
  ]);

  expect([first, second].filter(Boolean)).toHaveLength(1);
  const winner = peekPendingDesignWorkspaceTurn(original.projectId);
  expect(winner?.supersededByTurnId).toBe(first ? TURN_TWO : TURN_THREE);
  expect(winner?.brief).toBe(first ? "Build replacement A" : "Build replacement B");
});

test("a legacy active replacement replays unchanged facts but forks edited immutable facts", async () => {
  const oldRequest = {
    message: "Build the failed replacement",
    agentCommand: "codebuddy",
    model: "gpt-5.6-sol",
    explicitContext: [{
      kind: "resource" as const,
      id: "reference-old",
      resourceKind: "file" as const,
      revisionId: "revision-old",
    }],
    graphRevision: 7,
    selection: [],
  };
  const oldFingerprint = workspaceAgentRequestFingerprint(oldRequest);
  const original = {
    turnId: TURN_ONE,
    supersededByTurnId: TURN_TWO,
    brief: oldRequest.message,
    agentCommand: oldRequest.agentCommand,
    model: oldRequest.model,
    attachmentCount: 0,
    attachmentsStaged: true,
  };

  expect(setPendingDesignWorkspaceTurn({
    projectId: "project-exact-replay",
    ...original,
  })).toBe(true);
  const unchanged = await claimPendingTurnReplacement({
    projectId: "project-exact-replay",
    expectedActiveTurnId: TURN_TWO,
    activeRequestFingerprint: oldFingerprint,
    reservation: {
      fingerprint: oldFingerprint,
      request: oldRequest,
      contextItems: [],
    },
  });
  expect(unchanged.status).toBe("claimed");
  expect(unchanged.status === "claimed" && unchanged.turnId).toBe(TURN_TWO);

  expect(setPendingDesignWorkspaceTurn({
    projectId: "project-edited-retry",
    ...original,
  })).toBe(true);
  const editedRequest = {
    ...oldRequest,
    explicitContext: [{
      kind: "resource" as const,
      id: "reference-new",
      resourceKind: "file" as const,
      revisionId: "revision-new",
    }],
  };
  const edited = await claimPendingTurnReplacement({
    projectId: "project-edited-retry",
    expectedActiveTurnId: TURN_TWO,
    activeRequestFingerprint: oldFingerprint,
    reservation: {
      fingerprint: workspaceAgentRequestFingerprint(editedRequest),
      request: editedRequest,
      contextItems: [],
    },
  });
  expect(edited.status).toBe("claimed");
  if (edited.status !== "claimed") return;
  expect(edited.turnId).toMatch(/^turn-/);
  expect(edited.turnId).not.toBe(TURN_TWO);
  expect(edited.turn.supersessionLineage).toEqual([
    {
      turnId: TURN_TWO,
      parentTurnId: TURN_ONE,
      fingerprint: oldFingerprint,
    },
    {
      turnId: edited.turnId,
      parentTurnId: TURN_TWO,
      fingerprint: workspaceAgentRequestFingerprint(editedRequest),
    },
  ]);
});

test("project deletion discards malformed recovery records and every acknowledgement marker", () => {
  const projectId = "project-deleted";
  localStorage.setItem(storageKey(projectId), "{\"invalidated\":true}");
  localStorage.setItem(
    `dezin.pending.design-workspace-turn-ack:${encodeURIComponent(projectId)}:${TURN_ONE}`,
    "1",
  );
  localStorage.setItem(
    `dezin.pending.design-workspace-turn-ack:${encodeURIComponent(projectId)}:${TURN_TWO}`,
    "1",
  );
  localStorage.setItem("dezin.pending.design-workspace-turn", JSON.stringify({
    projectId,
    malformed: true,
  }));

  expect(discardPendingDesignWorkspaceTurn(projectId)).toBe(true);
  expect(localStorage.getItem(storageKey(projectId))).toBeNull();
  expect([...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))]
    .some((key) => key?.includes(encodeURIComponent(projectId)))).toBe(false);
  expect(localStorage.getItem("dezin.pending.design-workspace-turn")).toBeNull();
});

test("a pending Design Workspace turn persists only staged identities, never attachment bytes", () => {
  const base64 = "large-sensitive-payload";
  const pending = {
    projectId: "project-staged",
    turnId: TURN_ONE,
    brief: "Build from the staged direction",
    attachmentCount: 1,
    attachmentsStaged: true,
    attachments: [{
      title: "direction.png",
      uploadedFileId: ".refs/direction.png",
      preview: true,
    }],
  };

  expect(setPendingDesignWorkspaceTurn({
    ...pending,
    // Exercise runtime normalization of stale callers: bytes must never enter storage.
    images: [{ name: "direction.png", base64 }],
  } as Parameters<typeof setPendingDesignWorkspaceTurn>[0])).toBe(true);

  const stored = localStorage.getItem(storageKey("project-staged"));
  expect(stored).not.toBeNull();
  expect(stored).not.toContain(base64);
  expect(stored).toContain(".refs/direction.png");
  expect(peekPendingDesignWorkspaceTurn("project-staged")).toEqual(pending);
  expect(acknowledgePendingDesignWorkspaceTurn("project-staged", TURN_ONE)).toBe(true);
});

test("a pending Design Workspace turn reports when durable recovery storage is unavailable", () => {
  const availableStorage = localStorage;
  vi.stubGlobal("localStorage", {
    getItem: availableStorage.getItem.bind(availableStorage),
    removeItem: availableStorage.removeItem.bind(availableStorage),
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  });

  expect(setPendingDesignWorkspaceTurn({
    projectId: "project-memory-only",
    turnId: TURN_ONE,
    brief: "Build a workspace",
    attachmentCount: 0,
    attachmentsStaged: true,
  })).toBe(false);
  expect(peekPendingDesignWorkspaceTurn("project-memory-only")).toEqual({
    projectId: "project-memory-only",
    turnId: TURN_ONE,
    brief: "Build a workspace",
    attachmentCount: 0,
    attachmentsStaged: true,
  });

  vi.stubGlobal("localStorage", availableStorage);
});

test("pending Design Workspace turns coexist and acknowledge only their exact project", async () => {
  setPendingDesignWorkspaceTurn({
    projectId: "project-a",
    turnId: TURN_ONE,
    brief: "Build project A",
    attachmentCount: 0,
    attachmentsStaged: true,
  });
  setPendingDesignWorkspaceTurn({
    projectId: "project-b",
    turnId: TURN_TWO,
    brief: "Build project B",
    attachmentCount: 0,
    attachmentsStaged: true,
  });

  expect(localStorage.getItem(storageKey("project-a"))).not.toBeNull();
  expect(localStorage.getItem(storageKey("project-b"))).not.toBeNull();

  vi.resetModules();
  const afterReload = await import("./pending-brief.ts");
  const afterReloadLifecycle = await import("../project-studio/pending-turn-supersession.ts");
  expect(afterReloadLifecycle.acknowledgePendingDesignWorkspaceTurn("project-a", TURN_ONE)).toBe(true);
  expect(afterReload.peekPendingDesignWorkspaceTurn("project-a")).toBeNull();
  expect(afterReload.peekPendingDesignWorkspaceTurn("project-b")).toEqual({
    projectId: "project-b",
    turnId: TURN_TWO,
    brief: "Build project B",
    attachmentCount: 0,
    attachmentsStaged: true,
  });
  expect(localStorage.getItem(storageKey("project-b"))).not.toBeNull();
});

test("a pre-turnId legacy handoff migrates once with a stable project-scoped turn identity", async () => {
  localStorage.setItem("dezin.pending.design-workspace-turn", JSON.stringify({
    projectId: "project-legacy",
    brief: "Resume the legacy workspace",
    agentCommand: "codebuddy",
    attachments: [{
      title: "legacy.png",
      uploadedFileId: ".refs/legacy.png",
      preview: true,
    }],
  }));

  vi.resetModules();
  const migratedModule = await import("./pending-brief.ts");
  const migrated = migratedModule.peekPendingDesignWorkspaceTurn("project-legacy");

  expect(migrated).toEqual(expect.objectContaining({
    projectId: "project-legacy",
    brief: "Resume the legacy workspace",
    attachmentCount: 1,
    attachmentsStaged: true,
  }));
  expect(migrated?.turnId).toMatch(
    /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(localStorage.getItem("dezin.pending.design-workspace-turn")).toBeNull();
  expect(JSON.parse(localStorage.getItem(storageKey("project-legacy"))!)).toEqual(migrated);

  vi.resetModules();
  const reloadedModule = await import("./pending-brief.ts");
  expect(reloadedModule.peekPendingDesignWorkspaceTurn("project-legacy")?.turnId).toBe(migrated?.turnId);
});
