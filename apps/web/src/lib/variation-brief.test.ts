import { describe, it, expect } from "vitest";
import { composeVariationBrief } from "./variation-brief.ts";

describe("composeVariationBrief", () => {
  it("keeps the base brief and numbers the variation", () => {
    const out = composeVariationBrief("Make the hero bolder", 0, 3);
    expect(out).toContain("Make the hero bolder");
    expect(out).toMatch(/variation 1 of 3/i);
  });

  it("frames each as variation within identity (preserve brand, vary composition)", () => {
    const out = composeVariationBrief("Redo the pricing table", 2, 3);
    expect(out).toMatch(/variation 3 of 3/i);
    expect(out).toMatch(/preserve the brand identity/i);
    expect(out).toMatch(/distinct/i);
    expect(out).toMatch(/do not converge/i);
  });
});
