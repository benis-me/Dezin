import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCraftSections, defaultCraftDir } from "../src/index.ts";

test("loadCraftSections loads requested sections with their real rules", () => {
  const out = loadCraftSections(["typography", "color", "state-coverage"], defaultCraftDir());
  assert.match(out, /### typography/);
  assert.match(out, /0\.06em/); // ALL-CAPS tracking floor
  assert.match(out, /### color/);
  assert.match(out, /70–90%/); // neutral pixel budget
  assert.match(out, /### state-coverage/);
  assert.match(out, /Loading/);
});

test("loadCraftSections drops unknown/invalid slugs and dedupes", () => {
  const out = loadCraftSections(["typography", "nope", "typography", "../etc"], defaultCraftDir());
  assert.equal((out.match(/### typography/g) ?? []).length, 1);
  assert.ok(!out.includes("### nope"));
  assert.ok(!out.includes("etc"));
});

test("loadCraftSections returns '' when nothing resolves", () => {
  assert.equal(loadCraftSections([], defaultCraftDir()), "");
  assert.equal(loadCraftSections(["does-not-exist"], defaultCraftDir()), "");
});
