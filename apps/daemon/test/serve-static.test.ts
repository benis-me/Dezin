import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { injectRuntimeProbe } from "../src/serve-static.ts";

test("injectRuntimeProbe inserts the probe before </body>", () => {
  const out = injectRuntimeProbe("<html><body><h1>x</h1></body></html>");
  assert.match(out, /data-dezin-runtime-probe/);
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("</body>"));
});

test("injectRuntimeProbe appends when there is no </body>", () => {
  const out = injectRuntimeProbe("<h1>x</h1>");
  assert.match(out, /data-dezin-runtime-probe/);
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
