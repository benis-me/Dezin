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
