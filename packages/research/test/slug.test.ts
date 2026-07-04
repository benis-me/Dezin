import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueSlug } from "../src/slug.ts";

test("slugify kebab-cases and strips punctuation", () => {
  assert.equal(slugify("Stripe — Pricing Page!"), "stripe-pricing-page");
  assert.equal(slugify("  Bold & Editorial  "), "bold-editorial");
});

test("slugify strips diacritics", () => {
  assert.equal(slugify("Café Product"), "cafe-product");
});

test("slugify falls back when nothing survives", () => {
  assert.equal(slugify("！！！", "item"), "item");
  assert.equal(slugify(""), "item");
});

test("uniqueSlug appends a numeric suffix on collision", () => {
  const used = new Set(["hero", "hero-2"]);
  assert.equal(uniqueSlug("Hero", used), "hero-3");
  assert.equal(uniqueSlug("Fresh", used), "fresh");
});
