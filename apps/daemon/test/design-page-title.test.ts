import assert from "node:assert/strict";
import test from "node:test";

import { extractDesignPageTitle } from "../src/design/design-page-title.ts";

test("Page title extraction decodes entities and normalizes document whitespace", () => {
  assert.equal(
    extractDesignPageTitle("<!doctype html><html><head><title> Fish &amp; Chips\n\t工作台 </title></head><body></body></html>"),
    "Fish & Chips 工作台",
  );
});

test("Page title extraction enforces the Canvas Node UTF-8 byte contract", () => {
  const exactLimit = `${"界".repeat(85)}a`;
  assert.equal(Buffer.byteLength(exactLimit, "utf8"), 256);
  assert.equal(
    extractDesignPageTitle(`<!doctype html><html><head><title>${exactLimit}</title></head><body></body></html>`),
    exactLimit,
  );
  const tooLarge = "界".repeat(86);
  assert.equal(Buffer.byteLength(tooLarge, "utf8"), 258);
  assert.throws(
    () => extractDesignPageTitle(`<!doctype html><html><head><title>${tooLarge}</title></head><body></body></html>`),
    /1-256 UTF-8 bytes/i,
  );
  assert.throws(
    () => extractDesignPageTitle("<!doctype html><html><head><title> </title></head><body></body></html>"),
    /non-empty|1-256/i,
  );
});
