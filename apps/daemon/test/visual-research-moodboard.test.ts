import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import { syncVisualResearchMoodboard } from "../src/visual-research-moodboard.ts";
import { visualAssetsDir, visualSourcesPath, readVisualMoodboardId } from "../../../packages/research/src/index.ts";
import { moodboardAssetPath } from "../src/project-moodboard-context.ts";

function setup() {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-vrm-"));
  const projectDir = join(dataDir, "projects", "p1");
  mkdirSync(visualAssetsDir(projectDir), { recursive: true });
  writeFileSync(join(visualAssetsDir(projectDir), "a.png"), "x");
  writeFileSync(join(visualAssetsDir(projectDir), "b.png"), "y");
  writeFileSync(visualSourcesPath(projectDir), JSON.stringify([
    { id: "s1", platform: "dribbble", url: "https://dribbble.com/shots/1", designer: "Jane", takeaways: ["mono"], assets: ["assets/a.png"], reached: true },
  ]));
  return { store, dataDir, projectDir };
}

test("syncVisualResearchMoodboard builds a board with an image node per asset, attributed + rendered", async () => {
  const { store, dataDir, projectDir } = setup();
  const out = await syncVisualResearchMoodboard({ store, dataDir, projectDir });
  assert.ok(out.boardId);
  assert.equal(out.nodes, 2);
  assert.equal(await readVisualMoodboardId(projectDir), out.boardId);

  const nodes = store.listMoodboardNodes(out.boardId);
  const images = nodes.filter((n) => n.type === "image");
  assert.equal(images.length, 2);
  assert.ok(images.every((n) => typeof n.data.url === "string" && (n.data.url as string).includes(`/api/moodboards/${out.boardId}/assets/`)));
  assert.ok(images.some((n) => n.data.sourceUrl === "https://dribbble.com/shots/1" && n.data.designer === "Jane"));

  // asset files were copied into the board store
  const assets = store.listMoodboardAssets(out.boardId);
  assert.equal(assets.length, 2);
  assert.ok(assets.every((a) => existsSync(moodboardAssetPath(dataDir, out.boardId, a))));
  store.close();
});

test("syncVisualResearchMoodboard is idempotent — reuses the board id and asset rows", async () => {
  const { store, dataDir, projectDir } = setup();
  const first = await syncVisualResearchMoodboard({ store, dataDir, projectDir });
  const second = await syncVisualResearchMoodboard({ store, dataDir, projectDir });
  assert.equal(second.boardId, first.boardId);
  assert.equal(second.nodes, 2);
  assert.equal(store.listMoodboardAssets(first.boardId).length, 2); // not doubled
  store.close();
});
