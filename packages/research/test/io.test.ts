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
  listVisualAssets,
  readBrief,
  readChosenDirection,
  readReport,
  readSources,
  readVisualMoodboardId,
  readVisualSources,
  resetResearchBundle,
  researchExists,
  validateResearchBundle,
  visualResearchExists,
  writeBrief,
  writeChosenDirection,
  writeReport,
  writeSources,
  writeVisualMoodboardId,
} from "../src/io.ts";
import type { ResearchBrief, ResearchSource } from "../src/types.ts";

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

async function writeCompleteResearchTrack(dir: string, area: "product" | "visual", assetName: string): Promise<void> {
  const root = area === "product" ? join(dir, ".research") : join(dir, ".research", "visual");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, area === "product" ? "research.md" : "visual.md"),
    area === "product"
      ? "# Product research\n\nReal users compare alternatives, scan proof, and need a clear primary action before committing. This report grounds the design in those observed needs. [product-source]\n"
      : "# Visual research\n\nThe references use restrained contrast, a deliberate type hierarchy, and one focused accent to create a calm but distinctive interface. [visual-source]\n",
  );
  await writeFile(join(root, "assets", assetName), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(
    join(root, "sources.json"),
    `${JSON.stringify([
      {
        id: `${area}-source`,
        kind: "inspiration",
        title: `${area} source`,
        url: `https://example.com/${area}`,
        authority: area === "product" ? "primary" : undefined,
        reached: area === "visual" ? true : undefined,
        takeaways: ["A concrete, source-grounded design takeaway."],
        assets: [`assets/${assetName}`],
      },
    ])}\n`,
  );
}

async function writeMeaningfulDirection(dir: string, slug: string): Promise<void> {
  const target = join(dir, ".research", "directions", slug);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "direction.md"),
    `# ${slug}\n\nConcept: A focused product surface grounded in the research findings.\n\nStructure: Lead with the primary task, then evidence, details, and a clear next action.\n\nDistinctive move: Use one precise editorial transition to make the experience memorable without adding noise.\n`,
  );
}

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

test("resetResearchBundle removes generated outputs while preserving the distilled brief", async () => {
  const dir = await project();
  const sources: ResearchSource[] = [
    {
      id: "product-source",
      kind: "competitor",
      title: "Product source",
      url: "https://example.com/product",
      takeaways: ["A concrete product finding."],
      assets: [],
      authority: "primary",
    },
  ];
  await writeBrief(dir, brief);
  await writeReport(dir, "# Research\n\nGenerated product research.");
  await writeSources(dir, sources);
  await ensureResearchScaffold(dir);
  await writeFile(join(dir, ".research", "assets", "product.png"), "generated");
  await mkdir(join(dir, ".research", "visual", "assets"), { recursive: true });
  await writeFile(join(dir, ".research", "visual", "visual.md"), "# Visual research\n\nGenerated visual research.");
  await writeFile(join(dir, ".research", "visual", "assets", "visual.png"), "generated");
  await writeFile(
    join(dir, ".research", "visual", "sources.json"),
    `${JSON.stringify([{ ...sources[0], id: "visual-source", kind: "inspiration", reached: true }])}\n`,
  );
  await writeVisualMoodboardId(dir, "moodboard-1");
  await mkdir(join(dir, ".research", "directions", "calm-editorial"), { recursive: true });
  await writeFile(join(dir, ".research", "directions", "calm-editorial", "direction.md"), "# Calm editorial\n\nCandidate direction.");
  await writeChosenDirection(dir, "calm-editorial");

  assert.deepEqual(await readSources(dir), sources);
  assert.equal((await readVisualSources(dir))[0]?.id, "visual-source");
  assert.equal(await readVisualMoodboardId(dir), "moodboard-1");
  await resetResearchBundle(dir);

  assert.deepEqual(await readBrief(dir), brief);
  assert.equal(await readReport(dir), null);
  assert.deepEqual(await readSources(dir), []);
  assert.deepEqual(await listAssets(dir), []);
  assert.deepEqual(await listVisualAssets(dir), []);
  assert.deepEqual(await readVisualSources(dir), []);
  assert.equal(await readVisualMoodboardId(dir), null);
  assert.deepEqual(await listDirections(dir), []);
  assert.equal(await readChosenDirection(dir), null);
  assert.equal(researchExists(dir), false);
  assert.equal(visualResearchExists(dir), false);
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
  await ensureResearchScaffold(dir);
  await mkdir(join(dir, ".research", "directions", "bold-terminal"), { recursive: true });
  await mkdir(join(dir, ".research", "directions", "calm-editorial"), { recursive: true });
  await writeFile(join(dir, ".research", "directions", "bold-terminal", "direction.md"), "# Bold terminal\n\nCandidate direction.");
  await writeFile(join(dir, ".research", "directions", "calm-editorial", "direction.md"), "# Calm editorial\n\nCandidate direction.");
  assert.equal(await readChosenDirection(dir), null);
  await writeChosenDirection(dir, "bold-terminal");
  assert.equal(await readChosenDirection(dir), "bold-terminal");
  // A later pick overwrites the earlier one.
  await writeChosenDirection(dir, "calm-editorial");
  assert.equal(await readChosenDirection(dir), "calm-editorial");
});

