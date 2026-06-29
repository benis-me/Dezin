/**
 * @dezin/design — bundled design systems + a registry. Default = modern-minimal.
 * Systems are loaded from content/design-systems (DESIGN.md + tokens.css + manifest).
 */

export type { DesignSystem, DesignSystemCraft } from "./types.ts";
export { loadDesignSystems, defaultDesignDir, userDesignDir } from "./loader.ts";
export {
  DesignRegistry,
  defaultRegistry,
  modernMinimal,
  BUNDLED_DESIGN_SYSTEMS,
  DEFAULT_DESIGN_SYSTEM_ID,
} from "./registry.ts";
export {
  buildBrandSystem,
  slugifyBrand,
  isHexColor,
  type BrandInput,
  type GeneratedBrand,
} from "./brand-import.ts";
