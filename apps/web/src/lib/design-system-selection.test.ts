import { describe, expect, it } from "vitest";

import {
  NO_DESIGN_SYSTEM_ID,
  designSystemPickerValue,
  persistedDesignSystemId,
} from "./design-system-selection.ts";

describe("design system selection persistence", () => {
  it("keeps legacy null as inherited while persisting an explicit no-system choice", () => {
    expect(designSystemPickerValue(null)).toBe("");
    expect(designSystemPickerValue(NO_DESIGN_SYSTEM_ID)).toBe("");
    expect(persistedDesignSystemId("")).toBe(NO_DESIGN_SYSTEM_ID);
  });

  it("round-trips a pinned design system", () => {
    expect(designSystemPickerValue("modern-minimal")).toBe("modern-minimal");
    expect(persistedDesignSystemId("modern-minimal")).toBe("modern-minimal");
  });
});
