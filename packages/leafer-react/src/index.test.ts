import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("keeps the product package as a thin Capability Foundry facade", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.equal(
    source,
    [
      "// Product compatibility facade. The implementation authority lives in Capability Foundry.",
      'export * from "@capability-foundry/leafer-react";',
      "",
    ].join("\n"),
  );
});
