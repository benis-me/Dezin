import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/design-canvas/design-canvas.css"), "utf8");

test("Design Canvas CSS consumes full-color tokens without invalid hsl wrappers", () => {
  expect(css).not.toContain("hsl(var(--");
  expect(css).toContain("var(--background)");
  expect(css).toContain("color-mix(in oklch");
});

test("Design Canvas owns the full shell flex slot", () => {
  expect(css).toMatch(
    /\.design-canvas-root\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto;/s,
  );
});

test("Design Canvas keeps native titlebar and floating feedback geometry stable", () => {
  expect(css).toMatch(/\.design-canvas-topbar\s*\{[^}]*height:\s*36px\s*!important;[^}]*min-height:\s*36px\s*!important;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*position:\s*relative;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-notice\s*\{[^}]*position:\s*absolute;/s);
});

test("selected Nodes use a gap outline and discoverable corner brackets instead of a resizer box", () => {
  expect(css).toMatch(/\.design-canvas-node::after\s*\{[^}]*inset:\s*-3px;[^}]*border-radius:\s*15px;/s);
  expect(css).toMatch(/\.design-canvas-node--selected::after\s*\{[^}]*border-color:/s);
  expect(css).toMatch(/\.design-canvas-node__resize-corner\s*\{[^}]*opacity:\s*0;/s);
  expect(css).toContain(".design-canvas-node__resize-control:hover .design-canvas-node__resize-corner");
  expect(css).not.toContain(".react-flow__resize-control.line { border-color");
});

test("Agent header is compact and does not reserve an ornamental mark", () => {
  expect(css).toMatch(/\.design-canvas-agent__header\s*\{[^}]*height:\s*40px;[^}]*min-height:\s*40px;/s);
  expect(css).not.toContain(".design-canvas-agent__mark");
});

test("Agent composer grows within explicit bounds without a separator above it", () => {
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*padding:\s*0 9px 9px;[^}]*background:/s);
  expect(css).not.toMatch(/\.design-canvas-agent__composer\s*\{[^}]*border-top:/s);
  expect(css).toMatch(/\.design-canvas-agent__composer textarea\s*\{[^}]*max-height:\s*160px;[^}]*min-height:\s*62px;/s);
});

test("Agent Job cards reserve red surfaces for failures", () => {
  expect(css).toMatch(/\.design-canvas-agent__activity\[data-status="ready"\][^\{]*\{[^}]*background:\s*var\(--card\);/s);
  expect(css).toMatch(/\.design-canvas-agent__activity\[data-status="failed"\]\s*\{[^}]*var\(--destructive\)[^}]*background:/s);
  expect(css).not.toMatch(/\.design-canvas-agent__activity\[data-status="(?:running|ready)"\][^{]*\{[^}]*background:[^;}]*var\(--destructive\)/s);
});

test("Node catalog animation follows the Radix open and closed lifecycle", () => {
  expect(css).toContain('.design-node-catalog[data-state="open"]');
  expect(css).toContain('.design-node-catalog[data-state="closed"]');
  expect(css).toContain("@keyframes design-canvas-menu-in");
  expect(css).toContain("@keyframes design-canvas-menu-out");
});
