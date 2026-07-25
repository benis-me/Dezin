import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(`${process.cwd()}/src/project-studio/canvas/project-canvas.css`, "utf8");
const projectCanvas = readFileSync(`${process.cwd()}/src/project-studio/canvas/ProjectCanvas.tsx`, "utf8");

describe("canvas visual interaction contract", () => {
  test("hover never replaces the stronger selected-card treatment", () => {
    expect(css).toMatch(/\.dezin-flow-card:not\(\[data-selected\]\):hover\s*\{/);
    expect(css).not.toMatch(/\.dezin-flow-card:hover\s*\{/);
  });

  test("collapsed component groups keep their fixed 48px shell at overview zoom", () => {
    expect(css).toMatch(
      /\.dezin-flow-group\[data-role="component-library"\]\[data-zoom="overview"\]:not\(\[data-collapsed\]\) \.dezin-flow-group__header\s*\{/,
    );
    expect(css).toMatch(
      /\.dezin-flow-group\[data-zoom="overview"\]:not\(\[data-collapsed\]\) \.dezin-flow-group__system-icon\s*\{/,
    );
  });

  test("compact artifact cards center their title in the remaining fixed-height body", () => {
    expect(css).toMatch(
      /\.dezin-flow-card\[data-zoom="compact"\] \.dezin-flow-card__body\s*\{[^}]*display:\s*grid;[^}]*height:\s*calc\(100% - 126px\);[^}]*align-content:\s*center;/s,
    );
    expect(css).toMatch(
      /\.dezin-flow-page\[data-zoom="compact"\] \.dezin-flow-card__body\s*\{[^}]*height:\s*calc\(100% - 160px\);/s,
    );
  });

  test("narrow toolbars scroll stable, non-shrinking action clusters", () => {
    expect(css).toMatch(
      /\.dezin-canvas-toolbar__cluster\s*\{[^}]*flex:\s*none;/s,
    );
  });

  test("new connections preview the same orthogonal language as committed canvas edges", () => {
    expect(projectCanvas).toMatch(/connectionLineType=\{ConnectionLineType\.SmoothStep\}/);
    expect(projectCanvas).toMatch(/connectionLineStyle=\{CANVAS_CONNECTION_LINE_STYLE\}/);
    expect(projectCanvas).toMatch(/elevateEdgesOnSelect/);
  });
});
