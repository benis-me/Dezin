import { afterEach, expect, test } from "vitest";
import {
  claimPendingDesignCanvasIntent,
  completePendingDesignCanvasIntent,
  discardPendingDesignCanvasIntent,
  markPendingDesignCanvasContextComplete,
  peekPendingDesignCanvasIntent,
  releasePendingDesignCanvasIntent,
  setPendingDesignCanvasIntent,
  type PendingDesignCanvasIntent,
} from "./pending-design-canvas.ts";

const STORAGE_PREFIX = "dezin.design-canvas.intent.";

const intent: PendingDesignCanvasIntent = {
  projectId: "project-handoff",
  prompt: "Build a precise launch page",
  agentCommand: "codex",
  model: "gpt-5",
  context: [
    {
      kind: "project-version",
      title: "Existing hero",
      sourceProjectId: "source-project",
      sourceNodeId: "source-hero",
      sourceVersionId: "source-version-hero",
    },
    {
      kind: "project-version",
      title: "Existing checkout",
      sourceProjectId: "source-project",
      sourceNodeId: "source-node",
      sourceVersionId: "source-version",
    },
  ],
};

afterEach(() => {
  discardPendingDesignCanvasIntent(intent.projectId);
  discardPendingDesignCanvasIntent("project-discarded");
  discardPendingDesignCanvasIntent("project-corrupt");
  sessionStorage.clear();
});

test("pending Design Canvas intent is retained until its claim completes", () => {
  expect(setPendingDesignCanvasIntent(intent)).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(`${STORAGE_PREFIX}${intent.projectId}`)!)).toEqual(intent);

  const claim = claimPendingDesignCanvasIntent(intent.projectId);
  expect(claim?.intent).toEqual(intent);
  expect(claimPendingDesignCanvasIntent(intent.projectId)).toBeNull();
  expect(peekPendingDesignCanvasIntent(intent.projectId)).toEqual(intent);
  expect(sessionStorage.getItem(`${STORAGE_PREFIX}${intent.projectId}`)).not.toBeNull();

  expect(completePendingDesignCanvasIntent(claim!)).toBe(true);
  expect(peekPendingDesignCanvasIntent(intent.projectId)).toBeNull();
  expect(sessionStorage.getItem(`${STORAGE_PREFIX}${intent.projectId}`)).toBeNull();
});

test("a released failed claim remains recoverable and remembers imported contexts", () => {
  setPendingDesignCanvasIntent(intent);
  const first = claimPendingDesignCanvasIntent(intent.projectId)!;
  expect(markPendingDesignCanvasContextComplete(first, 0)).toBe(true);
  expect(releasePendingDesignCanvasIntent(first)).toBe(true);

  expect(peekPendingDesignCanvasIntent(intent.projectId)).toEqual(intent);
  const retry = claimPendingDesignCanvasIntent(intent.projectId)!;
  expect(retry.completedContextIndexes).toEqual([0]);
  expect(completePendingDesignCanvasIntent(retry)).toBe(true);
});

test("discard removes a pending Design Canvas intent before it can be consumed", () => {
  const discarded = { ...intent, projectId: "project-discarded" };
  setPendingDesignCanvasIntent(discarded);

  discardPendingDesignCanvasIntent(discarded.projectId);

  expect(peekPendingDesignCanvasIntent(discarded.projectId)).toBeNull();
  expect(sessionStorage.getItem(`${STORAGE_PREFIX}${discarded.projectId}`)).toBeNull();
});

test.each([
  ["malformed JSON", "{not-json"],
  [
    "an invalid context record",
    JSON.stringify({
      ...intent,
      projectId: "project-corrupt",
      context: [{ kind: "project-version", title: "missing identity" }],
    }),
  ],
])("corrupt session storage with %s is ignored and cleared safely", (_description, raw) => {
  const storageKey = `${STORAGE_PREFIX}project-corrupt`;
  sessionStorage.setItem(storageKey, raw);

  let pending: PendingDesignCanvasIntent | null | undefined;
  expect(() => {
    pending = peekPendingDesignCanvasIntent("project-corrupt");
  }).not.toThrow();
  expect(pending).toBeNull();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});
