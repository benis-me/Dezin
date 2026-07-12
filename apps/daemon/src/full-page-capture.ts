import type { Page } from "puppeteer-core";

export interface FullPageCaptureOptions {
  path?: string;
}

/**
 * Capture the whole rendered page, including app shells that keep the document fixed and put their
 * real vertical scroll on an inner `overflow:auto` container. Any temporary inline styles are kept
 * in the page context and restored even when Puppeteer's screenshot call rejects.
 */
export async function captureFullPageScreenshot(
  page: Page,
  options: FullPageCaptureOptions = {},
): Promise<Uint8Array> {
  const token = `dezin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  try {
    await page.evaluate((captureToken: string) => {
      const win = globalThis as any;
      const doc = win.document;
      if (!doc?.body || !doc.documentElement) return false;

      const viewportWidth = Math.max(1, Number(win.innerWidth) || doc.documentElement.clientWidth || 1);
      const viewportHeight = Math.max(1, Number(win.innerHeight) || doc.documentElement.clientHeight || 1);
      let dominant: any | undefined;
      let dominantScore = 0;

      for (const element of Array.from<any>(doc.body.querySelectorAll("*"))) {
        const style = win.getComputedStyle(element);
        if (!/(auto|scroll|overlay)/.test(style.overflowY ?? "")) continue;
        const clientHeight = Number(element.clientHeight) || 0;
        const scrollHeight = Number(element.scrollHeight) || 0;
        if (clientHeight < 1 || scrollHeight - clientHeight < 32) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;

        // Ignore small chat panes/sidebars. The workaround is only for the dominant app-shell
        // scroller that effectively stands in for the document viewport.
        const widthCoverage = rect.width / viewportWidth;
        const heightCoverage = rect.height / viewportHeight;
        if (widthCoverage < 0.4 || heightCoverage < 0.25) continue;
        const score = (scrollHeight - clientHeight) * rect.width + rect.width * rect.height;
        if (score > dominantScore) {
          dominant = element;
          dominantScore = score;
        }
      }

      if (!dominant) return false;
      const states: Array<{ node: any; style: string | null; scrollTop: number; scrollLeft: number }> = [];
      for (let node: any = dominant; node; node = node.parentElement) {
        states.push({
          node,
          style: node.getAttribute("style"),
          scrollTop: Number(node.scrollTop) || 0,
          scrollLeft: Number(node.scrollLeft) || 0,
        });
      }
      const registry = win.__dezinFullPageCaptureStates ?? (win.__dezinFullPageCaptureStates = Object.create(null));
      registry[captureToken] = states;

      const expandedHeight = Math.max(Number(dominant.scrollHeight) || 0, Number(dominant.clientHeight) || 0);
      dominant.style.setProperty("height", `${expandedHeight}px`, "important");
      dominant.style.setProperty("min-height", `${expandedHeight}px`, "important");
      dominant.style.setProperty("max-height", "none", "important");
      dominant.style.setProperty("overflow", "visible", "important");
      dominant.style.setProperty("contain", "none", "important");
      dominant.style.setProperty("flex", "none", "important");

      for (let ancestor: any = dominant.parentElement; ancestor; ancestor = ancestor.parentElement) {
        ancestor.style.setProperty("height", "auto", "important");
        ancestor.style.setProperty("min-height", "0px", "important");
        ancestor.style.setProperty("max-height", "none", "important");
        ancestor.style.setProperty("overflow", "visible", "important");
        ancestor.style.setProperty("contain", "none", "important");
      }
      // Force Chrome to commit the new document geometry before Puppeteer immediately asks CDP for
      // full-page layout metrics. Without this synchronous layout read, CDP can intermittently see
      // the pre-expansion viewport even though all style mutations above have completed.
      void dominant.getBoundingClientRect();
      void doc.documentElement.scrollHeight;
      return true;
    }, token);

    return await page.screenshot({ path: options.path, type: "png", fullPage: true });
  } finally {
    await page.evaluate((captureToken: string) => {
      const win = globalThis as any;
      const registry = win.__dezinFullPageCaptureStates;
      const states = registry?.[captureToken] as Array<{ node: any; style: string | null; scrollTop: number; scrollLeft: number }> | undefined;
      if (!states) return;
      for (let i = states.length - 1; i >= 0; i -= 1) {
        const state = states[i]!;
        if (state.style === null) state.node.removeAttribute("style");
        else state.node.setAttribute("style", state.style);
        state.node.scrollTop = state.scrollTop;
        state.node.scrollLeft = state.scrollLeft;
      }
      delete registry[captureToken];
    }, token).catch(() => {});
  }
}
