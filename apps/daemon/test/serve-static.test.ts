import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse, serialize } from "parse5";
import { injectRuntimeProbe, injectSelectBridge } from "../src/serve-static.ts";

test("preview bridge requires a nonce-bound parent handshake and never emits to wildcard", () => {
  const out = injectRuntimeProbe(injectSelectBridge("<html><head></head><body><button>Pick</button></body></html>"));
  assert.match(out, /dezin-bridge/);
  assert.match(out, /bridge-init/);
  assert.match(out, /e\.source!==parent/);
  assert.match(out, /e\.origin==='null'/);
  assert.match(out, /d\.nonce!==nonce/);
  assert.match(out, /\^\[a-zA-Z0-9_-\]\{43\}\$/);
  assert.match(out, /function command\(d\)/);
  assert.match(out, /d\.type==='select-mode'.*typeof d\.on==='boolean'/);
  assert.match(out, /selector\.length<=4096/);
  assert.match(out, /e\.ports&&e\.ports\[0\]/, "opaque origins require a transferred MessagePort");
  assert.doesNotMatch(out, /parent\.postMessage\([^;]+,'\*'\)/);
  assert.doesNotMatch(out, /parent\.postMessage\([^;]+,"\*"\)/);
});

test("picker supports keyboard selection and preserves complete text without folding whitespace", () => {
  const html = injectSelectBridge("<html><body><h1>Pick</h1></body></html>");
  const source = html.match(/<script data-dezin-bridge>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);

  const documentListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const sent: Array<Record<string, unknown>> = [];
  const appended: Array<Record<string, unknown>> = [];
  const commandRef: { current: ((message: Record<string, unknown>) => void) | null } = { current: null };
  const bodyStyle = { cursor: "" };
  const body = {
    nodeType: 1,
    tagName: "BODY",
    style: bodyStyle,
    scrollTop: 0,
    scrollLeft: 0,
    appendChild(node: Record<string, unknown>) { appended.push(node); },
  } as Record<string, unknown>;
  const attributes: Record<string, string> = {
    "data-design-node-id": "hero-title",
    "data-dezin-source-path": "src/Hero.tsx",
  };
  const target = {
    nodeType: 1,
    tagName: "H1",
    id: "",
    className: "",
    classList: { length: 0 },
    parentElement: body,
    previousElementSibling: null,
    textContent: "  Objects\n    for a considered\t home  ",
    getAttribute(name: string) { return attributes[name] ?? ""; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 320, height: 64 }; },
    scrollIntoView() {},
  };
  const trailingTarget = {
    ...target,
    textContent: "Footer action",
    getAttribute(name: string) {
      return name === "data-design-node-id"
        ? "footer-action"
        : name === "data-dezin-source-path"
          ? "src/Footer.tsx"
          : "";
    },
    getBoundingClientRect() { return { left: 10, top: 120, width: 180, height: 40 }; },
  };
  const bridge = {
    send(message: Record<string, unknown>) { sent.push(message); },
    listen(listener: (message: Record<string, unknown>) => void) { commandRef.current = listener; },
  };
  const document = {
    body,
    documentElement: { nodeType: 1, tagName: "HTML", style: {} },
    scrollingElement: body,
    createElement() {
      const attrs: Record<string, string> = {};
      return {
        style: {} as Record<string, string>,
        textContent: "",
        setAttribute(name: string, value: string) { attrs[name] = value; },
        getAttribute(name: string) { return attrs[name] ?? null; },
      };
    },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
    querySelectorAll() { return [target, trailingTarget]; },
    querySelector() { return null; },
  };
  const window = {
    __dezinBridgeTransport: bridge,
    addEventListener() {},
    setTimeout,
    pageXOffset: 0,
    pageYOffset: 0,
  };
  runInNewContext(source, {
    window,
    document,
    CSS: { escape: (value: string) => value },
    getComputedStyle: () => new Proxy({}, { get: () => "" }),
    setTimeout,
    clearTimeout,
  });

  const sendCommand = (message: Record<string, unknown>) => {
    const listener = commandRef.current;
    assert.ok(listener);
    listener(message);
  };
  const key = (value: string) => {
    let prevented = false;
    const event = {
      key: value,
      target: body,
      preventDefault() { prevented = true; },
      stopPropagation() {},
    };
    for (const listener of documentListeners.get("keydown") ?? []) listener(event);
    return prevented;
  };
  sendCommand({ type: "select-mode", on: true });
  assert.equal(key("ArrowDown"), true);
  assert.equal(key("Enter"), true);
  const selected = sent.find((message) => message.type === "element-selected");
  assert.equal(selected?.text, target.textContent);
  assert.equal(selected?.textComplete, true);
  assert.equal(selected?.textPreview, "Objects for a considered home");
  assert.equal(bodyStyle.cursor, "", "confirming a keyboard pick must leave selection cursor mode");
  assert.ok(appended.some((node) => typeof node.getAttribute === "function"
    && (node.getAttribute as (name: string) => unknown)("aria-live") === "polite"));

  sent.length = 0;
  target.textContent = "x".repeat(100_001);
  sendCommand({ type: "select-mode", on: true });
  key("ArrowDown");
  key("Enter");
  const oversized = sent.find((message) => message.type === "element-selected");
  assert.equal(oversized?.textComplete, false);
  assert.equal(Object.hasOwn(oversized ?? {}, "text"), false);
  assert.equal(String(oversized?.textPreview).length, 160);

  sent.length = 0;
  sendCommand({ type: "select-mode", on: true });
  key("ArrowUp");
  key("Enter");
  const reverseSelected = sent.find((message) => message.type === "element-selected");
  assert.equal(
    (reverseSelected?.locator as { designNodeId?: string } | undefined)?.designNodeId,
    "footer-action",
    "reverse traversal starts from the last selectable element",
  );
});