test("writeChosenDirection rejects unsafe or missing candidates without changing the durable choice", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await mkdir(join(dir, ".research", "directions", "calm-editorial"), { recursive: true });
  await writeFile(join(dir, ".research", "directions", "calm-editorial", "direction.md"), "# Calm editorial\n\nCandidate direction.");
  await writeChosenDirection(dir, "calm-editorial");

  await assert.rejects(writeChosenDirection(dir, "../calm-editorial"), /safe candidate direction/i);
  await assert.rejects(writeChosenDirection(dir, "missing-direction"), /candidate direction/i);
  assert.equal(await readChosenDirection(dir), "calm-editorial");
});

test("validateResearchBundle reports concrete product, visual, and direction issues for an empty tree", async () => {
  const dir = await project();
  const result = await validateResearchBundle(dir);
  const codes = result.issues.map((issue) => issue.code);

  assert.equal(result.complete, false);
  assert.ok(codes.includes("product-report-missing"));
  assert.ok(codes.includes("product-sources-missing"));
  assert.ok(codes.includes("product-assets-missing"));
  assert.ok(codes.includes("visual-report-missing"));
  assert.ok(codes.includes("visual-sources-missing"));
  assert.ok(codes.includes("visual-assets-missing"));
  assert.ok(codes.includes("directions-count"));
});

test("validateResearchBundle rejects missing source assets and fewer than two meaningful directions", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await mkdir(join(dir, ".research", "visual"), { recursive: true });
  await writeFile(join(dir, ".research", "research.md"), "# Product research\n\nA sufficiently detailed product report grounded in real comparisons, audience needs, and domain evidence for the design team to use.\n");
  await writeFile(join(dir, ".research", "visual", "visual.md"), "# Visual research\n\nA sufficiently detailed visual report about palette, typography, composition, motion, and texture from inspected references.\n");
  await writeFile(join(dir, ".research", "sources.json"), JSON.stringify([{ id: "p", title: "Product", takeaways: ["Useful"], assets: ["assets/missing.png"] }]));
  await writeFile(join(dir, ".research", "visual", "sources.json"), JSON.stringify([{ id: "v", title: "Visual", takeaways: ["Useful"], assets: ["assets/missing.png"] }]));
  await mkdir(join(dir, ".research", "directions", "thin"), { recursive: true });
  await writeFile(join(dir, ".research", "directions", "thin", "direction.md"), "# Thin\n\nGeneric.");

  const result = await validateResearchBundle(dir);
  const codes = result.issues.map((issue) => issue.code);

  assert.equal(result.complete, false);
  assert.ok(codes.includes("product-asset-missing"));
  assert.ok(codes.includes("visual-asset-missing"));
  assert.ok(codes.includes("direction-structure-missing"));
  assert.ok(codes.includes("directions-count"));
});

test("validateResearchBundle accepts two meaningful directions with source-linked local assets", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");

  const result = await validateResearchBundle(dir);

  assert.deepEqual(result, { complete: true, issues: [] });
});

