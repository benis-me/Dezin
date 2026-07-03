import { expect, test } from "vitest";
import type { SaveMoodboardNodeInput } from "../lib/api.ts";
import {
  buildPastedNodeInputs,
  classifyClipboardPaste,
  MOODBOARD_CLIPBOARD_MARKER,
  parseMoodboardClipboardNodes,
  serializeMoodboardClipboardNodes,
} from "./moodboard-clipboard.ts";

function imageInput(id: string, x = 40, y = 60): SaveMoodboardNodeInput {
  return { id, type: "image", x, y, width: 200, height: 120, zIndex: 3, data: { assetId: `asset-${id}`, url: `/asset/${id}.png` } };
}

test("serializeMoodboardClipboardNodes round-trips through parseMoodboardClipboardNodes", () => {
  const nodes = [imageInput("a"), imageInput("b", 80, 90)];
  const text = serializeMoodboardClipboardNodes("board-1", nodes);

  const parsed = parseMoodboardClipboardNodes(text);
  expect(parsed).not.toBeNull();
  expect(parsed?.boardId).toBe("board-1");
  expect(parsed?.nodes).toEqual(nodes);
});

test("serialized payload carries the moodboard marker so foreign apps can be distinguished", () => {
  const text = serializeMoodboardClipboardNodes("board-1", [imageInput("a")]);
  expect(text).toContain(MOODBOARD_CLIPBOARD_MARKER);
});

test("parseMoodboardClipboardNodes rejects plain text and foreign JSON", () => {
  expect(parseMoodboardClipboardNodes("just some copied text")).toBeNull();
  expect(parseMoodboardClipboardNodes(JSON.stringify({ hello: "world" }))).toBeNull();
  expect(parseMoodboardClipboardNodes(JSON.stringify({ marker: "other-app", nodes: [imageInput("a")] }))).toBeNull();
  expect(parseMoodboardClipboardNodes("")).toBeNull();
  expect(parseMoodboardClipboardNodes(null)).toBeNull();
});

test("parseMoodboardClipboardNodes rejects a payload whose nodes are not valid node inputs", () => {
  const text = JSON.stringify({ marker: MOODBOARD_CLIPBOARD_MARKER, version: 1, boardId: "board-1", nodes: [{ x: 1 }] });
  expect(parseMoodboardClipboardNodes(text)).toBeNull();
});

test("classifyClipboardPaste prefers moodboard node JSON over any accompanying image", () => {
  const text = serializeMoodboardClipboardNodes("board-1", [imageInput("a")]);
  const png = new File([new Uint8Array([1, 2, 3])], "clip.png", { type: "image/png" });

  const result = classifyClipboardPaste({ text, files: [png] });
  expect(result.kind).toBe("nodes");
  if (result.kind === "nodes") {
    expect(result.boardId).toBe("board-1");
    expect(result.nodes).toHaveLength(1);
  }
});

test("classifyClipboardPaste returns images when the text is not a moodboard payload", () => {
  const png = new File([new Uint8Array([1, 2, 3])], "clip.png", { type: "image/png" });
  const textFile = new File(["hi"], "note.txt", { type: "text/plain" });

  const result = classifyClipboardPaste({ text: "unrelated text", files: [textFile, png] });
  expect(result.kind).toBe("images");
  if (result.kind === "images") {
    expect(result.files).toEqual([png]);
  }
});

test("classifyClipboardPaste returns none when there is nothing pasteable", () => {
  expect(classifyClipboardPaste({ text: "unrelated", files: [] }).kind).toBe("none");
  expect(classifyClipboardPaste({}).kind).toBe("none");
});

test("buildPastedNodeInputs assigns fresh ids, stacked z-indexes, and offsets to the paste point", () => {
  const nodes = [imageInput("a", 100, 100), imageInput("b", 140, 180)];
  let counter = 0;
  const copies = buildPastedNodeInputs(nodes, { point: { x: 300, y: 300 }, startZIndex: 10, createId: () => `new-${counter++}` });

  expect(copies.map((node) => node.id)).toEqual(["new-0", "new-1"]);
  expect(copies.map((node) => node.zIndex)).toEqual([10, 11]);
  // top-left node lands on the paste point; the second keeps its relative offset (40, 80)
  expect({ x: copies[0].x, y: copies[0].y }).toEqual({ x: 300, y: 300 });
  expect({ x: copies[1].x, y: copies[1].y }).toEqual({ x: 340, y: 380 });
  // data is cloned, not shared
  expect(copies[0].data).not.toBe(nodes[0].data);
  expect(copies[0].data).toEqual(nodes[0].data);
});

test("buildPastedNodeInputs falls back to a fixed offset when no paste point is given", () => {
  const nodes = [imageInput("a", 100, 100)];
  const copies = buildPastedNodeInputs(nodes, { startZIndex: 1, createId: () => "new-0" });
  expect({ x: copies[0].x, y: copies[0].y }).toEqual({ x: 132, y: 132 });
});
