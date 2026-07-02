import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAntiSlopContract } from "../src/anti-slop.ts";
import { slopRules } from "../../quality/src/index.ts";

test("anti-slop prompt uses the same numeric thresholds as the linter", () => {
  const prompt = renderAntiSlopContract();

  assert.match(prompt, new RegExp(`at most ${slopRules.ACCENT_OVERUSE_CAP}`));
  assert.match(prompt, new RegExp(`≥${slopRules.ALL_CAPS_TRACKING_FLOOR_EM}em letter-spacing`));
  assert.doesNotMatch(prompt, /twice per screen/i);
});
