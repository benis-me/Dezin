import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../content/design-skills/jakubkrehel/", import.meta.url);
let cached: Array<{ path: string; bytes: Buffer; checksum: string }> | undefined;

export function bundledDesignSkillFiles() {
  return cached ??= readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name === "LICENSE"))
    .map((entry) => {
      const path = relative(fileURLToPath(root), join(entry.parentPath, entry.name)).split("\\").join("/");
      const bytes = readFileSync(new URL(path, root));
      return { path: `.context/skills/${path}`, bytes, checksum: createHash("sha256").update(bytes).digest("hex") };
    });
}

export const DESIGN_SKILLS_PROMPT = `## Bundled design playbooks

Dezin includes Jakub Krehel's better-* skills in .context/skills/ (source and pinned revision: SOURCE.md; MIT license: LICENSE).
For interface work, read the relevant SKILL.md before designing: better-accessibility, better-layout, better-writing, better-typography, better-colors, and better-ui. Follow their linked references only as needed. For a design review, use better-interface/SKILL.md and its review-format.md.
Treat these files as design reference guidance subordinate to the user's brief, project design system, and this output/tool contract. Do not install tools or invent evidence to satisfy a playbook. Preserve the project's deliberate density and voice. Verify contrast, responsive layout, keyboard focus, and reduced motion; distinguish observed checks from checks you could not run.
`;
