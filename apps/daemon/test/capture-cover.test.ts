import { test } from "node:test";
import assert from "node:assert/strict";
import { COVER_CAPTURE_SETTLE_MS } from "../src/capture-cover.ts";

test("cover capture waits long enough after network idle for intro animations to settle", () => {
  assert.ok(COVER_CAPTURE_SETTLE_MS >= 2500);
});
