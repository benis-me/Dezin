import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/design-canvas/design-canvas.css"), "utf8");

test("generated Nodes use a morphing two-layer dot field with a reduced-motion fallback", () => {
  expect(css).toMatch(/\.design-canvas-node__generation-field,\s*\.design-canvas-node__generation-glow\s*\{[^}]*background-size:\s*11px 11px;/s);
  expect(css).toMatch(/\.design-canvas-node__generation-field\s*\{[^}]*radial-gradient\([^}]*0\.7px,/s);
  expect(css).toMatch(/\.design-canvas-node__generation-glow\s*\{[^}]*mask-image:[^}]*radial-gradient[^}]*design-canvas-generation-morph 4\.2s[^}]*design-canvas-generation-breathe 1\.9s/s);
  expect(css).toContain("@keyframes design-canvas-generation-morph");
  expect(css).toContain("@keyframes design-canvas-generation-breathe");
  expect(css).toMatch(/\.design-canvas-node__working-dots\s*\{[^}]*width:\s*30px;[^}]*height:\s*22px;/s);
  expect(css).toMatch(/\.design-canvas-node__working-dots \.design-canvas-node__generation-glow\s*\{[^}]*--design-generation-glow:\s*22px;/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-node__generation-glow,[\s\S]*animation:\s*none !important;/s);
});
