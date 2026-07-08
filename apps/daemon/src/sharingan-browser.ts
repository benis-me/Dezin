import puppeteer from "puppeteer-core";
import { findChrome } from "./capture-cover.ts";

export interface Viewport { width: number; height: number; label: string }
export const VIEWPORTS: Viewport[] = [
  { width: 390, height: 844, label: "mobile" },
  { width: 1440, height: 900, label: "desktop" },
];

export interface DomNodeStyle {
  display: string; position: string; flexDirection: string; justifyContent: string; alignItems: string; gap: string;
  fontSize: string; fontWeight: string; color: string; backgroundColor: string; padding: string; margin: string;
}
export interface DomNode { tag: string; role?: string; classes: string; text: string; box: { x: number; y: number; w: number; h: number }; style?: DomNodeStyle }
export interface DomTreeStyle extends DomNodeStyle {
  width: string; height: string; border: string; borderColor: string; backgroundImage: string;
  gridTemplateColumns: string; gridTemplateRows: string; opacity: string; textAlign: string; lineHeight: string; letterSpacing: string;
}
export interface DomTreeNode {
  tag: string; role?: string; classes: string; text: string;
  box: { x: number; y: number; w: number; h: number };
  style: DomTreeStyle; children: DomTreeNode[];
}
export interface Asset { url: string; kind: "img" | "background" | "video"; alt?: string; w?: number; h?: number; local?: string }
export interface StyleTokens { colors: string[]; fontFamilies: string[]; fontSizes: string[]; radii: string[]; shadows: string[] }

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

/** Chrome launch options with the automation tells removed: no `--enable-automation`, and the
 *  AutomationControlled blink feature disabled. Pure so the flags can be asserted without launching. */
export function sharinganLaunchOptions(
  executablePath: string,
  opts: { userDataDir?: string; headless?: boolean },
): {
  executablePath: string;
  headless: boolean;
  userDataDir?: string;
  ignoreDefaultArgs: string[];
  args: string[];
  defaultViewport: { width: number; height: number };
} {
  return {
    executablePath,
    headless: opts.headless ?? false,
    userDataDir: opts.userDataDir,
    // Puppeteer adds --enable-automation by default; that flag (and the navigator.webdriver it sets)
    // is exactly what Google/Cloudflare fingerprint. Drop it and disable the matching blink feature.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-sandbox", "--hide-scrollbars", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1440, height: 900 },
  };
}

/** The structural slice of a puppeteer Page that applyStealth drives (so it can be faked in tests). */
export interface StealthPage {
  setUserAgent(ua: string): Promise<void>;
  evaluateOnNewDocument(fn: (...args: any[]) => unknown): Promise<unknown>;
}

/** Apply the runtime stealth hooks to a freshly-opened page: set a normal (non-Headless) UA and make
 *  navigator.webdriver read as undefined on every document. Does NOT bypass auth — it only stops the
 *  window from being flagged as a bot so the USER can complete Google/Cloudflare sign-in themselves. */
export async function applyStealth(page: StealthPage, userAgent: string): Promise<void> {
  await page.setUserAgent(userAgent);
  await page.evaluateOnNewDocument(() => {
    const nav = (globalThis as any).navigator;
    try {
      Object.defineProperty(nav, "webdriver", { get: () => undefined });
    } catch {
      /* navigator is frozen on some pages — best-effort */
    }
  });
}

export class SharinganSession {
  private browser: Browser;
  private page: Page;
  private origin: string;

  private constructor(browser: Browser, page: Page, origin: string) {
    this.browser = browser;
    this.page = page;
    this.origin = origin;
  }

  static async open(url: string, opts: { userDataDir?: string; headless?: boolean } = {}): Promise<SharinganSession> {
    const executablePath = findChrome();
    if (!executablePath) throw new Error("Chrome not found (required for Sharingan capture)");
    const browser = await puppeteer.launch(sharinganLaunchOptions(executablePath, opts));
    const page = await browser.newPage();
    // Strip "HeadlessChrome" from the UA the automated browser advertises (headful already says
    // "Chrome"; this covers the headless test/CI path and is belt-and-suspenders in production).
    const userAgent = (await browser.userAgent()).replace(/Headless/g, "");
    await applyStealth(page, userAgent);
    const origin = new URL(url).origin;
    const session = new SharinganSession(browser, page, origin);
    await session.navigate(url);
    return session;
  }

  currentUrl(): string { return this.page.url(); }

