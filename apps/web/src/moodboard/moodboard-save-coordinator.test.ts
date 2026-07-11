import { act } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { MoodboardSaveCoordinator } from "./moodboard-save-coordinator.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function savedNode(
  id: string,
  overrides: Partial<MoodboardNode> = {},
): MoodboardNode {
  return {
    id,
    boardId: "board-merge",
    type: "note",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 0,
    data: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("a long server mutation preserves local nodes saved after its baseline", async () => {
  const saveMoodboardNodes = vi.fn(async (boardId: string, inputs: SaveMoodboardNodeInput[]) =>
    inputs.map((input, index) => savedNode(input.id ?? `saved-${index}`, { ...input, boardId, updatedAt: 2 })),
  );
  const coordinator = new MoodboardSaveCoordinator(makeFakeApi({ saveMoodboardNodes }));
  const base = savedNode("base");
  coordinator.hydrate("board-merge", [base]);
  const mutation = coordinator.beginServerMutation("board-merge");

  coordinator.queue("board-merge", [base, savedNode("local")], 0);
  await coordinator.flush("board-merge");
  const reconciled = coordinator.reconcileServerNodes(
    "board-merge",
    [base, savedNode("agent")],
    mutation,
  );

  expect(reconciled.map((node) => node.id)).toEqual(["base", "agent", "local"]);
});

test("a local geometry edit does not roll back a server generator-to-image conversion", () => {
  const coordinator = new MoodboardSaveCoordinator(makeFakeApi());
  const generator = savedNode("generator", {
    type: "image-generator",
    data: { generatorPrompt: "soft light", generatorStatus: "running" },
  });
  coordinator.hydrate("board-merge", [generator]);
  const mutation = coordinator.beginServerMutation("board-merge");
  coordinator.queue("board-merge", [{ ...generator, x: 48 }], 10_000);

  const [reconciled] = coordinator.reconcileServerNodes(
    "board-merge",
    [savedNode("generator", { type: "image", data: { assetId: "asset-1", source: "generated" } })],
    mutation,
  );

  expect(reconciled).toMatchObject({
    id: "generator",
    type: "image",
    x: 48,
    data: { assetId: "asset-1", source: "generated" },
  });
});

test("a save queued after the last subscriber leaves still gets one detached retry", async () => {
  vi.useFakeTimers();
  const saveMoodboardNodes = vi
    .fn<ReturnType<typeof makeFakeApi>["saveMoodboardNodes"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (boardId, inputs) =>
      inputs.map((input, index) => ({
        ...input,
        id: input.id ?? `saved-${index}`,
        boardId,
        rotation: input.rotation ?? 0,
        zIndex: input.zIndex ?? index,
        data: input.data ?? {},
        createdAt: 1,
        updatedAt: 2,
      })),
    );
  const coordinator = new MoodboardSaveCoordinator(makeFakeApi({ saveMoodboardNodes }));
  const unsubscribe = coordinator.subscribe("board-detached", {});
  unsubscribe();

  const inputs: SaveMoodboardNodeInput[] = [
    { id: "image-1", type: "image", x: 0, y: 0, width: 100, height: 100, data: { assetId: "asset-1" } },
  ];
  coordinator.append("board-detached", inputs, []);
  await act(async () => {
    await coordinator.flush("board-detached");
  });
  expect(saveMoodboardNodes).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(saveMoodboardNodes).toHaveBeenCalledTimes(2);
  expect(saveMoodboardNodes).toHaveBeenLastCalledWith("board-detached", inputs);
});
