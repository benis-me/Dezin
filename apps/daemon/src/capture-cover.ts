import { existsSync } from "node:fs";

const CHROME_PATHS = [
  process.env.DEZIN_CHROME ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

export function findChrome(): string | null {
  return CHROME_PATHS.find((path) => path && existsSync(path)) ?? null;
}
