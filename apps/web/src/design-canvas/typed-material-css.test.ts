import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/design-canvas/typed-material.css"), "utf8");

test("code previews use a compact gutter and dense source rhythm", () => {
  expect(css).toMatch(/\.design-typed-material__highlight\s*\{[^}]*34px/s);
  expect(css).toMatch(/\.design-typed-material__highlight \.th-code\s*\{[^}]*padding:\s*10px 14px 14px 0;[^}]*line-height:\s*1\.52;/s);
  expect(css).toMatch(/\.design-typed-material__highlight \.th-line::before\s*\{[^}]*width:\s*34px;[^}]*padding-right:\s*8px;/s);
});

test("the focused code editor keeps syntax tokens aligned under its textarea", () => {
  expect(css).toMatch(/\.design-typed-material__editor-header\s*\{[^}]*min-height:\s*38px;/s);
  expect(css).toMatch(/\.design-typed-material__editor-highlight\s*\{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none;/s);
  expect(css).toMatch(/\.design-typed-material__editor-highlight \.th-code\s*\{[^}]*padding:\s*14px 16px;[^}]*line-height:\s*1\.55;/s);
  expect(css).toMatch(/\.design-typed-material__textarea\s*\{[^}]*padding:\s*14px 16px;[^}]*line-height:\s*1\.55;/s);
  expect(css).toMatch(/\.design-typed-material__textarea\[data-syntax-highlighted="true"\]\s*\{[^}]*color:\s*transparent;[^}]*-webkit-text-fill-color:\s*transparent;/s);
});