test("preview bridge stamps the protocol on every queued and live child event", () => {
  const nonce = "a".repeat(43);
  const html = injectRuntimeProbe("<html><head></head><body></body></html>");
  const source = html.match(/<script data-dezin-runtime-probe>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);

  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const parent = {};
  const dispatched: Array<{ type: string; detail: unknown }> = [];
  const createStyle = () => {
    const priorities: Record<string, string> = {};
    const style = {
      background: "",
      transition: "",
      animation: "",
      getPropertyValue(name: string) {
        return name === "background" || name === "transition" || name === "animation"
          ? this[name]
          : "";
      },
    getPropertyPriority(name: string) {
        return priorities[name] ?? "";
    },
    setProperty(name: string, value: string, priority = "") {
        assert.ok(name === "background" || name === "transition" || name === "animation");
        this[name] = value;
        priorities[name] = priority;
    },
    };
    return style;
  };
  const rootStyle = createStyle();
  const bodyStyle = createStyle();
  const window = {
    origin: "null",
    __DEZIN_RENDER_CONTEXT__: {
      kernel: {
        responsiveFrames: [{
          id: "kernel-mobile",
          name: "Kernel mobile",
          width: 390,
          height: 844,
          initialState: "ready",
          fixture: { source: "kernel" },
          background: "#f5f5f4",
        }],
      },
    },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatchEvent(event: { type: string; detail: unknown }) {
      dispatched.push(event);
      for (const listener of listeners.get(event.type) ?? []) listener(event as unknown as Record<string, unknown>);
      return true;
    },
  } as Record<string, unknown>;
  const sent: Array<Record<string, unknown>> = [];
  const port = {
    postMessage(message: Record<string, unknown>) { sent.push(message); },
    start() {},
    onmessage: null as null | ((event: { data: unknown }) => void),
  };
  function FakeXhr() {}
  Reflect.set(FakeXhr, "prototype", {});
  runInNewContext(source, {
    window,
    parent,
    location: { hash: `#dezin-bridge=${nonce}` },
    document: {
      readyState: "complete",
      documentElement: { style: rootStyle, setAttribute() {} },
      body: { scrollHeight: 100, innerText: "rendered preview content", style: bodyStyle },
    },
    console: { error() {} },
    XMLHttpRequest: FakeXhr,
    CSS: { supports: () => true },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    setTimeout,
    clearTimeout,
    isFinite,
  });

  const bridge = window.__dezinBridgeTransport as {
    send(message: Record<string, unknown>): void;
    listen(listener: (message: Record<string, unknown>) => void): void;
  };
  bridge.send({ source: "dezin", type: "queued-before-ready" });
  const init = {
    data: { source: "dezin-parent", type: "bridge-init", protocol: 1, nonce },
    source: parent,
    origin: "null",
    ports: [port],
  };
  listeners.get("message")?.[0]?.(init);
  bridge.send({ source: "dezin", type: "live-after-ready" });

  const commands: string[] = [];
  bridge.listen((message) => commands.push(String(message.type)));
  port.onmessage?.({ data: { source: "dezin-parent", type: "clear", protocol: 2, nonce } });
  port.onmessage?.({ data: { source: "dezin-parent", type: "clear", protocol: 1, nonce } });
  for (let index = 0; index < 18; index += 1) {
    listeners.get("error")?.[0]?.({
      target: window,
      message: `Failure before frame context ${index}`,
      filename: "src/entry.tsx",
      lineno: 7 + index,
      colno: 3,
    });
  }
  assert.equal(
    sent.some((message) => message.type === "runtime-error"),
    false,
    "pre-frame diagnostics stay inside the probe until they can be scoped",
  );
  port.onmessage?.({
    data: {
      source: "dezin-parent",
      type: "set-frame",
      protocol: 1,
      nonce,
      frameId: "desktop",
      frameAttemptId: "frame-attempt-1",
      initialState: "loading",
      fixture: { count: 2 },
      background: "#112233",
    },
  });

  assert.deepEqual(sent.slice(0, 3).map((message) => message.type), [
    "bridge-ready",
    "queued-before-ready",
    "live-after-ready",
  ]);
  assert.equal(sent.filter((message) => message.type === "runtime-error").length, 16);
  assert.equal(sent.at(-1)?.type, "frame-applied");
  assert.ok(sent.every((message) => message.protocol === 1));
  assert.ok(sent.every((message) => message.nonce === nonce));
  assert.deepEqual(commands, ["clear"], "commands from another protocol generation must be ignored");
  assert.deepEqual(
    JSON.parse(JSON.stringify(window.__DEZIN_RENDER_FRAME__)),
    {
      protocol: "dezin-frame-v1",
      frameId: "desktop",
      frameAttemptId: "frame-attempt-1",
      initialState: "loading",
      fixture: { count: 2 },
      background: "#112233",
    },
  );
  assert.equal(rootStyle.background, "#112233");
  assert.equal(bodyStyle.background, "transparent");
  assert.equal(rootStyle.getPropertyPriority("background"), "important");
  assert.equal(bodyStyle.getPropertyPriority("background"), "important");
  assert.equal(rootStyle.transition, "none");
  assert.equal(bodyStyle.transition, "none");
  assert.equal(rootStyle.animation, "none");
  assert.equal(bodyStyle.animation, "none");
  assert.deepEqual(dispatched.map((event) => event.type), ["dezin:frame-change"]);
  assert.equal(sent.at(-1)?.type, "frame-applied");
  assert.equal(sent.at(-1)?.frameAttemptId, "frame-attempt-1");
  assert.equal(sent.some((message) => message.message === "Failure before frame context 0"), false);
  assert.equal(sent.some((message) => message.message === "Failure before frame context 1"), false);
  const replayedEarlyError = sent.find((message) => message.message === "Failure before frame context 17");
  assert.equal(replayedEarlyError?.frameId, "desktop");
  assert.equal(replayedEarlyError?.frameAttemptId, "frame-attempt-1");
  assert.equal(commands.includes("set-frame"), false, "frame commands are consumed by the authenticated transport");

  listeners.get("error")?.[0]?.({
    target: window,
    message: "Frame-scoped failure",
    filename: "src/Hero.tsx",
    lineno: 24,
    colno: 7,
  });
  assert.equal(sent.at(-1)?.type, "runtime-error");
  assert.equal(sent.at(-1)?.frameId, "desktop");
  assert.equal(sent.at(-1)?.frameAttemptId, "frame-attempt-1");

  const applied = JSON.stringify(window.__DEZIN_RENDER_FRAME__);
  port.onmessage?.({
    data: {
      source: "dezin-parent",
      type: "set-frame",
      protocol: 1,
      nonce,
      frameId: "malformed",
      frameAttemptId: "frame-attempt-invalid",
      background: "x".repeat(4_097),
      fixture: { constructor: "pollution" },
    },
  });
  assert.equal(JSON.stringify(window.__DEZIN_RENDER_FRAME__), applied);
  assert.equal(dispatched.length, 1);
  assert.equal(sent.at(-1)?.type, "frame-rejected");
  assert.equal(sent.at(-1)?.frameAttemptId, "frame-attempt-invalid");
  assert.equal(sent.at(-1)?.reason, "invalid-fixture");

  port.onmessage?.({
    data: { source: "dezin-parent", type: "set-frame", protocol: 1, nonce, frameId: "kernel-mobile" },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(window.__DEZIN_RENDER_FRAME__)),
    {
      protocol: "dezin-frame-v1",
      frameId: "kernel-mobile",
      initialState: "ready",
      fixture: { source: "kernel" },
      background: "#f5f5f4",
    },
  );
  assert.equal(rootStyle.background, "#f5f5f4");
  assert.equal(bodyStyle.background, "transparent");
  assert.equal(sent.at(-1)?.type, "frame-applied");
  assert.equal(sent.at(-1)?.reason, "applied");

  port.onmessage?.({
    data: {
      source: "dezin-parent",
      type: "set-frame",
      protocol: 1,
      nonce,
      frameId: "safe-gradient",
      background: "linear-gradient(135deg, #111827 0%, rgb(37 99 235 / 80%) 100%)",
    },
  });
  assert.equal(sent.at(-1)?.type, "frame-applied");
  assert.equal(sent.at(-1)?.reason, "applied");
  const safeFrame = JSON.stringify(window.__DEZIN_RENDER_FRAME__);
  const safeBackground = bodyStyle.background;

  for (const background of [
    'url("https://attacker.invalid/tracker.png")',
    'image-set(url("https://attacker.invalid/1x.png") 1x)',
    "var(--remote-background)",
    'u\\72l("https://attacker.invalid/escaped.png")',
    "currentColor",
    "light-dark(white, black)",
    "Canvas",
  ]) {
    port.onmessage?.({
      data: {
        source: "dezin-parent",
        type: "set-frame",
        protocol: 1,
        nonce,
        frameId: "unsafe-background",
        background,
      },
    });
    assert.equal(sent.at(-1)?.type, "frame-rejected");
    assert.equal(sent.at(-1)?.frameId, "unsafe-background");
    assert.equal(sent.at(-1)?.reason, "unsafe-background");
    assert.equal(JSON.stringify(window.__DEZIN_RENDER_FRAME__), safeFrame);
    assert.equal(bodyStyle.background, safeBackground);
  }

  const replacementSent: Array<Record<string, unknown>> = [];
  const replacementPort = {
    postMessage(message: Record<string, unknown>) { replacementSent.push(message); },
    start() {},
    onmessage: null as null | ((event: { data: unknown }) => void),
  };
  listeners.get("message")?.[0]?.({
    data: { source: "dezin-parent", type: "bridge-init", protocol: 1, nonce },
    source: parent,
    origin: "null",
    ports: [replacementPort],
  });
  bridge.send({ source: "dezin", type: "after-reconnect" });
  assert.deepEqual(
    replacementSent.map((message) => message.type),
    ["bridge-ready", "after-reconnect"],
    "a nonce-bound parent may replace a stale MessagePort generation",
  );
});

