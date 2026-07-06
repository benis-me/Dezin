import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  visualDir, visualReportPath, visualAssetsDir, visualMoodboardPointerPath, visualSourcesPath,
  visualResearchExists, readVisualReport, listVisualAssets, readVisualSources,
  readVisualMoodboardId, writeVisualMoodboardId, buildResearchContext,
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
