import { test } from "node:test";
import assert from "node:assert/strict";
import { markCorroboration } from "../src/synthesis.ts";
import type { Finding } from "../src/types.ts";

const f = (id: string, selector?: string): Finding => ({ severity: "P2", id, message: "m", fix: "x", selector });

test("marks the elements both lanes independently flagged as corroborated", () => {
  const deterministic = [f("low-contrast", ".x"), f("tiny-text", ".y")];
  const agent = [f("visual-improve-1", ".x"), f("visual-improve-2", ".z")];
  const out = markCorroboration(deterministic, agent);
  assert.equal(out.deterministic.find((x) => x.selector === ".x")!.corroborated, true);
  assert.equal(out.agent.find((x) => x.selector === ".x")!.corroborated, true);
  assert.equal(out.deterministic.find((x) => x.selector === ".y")!.corroborated ?? false, false);
  assert.equal(out.agent.find((x) => x.selector === ".z")!.corroborated ?? false, false);
});

test("no shared selectors → nothing corroborated", () => {
  const out = markCorroboration([f("a", ".p")], [f("b", ".q")]);
  assert.equal(out.deterministic[0]!.corroborated ?? false, false);
  assert.equal(out.agent[0]!.corroborated ?? false, false);
});
