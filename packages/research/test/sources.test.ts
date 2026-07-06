import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSourceAssets, normalizeSource, parseSources, serializeSources } from "../src/sources.ts";
import { JUNK_DOMAINS } from "../src/index.ts";

test("parseSources round-trips through serializeSources", () => {
  const sources = [
    { id: "stripe", kind: "competitor" as const, title: "Stripe", url: "https://stripe.com", takeaways: ["clean tiers"], assets: ["assets/stripe.png"], authority: "unknown" as const },
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

test("parseSources with synthesizeTitle keeps a title-less source, labelling it by designer/platform; default drops it", () => {
  const text = JSON.stringify([{ platform: "dribbble", designer: "Jane", url: "https://dribbble.com/shots/1", assets: ["assets/a.png"] }]);
  assert.equal(parseSources(text).length, 0); // default: title required → dropped
  const lenient = parseSources(text, { synthesizeTitle: true });
  assert.equal(lenient.length, 1);
  assert.equal(lenient[0]!.title, "Jane · dribbble");
  assert.equal(lenient[0]!.designer, "Jane");
  assert.deepEqual(lenient[0]!.assets, ["assets/a.png"]);
});

test("normalizeSource drops junk-domain sources and defaults authority to unknown", () => {
  assert.equal(normalizeSource({ title: "listicle", url: "https://medium.com/@x/top-10", kind: "article" }), null);
  const ok = normalizeSource({ title: "Stripe docs", url: "https://stripe.com/docs", kind: "article" })!;
  assert.equal(ok.authority, "unknown");
  const primary = normalizeSource({ title: "Stripe", url: "https://stripe.com", kind: "competitor", authority: "primary", platform: "dribbble", designer: "Jane", reached: true })!;
  assert.equal(primary.authority, "primary");
  assert.equal(primary.platform, "dribbble");
  assert.equal(primary.designer, "Jane");
  assert.equal(primary.reached, true);
  assert.ok(JUNK_DOMAINS.includes("medium.com"));
});
