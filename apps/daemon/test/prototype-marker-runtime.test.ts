import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import puppeteer from "puppeteer-core";

import {
  applyArtifactThumbnailFrame,
  findChrome,
} from "../src/capture-cover.ts";
import { injectRuntimeProbe } from "../src/serve-static.ts";
import {
  SharinganSession,
  sharinganLaunchOptions,
} from "../src/sharingan-browser.ts";

const BRIDGE_NONCE = "a".repeat(43);
const RECEIPT_NONCE = "b".repeat(64);
const MARKER_ID = "prototype-marker-checkout";

test("prototype runtime proof applies exact Frame state before proving the generated marker", async (t) => {
  if (!findChrome()) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "dezin-prototype-runtime-"));
  const htmlPath = join(root, "index.html");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const html = [
    "<!doctype html><html><body><main id='surface'>Default state</main><script>",
    "window.addEventListener('dezin:frame-change',(event)=>{",
    "const frame=event.detail||{},surface=document.getElementById('surface');",
    "const expected=frame.frameId==='checkout'&&frame.initialState==='ready'",
    "&&frame.fixture&&frame.fixture.orderId==='order-1';",
    "if(expected){const button=document.createElement('button');",
    `button.setAttribute('data-dezin-node-id','${MARKER_ID}');`,
    "button.textContent='Continue';surface.replaceChildren(button);}",
    "const consumption=frame.consumption;",
    "if(expected&&consumption)window.dispatchEvent(new CustomEvent('dezin:frame-consumed',{detail:{",
    "source:'dezin-artifact',nonce:consumption.nonce,frameAttemptId:consumption.frameAttemptId,",
    "digest:consumption.digest}}));",
    "});",
    "</script></body></html>",
  ].join("");
  writeFileSync(htmlPath, injectRuntimeProbe(html), "utf8");
  const targetUrl = `${pathToFileURL(htmlPath).href}#dezin-bridge=${BRIDGE_NONCE}`;
  const controller = new AbortController();
  const session = await SharinganSession.open(targetUrl, { headless: true, signal: controller.signal });
  t.after(() => session.close());

  await assert.rejects(
    session.probePrototypeMarker(MARKER_ID, "click", RECEIPT_NONCE, controller.signal),
    /not-found/i,
  );
  await session.setViewport({ width: 1_280, height: 800, label: "checkout" });
  await session.applyRenderFrame(targetUrl, {
    frameId: "checkout",
    frameAttemptId: RECEIPT_NONCE,
    initialState: "ready",
    fixture: { orderId: "order-1" },
    background: "#ffffff",
  }, new AbortController().signal);
  await session.settle();

  assert.deepEqual(
    await session.probePrototypeMarker(MARKER_ID, "click", RECEIPT_NONCE, controller.signal),
    { tagName: "button", role: null, action: "button", visible: true },
  );
  await assert.rejects(
    session.probePrototypeMarker(MARKER_ID, "submit", RECEIPT_NONCE, controller.signal),
    /trigger-incompatible/i,
  );
});

test("prototype Present activates a dual-identity submit control through its exact v2 marker", async (t) => {
  const executablePath = findChrome();
  if (!executablePath) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "dezin-prototype-submit-"));
  const htmlPath = join(root, "index.html");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const html = [
    "<!doctype html><html><head></head><body>",
    "<form id='checkout'><button id='submit' type='submit'",
    " data-design-node-id='stable-checkout-cta'",
    ` data-dezin-node-id='${MARKER_ID}'>Continue</button></form>`,
    "<script>document.getElementById('checkout').addEventListener('submit',(event)=>event.preventDefault());</script>",
    "</body></html>",
  ].join("");
  writeFileSync(htmlPath, injectRuntimeProbe(html), "utf8");
  const targetUrl = `${pathToFileURL(htmlPath).href}#dezin-bridge=${BRIDGE_NONCE}`;
  const browser = await puppeteer.launch(sharinganLaunchOptions(executablePath, { headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ nonce, markerId }) => {
    const win = globalThis as any;
    win.__dezinPrototypeTestMessages = [];
    await new Promise<void>((resolve, reject) => {
      const channel = new win.MessageChannel();
      win.__dezinPrototypeTestPort = channel.port1;
      const timer = win.setTimeout(() => reject(new Error("preview bridge did not become ready")), 2_000);
      channel.port1.onmessage = (event: { data: Record<string, unknown> }) => {
        win.__dezinPrototypeTestMessages.push(event.data);
        if (event.data.type !== "bridge-ready") return;
        channel.port1.postMessage({
          source: "dezin-parent",
          type: "set-prototype-bindings",
          protocol: 1,
          nonce,
          bindings: [{
            bindingId: "binding-submit-control",
            locator: { designNodeId: markerId },
            trigger: "submit",
          }],
        });
        win.clearTimeout(timer);
        win.setTimeout(resolve, 20);
      };
      channel.port1.start();
      win.postMessage({
        source: "dezin-parent",
        type: "bridge-init",
        protocol: 1,
        nonce,
      }, "*", [channel.port2]);
    });
  }, { nonce: BRIDGE_NONCE, markerId: MARKER_ID });

  await page.click("#submit");
  await page.waitForFunction((markerId) => {
    const messages = (globalThis as any).__dezinPrototypeTestMessages as Array<Record<string, any>>;
    return messages.some((message) => message.type === "prototype-binding-activated"
      && message.bindingId === "binding-submit-control"
      && message.trigger === "submit"
      && message.locator?.designNodeId === markerId);
  }, { timeout: 2_000 }, MARKER_ID);
});

