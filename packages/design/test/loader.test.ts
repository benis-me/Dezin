import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDesignSystems, defaultDesignDir, defaultRegistry } from "../src/index.ts";

const AI_INDIGO = ["#6366f1", "#4f46e5", "#4338ca", "#3730a3", "#8b5cf6", "#7c3aed", "#a855f7"];

test("loads all bundled design systems (33) including both batches", () => {
  const systems = loadDesignSystems(defaultDesignDir());
  assert.equal(systems.length, 33, `got ${systems.map((s) => s.id).join(",")}`);
  for (const id of ["modern-minimal", "cursor", "stripe", "shadcn", "github", "mono", "claude", "openai", "kami", "figma", "supabase", "framer", "airbnb", "spotify", "revolut", "posthog", "retool", "anthropic"]) {
    assert.ok(systems.some((s) => s.id === id), `missing design system ${id}`);
  }
});

test("each system has a 9-section DESIGN.md, A1 tokens, and a name/craft", () => {
  for (const s of loadDesignSystems()) {
    const sections = s.designMd.match(/^## \d\./gm) ?? [];
    assert.equal(sections.length, 9, `${s.id} should have 9 sections, got ${sections.length}`);
    for (const t of ["--bg", "--fg", "--accent", "--font-display"]) {
      assert.ok(s.tokensCss.includes(t), `${s.id} tokens missing ${t}`);
    }
    assert.ok(s.name.length > 0, `${s.id} has a name`);
    assert.ok(s.craft.applies.length > 0, `${s.id} has craft.applies`);
  }
});

test("taste guard: no Tailwind-indigo accent; no pure black/white in dark", () => {
  for (const s of loadDesignSystems()) {
    const accent = (s.tokensCss.match(/--accent:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? "").toLowerCase();
    assert.ok(!AI_INDIGO.includes(accent), `${s.id} uses AI-default indigo accent ${accent}`);
    const dark = s.tokensCss.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.ok(!/#000000|#ffffff/i.test(dark), `${s.id} dark theme uses pure black/white`);
  }
});

test("defaultRegistry lists all systems with modern-minimal as default", () => {
  const reg = defaultRegistry();
  assert.equal(reg.list().length, 33);
  assert.equal(reg.default().id, "modern-minimal");
  assert.equal(reg.get("editorial")?.category, "Editorial & Print");
  assert.equal(reg.get("stripe")?.category, "Fintech & SaaS");
});
