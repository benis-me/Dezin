import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MoodboardDetail } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { VisualResearchBoard } from "./VisualResearchBoard.tsx";

afterEach(cleanup);

vi.mock("../moodboard/MoodboardCanvas.tsx", () => ({
  MoodboardCanvas: (props: { nodes: unknown[] }) => <div data-testid="visual-moodboard" data-nodes={props.nodes.length} />,
}));

function board(overrides: Partial<MoodboardDetail> = {}): MoodboardDetail {
  return {
    id: "b1",
    name: "Visual research",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    coverAssetId: null,
    nodes: [
      {
        id: "n1",
        boardId: "b1",
        type: "image",
        x: 0,
        y: 0,
        width: 200,
        height: 150,
        rotation: 0,
        zIndex: 0,
        data: { assetId: "a1", url: "/api/moodboards/b1/assets/a1", fileName: "hero.png", source: "upload" },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    assets: [
      {
        id: "a1",
        boardId: "b1",
        kind: "image",
        fileName: "hero.png",
        mimeType: "image/png",
        width: 200,
        height: 150,
        source: "upload",
        createdAt: 1,
        url: "/api/moodboards/b1/assets/a1",
      },
    ],
    messages: [],
    ...overrides,
  };
}

test("VisualResearchBoard loads the board and mounts the canvas", async () => {
  const api = makeFakeApi({ getMoodboard: async (id) => board({ id }) });
  const { findByTestId } = render(
    <ApiProvider client={api}>
      <VisualResearchBoard boardId="b1" />
    </ApiProvider>,
  );
  const el = await findByTestId("visual-moodboard");
  expect(el).toBeTruthy();
  expect(el.getAttribute("data-nodes")).toBe("1");
});
