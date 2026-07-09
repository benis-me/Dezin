#!/usr/bin/env node
// dezin-probe — a dedicated CLI the Sharingan build Agent uses to drive the capture browser and read
// the captured bundle, INSTEAD of hand-writing curl/python. `BASE` is baked in when this file is
// copied into a project's .sharingan/ ; the daemon token comes from the environment. Run as:
//   node .sharingan/probe.mjs <command> [args]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "__BASE__";
const TOKEN = process.env.DEZIN_DAEMON_TOKEN || "";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function api(method, endpoint, body) {
  const res = await fetch(BASE + endpoint, {
    method,
    headers: {
      "x-dezin-daemon-token": TOKEN,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function print(result) {
  console.log(typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2));
}

// Condense a captured nested dom.json into a compact indented tree, so the Agent reads THIS instead
// of loading + regexing the raw (often hundreds-of-KB) dom.json.
function shortColor(c) {
  return String(c || "").replace(/\s+/g, ""); // "rgb(0, 0, 0)" -> "rgb(0,0,0)"
}

// Compact per-node style summary so `outline` is a SUFFICIENT blueprint — the agent shouldn't need to
// open the raw dom.json. Defaults/inherited values are skipped to keep each line terse.
function styleSummary(s) {
  if (!s) return "";
  const p = [];
  if (s.display === "flex") p.push(s.flexDirection === "column" ? "flex-col" : "flex-row");
  else if (s.display === "grid") p.push("grid");
  else if (s.display === "none") p.push("hidden");
  if (s.display === "flex" || s.display === "grid") {
    if (s.gap && s.gap !== "normal" && s.gap !== "0px") p.push("gap:" + s.gap);
    if (s.justifyContent && s.justifyContent !== "normal") p.push("jc:" + s.justifyContent);
    if (s.alignItems && s.alignItems !== "normal") p.push("ai:" + s.alignItems);
  }
  if (s.backgroundColor && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(s.backgroundColor)) p.push("bg:" + shortColor(s.backgroundColor));
  if (s.backgroundImage && s.backgroundImage !== "none") p.push("bg-img");
  if (s.color) p.push("fg:" + shortColor(s.color));
  if (s.fontSize && s.fontSize !== "16px") p.push("fs:" + s.fontSize + (s.fontWeight && s.fontWeight !== "400" ? "/" + s.fontWeight : ""));
  else if (s.fontWeight && s.fontWeight !== "400") p.push("fw:" + s.fontWeight);
  if (s.padding && s.padding !== "0px") p.push("p:" + s.padding);
  if (s.border && !/^0px/.test(s.border) && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(s.border)) p.push("bd:" + shortColor(s.border));
  if (s.textAlign && s.textAlign !== "start" && s.textAlign !== "left") p.push("ta:" + s.textAlign);
  return p.length ? " {" + p.join(" ") + "}" : "";
}

function outline(domPathArg) {
  let domPath = domPathArg;
  if (!domPath) {
    const manifest = JSON.parse(readFileSync(join(".sharingan", "pages.json"), "utf8"));
    domPath = manifest.pages && manifest.pages[0] && manifest.pages[0].dom;
    if (!domPath) fail("no captured page in .sharingan/pages.json");
  }
  const root = JSON.parse(readFileSync(domPath, "utf8"));
  const roots = Array.isArray(root) ? root : [root];
  const MAX = 500;
  const lines = [];
  const walk = (node, depth) => {
    if (lines.length >= MAX || !node) return;
    const cls = node.classes ? "." + String(node.classes).trim().split(/\s+/).slice(0, 2).join(".") : "";
    const box = node.box ? ` [${Math.round(node.box.w)}x${Math.round(node.box.h)}]` : "";
    const txt = node.text ? ` "${String(node.text).replace(/\s+/g, " ").trim().slice(0, 48)}"` : "";
    lines.push("  ".repeat(depth) + (node.tag || "?") + cls + box + styleSummary(node.style) + txt);
    for (const child of node.children || []) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  console.log(lines.join("\n"));
  if (lines.length >= MAX) console.log(`… truncated at ${MAX} nodes — read ${domPath} for the full tree`);
}

function renderMap(mapPathArg) {
  let mapPath = mapPathArg;
  if (!mapPath) {
    const manifest = JSON.parse(readFileSync(join(".sharingan", "pages.json"), "utf8"));
    mapPath = manifest.pages && manifest.pages[0] && manifest.pages[0].renderMap;
    if (!mapPath) fail("no render-map.json in .sharingan/pages.json");
  }
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const viewport = map.viewport || {};
  const doc = map.document || {};
  const lines = [
    `viewport ${Math.round(viewport.width || 0)}x${Math.round(viewport.height || 0)} document ${Math.round(doc.width || 0)}x${Math.round(doc.height || 0)}`,
  ];
  const MAX = 220;
  for (const el of (Array.isArray(map.elements) ? map.elements : []).slice(0, MAX)) {
    const b = el.box || {};
    const s = el.style || {};
    const parts = [];
    if (s.fontSize && s.fontSize !== "16px") parts.push("fs:" + s.fontSize + (s.fontWeight && s.fontWeight !== "400" ? "/" + s.fontWeight : ""));
    else if (s.fontWeight && s.fontWeight !== "400") parts.push("fw:" + s.fontWeight);
    if (s.color) parts.push("fg:" + shortColor(s.color));
    if (s.backgroundColor && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(s.backgroundColor)) parts.push("bg:" + shortColor(s.backgroundColor));
    if (s.backgroundImage && s.backgroundImage !== "none") parts.push("bg-img");
    if (s.objectFit && s.objectFit !== "fill") parts.push("fit:" + s.objectFit);
    const txt = el.text ? ` "${String(el.text).replace(/\s+/g, " ").trim().slice(0, 48)}"` : "";
    const style = parts.length ? " " + parts.join(" ") : "";
    lines.push(`${el.selector || el.tag || "?"} ${el.tag || "?"} [${Math.round(b.x || 0)},${Math.round(b.y || 0)} ${Math.round(b.w || 0)}x${Math.round(b.h || 0)}]${style}${txt}`);
  }
  console.log(lines.join("\n"));
  if ((map.elements || []).length > MAX) console.log(`… truncated at ${MAX} elements — read ${mapPath} for the full render map`);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function compactList(values, max = 10) {
  return Array.from(new Set((values || []).filter(Boolean).map((v) => String(v).replace(/\s+/g, " ").trim()).filter(Boolean))).slice(0, max);
}

function boxOf(el) {
  return el && el.box ? el.box : {};
}

function textOf(el) {
  return String((el && el.text) || "").replace(/\s+/g, " ").trim();
}

function cssUrlValues(value) {
  const urls = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
  let match;
  while ((match = re.exec(String(value || "")))) {
    if (match[2]) urls.push(match[2]);
  }
  return urls;
}

function mediaUrlsForElement(el) {
  const urls = [];
  for (const key of ["currentSrc", "src", "poster"]) {
    if (el && el[key]) urls.push(String(el[key]));
  }
  urls.push(...cssUrlValues(el && el.style && el.style.backgroundImage));
  return Array.from(new Set(urls.map((u) => String(u).trim()).filter(Boolean)));
}

function canonicalUrl(value, stripQuery = false) {
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    if (stripQuery) u.search = "";
    return decodeURIComponent(u.href);
  } catch {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}

function urlsEquivalent(a, b) {
  const aa = canonicalUrl(a);
  const bb = canonicalUrl(b);
  return !!aa && !!bb && (aa === bb || canonicalUrl(aa, true) === canonicalUrl(bb, true));
}

function assetUrls(asset) {
  return ["url", "src", "currentSrc", "poster", "href"].map((key) => asset && asset[key]).filter(Boolean).map(String);
}

function isImageLikeAsset(asset) {
  const local = String((asset && asset.local) || "");
  const kind = String((asset && asset.kind) || "");
  return kind === "img" || kind === "background" || /\.(png|jpe?g|webp|gif|svg)$/i.test(local);
}

function assetMatchesSlotUrl(asset, slotUrls) {
  const urls = assetUrls(asset);
  return urls.some((assetUrl) => slotUrls.some((slotUrl) => urlsEquivalent(assetUrl, slotUrl)));
}

function assetSizeScore(asset, slot) {
  const aw = finite(asset && asset.w, 0);
  const ah = finite(asset && asset.h, 0);
  if (aw <= 0 || ah <= 0 || slot.box.w <= 0 || slot.box.h <= 0) return Infinity;
  const dw = Math.abs(aw - slot.box.w) / Math.max(1, slot.box.w);
  const dh = Math.abs(ah - slot.box.h) / Math.max(1, slot.box.h);
  const aspect = Math.abs(aw / ah - slot.box.w / slot.box.h);
  return dw + dh + aspect * 0.35;
}

function findAssetForSlot(slot, assets, usedAssets) {
  for (const [index, asset] of assets.entries()) {
    if (assetMatchesSlotUrl(asset, slot.urls)) return { index, asset };
  }

  let best = null;
  let bestScore = Infinity;
  for (const [index, asset] of assets.entries()) {
    if (usedAssets.has(index)) continue;
    const score = assetSizeScore(asset, slot);
    if (score < bestScore) {
      best = { index, asset };
      bestScore = score;
    }
  }
  if (best && bestScore <= 0.55) return best;

  for (const [index, asset] of assets.entries()) {
    if (!usedAssets.has(index)) return { index, asset };
  }
  return null;
}

function uniquifySvgHtml(html, index) {
  const prefix = `sgv-${index}-`;
  const ids = Array.from(String(html || "").matchAll(/\sid="([^"]+)"/g), (match) => match[1]).filter(Boolean);
  let out = String(html || "");
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`id="${escaped}"`, "g"), `id="${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${prefix}${id})`)
      .replace(new RegExp(`href="#${escaped}"`, "g"), `href="#${prefix}${id}"`)
      .replace(new RegExp(`xlink:href="#${escaped}"`, "g"), `xlink:href="#${prefix}${id}"`);
  }
  return out;
}

function shiftTextBoxForInlineMedia(item, mediaSlots) {
  const leftMedia = mediaSlots.filter((media) => {
    if (!centerInside(media.box, item.box)) return false;
    if (media.box.x > item.box.x + item.box.w * 0.45) return false;
    if (media.box.w > item.box.w * 0.45 || media.box.h > item.box.h * 0.9) return false;
    return true;
  });
  if (!leftMedia.length) return item;
  const mediaRight = Math.max(...leftMedia.map((media) => media.box.x + media.box.w));
  const nextX = Math.min(item.box.x + item.box.w - 8, Math.ceil(mediaRight + 8));
  const dx = Math.max(0, nextX - item.box.x);
  if (dx <= 0 || item.box.w - dx < 8) return item;
  return { ...item, box: { ...item.box, x: nextX, w: item.box.w - dx } };
}

function sourceSummary() {
  const manifest = readJson(join(".sharingan", "pages.json"), null);
  const page = manifest && manifest.pages && manifest.pages[0];
  if (!page) fail("no captured page in .sharingan/pages.json");
  const map = readJson(page.renderMap, {});
  const styles = readJson(page.styles, {});
  const assetsRaw = readJson(page.assets, []);
  const assets = Array.isArray(assetsRaw) ? assetsRaw : Array.isArray(assetsRaw.assets) ? assetsRaw.assets : [];
  const elements = Array.isArray(map.elements) ? map.elements : [];
  const viewport = map.viewport || {};
  const doc = map.document || {};
  const viewportH = Number(viewport.height) || 900;
  const docH = Number(doc.height) || viewportH;

  const texts = elements
    .map((el) => ({ el, text: textOf(el), box: boxOf(el) }))
    .filter((item) => item.text && Number(item.box.w) > 0 && Number(item.box.h) > 0)
    .sort((a, b) => (a.box.y || 0) - (b.box.y || 0) || (a.box.x || 0) - (b.box.x || 0));
  const navTexts = compactList(texts.filter((t) => (t.box.y || 0) < Math.min(120, viewportH * 0.16)).map((t) => t.text), 12);
  const hero = texts.find((t) => (t.box.y || 0) < viewportH * 0.45 && ((t.el.tag || "").match(/^h[1-3]$/i) || Number(t.box.h) >= 28 || t.text.length >= 8));
  const firstViewportTexts = compactList(texts.filter((t) => (t.box.y || 0) < viewportH).map((t) => t.text), 36);
  const footerTexts = compactList(texts.filter((t) => (t.box.y || 0) > docH - 280).map((t) => t.text), 12);
  const imageElements = elements.filter((el) => {
    const tag = String(el.tag || "").toLowerCase();
    return tag === "img" || tag === "video" || mediaUrlsForElement(el).length > 0;
  });
  const localAssets = assets.filter((a) => a && a.local);

  const lines = [];
  lines.push("SOURCE SUMMARY (bounded; use this instead of ad-hoc dom.json scripts)");
  lines.push(`url: ${page.url || manifest.entryUrl || ""}`);
  lines.push(`viewport: ${Math.round(viewport.width || 0)}x${Math.round(viewport.height || 0)} document: ${Math.round(doc.width || 0)}x${Math.round(doc.height || 0)}`);
  lines.push("");
  lines.push("SOURCE COMPONENT INVENTORY");
  lines.push(`- Header/nav: ${navTexts.length ? navTexts.join(" | ") : "not prominent in first viewport"}`);
  lines.push(`- Hero/primary panel: ${hero ? hero.text : "not text-dominant; mirror top measured region"}`);
  lines.push(`- Media/card grid: ${imageElements.length} image/video slot${imageElements.length === 1 ? "" : "s"} measured; ${localAssets.length} local asset${localAssets.length === 1 ? "" : "s"} downloaded`);
  if (footerTexts.length) lines.push(`- Footer/bottom text: ${footerTexts.join(" | ")}`);
  lines.push("");
  lines.push("STYLE TOKENS");
  lines.push(`- colors: ${compactList(styles.colors, 16).join(", ") || "see styles.json"}`);
  lines.push(`- fonts: ${compactList(styles.fontFamilies, 8).join(", ") || "see styles.json"}`);
  lines.push(`- font sizes: ${compactList(styles.fontSizes, 12).join(", ") || "see styles.json"}`);
  lines.push(`- radii: ${compactList(styles.radii, 8).join(", ") || "see styles.json"}`);
  lines.push("");
  lines.push("FIRST VIEWPORT TEXT ORDER");
  for (const text of firstViewportTexts) lines.push(`- ${text}`);
  lines.push("");
  lines.push("ASSET INVENTORY");
  for (const a of localAssets.slice(0, 30)) {
    const size = [a.w, a.h].filter((n) => Number(n) > 0).join("x");
    lines.push(`- ${a.local}${size ? ` (${size})` : ""}${a.alt ? ` alt="${String(a.alt).slice(0, 60)}"` : ""}`);
  }
  if (localAssets.length > 30) lines.push(`- … ${localAssets.length - 30} more local assets`);
  lines.push("");
  lines.push("BUILD DIRECTIVE");
  lines.push("- Start writing the Source Component Inventory and React components now.");
  lines.push("- Do not run node/python/jq scripts against dom.json or render-map.json after this summary.");
  lines.push("- Use outline/render-map only for one targeted repair if visual QA later reports a measured mismatch.");
  console.log(lines.join("\n"));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cssNumber(value) {
  const match = /-?\d*\.?\d+/.exec(String(value || ""));
  return match ? Number(match[0]) : NaN;
}

function fontSizePx(style) {
  return Math.max(1, finite(cssNumber(style && style.fontSize), 16));
}

function lineHeightPx(style) {
  const fontSize = fontSizePx(style);
  const raw = String((style && style.lineHeight) || "normal").trim();
  if (!raw || raw === "normal") return fontSize * 1.2;
  if (/^-?\d*\.?\d+$/.test(raw)) return Math.max(1, finite(raw, 1.2) * fontSize);
  return Math.max(1, finite(cssNumber(raw), fontSize * 1.2));
}

function textLineCount(item) {
  const lineHeight = lineHeightPx(item.style || {});
  return Math.max(1, Math.min(12, Math.floor((finite(item.box && item.box.h, 0) + 2) / lineHeight)));
}

function visibleBox(el, viewport, doc) {
  const b = boxOf(el);
  const x = finite(b.x);
  const y = finite(b.y);
  const w = finite(b.w);
  const h = finite(b.h);
  const vw = finite(viewport.width, 1440);
  const dh = finite(doc.height, finite(viewport.height, 900));
  if (w <= 1 || h <= 1) return null;
  if (x + w <= 0 || x >= vw || y + h <= 0 || y >= dh) return null;
  const visibleW = Math.max(0, Math.min(x + w, vw) - Math.max(x, 0));
  const visibleH = Math.max(0, Math.min(y + h, dh) - Math.max(y, 0));
  const visibleRatio = (visibleW * visibleH) / Math.max(1, w * h);
  if ((x < 0 || x + w > vw) && w * h >= 4000 && visibleRatio < 0.18) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function hasPaint(style) {
  if (!style) return false;
  const bg = String(style.backgroundColor || "");
  const bgImage = String(style.backgroundImage || "");
  const shadow = String(style.boxShadow || "");
  const radius = String(style.borderRadius || "");
  return (
    (bg && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(bg)) ||
    (bgImage && bgImage !== "none") ||
    (shadow && shadow !== "none") ||
    (radius && radius !== "0px")
  );
}

function overlaps(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

function centerInside(inner, outer) {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

function sourceScaffold() {
  const manifest = readJson(join(".sharingan", "pages.json"), null);
  const page = manifest && manifest.pages && manifest.pages[0];
  if (!page) fail("no captured page in .sharingan/pages.json");
  const map = readJson(page.renderMap, {});
  const assetsRaw = readJson(page.assets, []);
  const assets = asArray(Array.isArray(assetsRaw.assets) ? assetsRaw.assets : assetsRaw).filter((a) => a && a.local);
  const elements = Array.isArray(map.elements) ? map.elements : [];
  const viewport = map.viewport || { width: 1440, height: 900 };
  const doc = map.document || viewport;
  const vw = Math.round(finite(viewport.width, 1440));
  const dh = Math.round(finite(doc.height, finite(viewport.height, 900)));

  const painted = [];
  const imageSlots = [];
  const vectorSlots = [];
  const rawTexts = [];
  for (const [i, el] of elements.entries()) {
    const box = visibleBox(el, viewport, doc);
    if (!box) continue;
    const style = el.style || {};
    if (Number(style.opacity || 1) <= 0.05) continue;
    const tag = String(el.tag || "").toLowerCase();
    const selector = String(el.selector || "");
    if (tag === "body" || selector === "#root") continue;
    const mediaUrls = mediaUrlsForElement(el);
    const isMediaSlot = tag === "img" || tag === "video" || mediaUrls.length > 0;
    const svgHtml = tag === "svg" && typeof el.svg === "string" && el.svg.length > 0 ? el.svg : "";
    const isVectorSlot = Boolean(svgHtml) && box.w * box.h <= vw * dh * 0.25;
    if (isMediaSlot) imageSlots.push({ i, box, style, text: textOf(el), selector, tag, urls: mediaUrls });
    if (isVectorSlot) vectorSlots.push({ i, box, style, selector, html: uniquifySvgHtml(svgHtml, vectorSlots.length) });
    if (!isMediaSlot && !isVectorSlot && hasPaint(style) && box.w * box.h >= 80) painted.push({ i, box, style });
    const text = textOf(el);
    if (text && text.length <= 180 && box.w * box.h <= vw * dh * 0.28) rawTexts.push({ i, box, style, text, tag });
  }

  const textSlots = [];
  for (const item of rawTexts.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h || a.text.length - b.text.length)) {
    const overlapMatch = textSlots.some((existing) => {
      const area = Math.min(item.box.w * item.box.h, existing.box.w * existing.box.h);
      return area > 0 && overlaps(item.box, existing.box) / area > 0.65 && (item.text.includes(existing.text) || existing.text.includes(item.text));
    });
    const containedTextCount = textSlots.filter((existing) => centerInside(existing.box, item.box) && item.text.includes(existing.text)).length;
    if (!overlapMatch && containedTextCount < 2) textSlots.push(item);
    if (textSlots.length >= 160) break;
  }
  textSlots.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const adjustedTextSlots = textSlots.map((item) => shiftTextBoxForInlineMedia(item, [...imageSlots, ...vectorSlots]));

  const imgAssets = assets.filter(isImageLikeAsset);
  const usedAssets = new Set();
  const assignedImages = [];
  const images = imageSlots.slice(0, 260).map((slot) => {
    const duplicate = assignedImages.find((prev) => {
      const overlap = overlaps(prev.box, slot.box) / Math.max(1, Math.min(prev.box.w * prev.box.h, slot.box.w * slot.box.h));
      return overlap > 0.98 && prev.selector === slot.selector && prev.tag === slot.tag && prev.match;
    });
    const dataSrc = slot.urls.find((url) => /^data:image\//i.test(url));
    const match = dataSrc ? null : duplicate ? duplicate.match : findAssetForSlot(slot, imgAssets, usedAssets);
    if (match) usedAssets.add(match.index);
    const image = {
      ...slot,
      src: (match && match.asset && match.asset.local) || dataSrc || "",
      alt: (match && match.asset && match.asset.alt) || slot.text || "",
      match,
    };
    assignedImages.push(image);
    return image;
  });
  const boxes = painted
    .filter((item) => !imageSlots.some((img) => {
      const imgArea = img.box.w * img.box.h;
      const itemArea = item.box.w * item.box.h;
      return imgArea >= itemArea * 0.75 && overlaps(img.box, item.box) / Math.max(1, Math.min(imgArea, itemArea)) > 0.92;
    }))
    .slice(0, 180);

  const data = {
    pageUrl: page.url || manifest.entryUrl || "",
    viewport: { width: vw, height: Math.round(finite(viewport.height, 900)) },
    document: { width: Math.round(finite(doc.width, vw)), height: dh },
    boxes: boxes.map((item) => ({
      box: item.box,
      backgroundColor: item.style.backgroundColor || "transparent",
      backgroundImage: item.style.backgroundImage || "none",
      borderRadius: item.style.borderRadius || "0px",
      boxShadow: item.style.boxShadow || "none",
      opacity: item.style.opacity || "1",
    })),
    images: images.map((item) => ({
      box: item.box,
      src: item.src,
      alt: item.alt,
      objectFit: item.style.objectFit || "cover",
      borderRadius: item.style.borderRadius || "0px",
      opacity: item.style.opacity || "1",
    })),
    vectors: vectorSlots.slice(0, 160).map((item) => ({
      box: item.box,
      html: item.html,
      opacity: item.style.opacity || "1",
    })),
    texts: adjustedTextSlots.map((item) => ({
      box: item.box,
      text: item.text,
      lines: textLineCount(item),
      color: item.style.color || "rgb(245, 245, 245)",
      fontSize: item.style.fontSize || "16px",
      fontWeight: item.style.fontWeight || "400",
      lineHeight: item.style.lineHeight || "normal",
      letterSpacing: item.style.letterSpacing || "normal",
      textAlign: item.style.textAlign || "left",
    })),
  };

  mkdirSync("src", { recursive: true });
  writeFileSync(
    join("src", "App.jsx"),
    `// SHARINGAN SOURCE SCAFFOLD - CANONICAL REPLAY DATA.
// Do not replace this with hand-authored semantic components during the first build pass.
// Keep SOURCE.boxes, SOURCE.images, SOURCE.vectors, and SOURCE.texts rendering one-for-one unless visual QA names a local patch.
const SOURCE = ${JSON.stringify(data, null, 2)};

function boxStyle(item) {
  return {
    left: item.box.x,
    top: item.box.y,
    width: item.box.w,
    height: item.box.h,
    backgroundColor: item.backgroundColor,
    backgroundImage: item.backgroundImage && item.backgroundImage !== "none" ? item.backgroundImage : undefined,
    borderRadius: item.borderRadius,
    boxShadow: item.boxShadow,
    opacity: Number(item.opacity || 1),
  };
}

function imageStyle(item) {
  return {
    left: item.box.x,
    top: item.box.y,
    width: item.box.w,
    height: item.box.h,
    objectFit: item.objectFit || "cover",
    borderRadius: item.borderRadius,
    opacity: Number(item.opacity || 1),
  };
}

function vectorStyle(item) {
  return {
    left: item.box.x,
    top: item.box.y,
    width: item.box.w,
    height: item.box.h,
    opacity: Number(item.opacity || 1),
  };
}

function textJustify(value) {
  if (value === "center") return "center";
  if (value === "right" || value === "end") return "flex-end";
  return "flex-start";
}

function textStyle(item) {
  const lines = Math.max(1, Number(item.lines || 1));
  return {
    left: item.box.x,
    top: item.box.y,
    width: item.box.w,
    height: item.box.h,
    color: item.color,
    fontSize: item.fontSize,
    fontWeight: item.fontWeight,
    lineHeight: item.lineHeight,
    letterSpacing: item.letterSpacing,
    textAlign: item.textAlign,
    "--source-lines": lines,
    ...(lines <= 1 ? { justifyContent: textJustify(item.textAlign) } : {}),
  };
}

export default function App() {
  return (
    <main className="sharingan-root" aria-label={SOURCE.pageUrl}>
      <div className="sharingan-stage" style={{ width: SOURCE.document.width, height: SOURCE.document.height }}>
        {SOURCE.boxes.map((item, index) => (
          <div key={"box-" + index} className="source-box" style={boxStyle(item)} />
        ))}
        {SOURCE.images.map((item, index) =>
          item.src ? (
            <img key={"img-" + index} className="source-image" src={item.src} alt={item.alt || ""} style={imageStyle(item)} />
          ) : (
            <div key={"img-" + index} className="source-image source-missing" style={imageStyle(item)} />
          ),
        )}
        {(SOURCE.vectors || []).map((item, index) => (
          <div key={"vector-" + index} className="source-vector" style={vectorStyle(item)} dangerouslySetInnerHTML={{ __html: item.html }} />
        ))}
        {SOURCE.texts.map((item, index) => (
          <div key={"text-" + index} className="source-text" data-lines={item.lines || 1} style={textStyle(item)}>
            {item.text}
          </div>
        ))}
      </div>
    </main>
  );
}
`,
  );
  writeFileSync(
    join("src", "index.css"),
    `:root {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: rgb(245, 245, 245);
  background: rgb(0, 0, 0);
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  width: 100%;
  min-height: 100%;
  margin: 0;
  background: rgb(0, 0, 0);
}

body {
  overflow-x: auto;
}

.sharingan-root {
  width: 100%;
  min-height: 100vh;
  background: rgb(0, 0, 0);
}

.sharingan-stage {
  position: relative;
  overflow: hidden;
  background: rgb(15, 15, 15);
  transform-origin: top left;
}

.source-box,
.source-image,
.source-text {
  position: absolute;
}

.source-image {
  display: block;
  overflow: hidden;
}

.source-vector {
  position: absolute;
  overflow: visible;
  pointer-events: none;
}

.source-vector svg {
  width: 100%;
  height: 100%;
  display: block;
}

.source-missing {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.source-text {
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--source-lines, 1);
  white-space: normal;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
}

.source-text[data-lines="1"] {
  display: flex;
  align-items: center;
  white-space: nowrap;
  overflow-wrap: normal;
}

@media (max-width: 700px) {
  body {
    overflow-x: hidden;
  }

  .sharingan-stage {
    transform: scale(0.27);
  }
}
`,
  );
  console.log(`SOURCE SCAFFOLD wrote src/App.jsx and src/index.css from ${boxes.length} boxes, ${images.length} images, ${vectorSlots.length} vectors, ${adjustedTextSlots.length} text nodes.`);
}

const HELP = `dezin-probe — drive the Sharingan capture browser + read the capture (no curl/python needed).
Usage: node .sharingan/probe.mjs <command> [args]

  source-summary        one bounded source digest: component inventory + tokens + key text + assets
  source-scaffold       write measured first-pass src/App.jsx + src/index.css from render-map/assets
  navigate <url>        open a URL in the live capture browser
  read-dom              visible DOM nodes (tag/role/text/box) as JSON
  styles                computed style tokens (colors / fonts / radii / shadows)
  links                 same-origin links discovered on the current page
  click <selector>      click an element
  scroll <y>            scroll to a Y offset (px)
  capture [url]         capture the current (or given) page into .sharingan/
  outline [dom.json]    condensed indented tree of a captured page — READ THIS instead of parsing dom.json
  render-map [render-map.json] browser-measured layout rows from a captured page`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "source-summary" || cmd === "summary") return sourceSummary();
  if (cmd === "source-scaffold" || cmd === "scaffold") return sourceScaffold();
  if (cmd === "outline") return outline(args[0]);
  if (cmd === "render-map") return renderMap(args[0]);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return void console.log(HELP);
  if (!BASE || BASE === "__BASE__" || !TOKEN) fail("dezin-probe: not in a Sharingan run (base/token missing).");
  switch (cmd) {
    case "navigate":
      if (!args[0]) fail("usage: navigate <url>");
      print(await api("POST", "/navigate", { url: args[0] }));
      break;
    case "read-dom":
      print(await api("GET", "/read-dom"));
      break;
    case "styles":
    case "computed-styles":
      print(await api("GET", "/computed-styles"));
      break;
    case "links":
      print(await api("GET", "/links"));
      break;
    case "click":
      if (!args[0]) fail("usage: click <selector>");
      print(await api("POST", "/click", { selector: args[0] }));
      break;
    case "scroll": {
      const y = Number(args[0]);
      if (!Number.isFinite(y)) fail("usage: scroll <y-offset-number>");
      print(await api("POST", "/scroll", { y }));
      break;
    }
    case "capture":
      if (args[0] && !/^https?:\/\//i.test(args[0])) fail("capture: url must start with http(s):// (or omit it to capture the current page)");
      print(await api("POST", "/capture", args[0] ? { url: args[0] } : undefined));
      break;
    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => fail("dezin-probe error: " + (e && e.message ? e.message : e)));
