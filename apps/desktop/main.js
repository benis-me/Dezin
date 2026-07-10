// Dezin desktop shell (Electron). A thin orchestrator: it spawns the daemon, loads
// the app it serves into a window, and exposes native file access — no engine logic
// lives here. Not packaged/signed; run with `pnpm --filter dezin-desktop start`.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { createDaemonSupervisor, loadUrlWithRetry } = require("./daemon-supervisor.js");
const { createDialogPathState } = require("./dialog-path-state.js");
const { isAllowedAppNavigation, isSafeExternalUrl } = require("./navigation-policy.js");
const { handleTaskkillResult } = require("./process-group.js");
const { readWindowState, writeWindowState } = require("./window-state.js");

const ROOT = join(__dirname, "..", "..");
const DATA_DIR = process.env.DEZIN_DATA_DIR || join(ROOT, ".dezin", "data");
const PORTFILE = join(ROOT, ".dezin", "desktop-daemon.json");
const WEB_PORTFILE = join(ROOT, ".dezin", "web.json");
// Dev mode loads the Vite dev server instead of spawning the bundled daemon.
// DEZIN_DEV_URL pins an explicit URL; DEZIN_DEV=1 discovers Vite's actual port
// from .dezin/web.json (Vite auto-falls-back if its preferred port is taken).
// Either way assumes `pnpm dev` is running.
const DEV_URL = process.env.DEZIN_DEV_URL || "";
const DEV = process.env.DEZIN_DEV === "1";

let win = null;
let quitting = false;
let persistedDialogPathState = null;

function openSafeExternal(url) {
  if (!isSafeExternalUrl(url)) return;
  try {
    const opened = shell.openExternal(url);
    if (opened && typeof opened.catch === "function") {
      opened.catch((e) => console.error("[desktop] failed to open external URL:", e && e.message));
    }
  } catch (e) {
    console.error("[desktop] failed to open external URL:", e && e.message);
  }
}

function spawnDaemon({ ownerId }) {
  mkdirSync(dirname(PORTFILE), { recursive: true });
  try {
    rmSync(PORTFILE, { force: true });
  } catch {
    /* ignore */
  }
  const child = spawn("node", ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "src/start.ts"], {
    cwd: join(ROOT, "apps", "daemon"),
    detached: true,
    windowsHide: true,
    // Fixed default port so the browser extension can reach the daemon at a known address
    // (127.0.0.1:7457); still overridable via env. The portfile records whatever it binds.
    env: {
      ...process.env,
      DEZIN_PORT: process.env.DEZIN_PORT || "7457",
      DEZIN_PORTFILE: PORTFILE,
      DEZIN_DATA_DIR: DATA_DIR,
      DEZIN_ELECTRON: "1",
      DEZIN_DAEMON_OWNER_ID: ownerId,
    },
    // IPC channel lets the daemon ask us to capture covers via our own Chromium.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[daemon] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  child.on("error", (e) => console.error("[daemon] failed to spawn:", e.message));
  child.on("message", (msg) => {
    if (msg && msg.type === "capture") {
      captureCover(msg.htmlPath, msg.outPath).then((ok) => {
        try {
          child.send({ type: "capture-result", id: msg.id, ok });
        } catch {
          /* daemon gone */
        }
      });
    }
  });
  return child;
}

function readDaemonPortFile() {
  if (!existsSync(PORTFILE)) return null;
  try {
    return JSON.parse(readFileSync(PORTFILE, "utf8"));
  } catch {
    return null;
  }
}

function schedule(callback, delay) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

function killProcessGroup(pid, child) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    handleTaskkillResult({ result, child, logError: (message) => console.error(message) });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!error || error.code !== "ESRCH") {
      console.error("[daemon] failed to stop process group:", error && error.message);
    }
  }
}

function getDialogPathState() {
  if (!persistedDialogPathState) {
    persistedDialogPathState = createDialogPathState({
      stateFile: join(app.getPath("userData"), "dialog-path.json"),
      fallbackPath: app.getPath("documents"),
    });
  }
  return persistedDialogPathState;
}

const daemonSupervisor = createDaemonSupervisor({
  spawnDaemon,
  readPortFile: readDaemonPortFile,
  now: Date.now,
  schedule,
  killProcessGroup,
});

