import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import type { SharinganCaptureBundleFileInput } from "../../src/orchestration/sharingan-capture-resource-bundle.ts";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.byteLength);
  chunk.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.byteLength);
  return chunk;
}

export function sharinganFixturePng(width = 1440, height = 1800): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const SHARINGAN_FIXTURE_SCREENSHOT = sharinganFixturePng();

export interface SemanticSharinganFixtureOptions {
  readonly requestedUrl?: string;
  readonly finalUrl?: string;
  readonly marker?: string;
  readonly screenshotBytes?: Uint8Array;
  readonly dom?: unknown;
  readonly styles?: unknown;
  readonly renderMap?: unknown;
  readonly assetBytes?: Uint8Array;
}

export function semanticSharinganCaptureFiles(
  options: SemanticSharinganFixtureOptions = {},
): SharinganCaptureBundleFileInput[] {
  const requestedUrl = options.requestedUrl ?? "https://example.com/";
  const finalUrl = options.finalUrl ?? requestedUrl;
  const marker = options.marker ?? "exact";
  const dom = options.dom ?? [{
    tag: "body",
    classes: "",
    text: "",
    box: { x: 0, y: 0, w: 1440, h: 1800 },
    style: { display: "block", color: "rgb(17, 17, 17)", fontSize: "16px" },
    children: [{
      tag: "main",
      classes: "page",
      text: "Captured source",
      box: { x: 48, y: 48, w: 1344, h: 900 },
      style: { display: "block", color: "rgb(17, 17, 17)", fontSize: "16px" },
      children: [],
    }],
  }];
  const styles = options.styles ?? {
    colors: ["rgb(17, 17, 17)"],
    fontFamilies: ["Inter"],
    fontSizes: ["16px"],
    radii: [],
    shadows: [],
  };
  const renderMap = options.renderMap ?? {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 1800 },
    elements: [{
      selector: "body",
      tag: "body",
      text: "Captured source",
      box: { x: 0, y: 0, w: 1440, h: 1800 },
      style: { display: "block", color: "rgb(17, 17, 17)", fontSize: "16px" },
    }],
  };
  const pages = {
    schemaVersion: 2,
    requestedSourceUrl: requestedUrl,
    sourceUrl: finalUrl,
    marker,
    pages: [{
      requestedUrl,
      url: finalUrl,
      title: marker,
      screenshots: { desktop: ".sharingan/entry/shot.png" },
      dom: ".sharingan/entry/dom.json",
      styles: ".sharingan/entry/styles.json",
      assets: ".sharingan/entry/assets.json",
      renderMap: ".sharingan/entry/render-map.json",
      links: [],
    }],
  };
  const values: readonly (readonly [string, Uint8Array])[] = [
    [".sharingan/pages.json", Buffer.from(JSON.stringify(pages))],
    [".sharingan/probe.mjs", Buffer.from("export const immutableProbe = true;\n")],
    [".sharingan/entry/shot.png", options.screenshotBytes ?? SHARINGAN_FIXTURE_SCREENSHOT],
    [".sharingan/entry/dom.json", Buffer.from(JSON.stringify(dom))],
    [".sharingan/entry/styles.json", Buffer.from(JSON.stringify(styles))],
    [".sharingan/entry/assets.json", Buffer.from(JSON.stringify([{ kind: "img", local: "/_assets/source.png" }]))],
    [".sharingan/entry/render-map.json", Buffer.from(JSON.stringify(renderMap))],
    ["public/_assets/source.png", options.assetBytes ?? sharinganFixturePng(64, 64)],
  ];
  return values.map(([path, bytes]) => ({
    path,
    bytes,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  }));
}
