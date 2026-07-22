import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function renderProbeCliScript(base: string, runId: string, immutableCapture: boolean): string {
  const templatePath = fileURLToPath(new URL("./sharingan-probe.mjs", import.meta.url));
  return readFileSync(templatePath, "utf8")
    .replace('"__BASE__"', JSON.stringify(base))
    .replace('"__RUN_ID__"', JSON.stringify(runId))
    .replace('"__IMMUTABLE_CAPTURE__"', immutableCapture ? "true" : "false");
}

/** The mutable Run probe with its daemon endpoint baked into the first BASE/RUN_ID placeholders. */
export function probeCliScript(base: string, runId = ""): string {
  return renderProbeCliScript(base, runId, false);
}

/** Offline-only probe embedded in an immutable Sharingan Resource Revision.
 *  Mutable commands are rejected before they can perform any filesystem or network operation. */
export function immutableProbeCliScript(): string {
  return renderProbeCliScript("__BASE__", "__RUN_ID__", true);
}

/** Write the `dezin-probe` CLI into a project's `.sharingan/` so the build Agent can drive the capture
 *  browser + read the capture via `node .sharingan/probe.mjs <cmd>` — a real tool instead of
 *  hand-written curl/python. Returns the relative path the Agent should call. */
export function writeProbeCli(projectDir: string, base: string, runId = ""): string {
  mkdirSync(join(projectDir, ".sharingan"), { recursive: true });
  writeFileSync(join(projectDir, ".sharingan", "probe.mjs"), probeCliScript(base, runId));
  return ".sharingan/probe.mjs";
}
