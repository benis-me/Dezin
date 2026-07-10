const test = require("node:test");
const assert = require("node:assert/strict");

let createCoverCaptureController;
try {
  ({ createCoverCaptureController } = require("../cover-capture.js"));
} catch {
  // The contract assertion below provides a useful RED failure before the module exists.
}

class FakeBrowserWindow {
  static instances = [];

  constructor() {
    this.destroyCalls = 0;
    this.destroyed = false;
    this.loadPending = null;
    this.capturePending = null;
    this.webContents = {
      capturePage: () => new Promise((resolve, reject) => {
        this.capturePending = { resolve, reject };
      }),
    };
    FakeBrowserWindow.instances.push(this);
  }

  loadFile() {
    return new Promise((resolve, reject) => {
      this.loadPending = { resolve, reject };
    });
  }

  finishLoad() {
    this.loadPending?.resolve();
    this.loadPending = null;
  }

  finishCapture(png = Buffer.alloc(300, 1)) {
    this.capturePending?.resolve({ toPNG: () => png });
    this.capturePending = null;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.loadPending?.reject(new Error("window destroyed"));
    this.capturePending?.reject(new Error("window destroyed"));
    this.loadPending = null;
    this.capturePending = null;
  }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  assert.fail("condition did not become true");
}

function controllerHarness() {
  assert.equal(typeof createCoverCaptureController, "function", "desktop cover capture needs an injectable no-GUI controller");
  FakeBrowserWindow.instances = [];
  const writes = [];
  const controller = createCoverCaptureController({
    BrowserWindow: FakeBrowserWindow,
    existsSync: () => true,
    writeFileSync: (outPath, png) => writes.push({ outPath, length: png.length }),
    wait: async () => {},
    logError: () => {},
  });
  return { controller, writes };
}

test("desktop cancellation destroys only the exact id's capture window and cleans each task once", async () => {
  const { controller, writes } = controllerHarness();
  if (!controller) return;

  const first = controller.capture(101, "first.html", "first.png");
  const second = controller.capture(202, "second.html", "second.png");
  assert.equal(FakeBrowserWindow.instances.length, 2);
  const [firstWindow, secondWindow] = FakeBrowserWindow.instances;

  assert.equal(controller.cancel(101), true);
  assert.equal(await first, false);
  assert.equal(firstWindow.destroyCalls, 1, "cancel + capture finally share exactly-once cleanup");
  assert.equal(secondWindow.destroyCalls, 0, "another id's window remains alive");

  secondWindow.finishLoad();
  await waitFor(() => Boolean(secondWindow.capturePending));
  secondWindow.finishCapture();
  assert.equal(await second, true);
  assert.deepEqual(writes, [{ outPath: "second.png", length: 300 }]);
  assert.equal(secondWindow.destroyCalls, 1, "successful capture also cleans its window exactly once");
  assert.equal(controller.cancel(101), false, "a completed id is no longer tracked");
  assert.equal(firstWindow.destroyCalls, 1);
});

test("desktop cancellation after capturePage resolves still prevents the PNG write", async () => {
  const { controller, writes } = controllerHarness();
  if (!controller) return;

  const capture = controller.capture(303, "third.html", "third.png");
  const [window] = FakeBrowserWindow.instances;
  window.finishLoad();
  await waitFor(() => Boolean(window.capturePending));

  window.finishCapture();
  assert.equal(controller.cancel(303), true, "cancel wins before the capture continuation writes");
  assert.equal(await capture, false);
  assert.deepEqual(writes, []);
  assert.equal(window.destroyCalls, 1);
});