  async navigate(url: string): Promise<{ status: number; finalUrl: string }> {
    const res = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    // Give client-rendered pages a moment + trigger lazy content by scrolling.
    await this.page
      .evaluate(
        () =>
          new Promise<void>((r) => {
            const g = globalThis as any;
            g.scrollTo(0, g.document.body.scrollHeight);
            g.setTimeout(() => {
              g.scrollTo(0, 0);
              r();
            }, 400);
          }),
      )
      .catch(() => {});
    await this.settle();
    const finalUrl = this.page.url();
    try { this.origin = new URL(finalUrl).origin; } catch { /* keep the prior origin on an unparseable url */ }
    return { status: res?.status() ?? 0, finalUrl };
  }

  /** Wait for the page to settle before a screenshot: window `load` (readyState complete) plus every
   *  current <img> finishing (load OR error), bounded by `timeoutMs` so a never-idle SPA can't hang
   *  the capture. Runs in the page context (browser timers, not the daemon's). */
  async settle(timeoutMs = 6000): Promise<void> {
    await this.page.evaluate(async (timeout: number) => {
      const win = globalThis as any;
      const doc = win.document;
      const ready = new Promise<void>((r) => {
        if (doc.readyState === "complete") r();
        else win.addEventListener("load", () => r(), { once: true });
      });
      const imgs = Array.from(doc.images || []).filter((i: any) => i.src && !i.complete);
      const loaded = Promise.all(
        imgs.map((i: any) => new Promise<void>((r) => {
          i.addEventListener("load", () => r(), { once: true });
          i.addEventListener("error", () => r(), { once: true });
        })),
      );
      await Promise.race([Promise.all([ready, loaded]), new Promise<void>((r) => win.setTimeout(r, timeout))]);
    }, timeoutMs).catch(() => {});
  }