test("validateResearchBundle accepts every supported image format when its file signature is valid", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  const images: Array<[string, Buffer]> = [
    ["product.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["reference.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["reference.jpg", Buffer.from([0xff, 0xd8, 0xff])],
    ["reference.jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["reference.gif", Buffer.from("GIF89a")],
    ["reference.webp", Buffer.from("RIFF0000WEBP")],
    ["reference.bmp", Buffer.from("BM")],
    ["reference.ico", Buffer.from([0x00, 0x00, 0x01, 0x00])],
    ["reference.avif", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif")])],
  ];
  for (const [name, contents] of images) {
    await writeFile(join(dir, ".research", "assets", name), contents);
  }
  await writeFile(
    join(dir, ".research", "sources.json"),
    `${JSON.stringify([
      {
        id: "product-source",
        kind: "inspiration",
        title: "Product source",
        url: "https://example.com/product",
        authority: "primary",
        takeaways: ["A concrete, source-grounded design takeaway."],
        assets: images.map(([name]) => `assets/${name}`),
      },
    ])}\n`,
  );

  assert.deepEqual(await validateResearchBundle(dir), { complete: true, issues: [] });
});

test("validateResearchBundle rejects every supported image extension when its file signature is invalid", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  const invalidImages: Array<[string, Buffer]> = [
    ["invalid.svg", Buffer.from("<svx></svx>")],
    ["invalid.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00])],
    ["invalid.jpg", Buffer.from([0xff, 0xd8, 0x00])],
    ["invalid.jpeg", Buffer.from([0xff, 0xd8, 0x00])],
    ["invalid.gif", Buffer.from("GIFF")],
    ["invalid.webp", Buffer.from("RIFF0000NOPE")],
    ["invalid.bmp", Buffer.from("BZ")],
    ["invalid.ico", Buffer.from([0x00, 0x00, 0x02, 0x00])],
    ["invalid.avif", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmp42")])],
  ];
  for (const [name, contents] of invalidImages) {
    await writeFile(join(dir, ".research", "assets", name), contents);
  }
  await writeFile(
    join(dir, ".research", "sources.json"),
    `${JSON.stringify([
      {
        id: "product-source",
        kind: "inspiration",
        title: "Product source",
        url: "https://example.com/product",
        authority: "primary",
        takeaways: ["A concrete, source-grounded design takeaway."],
        assets: ["assets/product.png", ...invalidImages.map(([name]) => `assets/${name}`)],
      },
    ])}\n`,
  );

  const result = await validateResearchBundle(dir);
  const invalidPaths = new Set(
    result.issues.filter((issue) => issue.code === "product-asset-invalid").map((issue) => issue.path),
  );

  assert.equal(result.complete, false);
  assert.deepEqual(invalidPaths, new Set(invalidImages.map(([name]) => `assets/${name}`)));
});

test("validateResearchBundle rejects unsupported evidence formats in both product and visual tracks", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(dir, ".research", "assets", "product-evidence.txt"), pngSignature);
  await writeFile(join(dir, ".research", "visual", "assets", "visual-evidence.txt"), pngSignature);

  const result = await validateResearchBundle(dir);

  assert.equal(result.complete, false);
  assert.ok(result.issues.some((issue) => issue.code === "product-asset-invalid" && issue.path === "assets/product-evidence.txt"));
  assert.ok(result.issues.some((issue) => issue.code === "visual-asset-invalid" && issue.path === "visual/assets/visual-evidence.txt"));
});

test("validateResearchBundle requires every local asset to be linked from a source", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(dir, ".research", "assets", "orphan-product.png"), pngSignature);
  await writeFile(join(dir, ".research", "visual", "assets", "orphan-visual.png"), pngSignature);

  const result = await validateResearchBundle(dir);

  assert.equal(result.complete, false);
  assert.ok(result.issues.some((issue) => issue.code === "product-assets-unreferenced" && issue.path === "assets/orphan-product.png"));
  assert.ok(result.issues.some((issue) => issue.code === "visual-assets-unreferenced" && issue.path === "assets/orphan-visual.png"));
});