test("preview bridge rejects malformed or oversized frame state without changing the current frame", () => {
  const out = injectRuntimeProbe("<html><head></head><body></body></html>");
  assert.match(out, /dezin-frame-v1/);
  assert.match(out, /frame-rejected/);
  assert.match(out, /dezin:frame-change/);
  assert.match(out, /65536/);
  assert.match(out, /4096/);
});

test("runtime probe contains no raw control characters and still parses after the HTML tokenizer", () => {
  const out = injectRuntimeProbe("<html><head></head><body></body></html>");
  const source = out.match(/<script data-dezin-runtime-probe>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);
  assert.doesNotMatch(source, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);

  // Browsers replace a raw NUL while tokenizing inline script text. Parse and
  // serialize first so this test exercises the same transformation instead of
  // handing the original template string directly to node:vm.
  const browserHtml = serialize(parse(out));
  const browserSource = browserHtml.match(/<script data-dezin-runtime-probe="">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(browserSource);
  assert.doesNotThrow(() => new Function(browserSource));
});

test("injectRuntimeProbe installs before the page's own scripts, inside <head>", () => {
  const out = injectRuntimeProbe("<html><head><script>window.__early=1;</script></head><body><h1>x</h1></body></html>");
  assert.match(out, /data-dezin-runtime-probe/);
  // The probe's error hooks must be installed before any script the page itself runs,
  // so a parse-time throw in an early inline script is still caught.
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("window.__early"), "probe must precede the page's own scripts");
  // ...and it sits inside <head>.
  assert.ok(out.indexOf("data-dezin-runtime-probe") > out.indexOf("<head>"));
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("</head>"));
});

