import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateDesignHtml } from "../src/design/design-static-validation.ts";
import {
  designSystemWebFonts,
  expandDesignIcons,
  isDesignWebResourceUrl,
  loadDesignIconSets,
  suggestDesignIconNames,
  webResourcesPromptSection,
} from "../src/design/design-web-resources.ts";

const ICONIFY_SET = JSON.stringify({
  prefix: "lucide",
  info: { name: "Lucide", license: { title: "ISC" } },
  width: 24,
  height: 24,
  icons: {
    "arrow-right": { body: '<path d="M5 12h14"/>' },
  },
  aliases: {
    "arrow-left": { parent: "arrow-right", hFlip: true },
  },
});

test("web resource URLs admit exactly Fontsource CSS and font files on jsDelivr", () => {
  assert.ok(isDesignWebResourceUrl("https://cdn.jsdelivr.net/fontsource/css/inter@latest/index.css"));
  assert.ok(isDesignWebResourceUrl("https://cdn.jsdelivr.net/fontsource/css/playfair-display:vf@5/wght.css"));
  assert.ok(isDesignWebResourceUrl("https://cdn.jsdelivr.net/fontsource/fonts/inter@5.2.5/latin-400-normal.woff2"));
  assert.equal(isDesignWebResourceUrl("https://cdn.jsdelivr.net/npm/lodash@4/lodash.js"), false);
  assert.equal(isDesignWebResourceUrl("https://fonts.googleapis.com/css2?family=Inter"), false);
  assert.equal(isDesignWebResourceUrl("https://cdn.jsdelivr.net/fontsource/css/inter@latest/../x.css"), false);
});

test("a Fontsource stylesheet link validates while other remote stylesheets and @import stay rejected", () => {
  const page = (head: string) => `<!doctype html><html><head><title>Fonts</title>${head}</head><body><main>Copy</main></body></html>`;
  validateDesignHtml(page('<link rel="stylesheet" href="https://cdn.jsdelivr.net/fontsource/css/inter@latest/index.css">'));
  validateDesignHtml(page('<style>@font-face{font-family:X;src:url(https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.woff2) format("woff2")}</style>'));
  assert.throws(() => validateDesignHtml(page('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">')), /keep styles inline/);
  assert.throws(() => validateDesignHtml(page('<style>@import url("https://cdn.jsdelivr.net/fontsource/css/inter@latest/index.css");</style>')), /not @import/);
});

test("design-system font tokens map to Fontsource ids, skipping generic and system faces", () => {
  const fonts = designSystemWebFonts(`:root{
    --font-display: "Playfair Display", Georgia, serif;
    --font-body: "Inter", ui-sans-serif, system-ui, sans-serif;
    --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
    --font-alt: -apple-system, "Segoe UI", sans-serif;
  }`);
  assert.deepEqual(fonts, [
    { family: "Playfair Display", id: "playfair-display" },
    { family: "Inter", id: "inter" },
  ]);
  assert.match(webResourcesPromptSection({ fonts, iconSets: [] }), /“Playfair Display” → playfair-display/);
});

test("icon placeholders expand to inline SVG from a cached Iconify set and unknown names are reported", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-web-resources-"));
  try {
    let fetched = 0;
    const fakeFetch = (async () => {
      fetched += 1;
      return new Response(ICONIFY_SET, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const sets = await loadDesignIconSets(dataDir, {
      fetch: fakeFetch,
      sets: [{ prefix: "lucide", name: "Lucide", license: "ISC" }, { prefix: "missing", name: "Missing", license: "MIT" }],
    });
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0]!.names, ["arrow-left", "arrow-right"]);
    assert.equal(await readFile(join(dataDir, "web-resources", "icons", "lucide.json"), "utf8"), ICONIFY_SET);
    assert.ok(fetched >= 2);

    const html = '<button><svg data-icon="lucide:arrow-right" class="ic" width="20" height="20"></svg>Next</button>'
      + '<svg data-icon="lucide:arrow-left"></svg>';
    const first = await expandDesignIcons(html, sets.slice(0, 1));
    assert.deepEqual(first.unknown, []);
    assert.match(first.html, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24" data-icon="lucide:arrow-right" class="ic" width="20" height="20" aria-hidden="true"><path d="M5 12h14"\/><\/svg>/);
    assert.match(first.html, /data-icon="lucide:arrow-left" width="1em" height="1em" aria-hidden="true"><g transform="translate\(24 0\) scale\(-1 1\)">/);
    const again = await expandDesignIcons(first.html, sets.slice(0, 1));
    assert.equal(again.html, first.html);

    const unknown = await expandDesignIcons('<svg data-icon="lucide:arrow-rite"></svg><svg data-icon="ph:x"></svg>', sets.slice(0, 1));
    assert.deepEqual(unknown.unknown, ["lucide:arrow-rite", "ph:x"]);
    assert.deepEqual(suggestDesignIconNames("lucide:arrow-rite", sets), ["lucide:arrow-left", "lucide:arrow-right"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