test("validateResearchBundle rejects duplicate source ids within or across tracks", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  const duplicateSource = (area: "product" | "visual", asset: string) => ({
    id: "shared-source",
    kind: "inspiration",
    title: `${area} source`,
    url: `https://example.com/${area}`,
    authority: area === "product" ? "primary" : undefined,
    reached: area === "visual" ? true : undefined,
    takeaways: ["A concrete source-grounded design takeaway."],
    assets: [`assets/${asset}`],
  });
  await writeFile(
    join(dir, ".research", "sources.json"),
    JSON.stringify([duplicateSource("product", "product.png"), duplicateSource("product", "product.png")]),
  );
  await writeFile(
    join(dir, ".research", "visual", "sources.json"),
    JSON.stringify([duplicateSource("visual", "visual.png")]),
  );
  await writeFile(
    join(dir, ".research", "research.md"),
    "# Product research\n\nReal users compare alternatives, scan proof, and need a clear primary action before committing. This report cites shared-source as evidence.\n",
  );
  await writeFile(
    join(dir, ".research", "visual", "visual.md"),
    "# Visual research\n\nThe inspected references use restrained contrast and deliberate hierarchy. This report cites shared-source as evidence.\n",
  );

  const result = await validateResearchBundle(dir);

  assert.equal(result.complete, false);
  assert.ok(result.issues.some((issue) => issue.code === "product-source-id-duplicate" && issue.path === "shared-source"));
  assert.ok(result.issues.some((issue) => issue.code === "visual-source-id-duplicate" && issue.path === "shared-source"));
});

test("validateResearchBundle rejects an unsafe direction directory even when its markdown is meaningful", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  await writeMeaningfulDirection(dir, "Unsafe Direction");

  const result = await validateResearchBundle(dir);

  assert.equal(result.complete, false);
  assert.ok(result.issues.some((issue) => issue.code === "direction-slug-unsafe" && issue.path === "Unsafe Direction"));
});

test("validateResearchBundle rejects a source with no evidence takeaway", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  await writeFile(
    join(dir, ".research", "sources.json"),
    JSON.stringify([{ id: "empty", title: "Empty evidence", takeaways: [], assets: ["assets/product.png"] }]),
  );

  const result = await validateResearchBundle(dir);

  assert.equal(result.complete, false);
  assert.ok(result.issues.some((issue) => issue.code === "product-source-takeaways-missing"));
});

test("validateResearchBundle rejects fake media, provenance-free evidence, uncited reports, and vague direction structure", async () => {
  const dir = await project();
  await ensureResearchScaffold(dir);
  await writeCompleteResearchTrack(dir, "product", "product.png");
  await writeCompleteResearchTrack(dir, "visual", "visual.png");
  await writeMeaningfulDirection(dir, "calm-editorial");
  await writeMeaningfulDirection(dir, "focused-console");
  await writeFile(
    join(dir, ".research", "sources.json"),
    JSON.stringify([{ id: "product-source", title: "Unknown", takeaways: ["Claim"], assets: ["assets/product.png"] }]),
  );
  await writeFile(join(dir, ".research", "research.md"), "# Product research\n\nA long but generic report without any source identifier, provenance, or evidence citation despite making product claims for the build.\n");
  await writeFile(join(dir, ".research", "visual", "assets", "visual.png"), "not actually an image");
  await writeFile(
    join(dir, ".research", "visual", "sources.json"),
    JSON.stringify([{ id: "visual-source", title: "Visual", url: "https://example.com/visual", reached: false, takeaways: ["Claim"], assets: ["assets/visual.png"] }]),
  );
  await writeFile(
    join(dir, ".research", "directions", "calm-editorial", "direction.md"),
    "# Calm editorial\n\nThis has enough generic prose to pass a length threshold while omitting the required concept, ordered structure, and distinctive move contract entirely. It keeps talking without defining a buildable direction.\n",
  );

  const result = await validateResearchBundle(dir);
  const codes = result.issues.map((issue) => issue.code);

  assert.equal(result.complete, false);
  assert.ok(codes.includes("product-source-provenance-missing"));
  assert.ok(codes.includes("product-source-authority-unknown"));
  assert.ok(codes.includes("product-report-citation-missing"));
  assert.ok(codes.includes("visual-asset-invalid"));
  assert.ok(codes.includes("visual-source-unreached"));
  assert.ok(codes.includes("direction-structure-missing"));
});
