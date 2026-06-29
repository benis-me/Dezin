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
