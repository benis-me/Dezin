import puppeteer from "puppeteer-core";
import { findChrome } from "./capture-cover.ts";

export interface Viewport { width: number; height: number; label: string }
export const VIEWPORTS: Viewport[] = [
  { width: 390, height: 844, label: "mobile" },
  { width: 1440, height: 900, label: "desktop" },
];

export interface DomNode { tag: string; role?: string; classes: string; text: string; box: { x: number; y: number; w: number; h: number } }
export interface StyleTokens { colors: string[]; fontFamilies: string[]; fontSizes: string[]; radii: string[]; shadows: string[] }

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

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
    const browser = await puppeteer.launch({
      executablePath,
      headless: opts.headless ?? false,
      userDataDir: opts.userDataDir,
      args: ["--no-sandbox", "--hide-scrollbars"],
      defaultViewport: { width: 1440, height: 900 },
    });
    const page = await browser.newPage();
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
    const finalUrl = this.page.url();
    try { this.origin = new URL(finalUrl).origin; } catch { /* keep the prior origin on an unparseable url */ }
    return { status: res?.status() ?? 0, finalUrl };
  }

  async setViewport(v: Viewport): Promise<void> { await this.page.setViewport({ width: v.width, height: v.height, deviceScaleFactor: 1 }); }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return (await this.page.screenshot({ fullPage: opts.fullPage ?? false, type: "png" })) as Buffer;
  }

  async readDom(maxNodes = 400): Promise<DomNode[]> {
    return this.page.evaluate((max: number) => {
      const doc = (globalThis as any).document;
      const out: any[] = [];
      const walk = (el: any) => {
        if (out.length >= max) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || undefined,
            classes: typeof el.className === "string" ? el.className : "",
            text: (el.childNodes.length && el.innerText ? el.innerText : "").replace(/\s+/g, " ").trim().slice(0, 120),
            box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          });
        }
        for (const c of Array.from(el.children)) walk(c);
      };
      if (doc.body) walk(doc.body);
      return out;
    }, maxNodes);
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
