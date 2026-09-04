/**
 * Cloud web resources for generated Nodes: Fontsource fonts (loaded by the
 * browser from jsDelivr, the single permitted remote origin) and Iconify icon
 * sets (fetched once by the daemon, cached on disk, and inlined into the HTML
 * before validation so every published Version stays self-contained).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createProviderFetch } from "../provider-fetch.ts";

/** CSP source expression covering Fontsource CSS and font files. */
export const DESIGN_WEB_RESOURCE_CSP_SOURCE = "https://cdn.jsdelivr.net/fontsource/";

const FONTSOURCE_ID = "[a-z0-9-]+(?::vf)?@(?:latest|\\d+(?:\\.\\d+){0,2})";
const FONTSOURCE_CSS_URL = new RegExp(`^https://cdn\\.jsdelivr\\.net/fontsource/css/${FONTSOURCE_ID}/[a-z0-9-]+\\.css$`, "i");
const FONTSOURCE_FONT_URL = new RegExp(`^https://cdn\\.jsdelivr\\.net/fontsource/fonts/${FONTSOURCE_ID}/[a-z0-9-]+\\.(?:woff2|woff)$`, "i");

export function isDesignWebFontStylesheetUrl(url: string): boolean {
  return FONTSOURCE_CSS_URL.test(url.trim());
}

export function isDesignWebFontFileUrl(url: string): boolean {
  return FONTSOURCE_FONT_URL.test(url.trim());
}

/** Exactly the remote URLs a generated Node may load when web resources are enabled. */
export function isDesignWebResourceUrl(url: string): boolean {
  return isDesignWebFontStylesheetUrl(url) || isDesignWebFontFileUrl(url);
}

const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "inherit", "initial", "unset",
]);
const SYSTEM_FAMILY = /^(?:-apple-system|blinkmacsystemfont|segoe ui|sf pro|sf mono|sfmono|helvetica|arial|roboto$|menlo|monaco|consolas|courier|georgia|times|cambria|songti|pingfang|hiragino|microsoft yahei|noto sans$|noto serif$)/i;

