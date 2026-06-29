import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "fflate";
import { parseSchema, compileSchema, encodeBinarySchema } from "kiwi-schema";
import { figToJson, summarizeFig } from "../src/parse-fig.ts";

// Build a synthetic .fig archive the same way Figma does (kiwi schema + message,
// deflate-raw, length-prefixed), so we can verify the parser end-to-end without a
// real proprietary file.
function buildFig(message: unknown): Uint8Array {
  const schemaText = `
    message Vector { float x = 1; float y = 2; }
    message Color { float r = 1; float g = 2; float b = 3; float a = 4; }
    message Paint { uint type = 1; Color color = 2; }
    message FontName { string family = 1; string style = 2; }
    message TextData { string characters = 1; }
    message NodeChange {
      string type = 1;
      string name = 2;
      Vector size = 3;
      Paint[] fillPaints = 4;
      FontName fontName = 5;
      TextData textData = 6;
    }
    message Message { NodeChange[] nodeChanges = 1; }
  `;
  const schema = parseSchema(schemaText);
  const compiled = compileSchema(schema) as { encodeMessage: (m: unknown) => Uint8Array };
  const schemaC = deflateSync(encodeBinarySchema(schema));
  const dataC = deflateSync(compiled.encodeMessage(message));
  const head = new TextEncoder().encode("fig-kiwi");
  const out = new Uint8Array(head.length + 4 + 4 + schemaC.length + 4 + dataC.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  out.set(head, o);
  o += head.length;
  dv.setUint32(o, 15, true);
  o += 4;
  dv.setUint32(o, schemaC.length, true);
  o += 4;
  out.set(schemaC, o);
  o += schemaC.length;
  dv.setUint32(o, dataC.length, true);
  o += 4;
  out.set(dataC, o);
  return out;
}

test("figToJson decodes a fig-kiwi archive; summarizeFig extracts the design", () => {
  const fig = buildFig({
    nodeChanges: [
      { type: "CANVAS", name: "Page 1" },
      { type: "FRAME", name: "Hero", size: { x: 1440, y: 900 } },
      {
        type: "TEXT",
        name: "Headline",
        fontName: { family: "Geist", style: "Bold" },
        textData: { characters: "Ship faster" },
        fillPaints: [{ type: 0, color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }],
      },
    ],
  });

  const doc = figToJson(fig);
  assert.equal(doc.nodeChanges?.length, 3);
  assert.equal(doc.nodeChanges?.[1]?.name, "Hero");

  const summary = summarizeFig(doc, "demo.fig");
  assert.match(summary, /Hero — 1440×900/);
  assert.match(summary, /Geist/);
  assert.match(summary, /Ship faster/);
  assert.match(summary, /Palette: #1a1a1a/);
});

test("figToJson rejects a non-fig buffer", () => {
  assert.throws(() => figToJson(new TextEncoder().encode("not a fig file")), /fig-kiwi/);
});
