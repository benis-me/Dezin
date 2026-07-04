import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResearchContext,
  ensureResearchScaffold,
  listAssets,
  listDirections,
  readBrief,
  readChosenDirection,
  researchExists,
  writeBrief,
  writeChosenDirection,
  writeReport,
} from "../src/io.ts";
import type { ResearchBrief } from "../src/types.ts";

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dezin-research-"));
}

const brief: ResearchBrief = {
  what: "landing",
  audience: "devs",
  goals: ["convert"],
  tone: ["calm"],
  mustHave: [],
  mustAvoid: [],
  references: [],
  skill: "landing",
  body: "Body.",
};

test("writeBrief then readBrief round-trips on disk", async () => {
  const dir = await project();
  await writeBrief(dir, brief);
  assert.deepEqual(await readBrief(dir), brief);
});

test("researchExists reflects whether a report was written", async () => {
  const dir = await project();
  assert.equal(researchExists(dir), false);
  await writeReport(dir, "# Research\n\nFindings.");
  assert.equal(researchExists(dir), true);
});

test("listAssets and listDirections read the scaffold", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeFile(join(dir, ".research", "assets", "a.png"), "x");
  await mkdir(join(dir, ".research", "directions", "bold"), { recursive: true });
  await writeFile(join(dir, ".research", "directions", "bold", "direction.md"), "# Bold\n\nBig type.");
  assert.deepEqual(await listAssets(dir), ["assets/a.png"]);
  const directions = await listDirections(dir);
  assert.equal(directions.length, 1);
  const [first] = directions;
  assert.equal(first!.slug, "bold");
  assert.match(first!.markdown, /Big type/);
});

test("buildResearchContext includes the report and the chosen direction", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeReport(dir, "# Research\n\nKey finding: developers skim.");
  await mkdir(join(dir, ".research", "directions", "bold"), { recursive: true });
  await writeFile(join(dir, ".research", "directions", "bold", "direction.md"), "# Bold direction\n\nTerminal hero.");
  const ctx = await buildResearchContext(dir, "bold");
  assert.ok(ctx);
  assert.match(ctx!, /developers skim/);
  assert.match(ctx!, /Chosen direction/);
  assert.match(ctx!, /Terminal hero/);
});

test("buildResearchContext is null when there is no report", async () => {
  const dir = await project();
  assert.equal(await buildResearchContext(dir), null);
});

test("writeChosenDirection then readChosenDirection round-trips the picked slug", async () => {
  const dir = await project();
  assert.equal(await readChosenDirection(dir), null);
  await writeChosenDirection(dir, "bold-terminal");
  assert.equal(await readChosenDirection(dir), "bold-terminal");
  // A later pick overwrites the earlier one.
  await writeChosenDirection(dir, "calm-editorial");
  assert.equal(await readChosenDirection(dir), "calm-editorial");
});
