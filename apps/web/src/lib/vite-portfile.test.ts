import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { webPortfilePlugin } from "../../vite-portfile-plugin.ts";

const temporaryDirectories: string[] = [];
const addedExitListeners: Array<(...args: any[]) => void> = [];

class FakeHttpServer extends EventEmitter {
  address() {
    return { address: "::1", family: "IPv6", port: 7001 };
  }
}

function trackNewExitListeners(before: ReadonlySet<(...args: any[]) => void>) {
  for (const listener of process.listeners("exit")) {
    if (!before.has(listener)) addedExitListeners.push(listener);
  }
}

afterEach(() => {
  for (const listener of addedExitListeners.splice(0)) process.removeListener("exit", listener);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("non-listening Vite config consumers never register discovery-file cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-vite-portfile-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "web.json");
  writeFileSync(file, JSON.stringify({ url: "http://localhost:6273", port: 6273 }));
  const before = new Set(process.listeners("exit"));

  webPortfilePlugin({ file, fallbackPort: 6273 }).configureServer({ httpServer: null });
  trackNewExitListeners(before);

  expect(process.listeners("exit")).toEqual([...before]);
  expect(existsSync(file)).toBe(true);
});

test("a Vite server only removes the discovery file it wrote", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-vite-portfile-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "web.json");
  const server = new FakeHttpServer();
  const before = new Set(process.listeners("exit"));
  const plugin = webPortfilePlugin({ file, fallbackPort: 6273 });

  plugin.configureServer({ httpServer: server });
  trackNewExitListeners(before);
  server.emit("listening");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "http://localhost:7001", port: 7001 });

  const replacement = JSON.stringify({ url: "http://localhost:7002", port: 7002 });
  writeFileSync(file, replacement);
  server.emit("close");

  expect(readFileSync(file, "utf8")).toBe(replacement);
  expect(process.listeners("exit")).toEqual([...before]);
});
