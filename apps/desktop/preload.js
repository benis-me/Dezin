// Exposes a minimal, safe native bridge to the web app. The renderer checks
// `window.dezin?.isElectron` to light up native file access.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dezin", {
  isElectron: true,
  platform: process.platform,
  /** Native file picker → absolute paths (the local agent reads them directly). */
  pickFiles: () => ipcRenderer.invoke("dezin:pickFiles"),
  /** Native folder picker → absolute path(s). */
  pickFolder: () => ipcRenderer.invoke("dezin:pickFolder"),
});
