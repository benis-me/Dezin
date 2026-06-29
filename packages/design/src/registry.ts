import type { DesignSystem } from "./types.ts";
import { loadDesignSystems, defaultDesignDir } from "./loader.ts";

export const DEFAULT_DESIGN_SYSTEM_ID = "modern-minimal";

/** All design systems bundled with Dezin, loaded from content/design-systems. */
export const BUNDLED_DESIGN_SYSTEMS: DesignSystem[] = loadDesignSystems(defaultDesignDir());

/** The default brand object (modern-minimal). */
export const modernMinimal: DesignSystem =
  BUNDLED_DESIGN_SYSTEMS.find((s) => s.id === DEFAULT_DESIGN_SYSTEM_ID) ?? {
    id: DEFAULT_DESIGN_SYSTEM_ID,
    name: "Modern Minimal",
    category: "Modern & Minimal",
    summary: "",
    designMd: "",
    tokensCss: "",
    craft: { applies: [] },
  };

export class DesignRegistry {
  private map = new Map<string, DesignSystem>();

  constructor(systems: Iterable<DesignSystem> = BUNDLED_DESIGN_SYSTEMS) {
    for (const s of systems) this.map.set(s.id, s);
  }

  get(id: string): DesignSystem | null {
    return this.map.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  list(): DesignSystem[] {
    return [...this.map.values()];
  }

  default(): DesignSystem {
    return this.get(DEFAULT_DESIGN_SYSTEM_ID) ?? this.list()[0]!;
  }

  register(system: DesignSystem): void {
    this.map.set(system.id, system);
  }
}

export function defaultRegistry(): DesignRegistry {
  return new DesignRegistry();
}
