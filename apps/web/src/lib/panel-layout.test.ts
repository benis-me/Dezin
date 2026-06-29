import { afterEach, expect, test } from "vitest";
import { panelPercentFromPixels, readPanelPercent, readStoredPanelPercent } from "./panel-layout.ts";

afterEach(() => {
  localStorage.removeItem("dezin.test.panel");
});

test("readPanelPercent uses the fallback when no layout was stored", () => {
  expect(readStoredPanelPercent("dezin.test.panel", 24, 55)).toBeNull();
  expect(readPanelPercent("dezin.test.panel", 33, 24, 55)).toBe(33);
});

test("readPanelPercent preserves saved fractions and clamps invalid extremes", () => {
  localStorage.setItem("dezin.test.panel", "0.25");
  expect(readPanelPercent("dezin.test.panel", 33, 24, 55)).toBe(25);

  localStorage.setItem("dezin.test.panel", "0");
  expect(readPanelPercent("dezin.test.panel", 33, 24, 55)).toBe(24);
});

test("panelPercentFromPixels converts a pixel default into a clamped percentage", () => {
  expect(panelPercentFromPixels(400, 1000, 33, 24, 55)).toBe(40);
  expect(panelPercentFromPixels(400, 500, 33, 24, 55)).toBe(55);
  expect(panelPercentFromPixels(400, 0, 33, 24, 55)).toBe(33);
});
