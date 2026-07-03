/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");

test("shiny text animation uses a seamless repeatable gradient", () => {
  expect(css).toMatch(/@keyframes dezin-shiny-text[\s\S]*0%\s*{[\s\S]*background-position:\s*0%\s+50%/);
  expect(css).toMatch(/@keyframes dezin-shiny-text[\s\S]*100%\s*{[\s\S]*background-position:\s*200%\s+50%/);
  expect(css).toMatch(/\.shiny-text\s*{[\s\S]*repeating-linear-gradient/);
  expect(css).toMatch(/\.shiny-text\s*{[\s\S]*background-size:\s*200%\s+100%/);
});
