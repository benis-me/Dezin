import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function immutableProbeCliScript(): string {
  const templatePath = fileURLToPath(new URL("./sharingan-probe.mjs", import.meta.url));
  return readFileSync(templatePath, "utf8");
}
