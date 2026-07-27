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

test("resize separators expose a real pointer target in both orientations without consuming extra layout", () => {
  const style = document.createElement("style");
  const separatorStylesStart = css.indexOf(".dezin-resize-separator");
  const separatorStylesEnd = css.indexOf("/* Custom scrollbars", separatorStylesStart);
  style.textContent = css.slice(separatorStylesStart, separatorStylesEnd);
  document.head.append(style);
  const vertical = document.createElement("div");
  vertical.className = "dezin-resize-separator";
  vertical.setAttribute("aria-orientation", "vertical");
  const horizontal = document.createElement("div");
  horizontal.className = "dezin-resize-separator";
  horizontal.setAttribute("aria-orientation", "horizontal");
  document.body.append(vertical, horizontal);

  try {
    const verticalStyle = getComputedStyle(vertical);
    expect(verticalStyle.width).toBe("9px");
    expect(verticalStyle.marginInline).toBe("-4px");
    expect(verticalStyle.cursor).toBe("col-resize");

    const horizontalStyle = getComputedStyle(horizontal);
    expect(horizontalStyle.height).toBe("9px");
    expect(horizontalStyle.marginBlock).toBe("-4px");
    expect(horizontalStyle.cursor).toBe("row-resize");
  } finally {
    vertical.remove();
    horizontal.remove();
    style.remove();
  }
});
