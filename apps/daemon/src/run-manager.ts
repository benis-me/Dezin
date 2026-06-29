/**
 * In-process broker for live runs. A run's events are buffered + emitted (so multiple clients
 * can attach/reattach) and appended to a per-run JSONL log under <dataDir>/.runs/<id>.jsonl, so
 * a client that navigated away — or reconnects after an app restart — can replay what the run
 * reached. The run itself executes in the daemon and continues regardless of any one client's
 * connection; the only ways to stop it are an explicit cancel or the daemon exiting.
 */

import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface RunEntry {
  runId: string;
  conversationId: string;
  logPath: string;
  buffer: unknown[];
  emitter: EventEmitter;
  ctrl: AbortController;
  done: boolean;
}

const runs = new Map<string, RunEntry>();
const activeByConversation = new Map<string, string>();

export function runLogPath(dataDir: string, runId: string): string {
  return join(dataDir, ".runs", `${runId}.jsonl`);
}

/** Register a starting run + its abort controller. Call before emitting any events. */
export function createRun(meta: { runId: string; conversationId: string; dataDir: string }): AbortController {
  const logPath = runLogPath(meta.dataDir, meta.runId);
  try {
    mkdirSync(join(meta.dataDir, ".runs"), { recursive: true });
  } catch {
    /* best-effort */
  }
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);
  const entry: RunEntry = { runId: meta.runId, conversationId: meta.conversationId, logPath, buffer: [], emitter, ctrl: new AbortController(), done: false };
  runs.set(meta.runId, entry);
  activeByConversation.set(meta.conversationId, meta.runId);
  return entry.ctrl;
}

/** Buffer + persist + broadcast one event. */
export function pushEvent(runId: string, ev: unknown): void {
  const e = runs.get(runId);
  if (!e) return;
  e.buffer.push(ev);
  try {
    appendFileSync(e.logPath, `${JSON.stringify(ev)}\n`);
  } catch {
    /* best-effort persistence */
  }
  e.emitter.emit("event", ev);
}

/** Mark the run finished; late subscribers fall back to the persisted log. */
export function finishRun(runId: string): void {
  const e = runs.get(runId);
  if (!e) return;
  e.done = true;
  e.emitter.emit("done");
  if (activeByConversation.get(e.conversationId) === runId) activeByConversation.delete(e.conversationId);
  runs.delete(runId);
}

export function cancelRun(runId: string): boolean {
  const e = runs.get(runId);
  if (!e) return false;
  e.ctrl.abort();
  return true;
}

/** The live run id for a conversation, if one is in flight right now. */
export function activeRunForConversation(conversationId: string): string | undefined {
  const id = activeByConversation.get(conversationId);
  return id && runs.has(id) ? id : undefined;
}

export function isActive(runId: string): boolean {
  return runs.has(runId);
}

/**
 * Attach to a run: replays everything buffered so far, then streams live events until done.
 * If the run isn't in memory (already finished, or the daemon restarted), replays the
 * persisted log instead and ends — so a reconnecting client still sees the reached state.
 */
export function subscribe(runId: string, dataDir: string, onEvent: (ev: unknown) => void, onEnd: () => void): () => void {
  const e = runs.get(runId);
  if (!e) {
    for (const ev of readRunLog(runLogPath(dataDir, runId))) onEvent(ev);
    onEnd();
    return () => {};
  }
  for (const ev of e.buffer) onEvent(ev);
  if (e.done) {
    onEnd();
    return () => {};
  }
  const onEv = (ev: unknown): void => onEvent(ev);
  const onDone = (): void => onEnd();
  e.emitter.on("event", onEv);
  e.emitter.once("done", onDone);
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
