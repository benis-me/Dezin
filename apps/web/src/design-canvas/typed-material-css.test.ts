import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/design-canvas/typed-material.css"), "utf8");

test("code previews use a compact gutter and dense source rhythm", () => {
  expect(css).toMatch(/\.design-typed-material__highlight,\s*\.design-typed-material__editor-highlight\s*\{[^}]*34px/s);
  expect(css).toMatch(/:where\(\.design-typed-material__highlight, \.design-typed-material__editor-highlight\) \.th-code\s*\{[^}]*padding:\s*10px 14px 14px 0;[^}]*line-height:\s*1\.52;/s);
  expect(css).toMatch(/:where\(\.design-typed-material__highlight, \.design-typed-material__editor-highlight\) \.th-line::before\s*\{[^}]*width:\s*34px;[^}]*padding-right:\s*8px;/s);
});

test("the focused editor preserves the canvas code rhythm and line-number gutter", () => {
  expect(css).toMatch(/:where\(\.design-typed-material__highlight, \.design-typed-material__editor-highlight\) \.th-code\s*\{[^}]*padding:\s*10px 14px 14px 0;[^}]*font-size:\s*clamp\(10\.5px, 0\.86vw, 12\.5px\);[^}]*line-height:\s*1\.52;/s);
  expect(css).toMatch(/:where\(\.design-typed-material__highlight, \.design-typed-material__editor-highlight\) \.th-line::before\s*\{[^}]*width:\s*34px;[^}]*padding-right:\s*8px;/s);
  expect(css).toMatch(/\.design-typed-material__editor-header\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*3;/s);
  expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*\.design-typed-material__editor-header\s*\{[^}]*background:\s*var\(--card\);[^}]*backdrop-filter:\s*none;/s);
  expect(css).toMatch(/@media \(prefers-contrast: more\)[\s\S]*\.design-typed-material__editor-header\s*\{[^}]*border-color:\s*var\(--foreground\);[^}]*backdrop-filter:\s*none;/s);
  expect(css).toMatch(/\.design-typed-material__editor-highlight\s*\{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none;/s);
  expect(css).toMatch(/\.design-typed-material__textarea\s*\{[^}]*padding:\s*10px 14px 14px;[^}]*font-size:\s*clamp\(10\.5px, 0\.86vw, 12\.5px\);[^}]*line-height:\s*1\.52;/s);
  expect(css).toMatch(/\.design-typed-material__textarea\[data-syntax-highlighted="true"\]\s*\{[^}]*padding-left:\s*34px;[^}]*color:\s*transparent;[^}]*-webkit-text-fill-color:\s*transparent;/s);
});
