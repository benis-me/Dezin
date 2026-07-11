import { act } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SaveMoodboardNodeInput } from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { MoodboardSaveCoordinator } from "./moodboard-save-coordinator.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
