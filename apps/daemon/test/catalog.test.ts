import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { DesignRegistry, BUNDLED_DESIGN_SYSTEMS } from "../../../packages/design/src/index.ts";
import { createApp } from "../src/index.ts";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const store = new Store(":memory:");
  const designRegistry = new DesignRegistry([...BUNDLED_DESIGN_SYSTEMS]);
  const server = createApp({ store, dataDir: mkdtempSync(join(tmpdir(), "dezin-cat-")), designRegistry });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("GET /api/design-systems returns a light list (no full DESIGN.md/tokens)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/design-systems`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    assert.equal(list.length, 33);
    const ids = list.map((d) => d.id);
    for (const id of ["modern-minimal", "cursor", "stripe", "shadcn", "claude", "openai", "airbnb", "spotify"]) {
      assert.ok(ids.includes(id), `expected /api/design-systems to include ${id}`);
    }
    for (const d of list) {
      assert.ok(typeof d.id === "string" && typeof d.name === "string");
      assert.ok(typeof d.category === "string");
      assert.ok(!("designMd" in d), "must not include the full DESIGN.md");
      assert.ok(!("tokensCss" in d), "must not include tokens");
      const sw = d.swatch as Record<string, string>;
      assert.ok(sw && sw.bg && sw.surface && sw.fg && sw.accent, `${d.id} has a 4-color swatch`);
    }
  });
});

test("POST /api/design-systems/import generates + registers a brand system", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/design-systems/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme Labs", accent: "#ff5a1f", displayFont: "Cabinet Grotesk", vibe: "Bold and warm." }),
    });
    assert.equal(res.status, 201);
    const card = (await res.json()) as Record<string, unknown>;
    assert.equal(card.id, "acme-labs");
    assert.equal((card.swatch as Record<string, string>).accent, "#ff5a1f");

    // It now appears in the list (registered live) and detail returns the generated DESIGN.md.
    const list = (await (await fetch(`${base}/api/design-systems`)).json()) as Array<{ id: string }>;
    assert.ok(list.some((d) => d.id === "acme-labs"));
    const detail = (await (await fetch(`${base}/api/design-systems/acme-labs`)).json()) as { tokensCss: string };
    assert.ok(detail.tokensCss.includes("--accent: #ff5a1f;"));

    // Bad input → 400; duplicate → 409.
    assert.equal((await fetch(`${base}/api/design-systems/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", accent: "notacolor" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/design-systems/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Acme Labs", accent: "#000000" }) })).status, 409);
  });
});

test("GET /api/design-systems/:id returns the full system; 404 on unknown", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/design-systems/modern-minimal`);
    assert.equal(res.status, 200);
    const sys = (await res.json()) as Record<string, unknown>;
    assert.equal(sys.id, "modern-minimal");
    assert.ok(typeof sys.designMd === "string" && (sys.designMd as string).includes("## 1."));
    assert.ok(typeof sys.tokensCss === "string" && (sys.tokensCss as string).includes("--accent"));
    assert.ok((sys.swatch as Record<string, string>).accent);

    const miss = await fetch(`${base}/api/design-systems/nope`);
    assert.equal(miss.status, 404);
  });
});

test("GET /api/skills returns a light list (no body)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/skills`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    assert.equal(list.length, 21);
    const ids = list.map((s) => s.id);
    for (const id of ["frontend-design", "deck", "pricing-page", "blog-post", "faq", "component-library", "design-tokens", "settings-page", "status-page", "onboarding-flow"]) {
      assert.ok(ids.includes(id), `expected /api/skills to include ${id}`);
    }
    for (const s of list) {
      assert.ok(typeof s.id === "string" && typeof s.name === "string");
      assert.ok(typeof s.mode === "string");
      assert.ok(Array.isArray(s.triggers));
      assert.ok(!("body" in s), "must not include the skill body");
    }
  });
});
