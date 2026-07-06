import { test } from "node:test";
import assert from "node:assert/strict";
import { planVariantFanout } from "../src/variant-fanout.ts";

test("planVariantFanout names the requested number of variations", () => {
  const plan = planVariantFanout(3);
  assert.equal(plan.count, 3);
  assert.deepEqual(plan.variants.map((v) => v.name), ["Variation A", "Variation B", "Variation C"]);
});

test("planVariantFanout clamps to 2..4 and defaults to 3", () => {
  assert.equal(planVariantFanout(10).count, 4);
  assert.equal(planVariantFanout(1).count, 2);
  assert.equal(planVariantFanout(0).count, 3);
  assert.equal(planVariantFanout(Number.NaN).count, 3);
});
