import puppeteer from "puppeteer-core";
import { findChrome } from "./capture-cover.ts";
import { captureFullPageScreenshot } from "./full-page-capture.ts";

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
export interface RenderMapElement {
  selector: string;
  tag: string;
  src?: string;
  currentSrc?: string;
  poster?: string;
  svg?: string;
  text: string;
  box: { x: number; y: number; w: number; h: number };
  style: {
    display: string;
    position: string;
    zIndex: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
    color: string;
    backgroundColor: string;
    backgroundImage: string;
    objectFit: string;
    opacity: string;
    borderRadius: string;
    boxShadow: string;
    padding: string;
    margin: string;
  };
}
export interface RenderMap {
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  elements: RenderMapElement[];
}

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

  static async open(url: string, opts: { userDataDir?: string; headless?: boolean; signal?: AbortSignal } = {}): Promise<SharinganSession> {
    opts.signal?.throwIfAborted();
    const executablePath = findChrome();
    if (!executablePath) throw new Error("Chrome not found (required for Sharingan capture)");
    let browser: Browser | undefined;
    const closeOnAbort = (): void => { void browser?.close().catch(() => {}); };
    opts.signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      browser = await puppeteer.launch(sharinganLaunchOptions(executablePath, opts));
      opts.signal?.throwIfAborted();
      const page = await browser.newPage();
      opts.signal?.throwIfAborted();
      // Strip "HeadlessChrome" from the UA the automated browser advertises (headful already says
      // "Chrome"; this covers the headless test/CI path and is belt-and-suspenders in production).
      const userAgent = (await browser.userAgent()).replace(/Headless/g, "");
      await applyStealth(page, userAgent);
      opts.signal?.throwIfAborted();
      // Auto-dismiss alert/confirm/prompt — a blocking dialog freezes the page's JS thread, which would
      // hang settle()'s in-page waits (their timers never fire) and wedge the whole capture.
      page.on("dialog", (d) => void d.dismiss().catch(() => {}));
      const origin = new URL(url).origin;
      const session = new SharinganSession(browser, page, origin);
      await session.navigate(url);
      opts.signal?.throwIfAborted();
      return session;
    } catch (error) {
      await browser?.close().catch(() => {});
      throw error;
    } finally {
      opts.signal?.removeEventListener("abort", closeOnAbort);
    }
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

  /** Wait for the page to settle before a screenshot, so async SPA content isn't shot as a skeleton:
   *  (1) window `load` + every current <img> finishing, (2) a NETWORK-IDLE window (out-waits fetch/XHR
   *  that replaces skeletons with real data), (3) a DOM-STABILITY window (mutations quiet down after
   *  the render). All bounded by `timeoutMs` so a never-idle SPA can't hang the capture. */
  /** Race a page.evaluate against a Node-side timer, so a page that freezes its own JS thread (a
   *  blocking dialog, a synchronous infinite loop) can't hang settle — the in-page timer never fires
   *  in that case, so the in-page timeout alone is not a backstop. */
  private evalBounded(fn: (arg: number) => Promise<void>, ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return Promise.race([
      this.page.evaluate(fn, ms).then(() => undefined, () => undefined),
      new Promise<void>((r) => setTimeout(r, ms + 300)),
    ]);
  }

  async settle(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // 1. window load + current images (in the page context).
    await this.evalBounded(async (timeout: number) => {
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
    }, Math.max(0, deadline - Date.now()));
    // 2. Network idle — out-wait in-flight fetch/XHR. (timeout must stay > 0: puppeteer treats 0 as
    //    "no timeout" = wait forever, so skip once the budget is spent.)
    const netBudget = deadline - Date.now();
    if (netBudget > 100) await this.page.waitForNetworkIdle({ idleTime: 600, timeout: netBudget }).catch(() => {});
    // 3. DOM stability — wait until mutations quiet down (the skeleton→content render), bounded.
    const domBudget = deadline - Date.now();
    if (domBudget > 100) await this.evalBounded(async (budget: number) => {
      const win = globalThis as any;
      const target = win.document.body || win.document.documentElement;
      if (!target || typeof win.MutationObserver !== "function") return;
      await new Promise<void>((resolve) => {
        let quiet: any;
        const finish = () => { try { obs.disconnect(); } catch { /* noop */ } win.clearTimeout(quiet); win.clearTimeout(cap); resolve(); };
        const bump = () => { win.clearTimeout(quiet); quiet = win.setTimeout(finish, 400); };
        const obs = new win.MutationObserver(bump);
        obs.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
        const cap = win.setTimeout(finish, budget); // hard cap on the whole DOM-stability wait
        bump();
      });
    }, domBudget);
  }

  async setViewport(v: Viewport): Promise<void> { await this.page.setViewport({ width: v.width, height: v.height, deviceScaleFactor: 1 }); }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    const shot = opts.fullPage
      ? await captureFullPageScreenshot(this.page)
      : await this.page.screenshot({ fullPage: false, type: "png" });
    return Buffer.from(shot);
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

  /** Capture the browser's final rendered geometry. This is the render-first source of truth for
   *  1:1 reconstruction: real viewport/document dimensions, element bounding boxes, and the computed
   *  styles that drive visual similarity. */
  async readRenderMap(maxNodes = 700): Promise<RenderMap> {
    return this.page.evaluate((max: number) => {
      const win = globalThis as any;
      const doc = win.document;
      const escapeCss = (value: string): string => {
        const css = win.CSS as { escape?: (input: string) => string } | undefined;
        return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };
      const selectorFor = (el: any): string => {
        const id = el.getAttribute("id");
        if (id) return `#${escapeCss(id)}`;
        const dezinId = el.getAttribute("data-dezin-id");
        if (dezinId) return `[data-dezin-id="${String(dezinId).replace(/"/g, '\\"')}"]`;
        const testId = el.getAttribute("data-testid");
        if (testId) return `[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
        const cls = Array.from<string>(el.classList || []).slice(0, 2);
        const suffix = cls.length ? `.${cls.map(escapeCss).join(".")}` : "";
        return `${el.tagName.toLowerCase()}${suffix}`;
      };
      const abs = (u: string): string | undefined => {
        try {
          return u ? new win.URL(u, win.location.href).href : undefined;
        } catch {
          return undefined;
        }
      };
      const safeSvg = (el: any): string | undefined => {
        try {
          const clone = el.cloneNode(true) as any;
          for (const node of Array.from(clone.querySelectorAll("script,foreignObject"))) (node as any).remove();
          const all = [clone, ...Array.from(clone.querySelectorAll("*"))] as any[];
          for (const node of all) {
            for (const attr of Array.from(node.attributes || [])) {
              const name = String((attr as any).name || "");
              const value = String((attr as any).value || "");
              if (/^on/i.test(name) || (/href$/i.test(name) && /^\s*javascript:/i.test(value))) node.removeAttribute(name);
            }
          }
          const html = String(clone.outerHTML || "");
          return html.length > 0 && html.length <= 80_000 ? html : undefined;
        } catch {
          return undefined;
        }
      };
      const root = doc.documentElement;
      const body = doc.body;
      const elements: any[] = Array.from<any>(body ? [body, ...Array.from(body.querySelectorAll("*"))] : [])
        .map((el: any) => {
          const s = win.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (s.display === "none" || s.visibility === "hidden" || r.width <= 0 || r.height <= 0) return null;
          const tag = el.tagName.toLowerCase();
          const node: any = {
            selector: selectorFor(el),
            tag,
            text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
            box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            style: {
              display: s.display,
              position: s.position,
              zIndex: s.zIndex,
              fontSize: s.fontSize,
              fontWeight: s.fontWeight,
              lineHeight: s.lineHeight,
              letterSpacing: s.letterSpacing,
              color: s.color,
              backgroundColor: s.backgroundColor,
              backgroundImage: s.backgroundImage,
              objectFit: s.objectFit,
              opacity: s.opacity,
              borderRadius: s.borderRadius,
              boxShadow: s.boxShadow,
              padding: s.padding,
              margin: s.margin,
            },
          };
          if (tag === "img") {
            node.src = abs(el.getAttribute("src") || "");
            node.currentSrc = abs(el.currentSrc || el.src || "");
          } else if (tag === "video") {
            node.src = abs(el.currentSrc || el.src || "");
            node.poster = abs(el.getAttribute("poster") || "");
          } else if (tag === "source") {
            node.src = abs(el.getAttribute("src") || "");
          } else if (tag === "svg" && r.width <= 420 && r.height <= 320) {
            node.svg = safeSvg(el);
          }
          return node;
        })
        .filter((el: any) => el !== null)
        .slice(0, max);
      return {
        viewport: { width: win.innerWidth, height: win.innerHeight },
        document: {
          width: Math.max(root.scrollWidth, body?.scrollWidth || 0),
          height: Math.max(root.scrollHeight, body?.scrollHeight || 0),
        },
        elements,
      };
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
