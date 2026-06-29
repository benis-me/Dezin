import { test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_DIRECTIONS, findDirection, renderDirectionBlock } from "../src/index.ts";

test("five directions, each with a full palette + fonts + posture", () => {
  assert.equal(DESIGN_DIRECTIONS.length, 5);
  for (const d of DESIGN_DIRECTIONS) {
    for (const k of ["bg", "surface", "fg", "muted", "border", "accent"] as const) {
      assert.ok(d.palette[k], `${d.id} missing palette.${k}`);
    }
    assert.ok(d.posture.length > 0, `${d.id} has posture`);
    assert.ok(d.displayFont && d.bodyFont && d.monoFont, `${d.id} has fonts`);
  }
});

test("findDirection by id", () => {
  assert.equal(findDirection("modern-minimal")?.id, "modern-minimal");
  assert.equal(findDirection("nope"), null);
});

test("renderDirectionBlock emits a pasteable :root + posture", () => {
  const block = renderDirectionBlock(findDirection("editorial")!);
  assert.match(block, /## Visual direction/);
  assert.match(block, /:root/);
  assert.match(block, /--accent:/);
  assert.match(block, /Posture:/);
});
