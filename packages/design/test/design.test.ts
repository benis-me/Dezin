import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultRegistry,
  DEFAULT_DESIGN_SYSTEM_ID,
  modernMinimal,
} from "../src/index.ts";

test("registry resolves the default and bundled systems", () => {
  const reg = defaultRegistry();
  assert.equal(reg.default().id, DEFAULT_DESIGN_SYSTEM_ID);
  assert.ok(reg.has("modern-minimal"));
  assert.equal(reg.get("nope"), null);
  assert.ok(reg.list().length >= 1);
});

test("registry.register overrides by id", () => {
  const reg = defaultRegistry();
  reg.register({ ...modernMinimal, id: "modern-minimal", name: "Tweaked" });
  assert.equal(reg.get("modern-minimal")?.name, "Tweaked");
});

test("DESIGN.md has all nine sections", () => {
  const headings = modernMinimal.designMd.match(/^## \d\./gm) ?? [];
  assert.equal(headings.length, 9, `expected 9 sections, got ${headings.length}`);
});

test("tokens declare the A1-identity tokens", () => {
  for (const t of ["--bg", "--fg", "--accent", "--font-display"]) {
    assert.ok(modernMinimal.tokensCss.includes(t), `missing ${t}`);
  }
});

test("craft.applies includes the anti-slop core", () => {
  for (const c of ["typography", "color", "anti-ai-slop"]) {
    assert.ok(modernMinimal.craft.applies.includes(c), `craft missing ${c}`);
  }
});
