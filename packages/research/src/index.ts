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
  isSafeDirectionSlug,
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
  resetResearchBundle,
  writeBrief,
  readBrief,
  writeSources,
  readSources,
  writeReport,
  readReport,
  listAssets,
  listDirections,
  readCandidateDirection,
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
  validateResearchBundle,
  type ResearchBundleArea,
  type ResearchBundleIssue,
  type ResearchBundleValidation,
} from "./io.ts";
