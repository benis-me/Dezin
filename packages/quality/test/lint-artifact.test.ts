import { test } from "node:test";
import assert from "node:assert/strict";
import { lintArtifact } from "../src/lint-artifact.ts";
import type { Finding } from "../src/types.ts";
import { CLEAN_ARTIFACT, SLOPPY_ARTIFACT } from "./fixtures.ts";

function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.id);
}
function has(findings: Finding[], id: string): boolean {
  return findings.some((f) => f.id === id);
}

test("clean Linear/Vercel artifact produces zero findings", () => {
  const findings = lintArtifact(CLEAN_ARTIFACT);
  assert.deepEqual(findings, [], `expected clean, got: ${JSON.stringify(ids(findings))}`);
});

test("empty or shell-only artifacts are blocking P0", () => {
  for (const html of ["", " \n\t", "<!doctype html><html><head></head><body> </body></html>"]) {
    const findings = lintArtifact(html);
    assert.ok(
      findings.some((f) => f.id === "empty-artifact" && f.severity === "P0"),
      `expected empty-artifact P0 for ${JSON.stringify(html)}`,
    );
  }
});

test("standard mode skips prototype-only iframe and shell checks", () => {
  const standardSurface = `
/* file: index.html */
<div id="root"></div><script type="module" src="/src/main.jsx"></script>
/* file: src/App.jsx */
export default function App() {
  messagesEndRef.current?.scrollIntoView({ block: "end" });
  return <main><h1>Chat</h1><p>Real React content renders from source.</p></main>;
}
`;
  const standardFindings = lintArtifact(standardSurface, { mode: "standard" });
  assert.ok(!has(standardFindings, "empty-artifact"), "Vite shell should not be treated as an empty artifact");
  assert.ok(!has(standardFindings, "scroll-into-view"), "app-local scrollIntoView is valid in standard dev-server mode");

  const prototypeFindings = lintArtifact(`<script>messagesEndRef.current.scrollIntoView()</script>`);
  assert.ok(has(prototypeFindings, "empty-artifact"), "prototype mode still blocks shell-only output");
  assert.ok(has(prototypeFindings, "scroll-into-view"), "prototype iframe mode still blocks document scroll hijacking");
});

test("sloppy artifact trips the cardinal sins", () => {
  const f = lintArtifact(SLOPPY_ARTIFACT);
  assert.ok(has(f, "ai-default-indigo"), "indigo");
  assert.ok(has(f, "purple-gradient"), "purple gradient");
  assert.ok(has(f, "emoji-icon"), "emoji icon");
  assert.ok(has(f, "sans-display"), "sans display");
  assert.ok(has(f, "left-accent-card"), "left accent card");
  assert.ok(has(f, "invented-metric"), "invented metric");
  assert.ok(has(f, "filler-copy"), "filler copy");
  // P0s sort first
  assert.equal(f[0]?.severity, "P0");
});

test("indigo escape hatch: :root --accent passes, laundering fails", () => {
  const intentional = `<style>:root { --accent: #6366f1; }</style><a style="color: var(--accent)">x</a>`;
  assert.ok(!has(lintArtifact(intentional), "ai-default-indigo"), "intentional --accent should pass");

  const laundered = `<style>:root { --primary: #6366f1; }</style>`;
  assert.ok(has(lintArtifact(laundered), "ai-default-indigo"), "indigo via --primary should fire");

  const componentScope = `<style>.cta { color: #6366f1; }</style>`;
  assert.ok(has(lintArtifact(componentScope), "ai-default-indigo"), "indigo in a component selector should fire");

  const mixedSelector = `<style>:root, .cta { --accent: #6366f1; }</style>`;
  assert.ok(has(lintArtifact(mixedSelector), "ai-default-indigo"), "non-pure selector list should fire");
});

test("blue→cyan trust gradient is caught even with no indigo", () => {
  const html = `<style>.hero { background: linear-gradient(90deg, #3b82f6, #06b6d4); }</style>`;
  assert.ok(has(lintArtifact(html), "trust-gradient"));
});

