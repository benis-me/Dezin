/**
 * @dezin/research — the research/ project convention plus the intake and DeepResearch
 * phase prompts. See docs/DESIGN-PROCESS.md.
 */

export type { ResearchBrief, ResearchDirection, ResearchSource, SourceKind } from "./types.ts";
export {
  RESEARCH_DIRNAME,
  ASSETS_DIRNAME,
  DIRECTIONS_DIRNAME,
  CHOSEN_FILE,
  VISUAL_DIRNAME,
  VISUAL_REPORT_FILE,
  VISUAL_MOODBOARD_FILE,
  researchDir,
  briefPath,
  reportPath,
  sourcesPath,
  assetsDir,
  directionsDir,
  directionDir,
  directionPath,
  chosenPath,
  visualDir,
  visualReportPath,
  visualSourcesPath,
  visualAssetsDir,
  visualMoodboardPointerPath,
} from "./convention.ts";
export { slugify, uniqueSlug } from "./slug.ts";
export { directionTitle, directionBlurb } from "./directions.ts";
export { renderFrontmatter, parseFrontmatter, type FrontmatterValue } from "./frontmatter.ts";
export { buildBriefMarkdown, parseBriefMarkdown } from "./brief.ts";
export { normalizeSource, parseSources, serializeSources, collectSourceAssets, JUNK_DOMAINS } from "./sources.ts";
export {
  buildIntakePrompt,
  buildResearchPrompt,
  buildVisualResearchPrompt,
  buildSynthesisPrompt,
  type IntakeInput,
  type ResearchInput,
} from "./prompts.ts";
export { parseResearchActivity, type ResearchActivity } from "./activity.ts";
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
  directionsExist,
  writeChosenDirection,
  readChosenDirection,
  buildResearchContext,
  visualResearchExists,
  readVisualReport,
  readVisualSources,
  listVisualAssets,
  readVisualMoodboardId,
  writeVisualMoodboardId,
} from "./io.ts";
