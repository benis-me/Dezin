import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/design-canvas/design-canvas.css"), "utf8");
const particleCss = readFileSync(join(process.cwd(), "src/design-canvas/generation-particles.css"), "utf8");

test("generated Nodes use a morphing two-layer dot field with a reduced-motion fallback", () => {
  expect(css).toMatch(/\.design-canvas-node__generation-field,\s*\.design-canvas-node__generation-glow\s*\{[^}]*background-size:\s*11px 11px;/s);
  expect(css).toMatch(/\.design-canvas-node__generation-field\s*\{[^}]*radial-gradient\([^}]*0\.7px,/s);
  expect(css).toMatch(/\.design-canvas-node__generation-glow\s*\{[^}]*mask-image:[^}]*radial-gradient[^}]*will-change:\s*transform, opacity;[^}]*design-canvas-generation-morph 4\.8s linear[^}]*design-canvas-generation-breathe 1\.9s/s);
  expect(css).toContain("@keyframes design-canvas-generation-morph");
  expect(css).toContain("@keyframes design-canvas-generation-breathe");
  const morphFrames = css.slice(
    css.indexOf("@keyframes design-canvas-generation-morph"),
    css.indexOf("@keyframes design-canvas-generation-breathe"),
  );
  expect(morphFrames).toContain("transform: translate3d");
  expect(morphFrames).not.toMatch(/mask-(?:position|size)/);
  expect(css).toMatch(/\.design-canvas-node__working-dots\s*\{[^}]*width:\s*30px;[^}]*height:\s*22px;/s);
  expect(css).toMatch(/\.design-canvas-node__working-dots \.design-canvas-node__generation-glow\s*\{[^}]*--design-generation-glow:\s*22px;/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-node__generation-glow,[\s\S]*animation:\s*none !important;/s);
});

test("job-seeded generation particles animate only compositor properties and become static for reduced motion", () => {
  expect(particleCss).toContain(".design-canvas-node__generation-particle");
  expect(particleCss).toContain("@keyframes design-canvas-generation-particle-drift");

  const keyframes = particleCss.slice(
    particleCss.indexOf("@keyframes design-canvas-generation-particle-drift"),
    particleCss.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  expect(keyframes).toMatch(/transform:\s*translate3d/);
  expect(keyframes).toMatch(/opacity:/);
  expect(keyframes).not.toMatch(/(?:top|right|bottom|left|width|height|filter|background|mask-(?:position|size))\s*:/);

  expect(particleCss).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.design-canvas-node__generation-particle\s*\{[^}]*animation:\s*none !important;[^}]*transform:\s*translate3d\(0, 0, 0\) scale\(1\);[^}]*opacity:\s*var\(--generation-particle-static-opacity\);/s,
  );
  expect(particleCss).toMatch(
    /\[data-generation-motion="paused"\] \.design-canvas-node__generation-particle\s*\{[^}]*animation:\s*none !important;/s,
  );
  expect(particleCss).toMatch(
    /\[data-generation-motion="paused"\] \.design-canvas-node__generation-glow\s*\{[^}]*animation:\s*none !important;[^}]*will-change:\s*auto;/s,
  );
});
