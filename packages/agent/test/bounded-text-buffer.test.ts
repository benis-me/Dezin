import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedTextBuffer, OUTPUT_TRUNCATION_MARKER } from "../src/bounded-text-buffer.ts";

test("BoundedTextBuffer retains a byte-bounded UTF-8 tail with one marker", () => {
  const buffer = new BoundedTextBuffer(96);
  for (let index = 0; index < 100; index++) buffer.append(`前缀-${index}-🙂\n`);
  const output = buffer.toString();
  assert.ok(Buffer.byteLength(output, "utf8") <= 96);
  assert.equal(output.split(OUTPUT_TRUNCATION_MARKER).length - 1, 1);
  assert.doesNotMatch(output, /�/);
  assert.match(output, /99-🙂/);
});

test("BoundedTextBuffer does not add a marker before it truncates", () => {
  const buffer = new BoundedTextBuffer(64);
  buffer.append("hello");
  assert.equal(buffer.toString(), "hello");
  assert.equal(buffer.truncated, false);
});