/** The Fontsource id of a family name: lowercase, hyphenated. */
export function fontsourceIdForFamily(family: string): string {
  return family.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface DesignWebFont {
  family: string;
  id: string;
}

/**
 * Families a design system names in its `--font-*` tokens that a web font can
 * satisfy: the first family of each stack, minus generic and system faces.
 */
export function designSystemWebFonts(tokensCss: string): DesignWebFont[] {
  const fonts = new Map<string, DesignWebFont>();
  for (const match of tokensCss.matchAll(/--font-[a-z0-9-]+\s*:\s*([^;]+);/gi)) {
    const first = match[1]!.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
    if (!first || GENERIC_FAMILIES.has(first.toLowerCase()) || SYSTEM_FAMILY.test(first)) continue;
    const id = fontsourceIdForFamily(first);
    if (id && !fonts.has(id)) fonts.set(id, { family: first, id });
  }
  return [...fonts.values()];
}

export interface DesignIconSetSource {
  prefix: string;
  name: string;
  license: string;
  /** Exact @iconify-json package version: immutable data whose embedded license was checked. */
  version: string;
}

/**
 * Open-source Iconify sets that suit interface work. Versions are pinned on
 * purpose: Remix Icon moved upstream to a custom licence in January 2026, and
 * @iconify-json/ri 1.2.10 still carries the Apache-2.0 4.8.0 data.
 */
export const DESIGN_ICON_SETS: readonly DesignIconSetSource[] = [
  { prefix: "lucide", name: "Lucide", license: "ISC", version: "1.2.129" },
  { prefix: "ph", name: "Phosphor", license: "MIT", version: "1.2.2" },
  { prefix: "ri", name: "Remix Icon", license: "Apache-2.0", version: "1.2.10" },
  { prefix: "tabler", name: "Tabler Icons", license: "MIT", version: "1.2.38" },
  { prefix: "hugeicons", name: "Hugeicons (free)", license: "MIT", version: "1.2.34" },
  { prefix: "mingcute", name: "MingCute", license: "Apache-2.0", version: "1.2.8" },
  { prefix: "heroicons", name: "Heroicons", license: "MIT", version: "1.2.3" },
];

export interface DesignIconSet extends DesignIconSetSource {
  /** Cached Iconify JSON on disk. */
  path: string;
  /** Sorted icon names including aliases. */
  names: readonly string[];
}

interface IconifyIcon {
  body: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  rotate?: number;
  hFlip?: boolean;
  vFlip?: boolean;
}

interface IconifyJson {
  prefix: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  icons: Record<string, IconifyIcon>;
  aliases?: Record<string, IconifyIcon & { parent: string }>;
}

const ICON_SET_TIMEOUT_MS = 20_000;
const MAX_ICON_SET_BYTES = 32 * 1024 * 1024;
const SAFE_ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SAFE_PACKAGE_VERSION = /^\d+\.\d+\.\d+$/;

export function designIconSetUrl(source: Pick<DesignIconSetSource, "prefix" | "version">): string {
  if (!SAFE_PACKAGE_VERSION.test(source.version)) throw new Error(`Icon set ${source.prefix} needs an exact version`);
  return `https://cdn.jsdelivr.net/npm/@iconify-json/${source.prefix}@${source.version}/icons.json`;
}

function designIconSetPath(dataDir: string, source: Pick<DesignIconSetSource, "prefix" | "version">): string {
  return join(dataDir, "web-resources", "icons", `${source.prefix}@${source.version}.json`);
}

function parseIconifyJson(text: string, prefix: string): IconifyJson {
  const parsed = JSON.parse(text) as Partial<IconifyJson>;
  if (!parsed || parsed.prefix !== prefix || typeof parsed.icons !== "object" || parsed.icons === null) {
    throw new Error(`Icon set ${prefix} is not an Iconify JSON collection`);
  }
  return parsed as IconifyJson;
}

function iconNames(json: IconifyJson): string[] {
  return [...new Set([...Object.keys(json.icons), ...Object.keys(json.aliases ?? {})])]
    .filter((name) => SAFE_ICON_NAME.test(name))
    .sort();
}

/**
 * Best-effort: cached sets load from disk, missing sets are fetched once from
 * jsDelivr, and a set that cannot be loaded is simply absent for this turn.
 */
const loadedIconSets = new Map<string, DesignIconSet>();
const ICON_SET_WAIT_MS = 8_000;

export async function loadDesignIconSets(
  dataDir: string,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    sets?: readonly DesignIconSetSource[];
    /** How long a turn waits for a first download; slower sets finish in the background for the next turn. */
    waitMs?: number;
  } = {},
): Promise<DesignIconSet[]> {
  const fetchImpl = options.fetch ?? createProviderFetch();
  const loads = (options.sets ?? DESIGN_ICON_SETS).map(async (source): Promise<DesignIconSet | null> => {
    const path = designIconSetPath(dataDir, source);
    const memoized = loadedIconSets.get(path);
    if (memoized) return memoized;
    try {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ICON_SET_TIMEOUT_MS);
        const onAbort = () => controller.abort();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const response = await fetchImpl(designIconSetUrl(source), { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const length = Number(response.headers.get("content-length") ?? 0);
          if (length > MAX_ICON_SET_BYTES) throw new Error("icon set is too large");
          text = await response.text();
          if (Buffer.byteLength(text, "utf8") > MAX_ICON_SET_BYTES) throw new Error("icon set is too large");
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        }
        parseIconifyJson(text, source.prefix);
        await mkdir(join(dataDir, "web-resources", "icons"), { recursive: true });
        await writeFile(path, text, { mode: 0o600 });
      }
      const set = { ...source, path, names: iconNames(parseIconifyJson(text, source.prefix)) };
      loadedIconSets.set(path, set);
      return set;
    } catch {
      return null;
    }
  });
  const loaded = await Promise.all(loads.map((load) => Promise.race([
    load,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), options.waitMs ?? ICON_SET_WAIT_MS);
      timer.unref();
      void load.finally(() => clearTimeout(timer));
    }),
  ])));
  return loaded.filter((set): set is DesignIconSet => set !== null);
}

