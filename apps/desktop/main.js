// Dezin desktop shell (Electron). A thin orchestrator: it spawns the daemon, loads
// the app it serves into a window, and exposes native file access — no engine logic
// lives here. Not packaged/signed; run with `pnpm --filter dezin-desktop start`.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

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

let daemon = null;
let win = null;

function startDaemon() {
  mkdirSync(dirname(PORTFILE), { recursive: true });
  try {
    rmSync(PORTFILE, { force: true });
  } catch {
    /* ignore */
  }
  daemon = spawn("node", ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "src/start.ts"], {
    cwd: join(ROOT, "apps", "daemon"),
    // Fixed default port so the browser extension can reach the daemon at a known address
    // (127.0.0.1:7457); still overridable via env. The portfile records whatever it binds.
    env: { ...process.env, DEZIN_PORT: process.env.DEZIN_PORT || "7457", DEZIN_PORTFILE: PORTFILE, DEZIN_DATA_DIR: DATA_DIR, DEZIN_ELECTRON: "1" },
    // IPC channel lets the daemon ask us to capture covers via our own Chromium.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  daemon.stdout.on("data", (d) => process.stdout.write(`[daemon] ${d}`));
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  daemon.on("error", (e) => console.error("[daemon] failed to spawn:", e.message));
  daemon.on("message", (msg) => {
    if (msg && msg.type === "capture") {
      captureCover(msg.htmlPath, msg.outPath).then((ok) => {
        try {
          daemon.send({ type: "capture-result", id: msg.id, ok });
        } catch {
          /* daemon gone */
        }
      });
    }
  });
}

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

async function waitForDaemon(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(PORTFILE)) {
      try {
        return JSON.parse(readFileSync(PORTFILE, "utf8")).url;
      } catch {
        /* not written fully yet */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
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
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 920,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
    },
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
    startDaemon();
    url = await waitForDaemon();
  }
  if (!url) {
    dialog.showErrorBox("Dezin", "The Dezin daemon didn't start. Make sure `node` (v22+) is on your PATH.");
    app.quit();
    return;
  }

  win.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: "deny" };
  });
  win.once("ready-to-show", () => win.show());
  await win.loadURL(url);
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

ipcMain.handle("dezin:pickFiles", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("dezin:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? [] : r.filePaths;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (daemon) {
    try {
      daemon.kill();
    } catch {
      /* ignore */
    }
  }
});
