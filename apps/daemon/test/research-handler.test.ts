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

test("GET /api/projects/:id/research returns {exists:false} before any research", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const res = await fetch(`${base}/api/projects/${project.id}/research`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { exists: false });
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

test("GET /api/projects/:id/research/assets/:name serves a collected image (publicRead)", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = seedResearch(dataDir, store);
    const res = await fetch(`${base}/api/projects/${project.id}/research/assets/stripe.png`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "PNGDATA");
  });
});
