import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_EFFECTS, getBuiltInEffect, listBuiltInEffectCards, buildEffectAgentContext } from "../src/index.ts";

const REQUIRED = [
  "paper-texture",
  "fluted-glass",
  "water",
  "image-dithering",
  "halftone-dots",
  "halftone-cmyk",
  "heatmap",
  "liquid-metal",
  "gem-smoke",
  "mesh-gradient",
  "static-mesh-gradient",
  "static-radial-gradient",
  "dithering",
  "grain-gradient",
  "dot-grid",
  "neuro-noise",
  "simplex-noise",
  "god-rays",
  "smoke-ring",
  "metaballs",
];

test("built-in effects registry includes the requested shader set", () => {
  assert.deepEqual(
    BUILT_IN_EFFECTS.map((effect) => effect.id),
    REQUIRED,
  );
  assert.equal(listBuiltInEffectCards().length, REQUIRED.length);
  for (const effect of BUILT_IN_EFFECTS) {
    assert.equal(effect.origin, "built-in");
    assert.equal(effect.category, "@Paper");
    assert.equal(effect.previewUrl, `/effects/previews/${effect.id}.jpg`);
    assert.ok(effect.parameters.length >= 3, effect.id);
    assert.ok(effect.presets.some((preset) => preset.id === "default"), effect.id);
    assert.equal(effect.code, `@paper-design/shaders-react:${effect.id}`);
  }
  assert.equal(listBuiltInEffectCards()[0]?.previewUrl, "/effects/previews/paper-texture.jpg");
});

test("image-capable Paper effects expose an image parameter with demo assets", () => {
  const imageEffects = ["paper-texture", "fluted-glass", "water", "image-dithering", "halftone-dots", "halftone-cmyk", "heatmap", "liquid-metal", "gem-smoke"];
  for (const id of imageEffects) {
    const effect = getBuiltInEffect(id);
    assert.ok(effect, id);
    const image = effect.parameters.find((param) => param.id === "image");
    assert.equal(image?.type, "image", id);
    assert.ok(image?.options?.some((option) => option.value.startsWith("/effects/demo-")), id);
  }
});

test("buildEffectAgentContext exposes one selected effect, not the entire library", () => {
  const effect = getBuiltInEffect("paper-texture");
  assert.ok(effect);
  const context = buildEffectAgentContext(effect);
  assert.match(context, /paper texture/i);
  assert.match(context, /Parameters:/);
  assert.match(context, /@paper-design\/shaders-react:paper-texture/);
  assert.match(context, /WebGL2 fragment shader/);
  assert.doesNotMatch(context, /fluted glass/i);
});
