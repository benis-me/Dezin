import { describe, expect, test } from "vitest";
import type { RunSummary } from "../lib/api.ts";
import { buildVersionGroups, versionLabel } from "./workspace-versions.ts";

function run(id: string, status: string, createdAt: number): RunSummary {
  return {
    id,
    status,
    score: null,
    repairRounds: 0,
    lintPassed: false,
    createdAt,
    finishedAt: createdAt + 1,
  };
}

describe("buildVersionGroups", () => {
  test("does not count a cancelled Research direction gate as a version", () => {
    const groups = buildVersionGroups(
      [
        run("direction-gate", "cancelled", 1),
        run("published-design", "succeeded", 2),
      ],
      [],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs.map((candidate) => candidate.id)).toEqual(["published-design"]);
    expect(versionLabel(groups[0]!, 0)).toBe("v1");
  });

  test("keeps failed historical runs because a failure can occur after a snapshot was published", () => {
    const groups = buildVersionGroups(
      [
        run("published-design", "succeeded", 1),
        run("failed-after-publish", "failed", 2),
      ],
      [],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs.map((candidate) => candidate.id)).toEqual([
      "failed-after-publish",
      "published-design",
    ]);
    expect(groups[0]!.runs.map((_, index) => versionLabel(groups[0]!, index))).toEqual(["v2", "v1"]);
  });
});
