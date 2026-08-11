import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const requireFromWeb = createRequire(resolve(REPO_ROOT, "apps/web/package.json"));
const XYFLOW_ROOT = dirname(requireFromWeb.resolve("@xyflow/react/package.json"));

function extractUseResizeObserver(source) {
  const start = source.indexOf("function useResizeObserver() {");
  assert.notEqual(start, -1, "installed @xyflow/react must contain useResizeObserver");
  const endMarker = "\n}\n\n/**\n * Hook to handle the resize observation";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, "installed @xyflow/react useResizeObserver boundary changed");
  return source.slice(start, end + 2);
}

function exerciseInstalledObserver(functionSource, label) {
  let cleanup = null;
  let nextFrameId = 1;
  const frames = new Map();
  const cancelledFrames = [];
  const updates = [];

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
    }

    emit(entries) {
      this.callback(entries);
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const context = {
    ResizeObserver: FakeResizeObserver,
    selector$b: () => undefined,
    useStore: () => (value) => updates.push(value),
    useRef: (initial) => ({ current: initial }),
    useState: (initialize) => [initialize()],
    useEffect: (effect) => {
      cleanup = effect();
    },
    requestAnimationFrame: (callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      cancelledFrames.push(id);
      frames.delete(id);
    },
  };
  vm.runInNewContext(`${functionSource}\nglobalThis.__useResizeObserver = useResizeObserver;`, context, {
    filename: label,
  });
  const observer = context.__useResizeObserver();
  assert.ok(observer instanceof FakeResizeObserver);
  assert.equal(typeof cleanup, "function");

  const entry = (id, generation) => ({
    target: {
      generation,
      getAttribute: (name) => name === "data-id" ? id : null,
    },
  });
  const firstA = entry("node-a", 1);
  const firstB = entry("node-b", 1);
  const latestA = entry("node-a", 2);
  const firstC = entry("node-c", 1);
  observer.emit([firstA, firstB]);
  observer.emit([latestA, firstC]);

  assert.equal(updates.length, 0, `${label} must not update node internals inside ResizeObserver delivery`);
  assert.equal(frames.size, 1, `${label} must coalesce native callbacks into one animation frame`);
  const [[frameId, frame]] = frames;
  frames.delete(frameId);
  frame(16);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].size, 3);
  assert.equal(updates[0].get("node-a").nodeElement, latestA.target, "latest entry for one node must win");
  assert.equal(updates[0].get("node-b").nodeElement, firstB.target);
  assert.equal(updates[0].get("node-c").nodeElement, firstC.target);

  const pendingAfterFrame = entry("node-a", 3);
  observer.emit([pendingAfterFrame]);
  assert.equal(frames.size, 1);
  const [[pendingFrameId, pendingFrame]] = frames;
  cleanup();

  assert.equal(observer.disconnected, true);
  assert.deepEqual(cancelledFrames, [pendingFrameId]);
  assert.equal(frames.size, 0);
  pendingFrame(32);
  assert.equal(updates.length, 1, `${label} cleanup must clear pending node measurements`);
}

test("the installed @xyflow/react node ResizeObserver defers, coalesces, and cancels pending measurements", async () => {
  for (const fileName of ["index.js", "index.mjs"]) {
    const source = await readFile(resolve(XYFLOW_ROOT, "dist/esm", fileName), "utf8");
    exerciseInstalledObserver(extractUseResizeObserver(source), fileName);
  }

  const workspace = await readFile(resolve(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /patchedDependencies:\n\s+'@xyflow\/react@12\.11\.2':\s+patches\/@xyflow__react@12\.11\.2\.patch/);
  const lockfile = await readFile(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
  const lockPatch = lockfile.match(/patchedDependencies:\n\s+'@xyflow\/react@12\.11\.2':\s+([a-f0-9]+)/);
  assert.ok(lockPatch, "lockfile must record the @xyflow/react patch hash");
  assert.match(
    lockfile,
    new RegExp(`version: 12\\.11\\.2\\(patch_hash=${lockPatch[1]}\\)`),
    "the web importer must resolve @xyflow/react through the recorded patch",
  );
});
