import { describe, expect, test } from "vitest";

import {
  designNodeGenerationCopy,
  designNodePresentation,
} from "./node-presentation.ts";
import { DESIGN_NODE_KINDS } from "./types.ts";

describe("Design Node presentation matrix", () => {
  test("every Node kind has an explicit presentation and kind-specific working copy", () => {
    const modes = DESIGN_NODE_KINDS.map((kind) => designNodePresentation(kind).mode);
    expect(modes).toEqual([
      "component",
      "web",
      "system",
      "research",
      "tokens",
      "document",
      "layout",
      "knowledge",
      "media",
      "media",
      "typed-file",
      "typed-file",
    ]);

    const creationTitles = DESIGN_NODE_KINDS.map((kind) =>
      designNodeGenerationCopy(kind, "generating", false).title);
    expect(new Set(creationTitles)).toHaveLength(DESIGN_NODE_KINDS.length);
    expect(creationTitles).toContain("Building a responsive page");
    expect(creationTitles).toContain("Deriving design tokens");
    expect(creationTitles).toContain("Reading the document");
  });

  test("new and existing revisions use different copy while validation remains kind-aware", () => {
    expect(designNodeGenerationCopy("component", "generating", false).title)
      .toBe("Shaping a reusable component");
    expect(designNodeGenerationCopy("component", "generating", true).title)
      .toBe("Updating component states");
    expect(designNodeGenerationCopy("component", "validating", true).title)
      .toBe("Checking component states");
    expect(designNodeGenerationCopy("research", "queued", false).detail)
      .toContain("Synthesizing research");
  });
});
