import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderAntiSlopMarkdown, defaultCraftDocPath } from "../src/index.ts";
import { AI_DEFAULT_INDIGO, SLOP_EMOJI } from "../../quality/src/slop-rules.ts";

test("the rendered doc inlines every banned indigo hex (generated from the constants)", () => {
  const md = renderAntiSlopMarkdown();
  for (const hex of AI_DEFAULT_INDIGO) {
    assert.ok(md.includes(hex), `doc should mention ${hex}`);
  }
});

test("the rendered doc inlines every slop emoji", () => {
  const md = renderAntiSlopMarkdown();
  for (const emoji of SLOP_EMOJI) {
    assert.ok(md.includes(emoji), `doc should mention ${emoji}`);
  }
});

test("the rendered doc states the Dezin taste rules", () => {
  const md = renderAntiSlopMarkdown();
  assert.match(md, /Borders over shadows/);
  assert.match(md, /more than 3 times/);
  assert.match(md, /No gradient-clipped text/);
});

test("DRIFT: committed content/craft/anti-ai-slop.md matches the generator", () => {
  const onDisk = readFileSync(defaultCraftDocPath(), "utf8");
  assert.equal(
    onDisk,
    renderAntiSlopMarkdown(),
    "content/craft/anti-ai-slop.md is stale — run `pnpm --filter @dezin/craft regen` after changing slop-rules",
  );
});
