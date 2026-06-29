/**
 * Daemon entrypoint. Portless by default: with DEZIN_PORT unset it binds an
 * ephemeral port and writes a discovery file (DEZIN_PORTFILE, default
 * <dataDir>/daemon.json) that the web dev server reads for its proxy target.
 *
 *   node --experimental-strip-types --experimental-sqlite src/start.ts
 */

import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { DesignRegistry, BUNDLED_DESIGN_SYSTEMS, loadDesignSystems, userDesignDir } from "../../../packages/design/src/index.ts";
import { stopAllDevServers } from "./project-runtime.ts";
import { createApp } from "./app.ts";

const HOST = process.env.DEZIN_HOST ?? "127.0.0.1";
// 0 = ephemeral (portless). Set DEZIN_PORT to pin a fixed port.
const PORT = process.env.DEZIN_PORT !== undefined ? Number(process.env.DEZIN_PORT) : 0;
const DATA_DIR = process.env.DEZIN_DATA_DIR ?? join(homedir(), ".dezin");
const PORT_FILE = process.env.DEZIN_PORTFILE ?? join(DATA_DIR, "daemon.json");
// Single source of truth: the repo's package.json version, so About always matches it.
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string) || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function main(): void {
  mkdirSync(join(DATA_DIR, "projects"), { recursive: true });
  const store = new Store(join(DATA_DIR, "app.sqlite"));
  store.markInterruptedRuns(); // a prior process died mid-run → don't show those as running
  if (process.env.DEZIN_AGENT_CMD) store.updateSettings({ agentCommand: process.env.DEZIN_AGENT_CMD });
  // One shared registry: bundled systems + any the user has imported (persisted to disk).
  const designRegistry = new DesignRegistry([...BUNDLED_DESIGN_SYSTEMS, ...loadDesignSystems(userDesignDir(DATA_DIR))]);
  const server = createApp({ store, dataDir: DATA_DIR, version: VERSION, designRegistry });

  server.listen(PORT, HOST, () => {
    const { port } = server.address() as AddressInfo;
    const url = `http://${HOST}:${port}`;
    try {
      mkdirSync(dirname(PORT_FILE), { recursive: true });
      writeFileSync(PORT_FILE, `${JSON.stringify({ url, host: HOST, port, pid: process.pid })}\n`, "utf8");
    } catch {
      // discovery file is best-effort
    }
    console.log(`Dezin daemon listening on ${url}  (data: ${DATA_DIR})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} — shutting down`);
    try {
      rmSync(PORT_FILE, { force: true });
      stopAllDevServers();
    } catch {
      // ignore
    }
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
