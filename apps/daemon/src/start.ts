/**
 * Daemon entrypoint. Portless by default: with DEZIN_PORT unset it binds an
 * ephemeral port and writes a discovery file (DEZIN_PORTFILE, default
 * <dataDir>/daemon.json) that the web dev server reads for its proxy target.
 *
 *   node --experimental-strip-types --experimental-sqlite src/start.ts
 */

import { dirname, join } from "node:path";
import { closeSync, mkdirSync, openSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { DesignRegistry, BUNDLED_DESIGN_SYSTEMS, loadDesignSystems, userDesignDir } from "../../../packages/design/src/index.ts";
import { stopAllDevServers } from "./project-runtime.ts";
import { closeAllSharinganSessions } from "./sharingan-handler.ts";
import { createApp } from "./app.ts";

const HOST = process.env.DEZIN_HOST ?? "127.0.0.1";
// 0 = ephemeral (portless). Set DEZIN_PORT to pin a fixed port.
const PORT = process.env.DEZIN_PORT !== undefined ? Number(process.env.DEZIN_PORT) : 0;
const DATA_DIR = process.env.DEZIN_DATA_DIR ?? join(homedir(), ".dezin");
const PORT_FILE = process.env.DEZIN_PORTFILE ?? join(DATA_DIR, "daemon.json");
const LOCK_FILE = process.env.DEZIN_LOCKFILE ?? join(DATA_DIR, "daemon.lock");
const DAEMON_TOKEN = process.env.DEZIN_DAEMON_TOKEN?.trim() || randomBytes(32).toString("base64url");
const DAEMON_OWNER_ID = process.env.DEZIN_DAEMON_OWNER_ID?.trim() || `${process.pid}-${randomBytes(8).toString("hex")}`;
// Single source of truth: the repo's package.json version, so About always matches it.
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string) || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockOwnerPid(): number | null {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function acquireDaemonLock(): () => void {
  mkdirSync(DATA_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, ownerId: DAEMON_OWNER_ID, createdAt: Date.now() })}\n`, "utf8");
      closeSync(fd);
      return () => rmSync(LOCK_FILE, { force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      const pid = lockOwnerPid();
      if (pidIsAlive(pid ?? -1)) {
        throw new Error(`another Dezin daemon is already using ${DATA_DIR} (pid ${pid})`);
      }
      rmSync(LOCK_FILE, { force: true });
    }
  }
  throw new Error(`could not acquire Dezin daemon lock at ${LOCK_FILE}`);
}

function main(): void {
  const releaseLock = acquireDaemonLock();
  mkdirSync(join(DATA_DIR, "projects"), { recursive: true });
  const store = new Store(join(DATA_DIR, "app.sqlite"));
  // A prior process died mid-run → sweep those to cancelled AND leave a terminal message: finished
  // runs are no longer reattached/replayed on re-entry (that double-rendered them), so an interrupted
  // run needs a persisted terminal or its last turn looks unanswered.
  for (const r of store.markInterruptedRuns()) {
    store.addMessage(r.conversationId, "system", JSON.stringify({ result: { text: "Stopped — the app restarted before this run finished.", meta: {} } }));
  }
  if (process.env.DEZIN_AGENT_CMD) store.updateSettings({ agentCommand: process.env.DEZIN_AGENT_CMD });
  // One shared registry: bundled systems + any the user has imported (persisted to disk).
  const designRegistry = new DesignRegistry([...BUNDLED_DESIGN_SYSTEMS, ...loadDesignSystems(userDesignDir(DATA_DIR))]);
  const server = createApp({
    store,
    dataDir: DATA_DIR,
    version: VERSION,
    designRegistry,
    security: { token: DAEMON_TOKEN },
    daemonOwnerId: DAEMON_OWNER_ID,
  });
  server.on("error", (err) => {
    try {
      releaseLock();
      store.close();
    } finally {
      throw err;
    }
  });

  server.listen(PORT, HOST, () => {
    const { port } = server.address() as AddressInfo;
    const url = `http://${HOST}:${port}`;
    try {
      mkdirSync(dirname(PORT_FILE), { recursive: true });
      writeFileSync(PORT_FILE, `${JSON.stringify({ url, host: HOST, port, pid: process.pid, ownerId: DAEMON_OWNER_ID, token: DAEMON_TOKEN })}\n`, "utf8");
    } catch {
      // discovery file is best-effort
    }
    console.log(`Dezin daemon listening on ${url}  (data: ${DATA_DIR})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} — shutting down`);
    try {
      rmSync(PORT_FILE, { force: true });
      releaseLock();
      stopAllDevServers();
    } catch {
      // ignore
    }
    // Close any live Sharingan sessions (entry capture + probe) before exiting, so a
    // shutdown/crash can't orphan a headful Chrome holding the persistent-profile lock
    // (which would block the next clone). Best-effort: closeAllSharinganSessions never
    // throws, but guard anyway so a shutdown signal always reaches process.exit.
    closeAllSharinganSessions()
      .catch(() => {})
      .then(() => {
        server.close(() => {
          store.close();
          process.exit(0);
        });
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