test("prototype runtime proof rejects markers outside the visible hit-tested Frame", async (t) => {
  if (!findChrome()) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "dezin-prototype-visibility-"));
  const htmlPath = join(root, "index.html");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(htmlPath, [
    "<!doctype html><html><body style='margin:0'>",
    "<button data-dezin-node-id='visible' style='position:absolute;left:20px;top:20px;width:120px;height:40px'>Visible</button>",
    "<button data-dezin-node-id='offscreen' style='position:absolute;left:5000px;top:5000px;width:120px;height:40px'>Offscreen</button>",
    "<div style='position:absolute;left:20px;top:100px;width:20px;height:20px;overflow:hidden'>",
    "<button data-dezin-node-id='clipped' style='position:absolute;left:60px;top:0;width:120px;height:40px'>Clipped</button>",
    "</div>",
    "<button data-dezin-node-id='covered' style='position:absolute;left:20px;top:180px;width:120px;height:40px'>Covered</button>",
    "<div style='position:absolute;z-index:2;left:20px;top:180px;width:120px;height:40px;background:white'></div>",
    "<button data-design-node-id='legacy-only'>Legacy-only marker</button>",
    "<button data-design-node-id='duplicate'>Legacy duplicate</button>",
    "<button data-dezin-node-id='duplicate'>V2 duplicate</button>",
    "</body></html>",
  ].join(""), "utf8");
  const controller = new AbortController();
  const session = await SharinganSession.open(pathToFileURL(htmlPath).href, {
    headless: true,
    signal: controller.signal,
  });
  t.after(() => session.close());
  await session.setViewport({ width: 320, height: 480, label: "mobile" });

  assert.deepEqual(
    await session.probePrototypeMarker("visible", "click", RECEIPT_NONCE, controller.signal),
    { tagName: "button", role: null, action: "button", visible: true },
  );
  for (const markerId of ["offscreen", "clipped", "covered"]) {
    await assert.rejects(
      session.probePrototypeMarker(markerId, "click", RECEIPT_NONCE, controller.signal),
      /not-visible/i,
    );
  }
  await assert.rejects(
    session.probePrototypeMarker("duplicate", "click", RECEIPT_NONCE, controller.signal),
    /ambiguous/i,
  );
  await assert.rejects(
    session.probePrototypeMarker("legacy-only", "click", RECEIPT_NONCE, controller.signal),
    /not-found/i,
  );
});

test("prototype marker probing aborts and closes a frozen post-open Chromium session", async (t) => {
  if (!findChrome()) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "dezin-prototype-abort-"));
  const htmlPath = join(root, "index.html");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(htmlPath, [
    "<!doctype html><html><body><button data-dezin-node-id='frozen'>Frozen</button><script>",
    "const query=document.querySelectorAll.bind(document);",
    "document.querySelectorAll=(selector)=>{",
    "if(String(selector).includes('data-design-node-id')){while(true){}}",
    "return query(selector);",
    "};",
    "</script></body></html>",
  ].join(""), "utf8");
  const controller = new AbortController();
  const session = await SharinganSession.open(pathToFileURL(htmlPath).href, {
    headless: true,
    signal: controller.signal,
  });
  const startedAt = Date.now();
  const probe = session.probePrototypeMarker(
    "frozen",
    "click",
    RECEIPT_NONCE,
    controller.signal,
    5_000,
  );
  setTimeout(() => controller.abort(new Error("stop frozen prototype probe")), 100);
  const outcome = await Promise.race([
    probe.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    new Promise<{ status: "hung" }>((resolve) => setTimeout(() => resolve({ status: "hung" }), 1_500)),
  ]);
  if (outcome.status === "hung") await session.close();
  assert.equal(outcome.status, "rejected");
  assert.match(String(outcome.status === "rejected" ? outcome.error : ""), /stop frozen prototype probe/i);
  assert.ok(Date.now() - startedAt < 1_500);
  await session.close();
  await assert.rejects(
    session.setViewport({ width: 320, height: 480, label: "closed" }),
    /closed|connection|session|target/i,
  );
});

test("prototype marker probing enforces its own deadline and closes the frozen session", async (t) => {
  if (!findChrome()) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "dezin-prototype-deadline-"));
  const htmlPath = join(root, "index.html");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(htmlPath, [
    "<!doctype html><html><body><button data-dezin-node-id='frozen'>Frozen</button><script>",
    "const query=document.querySelectorAll.bind(document);",
    "document.querySelectorAll=(selector)=>{",
    "if(String(selector).includes('data-design-node-id')){while(true){}}",
    "return query(selector);",
    "};",
    "</script></body></html>",
  ].join(""), "utf8");
  const controller = new AbortController();
  const session = await SharinganSession.open(pathToFileURL(htmlPath).href, {
    headless: true,
    signal: controller.signal,
  });
  await assert.rejects(
    session.probePrototypeMarker("frozen", "click", RECEIPT_NONCE, controller.signal, 150),
    /timed out after 150ms/i,
  );
  await session.close();
  await assert.rejects(
    session.setViewport({ width: 320, height: 480, label: "closed" }),
    /closed|connection|session|target/i,
  );
});

for (const reason of ["unsupported-state", "frame acknowledgement timed out"]) {
  test(`prototype Frame bridge fails closed on ${reason}`, async () => {
    const page = {
      async evaluate() {
        return { ok: false as const, reason };
      },
    };
    await assert.rejects(
      applyArtifactThumbnailFrame(
        page as never,
        `http://127.0.0.1:4173/#dezin-bridge=${BRIDGE_NONCE}`,
        { frameId: "checkout", frameAttemptId: RECEIPT_NONCE },
        new AbortController().signal,
      ),
      /render frame was not applied/i,
    );
  });
}
