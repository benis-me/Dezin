import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAntiSlopContract } from "../src/anti-slop.ts";
import { slopRules, AA_NORMAL_CONTRAST, MIN_LINE_HEIGHT_RATIO, MAX_LINE_LENGTH_CH } from "../../quality/src/index.ts";

test("anti-slop prompt uses the same numeric thresholds as the linter", () => {
  const prompt = renderAntiSlopContract();

  assert.match(prompt, new RegExp(`at most ${slopRules.ACCENT_OVERUSE_CAP}`));
  assert.match(prompt, new RegExp(`≥${slopRules.ALL_CAPS_TRACKING_FLOOR_EM}em letter-spacing`));
  assert.doesNotMatch(prompt, /twice per screen/i);
});

test("anti-slop prompt teaches the rendered-quality bar upfront with the enforced thresholds", () => {
  const prompt = renderAntiSlopContract();
  // The post-render checks are now taught up front, referencing the actual thresholds (no drift).
  assert.match(prompt, new RegExp(`${AA_NORMAL_CONTRAST}:1`)); // contrast floor
  assert.match(prompt, new RegExp(`line-height ≥ ${MIN_LINE_HEIGHT_RATIO}`));
  assert.match(prompt, new RegExp(`${MAX_LINE_LENGTH_CH}ch`));
  assert.match(prompt, /nested cards/i);
  assert.match(prompt, /icon.tile/i);
  assert.match(prompt, /token scale/i);
  assert.match(prompt, /clich/i);
  assert.match(prompt, /bounce|elastic/i);
});