  async setViewport(v: Viewport): Promise<void> { await this.page.setViewport({ width: v.width, height: v.height, deviceScaleFactor: 1 }); }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return (await this.page.screenshot({ fullPage: opts.fullPage ?? false, type: "png" })) as Buffer;
  }

  async readDom(maxNodes = 1500): Promise<DomNode[]> {
    return this.page.evaluate((max: number) => {
      const win = globalThis as any;
      const doc = win.document;
      const out: any[] = [];
      const walk = (el: any) => {
        if (out.length >= max) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const s = win.getComputedStyle(el);
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || undefined,
            classes: typeof el.className === "string" ? el.className : "",
            text: (el.childNodes.length && el.innerText ? el.innerText : "").replace(/\s+/g, " ").trim().slice(0, 120),
            box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            style: {
              display: s.display, position: s.position, flexDirection: s.flexDirection, justifyContent: s.justifyContent,
              alignItems: s.alignItems, gap: s.gap, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color,
              backgroundColor: s.backgroundColor, padding: s.padding, margin: s.margin,
            },
          });
        }
        for (const c of Array.from(el.children)) walk(c);
      };
      if (doc.body) walk(doc.body);
      return out;
    }, maxNodes);
  }

  /** Capture the DOM as a NESTED tree (hierarchy preserved) with a fuller per-node computed-style
   *  subset — the reproduction blueprint the Sharingan builder mirrors. Invisible subtrees (0-area)
   *  are dropped. `maxNodes` bounds the total node count across the whole tree. Only leaf nodes carry
   *  `text` (interior text is redundant — the children carry it). */
  async readDomTree(maxNodes = 1500): Promise<DomTreeNode[]> {
    return this.page.evaluate((max: number) => {
      const win = globalThis as any;
      const doc = win.document;
      let count = 0;
      const build = (el: any): any | null => {
        if (count >= max) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        count++;
        const s = win.getComputedStyle(el);
        const node: any = {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || undefined,
          classes: typeof el.className === "string" ? el.className : "",
          text: (el.children.length === 0 && el.innerText ? el.innerText : "").replace(/\s+/g, " ").trim().slice(0, 200),
          box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          style: {
            display: s.display, position: s.position, flexDirection: s.flexDirection, justifyContent: s.justifyContent,
            alignItems: s.alignItems, gap: s.gap, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color,
            backgroundColor: s.backgroundColor, padding: s.padding, margin: s.margin, width: s.width, height: s.height,
            border: s.border, borderColor: s.borderColor, backgroundImage: s.backgroundImage,
            gridTemplateColumns: s.gridTemplateColumns, gridTemplateRows: s.gridTemplateRows, opacity: s.opacity,
            textAlign: s.textAlign, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
          },
          children: [],
        };
        for (const c of Array.from(el.children)) {
          const child = build(c);
          if (child) node.children.push(child);
        }
        return node;
      };
      const root = doc.body ? build(doc.body) : null;
      return root ? [root] : [];
    }, maxNodes);
  }

  /** Inventory the page's images: <img> (with alt + rendered size), CSS background-images, and
   *  <video>/<source> URLs. All URLs resolved absolute. captureCurrentPage downloads these (via
   *  fetchAsset, using the authenticated session) into the project's public/_assets/ so the clone can
   *  reproduce the source's real imagery 1:1 (v3 faithful-reproduction; authorized-use gated). */
  async assets(maxAssets = 80): Promise<Asset[]> {
    return this.page.evaluate((max: number) => {
      const win = globalThis as any;
      const doc = win.document;
      const abs = (u: string): string | null => { try { return new win.URL(u, win.location.href).href; } catch { return null; } };
      const seen = new Set<string>();
      const out: any[] = [];
      const push = (url: string | null, kind: string, alt?: string, w?: number, h?: number) => {
        if (!url || url.startsWith("data:") || seen.has(url) || out.length >= max) return;
        seen.add(url);
        out.push({ url, kind, alt: alt || undefined, w: w || undefined, h: h || undefined });
      };
      for (const img of Array.from<any>(doc.querySelectorAll("img"))) {
        const r = img.getBoundingClientRect();
        push(abs(img.currentSrc || img.src), "img", img.getAttribute("alt") || undefined, Math.round(r.width), Math.round(r.height));
      }
      for (const v of Array.from<any>(doc.querySelectorAll("video"))) {
        push(abs(v.getAttribute("poster") || ""), "img", undefined);
        push(abs(v.currentSrc || v.src || ""), "video");
      }
      for (const sc of Array.from<any>(doc.querySelectorAll("source"))) push(abs(sc.getAttribute("src") || ""), "video");
      for (const el of Array.from<any>(doc.querySelectorAll("body *")).slice(0, 1500)) {
        const bg = win.getComputedStyle(el).backgroundImage as string;
        if (!bg || bg === "none") continue;
        const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
        if (m) { const r = el.getBoundingClientRect(); push(abs(m[1] ?? ""), "background", undefined, Math.round(r.width), Math.round(r.height)); }
      }
      return out;
    }, maxAssets);
  }

  /** Fetch an asset's bytes in the PAGE context so it inherits the authenticated session's cookies
   *  (some source images are login-gated). Returns the raw bytes + content-type, or null on any
   *  failure (network error, non-2xx, CORS). Best-effort — callers treat null as "not cached". */
  async fetchAsset(url: string): Promise<{ bytes: number[]; contentType: string } | null> {
    return this.page.evaluate(async (u: string) => {
      try {
        const g = globalThis as any;
        const res = await g.fetch(u);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        const bytes = Array.from(new Uint8Array(ab)) as number[];
        if (!bytes.length) return null;
        return { bytes, contentType: res.headers.get("content-type") || "" };
      } catch {
        return null;
      }
    }, url);
  }

  async styleTokens(): Promise<StyleTokens> {
    return this.page.evaluate(() => {
      const win = globalThis as any;
      const doc = win.document;
      const colors = new Set<string>(), fonts = new Set<string>(), sizes = new Set<string>(), radii = new Set<string>(), shadows = new Set<string>();
      const nodes = Array.from<any>(doc.querySelectorAll("body *")).slice(0, 1500);
      for (const el of nodes) {
        const s = win.getComputedStyle(el);
        if (s.color) colors.add(s.color);
        if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") colors.add(s.backgroundColor);
        if (s.fontFamily) fonts.add(s.fontFamily);
        if (s.fontSize) sizes.add(s.fontSize);
        if (s.borderRadius && s.borderRadius !== "0px") radii.add(s.borderRadius);
        if (s.boxShadow && s.boxShadow !== "none") shadows.add(s.boxShadow);
      }
      const top = (set: Set<string>, n: number) => Array.from(set).slice(0, n);
      return { colors: top(colors, 24), fontFamilies: top(fonts, 8), fontSizes: top(sizes, 16), radii: top(radii, 8), shadows: top(shadows, 8) };
    });
  }

  async discoverLinks(): Promise<string[]> {
    const origin = this.origin;
    return this.page.evaluate((org: string) => {
      const g = globalThis as any;
      const urls = new Set<string>();
      for (const a of Array.from<any>(g.document.querySelectorAll("a[href]"))) {
        try {
          const u = new URL(a.href, g.location.href);
          if (u.origin === org) urls.add(u.origin + u.pathname);
        } catch { /* ignore */ }
      }
      return Array.from(urls).slice(0, 50);
    }, origin);
  }

  async hasPasswordField(): Promise<boolean> {
    return this.page.evaluate(() => !!(globalThis as any).document.querySelector('input[type="password"]'));
  }
  async click(selector: string): Promise<void> { await this.page.click(selector).catch(() => {}); }
  async scroll(y: number): Promise<void> { await this.page.evaluate((yy: number) => (globalThis as any).scrollTo(0, yy), y); }

  async bringToFront(): Promise<void> { await this.page.bringToFront().catch(() => {}); }

  async close(): Promise<void> { await this.browser.close().catch(() => {}); }
}

export const SHARINGAN_PAGE_BUDGET = 6;
