/**
 * Regenerate the committed craft docs from @dezin/quality slop-rules.
 *   node --experimental-strip-types scripts/regen-craft.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderAntiSlopMarkdown, defaultCraftDocPath } from "../packages/craft/src/index.ts";

const path = defaultCraftDocPath();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, renderAntiSlopMarkdown(), "utf8");
console.log("wrote", path);
