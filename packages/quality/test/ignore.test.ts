import { test } from "node:test";
import assert from "node:assert/strict";
import { applyIgnores, type QualityIgnore } from "../src/ignore.ts";
import type { Finding } from "../src/types.ts";

const f = (id: string, selector?: string): Finding => ({ severity: "P2", id, message: "m", fix: "x", selector });

test("a rule-wide ignore drops every finding of that rule", () => {
  const findings = [f("low-contrast", "p.a"), f("low-contrast", "p.b"), f("tiny-text", "small")];
  const out = applyIgnores(findings, [{ ruleId: "low-contrast" }]);
  assert.deepEqual(out.map((x) => x.id), ["tiny-text"]);
});

test("a selector-scoped ignore drops only that element's finding", () => {
  const findings = [f("low-contrast", "p.a"), f("low-contrast", "p.b")];
  const out = applyIgnores(findings, [{ ruleId: "low-contrast", selector: "p.a" }]);
  assert.deepEqual(out.map((x) => x.selector), ["p.b"]);
});

test("unrelated ignores keep everything; empty ignores are a no-op", () => {
  const findings = [f("low-contrast", "p.a"), f("tiny-text")];
  assert.equal(applyIgnores(findings, [{ ruleId: "nested-cards" }]).length, 2);
  assert.equal(applyIgnores(findings, []).length, 2);
});
