/**
 * In-process broker for live runs. A run's events are buffered + emitted (so multiple clients
 * can attach/reattach) and appended to a per-run JSONL log under <dataDir>/.runs/<id>.jsonl, so
 * a client that navigated away — or reconnects after an app restart — can replay what the run
 * reached. The run itself executes in the daemon and continues regardless of any one client's
 * connection; the only ways to stop it are an explicit cancel or the daemon exiting.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeSupervisor } from "./runtime-supervisor.ts";

interface RunEntry {
  runId: string;
  conversationId: string;
  logPath: string;
  buffer: unknown[];
  nextSeq: number;
  emitter: EventEmitter;
  ctrl: AbortController;
  writeQueue: Promise<void>;
  settled: Promise<void>;
  resolveSettled: () => void;
  finishPromise?: Promise<void>;
  done: boolean;
}

const runs = new Map<string, RunEntry>();

export function runLogPath(dataDir: string, runId: string): string {
  return join(dataDir, ".runs", `${runId}.jsonl`);
}

/** Register a starting run + its abort controller. Call before emitting any events. */
export function createRun(meta: {
  runId: string;
  conversationId: string;
  dataDir: string;
  projectId?: string;
  variantId?: string;
  runtimeSupervisor?: RuntimeSupervisor;
}): AbortController {
  const logPath = runLogPath(meta.dataDir, meta.runId);
  try {
    mkdirSync(join(meta.dataDir, ".runs"), { recursive: true });
  } catch {
    /* best-effort */
  }
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const entry: RunEntry = {
    runId: meta.runId,
    conversationId: meta.conversationId,
    logPath,
    buffer: [],
    nextSeq: 1,
    emitter,
    ctrl: new AbortController(),
    writeQueue: Promise.resolve(),
    settled,
    resolveSettled,
    done: false,
  };
  runs.set(meta.runId, entry);
  if (meta.runtimeSupervisor && meta.projectId) {
    try {
      meta.runtimeSupervisor.registerRun({
        projectId: meta.projectId,
        ...(meta.variantId ? { variantId: meta.variantId } : {}),
        runId: meta.runId,
        controller: entry.ctrl,
        settled,
      });
    } catch (error) {
      runs.delete(meta.runId);
      resolveSettled();
      throw error;
    }
  }
  return entry.ctrl;
}

function eventSeq(ev: unknown): number | null {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  const seq = (ev as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

function withSeq(ev: unknown, seq: number): unknown {
  if (ev && typeof ev === "object" && !Array.isArray(ev)) return { ...ev, seq };
  return { type: "event", value: ev, seq };
}

/** Buffer + persist + broadcast one event. */
export function pushEvent(runId: string, ev: unknown): void {
  const e = runs.get(runId);
  if (!e || e.done) return;
  const event = withSeq(ev, e.nextSeq++);
  e.buffer.push(event);
  let line = "";
  try {
    line = `${JSON.stringify(event)}\n`;
  } catch {
    line = "";
  }
  if (line) e.writeQueue = e.writeQueue.catch(() => {}).then(() => appendFile(e.logPath, line)).catch(() => {});
  e.emitter.emit("event", event);
}

/** Mark the run finished; late subscribers fall back to the persisted log. */
export function finishRun(runId: string): Promise<void> {
  const e = runs.get(runId);
  if (!e) return Promise.resolve();
  e.done = true;
  e.finishPromise ??= e.writeQueue
    .catch(() => {})
    .then(() => {
      if (runs.get(runId) !== e) return;
      try {
        e.emitter.emit("done");
      } finally {
        if (runs.get(runId) === e) runs.delete(runId);
      }
    })
    .catch(() => {})
    .finally(e.resolveSettled);
  return e.finishPromise;
}

export function cancelRun(runId: string): boolean {
  const e = runs.get(runId);
  if (!e) return false;
  e.ctrl.abort();
  return true;
}

/**
 * Attach to a run: replays everything buffered so far, then streams live events until done.
 * If the run isn't in memory (already finished, or the daemon restarted), replays the
 * persisted log instead and ends — so a reconnecting client still sees the reached state.
 */
function shouldReplay(ev: unknown, afterSeq: number, seen: Set<number>): boolean {
  const seq = eventSeq(ev);
  if (seq === null) return afterSeq <= 0;
  if (seq <= afterSeq || seen.has(seq)) return false;
  seen.add(seq);
  return true;
}

export function subscribe(
  runId: string,
  dataDir: string,
  onEvent: (ev: unknown) => void,
  onEnd: () => void,
  options: { afterSeq?: number } = {},
): () => void {
  const afterSeq = typeof options.afterSeq === "number" && Number.isFinite(options.afterSeq) ? options.afterSeq : 0;
  const seen = new Set<number>();
  const e = runs.get(runId);
  if (!e) {
    for (const ev of readRunLog(runLogPath(dataDir, runId))) {
      if (shouldReplay(ev, afterSeq, seen)) onEvent(ev);
    }
    onEnd();
    return () => {};
  }
  let ended = false;
  const onEv = (ev: unknown): void => {
    if (shouldReplay(ev, afterSeq, seen)) onEvent(ev);
  };
  const onDone = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  try {
    if (!e.done) {
      e.emitter.on("event", onEv);
      e.emitter.once("done", onDone);
    }
    for (const ev of e.buffer.slice()) onEv(ev);
    if (e.done) onDone();
  } catch (err) {
    e.emitter.off("event", onEv);
    e.emitter.off("done", onDone);
    throw err;
  }
  return () => {
    e.emitter.off("event", onEv);
    e.emitter.off("done", onDone);
  };
}

export function readRunLog(logPath: string): unknown[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    })
    .filter((x): x is unknown => x !== null);
}
