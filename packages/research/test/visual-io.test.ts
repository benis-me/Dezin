import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  visualDir, visualReportPath, visualAssetsDir, visualMoodboardPointerPath, visualSourcesPath,
  visualResearchExists, readVisualReport, listVisualAssets, readVisualSources,
  readVisualMoodboardId, writeVisualMoodboardId, buildResearchContext, directionsExist,
} from "../src/index.ts";

function proj(): string {
  return mkdtempSync(join(tmpdir(), "dezin-visual-"));
}

test("visual path helpers point under .research/visual", () => {
  const p = "/x";
  assert.match(visualDir(p), /\.research\/visual$/);
  assert.match(visualReportPath(p), /\.research\/visual\/visual\.md$/);
  assert.match(visualAssetsDir(p), /\.research\/visual\/assets$/);
  assert.match(visualMoodboardPointerPath(p), /\.research\/visual\/moodboard\.json$/);
});

test("visualResearchExists + readers reflect on-disk visual research", async () => {
  const p = proj();
  assert.equal(visualResearchExists(p), false);
  mkdirSync(visualAssetsDir(p), { recursive: true });
  writeFileSync(visualReportPath(p), "# Visual\n\nCalm palette.");
  writeFileSync(join(visualAssetsDir(p), "shot.png"), "x");
  assert.equal(visualResearchExists(p), true);
  assert.match((await readVisualReport(p))!, /Calm palette/);
  assert.deepEqual(await listVisualAssets(p), ["visual/assets/shot.png"]);
});

test("visual moodboard pointer round-trips", async () => {
  const p = proj();
  assert.equal(await readVisualMoodboardId(p), null);
  await writeVisualMoodboardId(p, "board-123");
  assert.equal(await readVisualMoodboardId(p), "board-123");
});

test("readVisualSources tolerates a title-less visual source (identified by url/platform/designer)", async () => {
  const p = proj();
  mkdirSync(visualDir(p), { recursive: true });
  writeFileSync(
    visualSourcesPath(p),
    JSON.stringify([{ id: "s1", platform: "behance", designer: "Ana", url: "https://behance.net/x", assets: ["assets/x.png"], reached: true }]),
  );
  const sources = await readVisualSources(p);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.designer, "Ana");
  assert.equal(sources[0]!.platform, "behance");
  assert.deepEqual(sources[0]!.assets, ["assets/x.png"]);
});

test("buildResearchContext gives the agent the REAL .research image paths (not research/) and forces opening them", async () => {
  const p = proj();
  mkdirSync(join(p, ".research", "assets"), { recursive: true });
  mkdirSync(visualAssetsDir(p), { recursive: true });
  writeFileSync(join(p, ".research", "research.md"), "# Product\n\nUsers skim.");
  writeFileSync(visualReportPath(p), "# Visual\n\nMono.");
  writeFileSync(join(p, ".research", "assets", "ref.png"), "x");
  writeFileSync(join(visualAssetsDir(p), "hero.png"), "x");
  const ctx = (await buildResearchContext(p))!;
  // Paths must carry the leading dot (RESEARCH_DIRNAME = ".research").
  assert.match(ctx, /\.research\/visual\/assets\/hero\.png/);
  assert.match(ctx, /\.research\/assets\/ref\.png/);
  // And must NOT hand the agent the broken dot-less path (a backtick directly before "research/").
  assert.doesNotMatch(ctx, /`research\//);
  // Force-open instruction (not the passive "study these").
  assert.match(ctx, /open .*(each|every).*(image|screenshot|reference)|open and study/i);
  assert.match(ctx, /primary visual evidence/i);
});

test("directionsExist reflects whether any candidate direction is on disk", () => {
  const p = proj();
  assert.equal(directionsExist(p), false);
  mkdirSync(join(p, ".research", "directions", "bold"), { recursive: true });
  assert.equal(directionsExist(p), true);
});

test("buildResearchContext folds in BOTH the product report and the visual report + assets", async () => {
  const p = proj();
  mkdirSync(join(p, ".research", "assets"), { recursive: true });
  mkdirSync(visualAssetsDir(p), { recursive: true });
  writeFileSync(join(p, ".research", "research.md"), "# Product\n\nUsers skim.");
  writeFileSync(visualReportPath(p), "# Visual\n\nMono, generous whitespace.");
  writeFileSync(join(visualAssetsDir(p), "hero.png"), "x");
  const ctx = (await buildResearchContext(p))!;
  assert.match(ctx, /Users skim/);
  assert.match(ctx, /Mono, generous whitespace/);
  assert.match(ctx, /visual\/assets\/hero\.png/);
});

test("buildResearchContext's preamble does NOT claim a product report exists when only visual research is present", async () => {
  const p = proj();
  mkdirSync(visualAssetsDir(p), { recursive: true });
  writeFileSync(visualReportPath(p), "# Visual\n\nBrutalist mono, tight grid.");
  const ctx = (await buildResearchContext(p))!;
  assert.ok(ctx, "expected a context block for a visual-only project");
  // The old unconditional opening line asserted a *product* report exists — must be gone here.
  assert.doesNotMatch(ctx, /A research report has been produced/);
  // A visual-appropriate line should still ground the build in the (real) visual research.
  assert.match(ctx, /Visual research has been produced/);
  assert.match(ctx, /Brutalist mono, tight grid/);
});
