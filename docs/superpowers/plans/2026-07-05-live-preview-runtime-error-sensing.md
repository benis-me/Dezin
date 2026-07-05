# Live Preview Runtime-Error Sensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live artifact preview sense its own runtime failures (crash / white screen / console + request errors), surface them to the user (fatal overlay + non-fatal badge), and let the Agent fix them via the existing repair pipeline.

**Architecture:** An injected in-page probe (sibling to the existing element-picker bridge) hooks `onerror` / `unhandledrejection` / `console.error` / resource + `fetch`/`XHR` failures inside the preview frame, classifies fatal-vs-non-fatal in-frame (only it can read the frame's DOM), and `postMessage`s to the parent. A parent-side hook validates, dedupes, runs a white-screen watchdog, and drives two UI tiers. "Fix with Agent" and an optional global auto-fix toggle feed captured errors into the existing `runBrief`.

**Tech Stack:** TypeScript, React, vitest (web: `apps/web`, tests beside source), node:test (`apps/daemon`, `packages/core`, tests in `test/`), better-sqlite settings store (`packages/core`), Vite (Standard-mode template), a plain injected `<script>` (both modes).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-live-preview-runtime-error-sensing-design.md`. Every task implements part of it.
- v1 scope: in-page probe only. **No** CDP / `webContents.debugger` / `WebContentsView`. The preview stays an `<iframe>`.
- Surfaces: main `WorkspaceScreen` preview only. Not `PreviewModal` / `VersionCompare`.
- Both build modes: Prototype (served HTML via `serve-static.ts`) and Standard (Vite template `content/templates/react-vite-gsap/vite.config.js`).
- The probe is a self-contained IIFE, idempotency-guarded by `window.__dezinRuntimeProbe`, kept **separate** from the picker bridge so it cannot regress picker/markup.
- Message envelope: `{ source: "dezin", type: "runtime-error" | "preview-heartbeat", … }`, validated by `event.source === iframe.contentWindow` and `event.origin === previewBridgeOriginForSrc(previewSrc)` (isolated frames post from origin `"null"`).
- Auto-fix is a **global** setting `autoFixLiveRuntimeErrors` (default `false`), mirroring the `visualQaEnabled` global + per-run-snapshot pattern; it triggers only on **fatal** errors, with loop guards.
- No `Co-Authored-By` trailer on commits. No version bump for these commits (feature-branch work; the root version bumps when the feature lands).
- Commit after each task. Web test command: `pnpm --filter ./apps/web test`. Daemon: `pnpm --filter ./apps/daemon test`. Core: `pnpm --filter @dezin/core test`.

---

### Task 1: Inject the runtime-error probe (both build modes)

**Files:**
- Modify: `apps/daemon/src/serve-static.ts` (add `RUNTIME_PROBE` + `injectRuntimeProbe`; call it in `serveFileFromBase`)
- Modify: `content/templates/react-vite-gsap/vite.config.js` (add the same probe string; inject in `transformIndexHtml`)
- Test: `apps/daemon/test/serve-static.test.ts` (new)

**Interfaces:**
- Produces: `injectRuntimeProbe(html: string): string` — returns `html` with the probe `<script>` inserted before `</body>` (or appended). The probe posts `RuntimeErrorMessage` / `PreviewHeartbeatMessage` (shapes defined in Task 2) to `parent`.

The probe script (identical string in both files):

```html
<script data-dezin-runtime-probe>(function(){
if(window.__dezinRuntimeProbe)return;window.__dezinRuntimeProbe=1;
var MAXLEN=2000,SIGCAP=50,WIN=1000,seen={},order=[];
function hasContent(){try{var b=document.body;return !!(b&&b.scrollHeight>40&&(b.innerText||'').trim().length>20);}catch(_){return true;}}
function trunc(s){s=String(s==null?'':s);return s.length>MAXLEN?s.slice(0,MAXLEN):s;}
function safe(o){try{return JSON.stringify(o);}catch(_){return String(o);}}
function post(kind,errorType,message,stack,src,line,col){
  var sig=errorType+'|'+message+'|'+(src||'')+':'+(line||0),now=Date.now(),rec=seen[sig];
  if(rec){rec.count++;if(now-rec.last<WIN)return;rec.last=now;}
  else{rec={count:1,last:now};seen[sig]=rec;order.push(sig);if(order.length>SIGCAP)delete seen[order.shift()];}
  try{parent.postMessage({source:'dezin',type:'runtime-error',kind:kind,errorType:errorType,message:trunc(message),stack:stack?trunc(stack):undefined,src:src||undefined,line:line,col:col,count:rec.count,at:now},'*');}catch(_){}
}
function classify(){return hasContent()?'nonfatal':'fatal';}
window.addEventListener('error',function(e){
  var t=e&&e.target;
  if(t&&t!==window&&t.tagName){post('nonfatal','resource','Failed to load '+String(t.tagName).toLowerCase()+' resource',undefined,t.src||t.href||'',0,0);return;}
  post(classify(),'error',(e&&e.message)||'Uncaught error',e&&e.error&&e.error.stack,e&&e.filename,e&&e.lineno,e&&e.colno);
},true);
window.addEventListener('unhandledrejection',function(e){
  var r=e&&e.reason;post(classify(),'unhandledrejection',(r&&r.message)||String(r),r&&r.stack);
});
var _err=console.error;console.error=function(){try{var p=[];for(var i=0;i<arguments.length;i++){var a=arguments[i];p.push(a&&a.stack?a.stack:(a&&typeof a==='object'?safe(a):String(a)));}post('nonfatal','console',p.join(' '));}catch(_){}return _err.apply(console,arguments);};
try{var _f=window.fetch;if(_f)window.fetch=function(){var args=arguments,u=args[0];return _f.apply(this,args).then(function(res){try{if(res&&res.status>=400)post('nonfatal','request',res.status+' '+(res.url||''),undefined,res.url||'');}catch(_){}return res;},function(err){try{post('nonfatal','request','fetch failed '+(typeof u==='string'?u:(u&&u.url)||''),err&&err.stack,typeof u==='string'?u:'');}catch(_){}throw err;});};}catch(_){}
try{var _o=XMLHttpRequest.prototype.open,_s=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__dezinUrl=u;return _o.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){var x=this;x.addEventListener('load',function(){try{if(x.status>=400)post('nonfatal','request',x.status+' '+(x.__dezinUrl||''),undefined,x.__dezinUrl||'');}catch(_){}});x.addEventListener('error',function(){try{post('nonfatal','request','request failed '+(x.__dezinUrl||''),undefined,x.__dezinUrl||'');}catch(_){}});return _s.apply(this,arguments);};}catch(_){}
function beat(){try{parent.postMessage({source:'dezin',type:'preview-heartbeat',phase:'first-paint',at:Date.now()},'*');}catch(_){}}
function firstPaint(n){if(hasContent()){beat();return;}if(n<=0)return;setTimeout(function(){firstPaint(n-1);},150);}
function init(){firstPaint(20);}
if(document.body)init();else document.addEventListener('DOMContentLoaded',init);
})();</script>
```

- [ ] **Step 1: Write the failing test** — `apps/daemon/test/serve-static.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { injectRuntimeProbe } from "../src/serve-static.ts";