test("color checks normalize equivalent CSS color syntaxes and Tailwind classes", () => {
  assert.ok(has(lintArtifact(`<style>.hero { color: rgb(99, 102, 241); }</style>`), "ai-default-indigo"));
  assert.ok(has(lintArtifact(`<style>.hero { color: hsl(239 84% 67%); }</style>`), "ai-default-indigo"));
  assert.ok(has(lintArtifact(`<style>.hero { color: oklch(0.585 0.233 277.117); }</style>`), "ai-default-indigo"));
  assert.ok(has(lintArtifact(`<div class="bg-indigo-500 text-white">Launch</div>`), "ai-default-indigo"));
});

test("gradient checks cover nested colors plus radial and conic gradients", () => {
  assert.ok(has(lintArtifact(`<style>.hero { background: radial-gradient(circle, rgb(99, 102, 241), white); }</style>`), "purple-gradient"));
  assert.ok(has(lintArtifact(`<style>.hero { background: conic-gradient(from 90deg, #3b82f6, #06b6d4); }</style>`), "trust-gradient"));
});

test("emoji only flagged in structural context, not body prose", () => {
  const inHeading = `<h2>🚀 Launch</h2>`;
  assert.ok(has(lintArtifact(inHeading), "emoji-icon"));
  const inProse = `<p>We launched today 🚀 and it went well.</p>`;
  assert.ok(!has(lintArtifact(inProse), "emoji-icon"));
});

test("ALL-CAPS tracking: literal value", () => {
  const bad = `<style>.eyebrow { text-transform: uppercase; font-size: 14px; }</style>`;
  assert.ok(has(lintArtifact(bad), "all-caps-no-tracking"), "missing letter-spacing should fire");

  const good = `<style>.eyebrow { text-transform: uppercase; letter-spacing: 0.08em; }</style>`;
  assert.ok(!has(lintArtifact(good), "all-caps-no-tracking"), "0.08em should pass");

  const tooTight = `<style>.eyebrow { text-transform: uppercase; letter-spacing: 0.02em; }</style>`;
  assert.ok(has(lintArtifact(tooTight), "all-caps-no-tracking"), "0.02em is below the 0.06 floor");
});

test("ALL-CAPS tracking: px converted against font-size", () => {
  // 1px at 40px font-size = 0.025em → fails; 3px at 40px = 0.075em → passes.
  const fail = `<style>.h { text-transform: uppercase; letter-spacing: 1px; font-size: 40px; }</style>`;
  assert.ok(has(lintArtifact(fail), "all-caps-no-tracking"));
  const pass = `<style>.h { text-transform: uppercase; letter-spacing: 3px; font-size: 40px; }</style>`;
  assert.ok(!has(lintArtifact(pass), "all-caps-no-tracking"));
});

test("ALL-CAPS tracking: resolves var() across a dark theme too", () => {
  const html = `<style>
    :root { --tk: 0.08em; }
    [data-theme="dark"] { --tk: 0.02em; }
    .label { text-transform: uppercase; letter-spacing: var(--tk); font-size: 12px; }
  </style>`;
  // Light theme passes but dark theme is 0.02em → conservative check fails overall.
  assert.ok(has(lintArtifact(html), "all-caps-no-tracking"));
});

test("accent overuse cap is stricter in Dezin (default 3)", () => {
  const body = Array.from({ length: 5 }, () => `<i style="color: var(--accent)"></i>`).join("");
  const html = `<style>:root{--accent:#2563eb}</style>${body}`;
  assert.ok(has(lintArtifact(html), "accent-overuse"), "5 accent uses > cap 3");
  assert.ok(!has(lintArtifact(html, { accentOveruseCap: 6 }), "accent-overuse"), "cap 6 allows 5");
});

