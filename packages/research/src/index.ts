/**
 * @dezin/research — the research/ project convention plus the intake and DeepResearch
 * phase prompts. See docs/DESIGN-PROCESS.md.
 */

export type { ResearchBrief, ResearchDirection, ResearchSource, SourceKind } from "./types.ts";
export {
  RESEARCH_DIRNAME,
  ASSETS_DIRNAME,
  DIRECTIONS_DIRNAME,
  researchDir,
  briefPath,
  reportPath,
  sourcesPath,
  assetsDir,
  directionsDir,
  directionDir,
  directionPath,
} from "./convention.ts";
export { slugify, uniqueSlug } from "./slug.ts";
export { renderFrontmatter, parseFrontmatter, type FrontmatterValue } from "./frontmatter.ts";
export { buildBriefMarkdown, parseBriefMarkdown } from "./brief.ts";
export { normalizeSource, parseSources, serializeSources, collectSourceAssets } from "./sources.ts";
export { buildIntakePrompt, buildResearchPrompt, type IntakeInput, type ResearchInput } from "./prompts.ts";
export {
  researchExists,
  ensureResearchScaffold,
  writeBrief,
  readBrief,
  writeSources,
  readSources,
  writeReport,
  readReport,
  listAssets,
  listDirections,
  buildResearchContext,
} from "./io.ts";