/** One icon name per line; the Agent greps it to find exact names. */
export function designIconCatalog(set: DesignIconSet): string {
  return `${set.names.join("\n")}\n`;
}

function resolveIcon(json: IconifyJson, name: string, depth = 0): IconifyIcon | null {
  const icon = json.icons[name];
  if (icon) return icon;
  const alias = json.aliases?.[name];
  if (!alias || depth > 4) return null;
  const parent = resolveIcon(json, alias.parent, depth + 1);
  if (!parent) return null;
  return {
    ...parent,
    ...(alias.width === undefined ? {} : { width: alias.width }),
    ...(alias.height === undefined ? {} : { height: alias.height }),
    ...(alias.left === undefined ? {} : { left: alias.left }),
    ...(alias.top === undefined ? {} : { top: alias.top }),
    rotate: ((parent.rotate ?? 0) + (alias.rotate ?? 0)) % 4,
    hFlip: Boolean(parent.hFlip) !== Boolean(alias.hFlip),
    vFlip: Boolean(parent.vFlip) !== Boolean(alias.vFlip),
  };
}

function renderIcon(json: IconifyJson, icon: IconifyIcon): { viewBox: string; body: string } {
  const left = icon.left ?? json.left ?? 0;
  const top = icon.top ?? json.top ?? 0;
  const width = icon.width ?? json.width ?? 16;
  const height = icon.height ?? json.height ?? 16;
  const transforms: string[] = [];
  if (icon.hFlip) transforms.push(`translate(${width + left * 2} 0) scale(-1 1)`);
  if (icon.vFlip) transforms.push(`translate(0 ${height + top * 2}) scale(1 -1)`);
  const rotate = ((icon.rotate ?? 0) % 4 + 4) % 4;
  if (rotate !== 0) transforms.push(`rotate(${rotate * 90} ${left + width / 2} ${top + height / 2})`);
  const body = transforms.length > 0 ? `<g transform="${transforms.join(" ")}">${icon.body}</g>` : icon.body;
  return { viewBox: `${left} ${top} ${width} ${height}`, body };
}

