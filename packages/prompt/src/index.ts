/**
 * @dezin/prompt — the lean 5-layer system-prompt composer.
 */

export {
  composeSystemPrompt,
  renderDesignSystemBlock,
  type ComposeInput,
} from "./compose.ts";
export { renderAntiSlopContract } from "./anti-slop.ts";
export { INJECTION_RESISTANCE, IDENTITY_CHARTER, SELF_CRITIQUE, ANTI_ROLEPLAY } from "./charter.ts";
export { DECK_FRAMEWORK } from "./deck.ts";
export {
  DESIGN_DIRECTIONS,
  findDirection,
  renderDirectionBlock,
  type Direction,
  type DirectionPalette,
} from "./directions.ts";
