import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/frontmatter.ts";

test("parses flat keys, flow arrays, booleans, and the body", () => {
  const text = `---
name: Frontend design
description: A single page with a colon: included.
mode: prototype
craft: [typography, color, anti-ai-slop]
designSystem: true
---

# Body heading

Real body text.`;
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.name, "Frontend design");
  assert.equal(data.description, "A single page with a colon: included.");
  assert.equal(data.mode, "prototype");
  assert.deepEqual(data.craft, ["typography", "color", "anti-ai-slop"]);
  assert.equal(data.designSystem, true);
  assert.match(body, /^# Body heading/);
  assert.match(body, /Real body text\.$/);
});

test("handles empty arrays and quoted values", () => {
  const { data } = parseFrontmatter(`---\ntriggers: []\nname: "Quoted Name"\n---\nx`);
  assert.deepEqual(data.triggers, []);
  assert.equal(data.name, "Quoted Name");
});

test("no frontmatter → empty data, whole text is body", () => {
  const { data, body } = parseFrontmatter("# Just markdown\n\ncontent");
  assert.deepEqual(data, {});
  assert.equal(body, "# Just markdown\n\ncontent");
});

test("tolerates CRLF and a missing closing fence", () => {
  const crlf = parseFrontmatter("---\r\nname: X\r\n---\r\nbody");
  assert.equal(crlf.data.name, "X");
  assert.equal(crlf.body, "body");
  const unclosed = parseFrontmatter("---\nname: X\nbody without fence");
  assert.deepEqual(unclosed.data, {});
});