test("injectRuntimeProbe inserts the probe before </body>", () => {
  const out = injectRuntimeProbe("<html><body><h1>x</h1></body></html>");
  assert.match(out, /data-dezin-runtime-probe/);
  assert.ok(out.indexOf("data-dezin-runtime-probe") < out.indexOf("</body>"));
});

test("injectRuntimeProbe appends when there is no </body>", () => {
  const out = injectRuntimeProbe("<h1>x</h1>");
  assert.match(out, /data-dezin-runtime-probe/);
});

test("prototype and standard probe strings stay identical", async () => {
  const staticSrc = await readFile(join(import.meta.dirname, "../src/serve-static.ts"), "utf8");
  const viteSrc = await readFile(
    join(import.meta.dirname, "../../../content/templates/react-vite-gsap/vite.config.js"),
    "utf8",
  );
  const grab = (s: string) => s.slice(s.indexOf("<script data-dezin-runtime-probe>"), s.indexOf("</script>", s.indexOf("data-dezin-runtime-probe")) + 9);
  assert.equal(grab(staticSrc), grab(viteSrc));
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/daemon test`
Expected: FAIL — `injectRuntimeProbe` is not exported.

- [ ] **Step 3: Add the probe + injector to `serve-static.ts`**

After the `injectSelectBridge` function (line ~55), add the `RUNTIME_PROBE` constant (the script string above, as a backtick template literal) and:

```ts
/** Inject the runtime-error probe before </body> (or append) for HTML responses. */
export function injectRuntimeProbe(html: string): string {
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + RUNTIME_PROBE + html.slice(i) : html + RUNTIME_PROBE;
}
```

In `serveFileFromBase`, change the HTML branch (line ~85-88) to chain both injectors:

```ts
    if (contentType.startsWith("text/html")) {
      const html = injectRuntimeProbe(injectSelectBridge(await readFile(file, "utf8")));
      send(res, 200, html, contentType);
      return;
    }
```

- [ ] **Step 4: Add the same probe to the Vite template**

In `content/templates/react-vite-gsap/vite.config.js`, add a `const RUNTIME_PROBE = \`…\`;` with the identical script string (after `PICKER_BRIDGE`), and update `transformIndexHtml`:

```js
    transformIndexHtml(html) {
      const bridges = PICKER_BRIDGE + RUNTIME_PROBE;
      return html.includes("</body>") ? html.replace("</body>", bridges + "</body>") : html + bridges;
    },
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter ./apps/daemon test`
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/serve-static.ts content/templates/react-vite-gsap/vite.config.js apps/daemon/test/serve-static.test.ts
git commit -m "feat(preview): inject runtime-error probe into served previews (both modes)"
```

---

### Task 2: Runtime-error protocol + type guards

**Files:**
- Create: `apps/web/src/lib/preview-runtime-errors.ts`
- Test: `apps/web/src/lib/preview-runtime-errors.test.ts`

**Interfaces:**
- Produces:
  - `type RuntimeErrorKind = "fatal" | "nonfatal"`
  - `type RuntimeErrorType = "error" | "unhandledrejection" | "console" | "resource" | "request"`
  - `interface RuntimeErrorMessage { source: "dezin"; type: "runtime-error"; kind: RuntimeErrorKind; errorType: RuntimeErrorType; message: string; stack?: string; src?: string; line?: number; col?: number; count: number; at: number }`
  - `interface PreviewHeartbeatMessage { source: "dezin"; type: "preview-heartbeat"; phase: "first-paint"; at: number }`
  - `isRuntimeErrorMessage(data: unknown): data is RuntimeErrorMessage`
  - `isHeartbeatMessage(data: unknown): data is PreviewHeartbeatMessage`
  - `signatureOf(m: Pick<RuntimeErrorMessage, "errorType" | "message" | "src" | "line">): string`

- [ ] **Step 1: Write the failing test** — `apps/web/src/lib/preview-runtime-errors.test.ts`

```ts
import { expect, test } from "vitest";
import { isRuntimeErrorMessage, isHeartbeatMessage, signatureOf } from "./preview-runtime-errors.ts";

const base = { source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "boom", count: 1, at: 1 };

test("isRuntimeErrorMessage accepts a valid message", () => {
  expect(isRuntimeErrorMessage(base)).toBe(true);
});

test("isRuntimeErrorMessage rejects foreign / malformed data", () => {
  expect(isRuntimeErrorMessage({ ...base, source: "other" })).toBe(false);
  expect(isRuntimeErrorMessage({ ...base, type: "selected" })).toBe(false);
  expect(isRuntimeErrorMessage({ ...base, kind: "meh" })).toBe(false);
  expect(isRuntimeErrorMessage(null)).toBe(false);
});

test("isHeartbeatMessage accepts a valid heartbeat", () => {
  expect(isHeartbeatMessage({ source: "dezin", type: "preview-heartbeat", phase: "first-paint", at: 2 })).toBe(true);
  expect(isHeartbeatMessage(base)).toBe(false);
});

test("signatureOf is stable across identical errors", () => {
  expect(signatureOf({ errorType: "error", message: "x", src: "a.js", line: 3 })).toBe(
    signatureOf({ errorType: "error", message: "x", src: "a.js", line: 3 }),
  );
  expect(signatureOf({ errorType: "error", message: "x" })).not.toBe(signatureOf({ errorType: "error", message: "y" }));
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `preview-runtime-errors.ts` with types + guards**

```ts
export type RuntimeErrorKind = "fatal" | "nonfatal";
export type RuntimeErrorType = "error" | "unhandledrejection" | "console" | "resource" | "request";

export interface RuntimeErrorMessage {
  source: "dezin";
  type: "runtime-error";
  kind: RuntimeErrorKind;
  errorType: RuntimeErrorType;
  message: string;
  stack?: string;
  src?: string;
  line?: number;
  col?: number;
  count: number;
  at: number;
}

export interface PreviewHeartbeatMessage {
  source: "dezin";
  type: "preview-heartbeat";
  phase: "first-paint";
  at: number;
}

const KINDS = new Set<RuntimeErrorKind>(["fatal", "nonfatal"]);

export function isRuntimeErrorMessage(data: unknown): data is RuntimeErrorMessage {
  const d = data as Partial<RuntimeErrorMessage> | null;
  return Boolean(
    d && typeof d === "object" && d.source === "dezin" && d.type === "runtime-error" &&
      typeof d.message === "string" && typeof d.kind === "string" && KINDS.has(d.kind as RuntimeErrorKind),
  );
}

export function isHeartbeatMessage(data: unknown): data is PreviewHeartbeatMessage {
  const d = data as Partial<PreviewHeartbeatMessage> | null;
  return Boolean(d && typeof d === "object" && d.source === "dezin" && d.type === "preview-heartbeat");
}

export function signatureOf(m: Pick<RuntimeErrorMessage, "errorType" | "message" | "src" | "line">): string {
  return `${m.errorType}|${m.message}|${m.src ?? ""}:${m.line ?? 0}`;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/preview-runtime-errors.ts apps/web/src/lib/preview-runtime-errors.test.ts
git commit -m "feat(preview): runtime-error message types + validation guards"
```

---

### Task 3: Error-model reducer (dedupe, dismiss, generation suppression)

**Files:**
- Modify: `apps/web/src/lib/preview-runtime-errors.ts`
- Test: `apps/web/src/lib/preview-runtime-errors.test.ts`

**Interfaces:**
- Consumes: `RuntimeErrorMessage`, `signatureOf` (Task 2).
- Produces:
  - `interface RuntimeError extends RuntimeErrorMessage { sig: string }`
  - `interface RuntimeErrorState { fatal: RuntimeError | null; nonFatal: RuntimeError[]; dismissedFatalSig: string | null }`
  - `const initialRuntimeErrorState: RuntimeErrorState`
  - `ingestRuntimeError(state, msg: RuntimeErrorMessage, opts: { runActive: boolean }): RuntimeErrorState`
  - `dismissFatal(state): RuntimeErrorState`
  - `dismissNonFatal(state, sig: string): RuntimeErrorState`
  - `resetRuntimeErrors(): RuntimeErrorState`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { initialRuntimeErrorState, ingestRuntimeError, dismissFatal, dismissNonFatal } from "./preview-runtime-errors.ts";

const msg = (over: Partial<RuntimeErrorMessage> = {}): RuntimeErrorMessage => ({
  source: "dezin", type: "runtime-error", kind: "nonfatal", errorType: "console", message: "m", count: 1, at: 1, ...over,
});

test("ingest routes fatal and non-fatal into separate buckets", () => {
  let s = initialRuntimeErrorState;
  s = ingestRuntimeError(s, msg({ kind: "fatal", errorType: "error", message: "died" }), { runActive: false });
  s = ingestRuntimeError(s, msg({ message: "warn" }), { runActive: false });
  expect(s.fatal?.message).toBe("died");
  expect(s.nonFatal.map((e) => e.message)).toEqual(["warn"]);
});

test("ingest dedupes non-fatal by signature and keeps latest count", () => {
  let s = initialRuntimeErrorState;
  s = ingestRuntimeError(s, msg({ message: "dup", count: 1 }), { runActive: false });
  s = ingestRuntimeError(s, msg({ message: "dup", count: 4 }), { runActive: false });
  expect(s.nonFatal).toHaveLength(1);
  expect(s.nonFatal[0].count).toBe(4);
});

test("runActive suppresses fatal (buffers nothing visible)", () => {
  const s = ingestRuntimeError(initialRuntimeErrorState, msg({ kind: "fatal", message: "x" }), { runActive: true });
  expect(s.fatal).toBeNull();
});

test("a dismissed fatal signature does not re-open until it changes", () => {
  let s = ingestRuntimeError(initialRuntimeErrorState, msg({ kind: "fatal", errorType: "error", message: "z" }), { runActive: false });
  s = dismissFatal(s);
  expect(s.fatal).toBeNull();
  s = ingestRuntimeError(s, msg({ kind: "fatal", errorType: "error", message: "z" }), { runActive: false });
  expect(s.fatal).toBeNull();
});

test("dismissNonFatal removes one entry by signature", () => {
  let s = ingestRuntimeError(initialRuntimeErrorState, msg({ message: "a" }), { runActive: false });
  s = dismissNonFatal(s, s.nonFatal[0].sig);
  expect(s.nonFatal).toHaveLength(0);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Implement the reducer** (append to `preview-runtime-errors.ts`)

```ts
export interface RuntimeError extends RuntimeErrorMessage { sig: string }
export interface RuntimeErrorState {
  fatal: RuntimeError | null;
  nonFatal: RuntimeError[];
  dismissedFatalSig: string | null;
}
export const initialRuntimeErrorState: RuntimeErrorState = { fatal: null, nonFatal: [], dismissedFatalSig: null };
export function resetRuntimeErrors(): RuntimeErrorState {
  return { fatal: null, nonFatal: [], dismissedFatalSig: null };
}

const NONFATAL_CAP = 50;

export function ingestRuntimeError(state: RuntimeErrorState, msg: RuntimeErrorMessage, opts: { runActive: boolean }): RuntimeErrorState {
  const sig = signatureOf(msg);
  const entry: RuntimeError = { ...msg, sig };
  if (msg.kind === "fatal") {
    if (opts.runActive || state.dismissedFatalSig === sig) return state;
    return { ...state, fatal: entry };
  }
  const rest = state.nonFatal.filter((e) => e.sig !== sig);
  return { ...state, nonFatal: [...rest, entry].slice(-NONFATAL_CAP) };
}

export function dismissFatal(state: RuntimeErrorState): RuntimeErrorState {
  return { ...state, fatal: null, dismissedFatalSig: state.fatal?.sig ?? state.dismissedFatalSig };
}

export function dismissNonFatal(state: RuntimeErrorState, sig: string): RuntimeErrorState {
  return { ...state, nonFatal: state.nonFatal.filter((e) => e.sig !== sig) };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/preview-runtime-errors.ts apps/web/src/lib/preview-runtime-errors.test.ts
git commit -m "feat(preview): runtime-error state reducer with dedupe + suppression"
```

---

### Task 4: `usePreviewRuntimeErrors` hook (listener + watchdog + reset)

**Files:**
- Modify: `apps/web/src/lib/preview-runtime-errors.ts`
- Test: `apps/web/src/lib/preview-runtime-errors.test.tsx` (new — `.tsx` for `renderHook`)

**Interfaces:**
- Consumes: reducer + guards (Tasks 2-3); `previewBridgeOriginForSrc` from `./preview-sandbox.ts`.
- Produces:
  - `usePreviewRuntimeErrors(args: { iframeRef: RefObject<HTMLIFrameElement | null>; previewSrc: string | null; runActive: boolean; watchdogMs?: number; armed?: boolean }): { fatal: RuntimeError | null; nonFatal: RuntimeError[]; dismissFatal(): void; dismissNonFatal(sig: string): void }`
- Behavior: adds a `window` `message` listener; accepts only events where `event.source === iframeRef.current?.contentWindow` and `event.origin === previewBridgeOriginForSrc(previewSrc)`; routes `runtime-error` through `ingestRuntimeError`; a `preview-heartbeat` cancels the watchdog. On mount / `previewSrc` change (when `armed`), start a `watchdogMs` (default 8000) timer that, absent any heartbeat or fatal, sets a synthetic blank fatal. Resets state on `previewSrc` change.

- [ ] **Step 1: Write the failing test** — `apps/web/src/lib/preview-runtime-errors.test.tsx`

```tsx
import { expect, test, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { usePreviewRuntimeErrors } from "./preview-runtime-errors.ts";

afterEach(cleanup);

function harness(previewSrc: string, runActive = false) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const win = iframe.contentWindow as Window;
  const { result } = renderHook(() => {
    const ref = useRef<HTMLIFrameElement | null>(iframe);
    return usePreviewRuntimeErrors({ iframeRef: ref, previewSrc, runActive, watchdogMs: 100, armed: true });
  });
  return { result, win };
}

function fire(win: Window, data: unknown, origin = "null") {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: win as MessageEventSource }));
}

test("surfaces a fatal error from a validated message", () => {
  const { result, win } = harness("/projects/p/preview/");
  act(() => fire(win, { source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "died", count: 1, at: 1 }));
  expect(result.current.fatal?.message).toBe("died");
});

test("ignores messages from a foreign origin", () => {
  const { result, win } = harness("/projects/p/preview/");
  act(() => fire(win, { source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "x", count: 1, at: 1 }, "https://evil.example"));
  expect(result.current.fatal).toBeNull();
});

test("watchdog raises a blank fatal when no heartbeat arrives", () => {
  vi.useFakeTimers();
  const { result } = harness("/projects/p/preview/");
  act(() => vi.advanceTimersByTime(150));
  expect(result.current.fatal?.errorType).toBe("error");
  expect(result.current.fatal?.message).toMatch(/did not render/i);
  vi.useRealTimers();
});

test("a heartbeat cancels the watchdog", () => {
  vi.useFakeTimers();
  const { result, win } = harness("/projects/p/preview/");
  act(() => fire(win, { source: "dezin", type: "preview-heartbeat", phase: "first-paint", at: 1 }));
  act(() => vi.advanceTimersByTime(150));
  expect(result.current.fatal).toBeNull();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: FAIL — `usePreviewRuntimeErrors` not defined.

- [ ] **Step 3: Implement the hook** (append; add imports at top of the file)

```ts
import { useEffect, useRef, useState, type RefObject } from "react";
import { previewBridgeOriginForSrc } from "./preview-sandbox.ts";

const BLANK_FATAL: RuntimeError = {
  source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error",
  message: "The preview did not render.", count: 1, at: 0, sig: "blank|The preview did not render.|:0",
};

export function usePreviewRuntimeErrors(args: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewSrc: string | null;
  runActive: boolean;
  watchdogMs?: number;
  armed?: boolean;
}): { fatal: RuntimeError | null; nonFatal: RuntimeError[]; dismissFatal(): void; dismissNonFatal(sig: string): void } {
  const { iframeRef, previewSrc, runActive, watchdogMs = 8000, armed = true } = args;
  const [state, setState] = useState<RuntimeErrorState>(initialRuntimeErrorState);
  const runActiveRef = useRef(runActive);
  runActiveRef.current = runActive;

  useEffect(() => {
    setState(resetRuntimeErrors());
    const onMessage = (event: MessageEvent): void => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;
      if (event.origin !== previewBridgeOriginForSrc(previewSrc)) return;
      const data = event.data;
      if (isHeartbeatMessage(data)) {
        clearTimeout(timer);
        return;
      }
      if (isRuntimeErrorMessage(data)) {
        clearTimeout(timer);
        setState((s) => ingestRuntimeError(s, data, { runActive: runActiveRef.current }));
      }
    };
    window.addEventListener("message", onMessage);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (armed && previewSrc) {
      timer = setTimeout(() => {
        setState((s) => (s.fatal || runActiveRef.current || s.dismissedFatalSig === BLANK_FATAL.sig ? s : { ...s, fatal: BLANK_FATAL }));
      }, watchdogMs);
    }
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [iframeRef, previewSrc, watchdogMs, armed]);

  return {
    fatal: state.fatal,
    nonFatal: state.nonFatal,
    dismissFatal: () => setState(dismissFatal),
    dismissNonFatal: (sig: string) => setState((s) => dismissNonFatal(s, sig)),
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/preview-runtime-errors.ts apps/web/src/lib/preview-runtime-errors.test.tsx
git commit -m "feat(preview): usePreviewRuntimeErrors hook with white-screen watchdog"
```

---

### Task 5: Repair-prompt builder

**Files:**
- Modify: `apps/web/src/lib/preview-runtime-errors.ts`
- Test: `apps/web/src/lib/preview-runtime-errors.test.ts`

**Interfaces:**
- Consumes: `RuntimeError` (Task 3).
- Produces: `buildRuntimeErrorRepairPrompt(errors: RuntimeError[], ctx: { mode: string; projectPath?: string }): string`

- [ ] **Step 1: Write the failing test** (append to `.test.ts`)

```ts
import { buildRuntimeErrorRepairPrompt } from "./preview-runtime-errors.ts";

test("repair prompt includes message, stack, source and asks to fix + verify", () => {
  const p = buildRuntimeErrorRepairPrompt(
    [{ source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "x is not a function", stack: "at App (App.tsx:10)", src: "App.tsx", line: 10, count: 2, at: 1, sig: "s" }],
    { mode: "standard", projectPath: "/p" },
  );
  expect(p).toMatch(/x is not a function/);
  expect(p).toMatch(/App\.tsx/);
  expect(p).toMatch(/at App/);
  expect(p.toLowerCase()).toMatch(/fix/);
  expect(p.toLowerCase()).toMatch(/preview|render/);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: FAIL — not defined.

- [ ] **Step 3: Implement the builder** (append)

```ts
export function buildRuntimeErrorRepairPrompt(errors: RuntimeError[], ctx: { mode: string; projectPath?: string }): string {
  const blocks = errors.map((e, i) => {
    const lines = [
      `${i + 1}. [${e.errorType}${e.count > 1 ? ` ×${e.count}` : ""}] ${e.message}`,
      e.src ? `   source: ${e.src}${e.line ? `:${e.line}` : ""}` : "",
      e.stack ? `   stack: ${e.stack}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  });
  return `The live preview reported runtime errors. Find the root cause in this project's source and fix it.

Build mode: ${ctx.mode}${ctx.projectPath ? `\nProject path: ${ctx.projectPath}` : ""}

Runtime errors observed in the rendered preview:
${blocks.join("\n")}

Fix the underlying bug in the project's code (not by hiding the error), then confirm the preview renders without these errors.`;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ./apps/web test preview-runtime-errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/preview-runtime-errors.ts apps/web/src/lib/preview-runtime-errors.test.ts
git commit -m "feat(preview): build repair prompt from captured runtime errors"
```

---

### Task 6: Overlay + badge UI

**Files:**
- Create: `apps/web/src/components/PreviewRuntimeErrorOverlay.tsx`
- Test: `apps/web/src/components/PreviewRuntimeErrorOverlay.test.tsx`

**Interfaces:**
- Consumes: `RuntimeError` (Task 3).
- Produces:
  - `PreviewRuntimeErrorOverlay({ fatal, nonFatal, onFixFatal, onFixNonFatal, onReload, onDismissFatal, onDismissNonFatal }): JSX.Element | null`
  - Renders a full-cover card when `fatal`, plus a corner badge `Errors · N` when `nonFatal.length > 0`. Presentational only; all actions are callbacks. Uses existing house classes (`bg-card`, `border-border`, `text-destructive`, `text-muted-foreground`).

- [ ] **Step 1: Write the failing test** — `PreviewRuntimeErrorOverlay.test.tsx`

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewRuntimeErrorOverlay } from "./PreviewRuntimeErrorOverlay.tsx";

afterEach(cleanup);
const err = (over = {}) => ({ source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "boom", count: 1, at: 1, sig: "s", ...over } as any);

test("renders nothing when there are no errors", () => {
  const { container } = render(<PreviewRuntimeErrorOverlay fatal={null} nonFatal={[]} onFixFatal={vi.fn()} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

test("fatal overlay shows the message and fires onFixFatal", async () => {
  const onFixFatal = vi.fn();
  render(<PreviewRuntimeErrorOverlay fatal={err({ message: "died" })} nonFatal={[]} onFixFatal={onFixFatal} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />);
  expect(screen.getByText("died")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /fix with agent/i }));
  expect(onFixFatal).toHaveBeenCalledTimes(1);
});

test("non-fatal badge shows the count", () => {
  render(<PreviewRuntimeErrorOverlay fatal={null} nonFatal={[err({ kind: "nonfatal", message: "a", sig: "a" }), err({ kind: "nonfatal", message: "b", sig: "b" })]} onFixFatal={vi.fn()} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />);
  expect(screen.getByText(/2/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/web test PreviewRuntimeErrorOverlay`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
import { useState } from "react";
import { CircleAlert, RotateCw, X } from "lucide-react";
import type { RuntimeError } from "../lib/preview-runtime-errors.ts";
import { cn } from "@/lib/utils.ts";

interface Props {
  fatal: RuntimeError | null;
  nonFatal: RuntimeError[];
  onFixFatal: () => void;
  onFixNonFatal: () => void;
  onReload: () => void;
  onDismissFatal: () => void;
  onDismissNonFatal: (sig: string) => void;
}

export function PreviewRuntimeErrorOverlay(props: Props) {
  const { fatal, nonFatal, onFixFatal, onFixNonFatal, onReload, onDismissFatal, onDismissNonFatal } = props;
  const [open, setOpen] = useState(false);
  if (!fatal && nonFatal.length === 0) return null;

  return (
    <>
      {fatal ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-surface/85 backdrop-blur-sm p-6">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-destructive">
              <CircleAlert size={16} strokeWidth={2} />
              <h2 className="text-sm font-semibold">This preview crashed</h2>
            </div>
            <p className="mb-3 break-words font-mono text-xs text-foreground">{fatal.message}</p>
            {fatal.stack ? (
              <pre className="mb-3 max-h-32 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] text-muted-foreground">{fatal.stack}</pre>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={onFixFatal} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90">Fix with Agent</button>
              <button type="button" onClick={onReload} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-2"><RotateCw size={12} strokeWidth={1.8} />Reload</button>
              <button type="button" onClick={onDismissFatal} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-2">Dismiss</button>
            </div>
          </div>
        </div>
      ) : null}

      {nonFatal.length > 0 ? (
        <div className="absolute bottom-3 right-3 z-20">
          <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/15">
            <CircleAlert size={12} strokeWidth={2} />Errors · {nonFatal.length}
          </button>
          {open ? (
            <div className="mt-2 w-80 rounded-lg border border-border bg-card p-2 shadow-sm">
              <ul className="max-h-56 space-y-1 overflow-auto">
                {nonFatal.map((e) => (
                  <li key={e.sig} className={cn("flex items-start justify-between gap-2 rounded-md px-2 py-1 text-[11px]")}>
                    <span className="min-w-0 break-words font-mono text-muted-foreground">{e.message}{e.count > 1 ? ` ×${e.count}` : ""}</span>
                    <button type="button" aria-label="Dismiss" onClick={() => onDismissNonFatal(e.sig)} className="shrink-0 text-muted-foreground hover:text-foreground"><X size={12} /></button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={onFixNonFatal} className="mt-2 w-full rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90">Fix with Agent</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ./apps/web test PreviewRuntimeErrorOverlay`
Expected: PASS. (If `@testing-library/user-event` is absent, use `fireEvent.click` from `@testing-library/react` instead.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/PreviewRuntimeErrorOverlay.tsx apps/web/src/components/PreviewRuntimeErrorOverlay.test.tsx
git commit -m "feat(preview): fatal overlay + non-fatal badge UI"
```

---

### Task 7: Wire the manual loop into WorkspaceScreen

**Files:**
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Test: `apps/web/src/screens/workspace.test.tsx`

**Interfaces:**
- Consumes: `usePreviewRuntimeErrors`, `buildRuntimeErrorRepairPrompt` (Tasks 4-5); `PreviewRuntimeErrorOverlay` (Task 6); existing `runBrief`, `previewIframeRef`, `previewSrc`, `runningRef`, `projectMode`, `project?.projectPath`, `setupPhase`.
- Produces: the overlay rendered over the preview; `Fix with Agent` dispatches `runBrief(buildRuntimeErrorRepairPrompt(...))`.

- [ ] **Step 1: Write the failing test** (add to `workspace.test.tsx`; reuse the file's existing `dispatchPreviewMessage` helper at line ~27 and mirror the provider wrapping of the existing test that asserts `streamRun` was called, ~line 459)

```tsx
test("a fatal runtime-error shows the crash overlay and Fix dispatches a repair run", async () => {
  const streamRun = vi.fn(() => (async function* (): AsyncGenerator<RunEvent> {})());
  render(
    <AgentsProvider agents={AGENTS}>
      <ApiProvider client={makeFakeApi({ streamRun: streamRun as never })}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>
    </AgentsProvider>,
  );
  await screen.findByTitle("Artifact preview"); // preview iframe present (same setup as the other preview tests)
  dispatchPreviewMessage({ type: "runtime-error", kind: "fatal", errorType: "error", message: "render blew up", count: 1, at: 1 });
  expect(await screen.findByText("render blew up")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /fix with agent/i }));
  await waitFor(() =>
    expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ brief: expect.stringMatching(/render blew up/) }), expect.anything()),
  );
});
```

> `dispatchPreviewMessage(data)` already exists in this file: it posts `{ source: "dezin", ...data }` from the "Artifact preview" iframe with `origin: "null"` — which is exactly what the hook's origin check accepts for a same-origin prototype preview. Match the exact provider wrapper (`AgentsProvider` props etc.) used by the existing `streamRun` assertion test in this file.

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/web test workspace`
Expected: FAIL — no overlay rendered.

- [ ] **Step 3: Mount the hook + wire the fix**

In `WorkspaceScreen`, near the other preview state, add:

```tsx
const runtimeErrors = usePreviewRuntimeErrors({
  iframeRef: previewIframeRef,
  previewSrc,
  runActive: running,
  armed: projectMode !== "standard" || setupPhase === "ready",
});
const fixRuntimeErrors = useCallback(
  (errors: RuntimeError[]) => {
    if (errors.length === 0) return;
    void runBrief(buildRuntimeErrorRepairPrompt(errors, { mode: projectMode, projectPath: project?.projectPath ?? undefined }));
  },
  [projectMode, project?.projectPath],
);
```

Add imports at the top:

```tsx
import { usePreviewRuntimeErrors, buildRuntimeErrorRepairPrompt, type RuntimeError } from "../lib/preview-runtime-errors.ts";
import { PreviewRuntimeErrorOverlay } from "../components/PreviewRuntimeErrorOverlay.tsx";
```

- [ ] **Step 4: Render the overlay over the preview**

Wrap the mount at line ~4780 so the overlay is a positioned sibling of the iframe:

```tsx
<div className="relative flex h-full min-w-0 justify-center overflow-auto">
  {renderPreviewFrame()}
  <PreviewRuntimeErrorOverlay
    fatal={runtimeErrors.fatal}
    nonFatal={runtimeErrors.nonFatal}
    onFixFatal={() => runtimeErrors.fatal && fixRuntimeErrors([runtimeErrors.fatal])}
    onFixNonFatal={() => fixRuntimeErrors(runtimeErrors.nonFatal)}
    onReload={refreshPreview}
    onDismissFatal={runtimeErrors.dismissFatal}
    onDismissNonFatal={runtimeErrors.dismissNonFatal}
  />
</div>
```

(Reuse the existing `refreshPreview` in this file — the same handler `StandardDoctor` uses for `onRefresh` — rather than `contentWindow.location.reload()`, which throws cross-origin for Standard dev servers.)

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter ./apps/web test workspace`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/screens/WorkspaceScreen.tsx apps/web/src/screens/workspace.test.tsx
git commit -m "feat(preview): surface live runtime errors + fix-with-agent in workspace"
```

---

### Task 8: Auto-fix setting + controller

**Files:**
- Modify: `packages/core/src/types.ts` (add `autoFixLiveRuntimeErrors: boolean`)
- Modify: `packages/core/src/store.ts` (CREATE TABLE column, `ensureColumn`, `DEFAULT_SETTINGS`, read map, patch merge, UPSERT)
- Modify: `apps/web/src/lib/api.ts` (add `autoFixLiveRuntimeErrors: boolean` to the Settings type)
- Modify: `apps/web/src/screens/SettingsScreen.tsx` (add the toggle)
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx` (read the flag from `getSettings`; auto-fix effect)
- Modify: `apps/web/src/test/fake-api.ts` (add `autoFixLiveRuntimeErrors: false` to the default `getSettings` return)
- Test: `packages/core/test/store.test.ts` (or the existing settings test file) + `apps/web/src/screens/workspace.test.tsx`

**Interfaces:**
- Consumes: `runtimeErrors.fatal`, `running`, `fixRuntimeErrors` (Task 7); a new `autoFixLive` state read from `api.getSettings()`.
- Produces: settings field round-tripped through the store; an effect that auto-dispatches one repair per distinct fatal signature when enabled + idle.

- [ ] **Step 1: Write the failing store test** — `packages/core/test/store.test.ts` (append; follow the file's existing store-construction helper)

```ts
test("autoFixLiveRuntimeErrors round-trips through settings", () => {
  const store = makeStore(); // existing helper in this test file
  assert.equal(store.getSettings().autoFixLiveRuntimeErrors, false);
  store.patchSettings({ autoFixLiveRuntimeErrors: true });
  assert.equal(store.getSettings().autoFixLiveRuntimeErrors, true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @dezin/core test`
Expected: FAIL — property missing / not persisted.

- [ ] **Step 3: Add the field across core (mirror `visualQaEnabled` exactly)**

- `types.ts`: beside `visualQaEnabled: boolean;` add `autoFixLiveRuntimeErrors: boolean;`
- `store.ts` CREATE TABLE (line ~123, beside `visual_qa_enabled`): add `auto_fix_live_runtime_errors INTEGER NOT NULL DEFAULT 0,`
- `store.ts` `migrate()` (line ~516, beside the `visual_qa_enabled` ensureColumn): add `ensureColumn("settings", "auto_fix_live_runtime_errors", "auto_fix_live_runtime_errors INTEGER NOT NULL DEFAULT 0");`
- `store.ts` `DEFAULT_SETTINGS` (line ~215, beside `visualQaEnabled: false`): add `autoFixLiveRuntimeErrors: false,`
- `store.ts` read map (line ~1331): add `autoFixLiveRuntimeErrors: Number(r.auto_fix_live_runtime_errors ?? 0) === 1,`
- `store.ts` patch merge (line ~1363, beside `visualQaEnabled: patch.visualQaEnabled ?? cur.visualQaEnabled`): add `autoFixLiveRuntimeErrors: patch.autoFixLiveRuntimeErrors ?? cur.autoFixLiveRuntimeErrors,`
- `store.ts` settings UPSERT (line ~1427, beside `next.visualQaEnabled ? 1 : 0`): add `auto_fix_live_runtime_errors` to the column-name list and a matching `?` placeholder in the same ordinal position, and `next.autoFixLiveRuntimeErrors ? 1 : 0,` to the values array at that same position.

- [ ] **Step 4: Run core test, verify pass**

Run: `pnpm --filter @dezin/core test`
Expected: PASS.

- [ ] **Step 5: Add the web Settings field, toggle, fake-api default, and the WorkspaceScreen settings read**

- `apps/web/src/lib/api.ts` (line ~332, beside `visualQaEnabled: boolean;`): add `autoFixLiveRuntimeErrors: boolean;`
- `apps/web/src/screens/SettingsScreen.tsx`: duplicate the `visualQaEnabled` `<Switch>` block (line ~308-312) with a new label ("Auto-fix live preview errors" / "Automatically send a repair run when the live preview crashes") and `checked={settings.autoFixLiveRuntimeErrors}` / `onCheckedChange={(checked) => save("autoFixLiveRuntimeErrors", checked)}`.
- `apps/web/src/test/fake-api.ts`: add `autoFixLiveRuntimeErrors: false,` to the default `getSettings` return (line ~66, beside `autoImproveMaxRounds`) so existing tests keep type-checking.
- `apps/web/src/screens/WorkspaceScreen.tsx`: add `const [autoFixLive, setAutoFixLive] = useState(false);` near the other state (line ~2326), and extend the existing `getSettings` effect (line ~3366) to also set it:

```tsx
      .then((s) => {
        if (!alive) return;
        setSettingsAgent(s?.agentCommand ?? "");
        setSettingsModel(s?.model ?? "");
        setAutoFixLive(!!s?.autoFixLiveRuntimeErrors);
      })
```

- [ ] **Step 6: Add the auto-fix controller test** (append to `workspace.test.tsx`)

```tsx
test("auto-fix dispatches one repair when enabled and a fatal error arrives while idle", async () => {
  const streamRun = vi.fn(() => (async function* (): AsyncGenerator<RunEvent> {})());
  render(
    <AgentsProvider agents={AGENTS}>
      <ApiProvider client={makeFakeApi({ streamRun: streamRun as never, getSettings: async () => ({ agentCommand: "claude", model: "", autoFixLiveRuntimeErrors: true }) as never })}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>
    </AgentsProvider>,
  );
  await screen.findByTitle("Artifact preview");
  dispatchPreviewMessage({ type: "runtime-error", kind: "fatal", errorType: "error", message: "auto boom", count: 1, at: 1 });
  await waitFor(() => expect(streamRun).toHaveBeenCalledTimes(1));
  dispatchPreviewMessage({ type: "runtime-error", kind: "fatal", errorType: "error", message: "auto boom", count: 1, at: 1 }); // same signature must not re-fire
  await new Promise((r) => setTimeout(r, 0));
  expect(streamRun).toHaveBeenCalledTimes(1);
});
```

> The `getSettings` override returns only the fields `WorkspaceScreen` reads (`agentCommand`, `model`, `autoFixLiveRuntimeErrors`); nothing else in the screen consumes settings.

- [ ] **Step 7: Implement the auto-fix effect** in `WorkspaceScreen` (after the hook from Task 7)

```tsx
const autoFixedSigsRef = useRef<Set<string>>(new Set());
useEffect(() => {
  const fatal = runtimeErrors.fatal;
  if (!autoFixLive || !fatal || running) return;
  if (autoFixedSigsRef.current.has(fatal.sig)) return;
  autoFixedSigsRef.current.add(fatal.sig);
  fixRuntimeErrors([fatal]);
}, [runtimeErrors.fatal, autoFixLive, running, fixRuntimeErrors]);
```

- [ ] **Step 8: Run tests, verify pass**

Run: `pnpm --filter @dezin/core test && pnpm --filter ./apps/web test workspace`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/store.ts packages/core/test/store.test.ts apps/web/src/lib/api.ts apps/web/src/screens/SettingsScreen.tsx apps/web/src/screens/WorkspaceScreen.tsx apps/web/src/screens/workspace.test.tsx
git commit -m "feat(preview): global auto-fix toggle for fatal live runtime errors"
```

---

## Final verification

- [ ] Run the full suite: `pnpm test`
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Manual smoke (Prototype): generate/open a prototype, edit its HTML to `throw new Error("x")` at load → crash overlay appears; click **Fix with Agent** → a repair run starts.
- [ ] Manual smoke (Standard): break a component's render → overlay appears after the dev server serves it; non-fatal `console.error` shows the badge, not the overlay.

## Notes for the implementer

- The probe is injected as a plain `<script>`; it never imports from the monorepo (the Standard copy ships inside generated projects). Keep the two copies byte-identical — the Task 1 drift test enforces this.
- The parent trusts the probe's `kind`. Do not try to re-classify in the parent; it cannot read the frame's DOM.
- `previewBridgeOriginForSrc` returns `"null"` for isolated same-origin/prototype frames and the real origin for cross-origin Standard dev servers — the hook's origin check already handles both.
- Generation suppression uses the live `running` flag; the `usePreviewRuntimeErrors` hook reads it through a ref so mid-generation errors never flash an overlay.