// Render a self-contained HTML into a 1280×800 PNG using a hidden Chromium window —
// no external Chrome, no puppeteer. paintWhenInitiallyHidden makes the offscreen
// surface paint so capturePage returns real pixels.
async function captureCover(htmlPath, outPath) {
  if (!existsSync(htmlPath)) return false;
  let view = null;
  try {
    view = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: { sandbox: true, paintWhenInitiallyHidden: true, backgroundThrottling: false, offscreen: false },
    });
    await view.loadFile(htmlPath);
    await new Promise((r) => setTimeout(r, 500)); // fonts + first paint
    const image = await view.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 800 });
    const png = image.toPNG();
    if (!png || png.length < 256) return false;
    writeFileSync(outPath, png);
    return true;
  } catch (e) {
    console.error("[capture] failed:", e && e.message);
    return false;
  } finally {
    try {
      view && view.destroy();
    } catch {
      /* ignore */
    }
  }
}

// Dev: poll for the Vite portfile (.dezin/web.json), written by webPortfilePlugin
// with whatever port Vite actually bound — so a port-conflict fallback stays in sync.
async function waitForWebUrl(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(WEB_PORTFILE)) {
      try {
        return JSON.parse(readFileSync(WEB_PORTFILE, "utf8")).url;
      } catch {
        /* not written fully yet */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function createWindow() {
  const windowStateFile = join(app.getPath("userData"), "window-state.json");
  const windowState = readWindowState(windowStateFile);
  const window = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: 920,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win = window;
  let saveWindowStateTimer = null;
  const saveWindowState = () => {
    if (window.isDestroyed() || window.isMinimized()) return;
    writeWindowState(windowStateFile, window.getBounds());
  };
  const scheduleSaveWindowState = () => {
    if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
    saveWindowStateTimer = setTimeout(() => {
      saveWindowStateTimer = null;
      saveWindowState();
    }, 200);
  };
  window.on("resize", scheduleSaveWindowState);
  window.on("close", () => {
    if (saveWindowStateTimer) {
      clearTimeout(saveWindowStateTimer);
      saveWindowStateTimer = null;
    }
    saveWindowState();
  });
  window.on("closed", () => {
    if (win === window) win = null;
  });

  let url = DEV_URL;
  if (!url && DEV) {
    url = await waitForWebUrl();
    if (!url) {
      dialog.showErrorBox("Dezin", "Couldn't find the Vite dev server — run `pnpm dev` first.");
      app.quit();
      return;
    }
  }
  if (!url) {
    try {
      url = await daemonSupervisor.ensureStarted();
    } catch (error) {
      console.error("[daemon] failed to become ready:", error && error.message);
    }
  }
  if (!url) {
    dialog.showErrorBox("Dezin", "The Dezin daemon didn't start. Make sure `node` (v22+) is on your PATH.");
    app.quit();
    return;
  }
  if (window.isDestroyed()) return;

  window.webContents.setWindowOpenHandler(({ url: u }) => {
    openSafeExternal(u);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (isAllowedAppNavigation(targetUrl, url)) return;
    event.preventDefault();
    openSafeExternal(targetUrl);
  });
  window.once("ready-to-show", () => window.show());
  try {
    await loadUrlWithRetry(() => window.loadURL(url), { shouldRetry: () => !window.isDestroyed() });
  } catch (error) {
    if (quitting || window.isDestroyed()) return;
    throw error;
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function launchWindow() {
  void createWindow().catch((error) => {
    console.error("[desktop] failed to load app window:", error && error.message);
    if (!quitting) {
      dialog.showErrorBox("Dezin", "The Dezin app window failed to load.");
      app.quit();
    }
  });
}

ipcMain.handle("dezin:pickFiles", async () => {
  const dialogPathState = getDialogPathState();
  const r = await dialog.showOpenDialog(win, {
    defaultPath: dialogPathState.defaultPath(),
    properties: ["openFile", "multiSelections"],
  });
  dialogPathState.rememberSelection(r, { directory: false });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("dezin:pickFolder", async () => {
  const dialogPathState = getDialogPathState();
  const r = await dialog.showOpenDialog(win, {
    defaultPath: dialogPathState.defaultPath(),
    properties: ["openDirectory"],
  });
  dialogPathState.rememberSelection(r, { directory: true });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("dezin:openPath", async (_event, pathToOpen) => {
  if (typeof pathToOpen !== "string" || !pathToOpen.trim() || !existsSync(pathToOpen)) return false;
  try {
    const error = await shell.openPath(pathToOpen.trim());
    if (error) {
      console.error("[desktop] failed to open path:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[desktop] failed to open path:", e && e.message);
    return false;
  }
});

app.whenReady().then(() => {
  buildMenu();
  launchWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) launchWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  void daemonSupervisor.stop();
});
