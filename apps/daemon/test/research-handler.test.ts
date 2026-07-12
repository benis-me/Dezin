import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-research-"));
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

/** Scaffold a .research tree in a (prototype) project's dir and return the project. */
function seedResearch(dataDir: string, store: Store) {
  const project = store.createProject({ name: "P" });
  const r = join(dataDir, "projects", project.id, ".research");
  mkdirSync(join(r, "assets"), { recursive: true });
  mkdirSync(join(r, "directions", "bold"), { recursive: true });
  writeFileSync(join(r, "research.md"), "# Report\n\nKey finding: users skim. ![shot](assets/stripe.png)");
  writeFileSync(join(r, "sources.json"), JSON.stringify([{ id: "s1", kind: "competitor", title: "Stripe", url: "https://stripe.com" }]));
  writeFileSync(join(r, "directions", "bold", "direction.md"), "# Bold direction\n\nBig type.");
  writeFileSync(join(r, "assets", "stripe.png"), "PNGDATA");
  return project;
}

/** Additionally scaffold the .research/visual/ tree (the visual track's deliverables) on an existing project. */
function seedVisualResearch(dataDir: string, projectId: string) {
  const v = join(dataDir, "projects", projectId, ".research", "visual");
  mkdirSync(join(v, "assets"), { recursive: true });
  writeFileSync(join(v, "visual.md"), "# Visual research\n\nMoodboard theme: brutalist mono.");
  writeFileSync(join(v, "sources.json"), JSON.stringify([{ id: "v1", kind: "inspiration", url: "https://dribbble.com/shots/1", designer: "Jane", assets: ["assets/mono.png"] }]));
  writeFileSync(join(v, "assets", "mono.png"), "PNGDATA-VISUAL");
  writeFileSync(join(v, "moodboard.json"), JSON.stringify({ boardId: "board-123" }));
}

test("GET /api/projects/:id/research returns {exists:false} before any research", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { exists: false });
  });
});

test("GET /api/projects/:id/research exposes validation issues for a pre-report partial bundle", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Partial evidence" });
    const root = join(dataDir, "projects", project.id, ".research");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "reference.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    writeFileSync(join(root, "sources.json"), JSON.stringify([{ id: "partial", title: "Partial source", url: "https://example.com", assets: ["assets/reference.png"] }]));

    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    const body = (await res.json()) as { exists: boolean; complete?: boolean; issues?: Array<{ code: string }> };

    assert.equal(body.exists, true);
    assert.equal(body.complete, false);
    assert.ok(body.issues?.some((issue) => issue.code === "product-report-missing"));
  });
});

test("GET /api/projects/:id/research returns the deliverables when .research exists", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      exists: boolean;
      report: string;
      sources: Array<{ title: string }>;
      directions: Array<{ slug: string; title: string; markdown: string }>;
      assets: string[];
    };
    assert.equal(body.exists, true);
    assert.match(body.report, /Key finding: users skim/);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0]!.title, "Stripe");
    assert.equal(body.directions.length, 1);
    assert.equal(body.directions[0]!.slug, "bold");
    assert.equal(body.directions[0]!.title, "Bold direction");
    assert.deepEqual(body.assets, ["assets/stripe.png"]);
  });
});

test("GET /api/projects/:id/research exposes incomplete validation state and concrete issues", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      exists: boolean;
      complete?: boolean;
      issues?: Array<{ area: string; code: string; message: string; path?: string }>;
    };

    assert.equal(body.exists, true);
    assert.equal(body.complete, false);
    assert.ok(body.issues?.length, "partial deliverables must expose their validation failures");
    assert.ok(body.issues?.some((issue) => issue.area === "visual" && issue.code === "visual-report-missing"));
    assert.ok(body.issues?.every((issue) => issue.message.trim().length > 0));
  });
});

test("GET /api/projects/:id/research includes the visual track's deliverables alongside product research", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    seedVisualResearch(dataDir, project.id);
    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      exists: boolean;
      visual?: {
        exists: boolean;
        report: string;
        sources: Array<{ url?: string; designer?: string }>;
        assets: string[];
        boardId?: string;
      };
    };
    assert.equal(body.exists, true);
    assert.ok(body.visual, "expected a visual section on the response");
    assert.equal(body.visual!.exists, true);
    assert.match(body.visual!.report, /Moodboard theme: brutalist mono/);
    assert.equal(body.visual!.sources.length, 1);
    assert.equal(body.visual!.sources[0]!.designer, "Jane");
    assert.deepEqual(body.visual!.assets, ["visual/assets/mono.png"]);
    assert.equal(body.visual!.boardId, "board-123");
  });
});

test("GET /api/projects/:id/research keeps a visual-only partial bundle visible", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Visual only" });
    seedVisualResearch(dataDir, project.id);

    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      exists: boolean;
      report?: string;
      sources?: unknown[];
      visual?: { exists: boolean; report: string; sources: unknown[] };
    };

    assert.equal(body.exists, true, "one durable Research track keeps the tab discoverable");
    assert.equal(body.report, "");
    assert.deepEqual(body.sources, []);
    assert.equal(body.visual?.exists, true);
    assert.match(body.visual?.report ?? "", /brutalist mono/);
    assert.equal(body.visual?.sources.length, 1);
  });
});

test("GET /api/projects/:id/research reports visual.exists === false when only product research exists", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    const body = (await res.json()) as { visual?: { exists: boolean; boardId?: string } };
    assert.ok(body.visual, "expected a visual section even when the visual track hasn't produced anything");
    assert.equal(body.visual!.exists, false);
    assert.equal(body.visual!.boardId, undefined);
  });
});

test("GET /api/projects/:id/research reports the chosen direction once one is picked", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    // Before a pick, no chosen slug is reported.
    const before = (await (await fetch(`${base}/api/projects/${project.id}/research`)).json()) as { chosenSlug?: string };
    assert.equal(before.chosenSlug, undefined);

    // The gate records the pick in .research/chosen.
    writeFileSync(join(dataDir, "projects", project.id, ".research", "chosen"), "bold\n");
    const after = (await (await fetch(`${base}/api/projects/${project.id}/research`)).json()) as { chosenSlug?: string };
    assert.equal(after.chosenSlug, "bold");
  });
});

test("GET /api/projects/:id/research/assets/:name serves a collected image (publicRead)", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    const res = await fetch(`${base}/api/projects/${project.id}/research/assets/stripe.png`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "PNGDATA");
  });
});

test("GET /api/projects/:id/research/visual/assets/:name serves a collected VISUAL image (publicRead)", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    seedVisualResearch(dataDir, project.id);
    const res = await fetch(`${base}/api/projects/${project.id}/research/visual/assets/mono.png`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "PNGDATA-VISUAL");
  });
});