test("Dezin extension: shadow-only card prefers a border", () => {
  const shadow = `<style>.card { border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }</style>`;
  assert.ok(has(lintArtifact(shadow), "dezin-shadow-card"));
  const bordered = `<style>.card { border-radius: 10px; border: 1px solid var(--border); }</style>`;
  assert.ok(!has(lintArtifact(bordered), "dezin-shadow-card"));
  // overlays are exempt
  const dropdown = `<style>.dropdown-card { box-shadow: 0 8px 24px rgba(0,0,0,0.2); }</style>`;
  assert.ok(!has(lintArtifact(dropdown), "dezin-shadow-card"));
});

test("Dezin extension: gradient-clipped text", () => {
  const html = `<style>.title { background: linear-gradient(90deg, #2563eb, #1d4ed8); -webkit-background-clip: text; }</style>`;
  assert.ok(has(lintArtifact(html), "dezin-gradient-text"));
});

test("Dezin extension: oversized radius (non-pill) is P2", () => {
  const html = `<style>.box { border-radius: 48px; }</style>`;
  const f = lintArtifact(html);
  assert.ok(f.some((x) => x.id === "dezin-oversized-radius" && x.severity === "P2"));
  const pill = `<style>.chip { border-radius: 999px; }</style>`;
  assert.ok(!lintArtifact(pill).some((x) => x.id === "dezin-oversized-radius"));
});

test("external image CDN flagged P1", () => {
  const html = `<img src="https://images.unsplash.com/photo-123" alt="x">`;
  assert.ok(has(lintArtifact(html), "external-image"));
});

test("deck check only runs with isDeck", () => {
  const html = `<section class="slide"><h1>x</h1></section>`;
  assert.ok(!lintArtifact(html).some((x) => x.id === "slide-theme-missing"));
  assert.ok(lintArtifact(html, { isDeck: true }).some((x) => x.id === "slide-theme-missing"));
});

test("disableDezinRules drops only the Dezin extensions", () => {
  const html = `<style>.card { border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }</style>`;
  assert.ok(!lintArtifact(html, { disableDezinRules: true }).some((x) => x.id.startsWith("dezin-")));
});

test("typography craft: text-align: justify is flagged", () => {
  assert.ok(has(lintArtifact(`<style>.prose { text-align: justify; }</style>`), "text-justify"));
  assert.ok(!has(lintArtifact(`<style>.prose { text-align: left; }</style>`), "text-justify"));
});

test("a11y: more than one <h1> is flagged", () => {
  assert.ok(has(lintArtifact(`<h1>A</h1><section><h1>B</h1></section>`), "multiple-h1"));
  assert.ok(!has(lintArtifact(`<h1>A</h1><h2>B</h2>`), "multiple-h1"));
});

test("a11y: clickable div without role is flagged; a real button passes", () => {
  assert.ok(has(lintArtifact(`<div onclick="go()">Buy</div>`), "div-as-button"));
  assert.ok(!has(lintArtifact(`<div role="button" tabindex="0" onclick="go()">Buy</div>`), "div-as-button"));
  assert.ok(!has(lintArtifact(`<button onclick="go()">Buy</button>`), "div-as-button"));
});

test("a11y: positive tabindex is flagged (P2)", () => {
  assert.ok(has(lintArtifact(`<input tabindex="3">`), "positive-tabindex"));
  assert.ok(!has(lintArtifact(`<input tabindex="0">`), "positive-tabindex"));
  assert.ok(!has(lintArtifact(`<input tabindex="-1">`), "positive-tabindex"));
});

test("animation-discipline: decorative motion needs a prefers-reduced-motion guard", () => {
  const anim = `<style>@keyframes spin { to { transform: rotate(360deg); } } .x { animation: spin 2s linear infinite; }</style>`;
  assert.ok(has(lintArtifact(anim), "no-reduced-motion"));
  const guarded = `${anim}<style>@media (prefers-reduced-motion: reduce) { .x { animation: none; } }</style>`;
  assert.ok(!has(lintArtifact(guarded), "no-reduced-motion"), "a reduced-motion guard clears it");
  const hoverOnly = `<style>.btn { transition: background 0.2s ease; }</style>`;
  assert.ok(!has(lintArtifact(hoverOnly), "no-reduced-motion"), "a bare hover transition does not fire");
});