test("injectRuntimeProbe injects after <html> when there is no <head>", () => {
  const out = injectRuntimeProbe("<html><body><script>window.__b=1;</script></body></html>");
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("window.__b"), "probe must precede the page's own scripts");
  assert.ok(out.indexOf("data-dezin-runtime-probe") > out.indexOf("<html>"));
});

test("injectRuntimeProbe falls back to prepend when there is no <head>/<html>", () => {
  const out = injectRuntimeProbe("<h1>x</h1>");
  assert.match(out, /data-dezin-runtime-probe/);
  assert.ok(out.startsWith("<script data-dezin-runtime-probe>"));
});

test("prototype and standard probe strings stay identical", async () => {
  const staticSrc = await readFile(join(import.meta.dirname, "../src/serve-static.ts"), "utf8");
  const viteSrc = await readFile(
    join(import.meta.dirname, "../../../content/templates/react-vite/vite.config.js"),
    "utf8",
  );
  const grab = (s: string) => s.slice(s.indexOf("<script data-dezin-runtime-probe>"), s.indexOf("</script>", s.indexOf("data-dezin-runtime-probe")) + 9);
  assert.equal(grab(staticSrc), grab(viteSrc));
});

test("prototype and standard picker strings stay identical", async () => {
  const staticSrc = await readFile(join(import.meta.dirname, "../src/serve-static.ts"), "utf8");
  const viteSrc = await readFile(
    join(import.meta.dirname, "../../../content/templates/react-vite/vite.config.js"),
    "utf8",
  );
  const grab = (source: string) => source.slice(
    source.indexOf("<script data-dezin-bridge>"),
    source.indexOf("</script>", source.indexOf("data-dezin-bridge")) + 9,
  );
  assert.equal(grab(staticSrc), grab(viteSrc));
});
