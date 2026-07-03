import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectEffectContext, effectReferenceLine, normalizeProjectEffectRefs } from "../src/project-effect-context.ts";

test("effect refs are normalized, deduped, and bounded", () => {
  assert.deepEqual(
    normalizeProjectEffectRefs([
      { id: "paper-texture", name: "paper texture" },
      { id: "paper-texture", name: "duplicate" },
      { id: "" },
      null,
      { id: "mesh-gradient" },
      { id: "water" },
      { id: "heatmap" },
      { id: "god-rays" },
      { id: "metaballs" },
    ]),
    [
      { id: "paper-texture", name: "paper texture" },
      { id: "mesh-gradient", name: undefined },
      { id: "water", name: undefined },
      { id: "heatmap", name: undefined },
      { id: "god-rays", name: undefined },
    ],
  );
});

test("effect context exposes selected effects and discovery APIs without dumping the library", () => {
  const context = buildProjectEffectContext({
    store: { getEffect: () => null } as never,
    refs: [{ id: "paper-texture", name: "paper texture" }],
    request: "Make the hero feel tactile.",
    origin: "http://127.0.0.1:4768",
  });

  assert.equal(effectReferenceLine(context.labels), "\n\nEffect references (available to the Agent at run time): paper texture (paper-texture)");
  assert.match(context.promptBlock, /## Referenced Effects/);
  assert.match(context.promptBlock, /paper-texture/);
  assert.match(context.promptBlock, /roughness/);
  assert.match(context.promptBlock, /GET http:\/\/127\.0\.0\.1:4768\/api\/effects\?query=/);
  assert.match(context.promptBlock, /GET http:\/\/127\.0\.0\.1:4768\/api\/effects\/:id/);
  assert.doesNotMatch(context.promptBlock, /fluted-glass/);
});

test("effect lookup is omitted for unrelated design requests without selected refs", () => {
  const context = buildProjectEffectContext({
    store: { getEffect: () => null } as never,
    refs: [],
    request: "make a hero",
    origin: "http://127.0.0.1:4768",
  });

  assert.equal(context.promptBlock, "");
});
