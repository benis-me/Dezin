import { describe, expect, test } from "vitest";
import {
  generationPlanFailureMessage,
  publicFailureMessage,
} from "./public-failure-message.ts";

describe("public generation failure messages", () => {
  test("removes local paths and internal identifiers without hiding the actionable filename", () => {
    expect(publicFailureMessage(
      "Build 6ee84ec6-2db7-4a76-842d-4270f053006a failed at /Users/example/project/.dezin/private/output.json.",
    )).toBe("Build internal reference failed at output.json.");
  });

  test("uses a safe fallback when a compile failure has no public detail", () => {
    expect(generationPlanFailureMessage({
      compileError: { message: "   ", code: "invalid-plan", issues: [] },
    })).toBe("The approved proposal could not be compiled.");
  });
});
