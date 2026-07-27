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

  test("artifact previews give page covers the frame while components retain their full composition", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const pagePreview = document.createElement("div");
    pagePreview.className = "dezin-flow-card__preview";
    pagePreview.dataset.artifactKind = "page";
    const pageImage = document.createElement("img");
    pagePreview.append(pageImage);
    const componentPreview = document.createElement("div");
    componentPreview.className = "dezin-flow-card__preview";
    componentPreview.dataset.artifactKind = "component";
    const componentImage = document.createElement("img");
    componentPreview.append(componentImage);
    document.body.append(pagePreview, componentPreview);

    try {
      expect(getComputedStyle(pageImage).objectFit).toBe("cover");
      expect(getComputedStyle(pageImage).objectPosition).toBe("center top");
      expect(getComputedStyle(pageImage).paddingTop).toBe("0px");
      expect(getComputedStyle(componentImage).objectFit).toBe("contain");
      expect(getComputedStyle(componentImage).paddingTop).toBe("6px");
    } finally {
      pagePreview.remove();
      componentPreview.remove();
      style.remove();
    }
  });

  test("overview cards reserve readable hierarchy for artifact name and status", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const card = document.createElement("article");
    card.className = "dezin-flow-card";
    card.dataset.zoom = "overview";
    const preview = document.createElement("div");
    preview.className = "dezin-flow-card__preview";
    const kind = document.createElement("span");
    kind.className = "dezin-flow-card__kind dezin-flow-card__overview-kind";
    kind.textContent = "Page";
    preview.append(kind);
    const body = document.createElement("div");
    body.className = "dezin-flow-card__body";
    const title = document.createElement("h3");
    title.textContent = "Checkout";
    const status = document.createElement("span");
    status.className = "dezin-flow-card__overview-meta";
    status.textContent = "published";
    body.append(title, status);
    card.append(preview, body);
    document.body.append(card);

    try {
      expect(getComputedStyle(title).fontSize).toBe("30px");
      expect(getComputedStyle(status).fontSize).toBe("17px");
      expect(getComputedStyle(kind).fontSize).toBe("13px");
    } finally {
      card.remove();
      style.remove();
    }
  });

  test("overview resource cards retain their revision preview instead of collapsing to generic copy", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const card = document.createElement("article");
    card.className = "dezin-flow-card dezin-flow-resource";
    card.dataset.zoom = "overview";
    card.dataset.resourcePreview = "research";
    const preview = document.createElement("div");
    preview.className = "dezin-flow-resource__preview dezin-flow-resource__preview--research";
    const summary = document.createElement("p");
    summary.textContent = "A grounded decision summary";
    preview.append(summary);
    card.append(preview);
    document.body.append(card);

    try {
      expect(getComputedStyle(card).gridTemplateColumns).not.toBe("minmax(0, 1fr)");
      expect(getComputedStyle(preview).display).toBe("grid");
      expect(getComputedStyle(summary).display).toBe("-webkit-box");
    } finally {
      card.remove();
      style.remove();
    }
  });

  test("narrow toolbars scroll stable, non-shrinking action clusters", () => {
    expect(css).toMatch(
      /\.dezin-canvas-toolbar__cluster\s*\{[^}]*flex:\s*none;/s,
    );
  });

  test("floating canvas chrome relies on hairline borders instead of stacked card shadows", () => {
    for (const selector of [
      ".dezin-flow-group__toolbar",
      ".dezin-canvas-toolbar",
      ".dezin-workspace-outline",
    ]) {
      const escaped = selector.replaceAll(".", "\\.");
      expect(css).toMatch(new RegExp(`${escaped}\\s*\\{[^}]*box-shadow:\\s*none;`, "s"));
    }
  });

  test("new connections preview the same orthogonal language as committed canvas edges", () => {
    expect(projectCanvas).toMatch(/connectionLineType=\{ConnectionLineType\.SmoothStep\}/);
    expect(projectCanvas).toMatch(/connectionLineStyle=\{CANVAS_CONNECTION_LINE_STYLE\}/);
    expect(projectCanvas).toMatch(/elevateEdgesOnSelect/);
  });

  test("fit framing reserves toolbar clearance in fit padding without pushing content under the header", () => {
    expect(projectCanvas).toMatch(
      /fitView\(\{\s*padding:\s*\{\s*top:\s*0\.18,\s*right:\s*0\.18,\s*bottom:\s*0\.32,\s*left:\s*0\.18,/s,
    );
    expect(projectCanvas).not.toMatch(
      /const fitted = offsetViewportForBottomChrome\(instance\.getViewport\(\)\)/,
    );
    expect(projectCanvas).not.toMatch(
      /setViewport\(\s*offsetViewportForBottomChrome\(flowRef\.current\.getViewport\(\)\)/s,
    );
  });
});
