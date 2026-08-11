import assert from "node:assert/strict";
import test from "node:test";

import {
  FIGMA_NODE_IDS_MAX_BYTES,
  FIGMA_NODE_ID_MAX_BYTES,
  FigmaUrlError,
  parseFigmaUrl,
} from "../src/design/figma-url.ts";

test("Figma Design URLs normalize file identity, selected Node ids, and canonical source URL", () => {
  assert.deepEqual(
    parseFigmaUrl(" https://www.figma.com/design/AbC123xyZ/Product-System?node-id=5-3&t=tracking "),
    {
      fileType: "design",
      fileKey: "AbC123xyZ",
      branchKey: null,
      fileName: "Product-System",
      nodeIds: ["5:3"],
      requestedVersionId: null,
      normalizedUrl: "https://www.figma.com/design/AbC123xyZ/Product-System?node-id=5%3A3",
    },
  );
});

test("explicit Figma Node ids are normalized, deduplicated, sorted, and must agree with the URL", () => {
  assert.deepEqual(
    parseFigmaUrl("https://figma.com/file/Key123/File", ["8-2", "5:3", "8:2"]),
    {
      fileType: "file",
      fileKey: "Key123",
      branchKey: null,
      fileName: "File",
      nodeIds: ["5:3", "8:2"],
      requestedVersionId: null,
      normalizedUrl: "https://www.figma.com/file/Key123/File?node-id=5%3A3%2C8%3A2",
    },
  );
  assert.throws(
    () => parseFigmaUrl("https://www.figma.com/design/Key123/File?node-id=5-3", ["5:4"]),
    (error: unknown) => error instanceof FigmaUrlError && /disagrees/.test(error.message),
  );
});

test("Figma Node ids have exact per-id and aggregate UTF-8 budgets", () => {
  const sizedId = (length: number, index: number) => {
    const prefix = `${index}:`;
    return `${prefix}${"7".repeat(length - prefix.length)}`;
  };
  const atPerIdLimit = sizedId(FIGMA_NODE_ID_MAX_BYTES, 1);
  assert.equal(parseFigmaUrl("https://figma.com/file/Key123/File", [atPerIdLimit]).nodeIds[0], atPerIdLimit);
  assert.throws(
    () => parseFigmaUrl("https://figma.com/file/Key123/File", [sizedId(FIGMA_NODE_ID_MAX_BYTES + 1, 1)]),
    FigmaUrlError,
  );

  const atAggregateLimit = [
    ...Array.from({ length: 32 }, (_, index) => sizedId(64, index + 1)),
    ...Array.from({ length: 31 }, (_, index) => sizedId(63, index + 33)),
    sizedId(32, 64),
  ];
  assert.equal(
    Buffer.byteLength(atAggregateLimit.join(","), "utf8"),
    FIGMA_NODE_IDS_MAX_BYTES,
  );
  assert.equal(
    parseFigmaUrl("https://figma.com/file/Key123/File", atAggregateLimit).nodeIds.length,
    64,
  );
  const overAggregateLimit = [...atAggregateLimit.slice(0, -1), sizedId(33, 64)];
  assert.throws(
    () => parseFigmaUrl("https://figma.com/file/Key123/File", overAggregateLimit),
    FigmaUrlError,
  );
});

test("Figma Design branch, Board, and Slides URLs retain their exact adapter identity", () => {
  assert.deepEqual(
    parseFigmaUrl("https://www.figma.com/design/MainKey1/branch/BranchKey2/Branch-Name"),
    {
      fileType: "design",
      fileKey: "MainKey1",
      branchKey: "BranchKey2",
      fileName: "Branch-Name",
      nodeIds: [],
      requestedVersionId: null,
      normalizedUrl: "https://www.figma.com/design/MainKey1/branch/BranchKey2/Branch-Name",
    },
  );
  assert.equal(parseFigmaUrl("https://www.figma.com/board/BoardKey1/Workshop").fileType, "board");
  assert.equal(parseFigmaUrl("https://www.figma.com/slides/SlideKey1/Quarterly").fileType, "slides");
});

test("Figma URL parsing fails closed on credentials, unsupported hosts/types, fragments, and malformed ids", () => {
  const invalid = [
    "https://token@www.figma.com/design/Key123/File",
    "https://evil.example/design/Key123/File",
    "http://www.figma.com/design/Key123/File",
    "https://www.figma.com/community/Key123/File",
    "https://www.figma.com/proto/Key123/File",
    "https://www.figma.com/site/Key123/File",
    "https://www.figma.com/buzz/Key123/File",
    "https://www.figma.com/design/../File",
    "https://www.figma.com/design/Key123/File#fragment",
    "https://www.figma.com/design/Key123/File?node-id=bad",
    "https://www.figma.com/design/Key123/File%2FName",
    "https://www.figma.com/design/Key123/File%5CName",
    "https://www.figma.com/design/Key123/File?version-id=historical-version",
  ];
  for (const value of invalid) {
    assert.throws(() => parseFigmaUrl(value), FigmaUrlError, value);
  }
});
