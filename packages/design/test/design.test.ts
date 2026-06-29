import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultRegistry,
  DEFAULT_DESIGN_SYSTEM_ID,
  modernMinimal,
} from "../src/index.ts";
// Cross-package import via relative path (no install; hermetic loop).
import { lintArtifact } from "../../quality/src/index.ts";

test("registry resolves the default and bundled systems", () => {
  const reg = defaultRegistry();
  assert.equal(reg.default().id, DEFAULT_DESIGN_SYSTEM_ID);
  assert.ok(reg.has("modern-minimal"));
  assert.equal(reg.get("nope"), null);
  assert.ok(reg.list().length >= 1);
});

test("registry.register overrides by id", () => {
  const reg = defaultRegistry();
  reg.register({ ...modernMinimal, id: "modern-minimal", name: "Tweaked" });
  assert.equal(reg.get("modern-minimal")?.name, "Tweaked");
});

test("DESIGN.md has all nine sections", () => {
  const headings = modernMinimal.designMd.match(/^## \d\./gm) ?? [];
  assert.equal(headings.length, 9, `expected 9 sections, got ${headings.length}`);
});

test("tokens declare the A1-identity tokens", () => {
  for (const t of ["--bg", "--fg", "--accent", "--font-display"]) {
    assert.ok(modernMinimal.tokensCss.includes(t), `missing ${t}`);
  }
});

test("the default brand does NOT trip its own linter", () => {
  const artifact = `<!doctype html>
<html lang="en" data-theme="light">
<head><meta charset="utf-8">
<style>
${modernMinimal.tokensCss}
body { background: var(--bg); color: var(--fg); font-family: var(--font-body); }
h1 { font-family: var(--font-display); font-size: 32px; font-weight: 590; letter-spacing: -0.02em; }
.eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.btn-primary { background: var(--accent); color: var(--accent-fg); border-radius: var(--radius); }
</style>
</head>
<body>
  <section data-od-id="hero">
    <p class="eyebrow">Changelog</p>
    <h1>Ship design, not slop</h1>
    <p>Real copy in plain language describing what the product does.</p>
    <a class="btn-primary" href="#start">Start building</a>
  </section>
  <section data-od-id="features">
    <div class="card"><h2>Token-aware</h2><p>It honours the active design system.</p></div>
  </section>
</body>
</html>`;
  const findings = lintArtifact(artifact);
  assert.deepEqual(
    findings.map((f) => f.id),
    [],
    `default brand should produce zero findings; got: ${JSON.stringify(findings.map((f) => `${f.severity}:${f.id}`))}`,
  );
});

test("craft.applies includes the anti-slop core", () => {
  for (const c of ["typography", "color", "anti-ai-slop"]) {
    assert.ok(modernMinimal.craft.applies.includes(c), `craft missing ${c}`);
  }
});
