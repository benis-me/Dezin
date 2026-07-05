import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { injectRuntimeProbe } from "../src/serve-static.ts";

test("injectRuntimeProbe installs before the page's own scripts, inside <head>", () => {
  const out = injectRuntimeProbe("<html><head><script>window.__early=1;</script></head><body><h1>x</h1></body></html>");
  assert.match(out, /data-dezin-runtime-probe/);
  // The probe's error hooks must be installed before any script the page itself runs,
  // so a parse-time throw in an early inline script is still caught.
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("window.__early"), "probe must precede the page's own scripts");
  // ...and it sits inside <head>.
  assert.ok(out.indexOf("data-dezin-runtime-probe") > out.indexOf("<head>"));
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("</head>"));
});

test("injectRuntimeProbe injects after <html> when there is no <head>", () => {
  const out = injectRuntimeProbe("<html><body><script>window.__b=1;</script></body></html>");
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("window.__b"), "probe must precede the page's own scripts");
  assert.ok(out.indexOf("data-dezin-runtime-probe") > out.indexOf("<html>"));
});

test("injectRuntimeProbe falls back to prepend when there is no <head>/<html>", () => {
  const out = injectRuntimeProbe("<h1>x</h1>");
  assert.match(out, /data-dezin-runtime-probe/);
  assert.ok(out.startsWith("<script data-dezin-runtime-probe>"));
});

test("prototype and standard probe strings stay identical", async () => {
  const staticSrc = await readFile(join(import.meta.dirname, "../src/serve-static.ts"), "utf8");
  const viteSrc = await readFile(
    join(import.meta.dirname, "../../../content/templates/react-vite-gsap/vite.config.js"),
    "utf8",
  );
  const grab = (s: string) => s.slice(s.indexOf("<script data-dezin-runtime-probe>"), s.indexOf("</script>", s.indexOf("data-dezin-runtime-probe")) + 9);
  assert.equal(grab(staticSrc), grab(viteSrc));
});
