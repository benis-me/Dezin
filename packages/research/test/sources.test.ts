import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSourceAssets, normalizeSource, parseSources, serializeSources } from "../src/sources.ts";

test("parseSources round-trips through serializeSources", () => {
  const sources = [
    { id: "stripe", kind: "competitor" as const, title: "Stripe", url: "https://stripe.com", takeaways: ["clean tiers"], assets: ["assets/stripe.png"] },
  ];
  assert.deepEqual(parseSources(serializeSources(sources)), sources);
});

test("normalizeSource fills defaults and drops entries without a title", () => {
  assert.equal(normalizeSource({ takeaways: [] }), null);
  const s = normalizeSource({ title: "Thing" }, 3);
  assert.equal(s?.id, "source-4");
  assert.equal(s?.kind, "inspiration");
  assert.deepEqual(s?.takeaways, []);
});

test("normalizeSource coerces an unknown kind to inspiration", () => {
  assert.equal(normalizeSource({ title: "X", kind: "banana" })?.kind, "inspiration");
});

test("parseSources is junk-tolerant", () => {
  assert.deepEqual(parseSources("not json"), []);
  assert.deepEqual(parseSources("{}"), []);
  assert.deepEqual(parseSources(null), []);
  assert.deepEqual(parseSources('[{"title":""},{"title":"Ok"}]').map((s) => s.title), ["Ok"]);
});

test("collectSourceAssets dedupes across sources", () => {
  const sources = parseSources(
    JSON.stringify([
      { title: "A", assets: ["assets/x.png", "assets/y.png"] },
      { title: "B", assets: ["assets/y.png"] },
    ]),
  );
  assert.deepEqual(collectSourceAssets(sources), ["assets/x.png", "assets/y.png"]);
});