test("color craft: dark theme must not use pure black/white", () => {
  assert.ok(has(lintArtifact(`<style>[data-theme="dark"] { background: #000; }</style>`), "dark-pure-black"));
  assert.ok(has(lintArtifact(`<style>.dark { color: #ffffff; }</style>`), "dark-pure-black"));
  assert.ok(!has(lintArtifact(`<style>[data-theme="dark"] { background: #0a0a0a; color: #f2f2f2; }</style>`), "dark-pure-black"));
  // a pure-white background in a LIGHT context is fine
  assert.ok(!has(lintArtifact(`<style>:root { --bg: #ffffff; }</style>`), "dark-pure-black"));
});

test("flags bounce/overshoot easing in source CSS (frozen out of computed style, so linted here)", () => {
  const html = `<style>.card{transition:transform .3s cubic-bezier(0.68,-0.55,0.27,1.55)}</style><div class="card"></div>`;
  assert.ok(ids(lintArtifact(html)).includes("bounce-easing"));
});

test("does not flag a well-behaved ease-out curve", () => {
  const html = `<style>.card{transition:transform .3s cubic-bezier(0.22,1,0.36,1)}</style><div class="card"></div>`;
  assert.equal(ids(lintArtifact(html)).includes("bounce-easing"), false);
});

test("provider tells: repeating-gradient stripes flagged for GPT, not others", () => {
  const html = `<style>.hero{background:repeating-linear-gradient(45deg,#eee 0 10px,#fff 10px 20px)}</style><div class="hero">x</div>`;
  assert.ok(ids(lintArtifact(html, { provider: "gpt" })).includes("repeating-stripes"));
  assert.equal(ids(lintArtifact(html, { provider: "claude" })).includes("repeating-stripes"), false);
});

test("provider tells: codex grid-overlay background flagged for GPT", () => {
  const html = `<style>.grid{background-image:linear-gradient(to right,#eee 1px,transparent 1px),linear-gradient(to bottom,#eee 1px,transparent 1px);background-size:24px 24px}</style><div class="grid">x</div>`;
  assert.ok(ids(lintArtifact(html, { provider: "gpt" })).includes("codex-grid-background"));
});

test("provider tells: img:hover transform flagged for Gemini, not others", () => {
  const html = `<style>.card img:hover{transform:scale(1.05)}</style><div class="card"><img src="a.png" alt="a"></div>`;
  assert.ok(ids(lintArtifact(html, { provider: "gemini" })).includes("image-hover-transform"));
  assert.equal(ids(lintArtifact(html, { provider: "gpt" })).includes("image-hover-transform"), false);
});

test("copy audit: flags marketing cliches, not plain product copy", () => {
  assert.ok(ids(lintArtifact(`<h1>Elevate your workflow</h1><p>A seamless, world-class experience.</p>`)).includes("marketing-cliche"));
  assert.equal(ids(lintArtifact(`<h1>Track your expenses</h1><p>See where your money goes each month.</p>`)).includes("marketing-cliche"), false);
});

test("copy audit: flags manufactured-contrast cadence repeated 3+ times", () => {
  assert.ok(ids(lintArtifact(`<p>Fast. No waiting. Simple. No clutter. Clear. No noise.</p>`)).includes("aphoristic-cadence"));
});

test("copy audit: flags em-dash overuse but not a single em-dash", () => {
  assert.ok(ids(lintArtifact(`<p>This — that — and the other — plus one more — really.</p>`)).includes("em-dash-overuse"));
  assert.equal(ids(lintArtifact(`<p>This — is perfectly fine.</p>`)).includes("em-dash-overuse"), false);
});
