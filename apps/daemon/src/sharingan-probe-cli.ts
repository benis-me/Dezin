import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The probe CLI template (`sharingan-probe.mjs`) with the daemon's Sharingan base URL baked into the
 *  first `"__BASE__"` placeholder (the const). The second occurrence — the un-baked guard in main() —
 *  is left intact by using a single-occurrence string replace. */
export function probeCliScript(base: string): string {
  const templatePath = fileURLToPath(new URL("./sharingan-probe.mjs", import.meta.url));
  return readFileSync(templatePath, "utf8").replace('"__BASE__"', JSON.stringify(base));
}

/** Write the `dezin-probe` CLI into a project's `.sharingan/` so the build Agent can drive the capture
 *  browser + read the capture via `node .sharingan/probe.mjs <cmd>` — a real tool instead of
 *  hand-written curl/python. Returns the relative path the Agent should call. */
export function writeProbeCli(projectDir: string, base: string): string {
  mkdirSync(join(projectDir, ".sharingan"), { recursive: true });
  writeFileSync(join(projectDir, ".sharingan", "probe.mjs"), probeCliScript(base));
  return ".sharingan/probe.mjs";
}
