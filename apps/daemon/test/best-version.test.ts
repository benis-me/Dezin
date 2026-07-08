import { test } from "node:test";
import assert from "node:assert/strict";
import { bestVersion } from "../src/best-version.ts";

test("bestVersion returns null for no versions", () => {
  assert.equal(bestVersion([]), null);
});

test("bestVersion picks the highest-scoring version", () => {
  const v = [{ score: 40, id: "a" }, { score: 80, id: "b" }, { score: 55, id: "c" }];
  assert.equal(bestVersion(v)?.id, "b");
});

test("bestVersion breaks ties toward the LATER round (so a tying last round needs no restore)", () => {
  const v = [{ score: 80, id: "a" }, { score: 60, id: "b" }, { score: 80, id: "c" }];
  assert.equal(bestVersion(v)?.id, "c");
});

test("bestVersion returns the last round when it is already the best", () => {
  const v = [{ score: 40, id: "a" }, { score: 90, id: "last" }];
  assert.equal(bestVersion(v)?.id, "last");
});
