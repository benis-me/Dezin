import { test, expect } from "vitest";
import { diffLines, diffStat } from "./diff.ts";

test("diffLines marks added, removed, and context lines", () => {
  const lines = diffLines("a\nb\nc", "a\nx\nc");
  expect(lines).toEqual([
    { t: "ctx", text: "a" },
    { t: "del", text: "b" },
    { t: "add", text: "x" },
    { t: "ctx", text: "c" },
  ]);
  expect(diffStat(lines)).toEqual({ added: 1, removed: 1 });
});

test("diffLines handles pure additions", () => {
  const lines = diffLines("a", "a\nb\nc");
  expect(diffStat(lines)).toEqual({ added: 2, removed: 0 });
});

test("diffLines avoids quadratic work for large unrelated files", () => {
  const oldText = Array.from({ length: 5_000 }, (_, i) => `old-${i}`).join("\n");
  const newText = Array.from({ length: 5_000 }, (_, i) => `new-${i}`).join("\n");
  const lines = diffLines(oldText, newText);

  expect(lines).toHaveLength(10_000);
  expect(diffStat(lines)).toEqual({ added: 5_000, removed: 5_000 });
});
