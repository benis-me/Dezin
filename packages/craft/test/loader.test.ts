import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
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

test("every craft slug referenced by a shipped design-system manifest resolves to a craft file (no silent drops)", () => {
  const dsDir = join(dirname(defaultCraftDir()), "design-systems");
  const missing: string[] = [];
  for (const name of readdirSync(dsDir)) {
    const mf = join(dsDir, name, "manifest.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8")) as { craft?: { applies?: string[]; suggested?: string[] } };
    for (const slug of [...(m.craft?.applies ?? []), ...(m.craft?.suggested ?? [])]) {
      if (!loadCraftSections([slug], defaultCraftDir()).trim()) missing.push(`${name}: ${slug}`);
    }
  }
  assert.deepEqual(missing, [], `dangling craft slugs (no content/craft/<slug>.md): ${missing.join(", ")}`);
});
