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
import { createApp, createRuntimeSupervisor } from "./app.ts";
import { startDaemonAfterGenerationRecovery } from "./daemon-startup.ts";
import { shutdownDaemon } from "./daemon-shutdown.ts";
import { createProductionGenerationRecoveryBarrier } from "./orchestration/generation-runtime-composition.ts";
import { cleanupPrototypeVersionSnapshotResidue } from "./prototype-version-snapshot.ts";
import { projectDir } from "./serve-static.ts";

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

async function main(): Promise<void> {
  const releaseDaemonLock = acquireDaemonLock();
  let lockReleased = false;
  const releaseLock = (): void => {
    if (lockReleased) return;
    lockReleased = true;
    releaseDaemonLock();
  };
  cleanupPrototypeVersionSnapshotResidue(DATA_DIR);
  mkdirSync(join(DATA_DIR, "projects"), { recursive: true });
  const store = new Store(join(DATA_DIR, "app.sqlite"));
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };
  // A prior process died mid-run → sweep those to cancelled AND leave a terminal message: finished
  // runs are no longer reattached/replayed on re-entry (that double-rendered them), so an interrupted
  // run needs a persisted terminal or its last turn looks unanswered.
  for (const r of store.markInterruptedRuns()) {
    store.addMessage(r.conversationId, "system", JSON.stringify({ result: { text: "Stopped — the app restarted before this run finished.", meta: {} } }));
  }
  if (process.env.DEZIN_AGENT_CMD) store.updateSettings({ agentCommand: process.env.DEZIN_AGENT_CMD });
  // One shared registry: bundled systems + any the user has imported (persisted to disk).
  const designRegistry = new DesignRegistry([...BUNDLED_DESIGN_SYSTEMS, ...loadDesignSystems(userDesignDir(DATA_DIR))]);
  const generationRecovery = createProductionGenerationRecoveryBarrier({
    workspaceStore: store.workspace,
    dataDir: DATA_DIR,
    repositoryDirForWorkspace(workspaceId) {
      for (const project of store.listProjects()) {
        if (store.workspace.getWorkspace(project.id)?.id === workspaceId) {
          return projectDir(DATA_DIR, project.id);
        }
      }
      throw new Error(`Generation Workspace has no owning Project: ${workspaceId}`);
    },
    onError(event) {
      console.warn(`Generation recovery ${event.operation} failed`, event.error);
    },
  });
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir: DATA_DIR });
  const server = createApp({
    store,
    dataDir: DATA_DIR,
    version: VERSION,
    designRegistry,
    security: { token: DAEMON_TOKEN },
    daemonOwnerId: DAEMON_OWNER_ID,
    runtimeSupervisor,
  });

  let shuttingDown = false;
  const startupController = new AbortController();
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    startupController.abort(new Error(`${signal} during daemon startup`));
    console.log(`\n${signal} — shutting down`);
    try {
      rmSync(PORT_FILE, { force: true });
    } catch {
      // ignore
    }
    void shutdownDaemon({
      server,
      generationRuntime: generationRecovery,
      runtimeSupervisor,
      closeStore,
    }).catch(() => false).finally(() => {
      releaseLock();
      process.exit(exitCode);
    });
  };
  server.on("error", (error) => {
    console.error("Dezin daemon server error", error);
    shutdown("server error", 1);
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  let startupRolledBack = false;
  const rollbackStartup = async (): Promise<void> => {
    if (startupRolledBack) return;
    startupRolledBack = true;
    try {
      await runtimeSupervisor.shutdown(Date.now() + 5_000);
    } finally {
      try {
        closeStore();
      } finally {
        releaseLock();
      }
    }
  };

  try {
    await startDaemonAfterGenerationRecovery({
      generationRecovery,
      signal: startupController.signal,
      listen: () => server.listen(PORT, HOST, () => {
        const { port } = server.address() as AddressInfo;
        const url = `http://${HOST}:${port}`;
        try {
          mkdirSync(dirname(PORT_FILE), { recursive: true });
          writeFileSync(PORT_FILE, `${JSON.stringify({ url, host: HOST, port, pid: process.pid, ownerId: DAEMON_OWNER_ID, token: DAEMON_TOKEN })}\n`, "utf8");
        } catch {
          // discovery file is best-effort
        }
        console.log(`Dezin daemon listening on ${url}  (data: ${DATA_DIR})`);
      }),
      rollback: rollbackStartup,
    });
  } catch (error) {
    await generationRecovery.stop();
    await rollbackStartup();
    if (shuttingDown) return;
    throw error;
  }
}

void main().catch((error) => {
  console.error("Dezin daemon failed to start", error);
  process.exitCode = 1;
});
