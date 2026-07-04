import { test } from "node:test";
import assert from "node:assert/strict";
import { directionTitle } from "../src/directions.ts";

test("directionTitle extracts the first markdown heading", () => {
  assert.equal(directionTitle('# Direction A — "The Blind Spot"\n\nConcept.'), 'Direction A — "The Blind Spot"');
  assert.equal(directionTitle("intro\n\n# Later heading\n\nx"), "Later heading");
});

test("directionTitle falls back when there is no heading", () => {
  assert.equal(directionTitle("no heading here"), "Untitled direction");
  assert.equal(directionTitle(""), "Untitled direction");
});