const ICON_PLACEHOLDER = /<svg\b([^>]*?)\sdata-icon=(["'])([a-z0-9-]+):([a-z0-9-]+)\2([^>]*)>([\s\S]*?)<\/svg>/gi;
const REPLACED_ATTRIBUTES = /\s(?:viewBox|xmlns|aria-hidden)=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export interface ExpandedDesignIcons {
  html: string;
  /** `prefix:name` references that no enabled set provides, in document order. */
  unknown: string[];
}

/**
 * Replace every `<svg data-icon="set:name">` with the real vector. Re-running
 * on already expanded markup is idempotent because `data-icon` survives.
 */
export async function expandDesignIcons(html: string, sets: readonly DesignIconSet[]): Promise<ExpandedDesignIcons> {
  const byPrefix = new Map(sets.map((set) => [set.prefix, set]));
  const jsonByPrefix = new Map<string, IconifyJson | null>();
  const unknown: string[] = [];
  const references = [...html.matchAll(ICON_PLACEHOLDER)];
  if (references.length === 0) return { html, unknown };
  for (const prefix of new Set(references.map((match) => match[3]!.toLowerCase()))) {
    const set = byPrefix.get(prefix);
    if (!set) {
      jsonByPrefix.set(prefix, null);
      continue;
    }
    try {
      jsonByPrefix.set(prefix, parseIconifyJson(await readFile(set.path, "utf8"), prefix));
    } catch {
      jsonByPrefix.set(prefix, null);
    }
  }
  const expanded = html.replace(ICON_PLACEHOLDER, (whole, before: string, _quote, prefix: string, name: string, after: string) => {
    const reference = `${prefix.toLowerCase()}:${name.toLowerCase()}`;
    const json = jsonByPrefix.get(prefix.toLowerCase());
    const icon = json ? resolveIcon(json, name.toLowerCase()) : null;
    if (!json || !icon) {
      unknown.push(reference);
      return whole;
    }
    const { viewBox, body } = renderIcon(json, icon);
    const kept = `${before} ${after}`.replace(REPLACED_ATTRIBUTES, "").replace(/\s+/g, " ").trim();
    const sized = /\b(?:width|height)=/i.test(kept) ? kept : `${kept} width="1em" height="1em"`.trim();
    const labelled = /\b(?:aria-label|aria-labelledby|role)=/i.test(kept) ? "" : ' aria-hidden="true"';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" data-icon="${reference}"${sized ? ` ${sized}` : ""}${labelled}>${body}</svg>`;
  });
  return { html: expanded, unknown: [...new Set(unknown)] };
}

/** Closest catalog names for an unknown reference, to make the repair diagnostic actionable. */
export function suggestDesignIconNames(reference: string, sets: readonly DesignIconSet[], limit = 5): string[] {
  const [prefix, name = ""] = reference.split(":");
  const set = sets.find((candidate) => candidate.prefix === prefix);
  if (!set) return [];
  const tokens = name.split("-").filter((token) => token.length >= 3);
  const scored = set.names
    .map((candidate) => ({ candidate, score: tokens.filter((token) => candidate.includes(token)).length }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.length - right.candidate.length);
  return scored.slice(0, limit).map((entry) => `${prefix}:${entry.candidate}`);
}

export interface DesignWebResourcesInput {
  fonts: readonly DesignWebFont[];
  iconSets: readonly DesignIconSet[];
}

export const DESIGN_ICON_CATALOG_DIRECTORY = ".context/icons";

/** Deterministic prompt text: it names only static ids and set prefixes, never network results. */
export function webResourcesPromptSection(input: DesignWebResourcesInput | null | undefined): string {
  if (!input) return "";
  const fonts = input.fonts.length > 0
    ? ` This design system's families: ${input.fonts.map((font) => `“${font.family}” → ${font.id}`).join(", ")}.`
    : "";
  const sets = input.iconSets.length > 0
    ? `Icons: write an empty <svg data-icon="<set>:<name>" width="20" height="20"></svg> wherever an interface icon belongs; the daemon inlines the real vector before validation and it inherits currentColor. Available sets (grep exact names in ${DESIGN_ICON_CATALOG_DIRECTORY}/<set>.txt): ${input.iconSets.map((set) => `${set.prefix} (${set.name}, ${set.license})`).join(", ")}. Use one set consistently per document. Never hand-author generic interface glyphs that a set already provides; hand-drawn SVG is for brand marks and illustration only.`
    : "Icons: no icon catalog is available this turn, so draw the few icons you need as clean inline SVG.";
  return `## Web fonts and icons\n\n`
    + `Fonts: load Fontsource families from jsDelivr, the only permitted remote origin, with <link rel="stylesheet"> tags in <head>, then use the family name in CSS with a system fallback stack. `
    + `https://cdn.jsdelivr.net/fontsource/css/<id>@latest/index.css loads weight 400; add one link per extra weight you use (for example https://cdn.jsdelivr.net/fontsource/css/<id>@latest/600.css); `
    + `https://cdn.jsdelivr.net/fontsource/css/<id>:vf@latest/wght.css loads a variable family when Fontsource ships one; its CSS declares the family as “<Family> Variable”, so write font-family: "Inter Variable", "Inter", sans-serif. The id is the lowercase hyphenated family name (inter, playfair-display, jetbrains-mono, noto-sans-sc).${fonts} `
    + `Families Fontsource does not carry stay on their fallback stack. Never @import, and never link any other host.\n\n`
    + `${sets}\n\n`;
}
