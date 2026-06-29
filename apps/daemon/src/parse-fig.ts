// Parses Figma's proprietary .fig binary into a usable design summary, so a dropped
// .fig can become agent context. Format (reverse-engineered, see fig-kiwi): an
// 8-byte "fig-kiwi" prelude, a uint32 version, then length-prefixed deflate-raw chunks
// — chunk 0 is the kiwi schema, chunk 1 is the kiwi-encoded document. Newer exports
// wrap that in a ZIP whose canvas.fig holds the same archive.

import { inflateSync, unzipSync } from "fflate";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";

const PRELUDE = "fig-kiwi";

interface FigColor {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}
interface FigNode {
  type?: string;
  name?: string;
  size?: { x?: number; y?: number };
  fillPaints?: { color?: FigColor; type?: string }[];
  fontName?: { family?: string; style?: string };
  fontSize?: number;
  textData?: { characters?: string };
  characters?: string;
}
export interface FigDocument {
  nodeChanges?: FigNode[];
  [k: string]: unknown;
}

/** Split a fig-kiwi archive into its length-prefixed chunks (chunk 0 = schema, 1 = data). */
function parseArchive(buf: Uint8Array): Uint8Array[] {
  let prelude = "";
  for (let i = 0; i < PRELUDE.length && i < buf.length; i++) prelude += String.fromCharCode(buf[i]!);
  if (prelude !== PRELUDE) throw new Error(`not a fig-kiwi archive (prelude "${prelude}")`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = PRELUDE.length + 4; // skip prelude + uint32 version
  const files: Uint8Array[] = [];
  while (off + 4 <= buf.length) {
    const size = dv.getUint32(off, true);
    off += 4;
    if (size === 0 || off + size > buf.length) break;
    files.push(buf.subarray(off, off + size));
    off += size;
  }
  return files;
}

/** Decode a .fig file (or ZIP-wrapped canvas.fig) into Figma's document message. */
export function figToJson(input: Uint8Array): FigDocument {
  let buf = input;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // PK\x03\x04 → ZIP container; the document lives in canvas.fig
    const entries = unzipSync(buf);
    const canvas = entries["canvas.fig"] ?? Object.values(entries)[0];
    if (!canvas) throw new Error("zip archive has no canvas.fig");
    buf = canvas;
  }
  const [schemaChunk, dataChunk] = parseArchive(buf);
  if (!schemaChunk || !dataChunk) throw new Error("missing schema/data chunks");
  const schema = decodeBinarySchema(inflateSync(schemaChunk));
  const compiled = compileSchema(schema) as { decodeMessage: (b: Uint8Array) => FigDocument };
  return compiled.decodeMessage(inflateSync(dataChunk));
}

function hex(c: FigColor): string {
  const to = (v: number | undefined): string =>
    Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

function uniq(values: string[], cap: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, cap);
}

/** Turn the decoded document into a compact, agent-friendly markdown brief. */
export function summarizeFig(doc: FigDocument, filename: string): string {
  const nodes = Array.isArray(doc.nodeChanges) ? doc.nodeChanges : [];
  const pages = uniq(
    nodes.filter((n) => n.type === "CANVAS").map((n) => n.name ?? ""),
    12,
  );
  const frames = uniq(
    nodes
      .filter((n) => (n.type === "FRAME" || n.type === "ROUNDED_RECTANGLE") && n.size)
      .map((n) => `${n.name ?? "Frame"} — ${Math.round(n.size?.x ?? 0)}×${Math.round(n.size?.y ?? 0)}`),
    24,
  );
  const colors = uniq(
    nodes.flatMap((n) => (n.fillPaints ?? []).filter((p) => p.color && p.type !== "IMAGE").map((p) => hex(p.color!))),
    16,
  );
  const fonts = uniq(
    nodes.map((n) => n.fontName?.family ?? ""),
    10,
  );
  const texts = uniq(
    nodes
      .filter((n) => n.type === "TEXT")
      .map((n) => (n.textData?.characters ?? n.characters ?? "").replace(/\s+/g, " ").trim())
      .map((t) => (t.length > 80 ? `${t.slice(0, 80)}…` : t)),
    24,
  );

  const lines = [`Imported Figma design (${filename}). Recreate it faithfully — match the layout, type, and palette.`];
  if (pages.length) lines.push(`Pages: ${pages.join(", ")}.`);
  if (frames.length) lines.push(`Frames (${frames.length}): ${frames.join("; ")}.`);
  if (colors.length) lines.push(`Palette: ${colors.join(", ")}.`);
  if (fonts.length) lines.push(`Fonts: ${fonts.join(", ")}.`);
  if (texts.length) lines.push(`Text content: ${texts.map((t) => `"${t}"`).join(" / ")}.`);
  if (lines.length === 1) lines.push(`(${nodes.length} nodes — could not extract structured layers.)`);
  return lines.join("\n");
}
