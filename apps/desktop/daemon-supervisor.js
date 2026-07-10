const READINESS_TIMEOUT_MS = 20_000;
const READINESS_POLL_MS = 150;
const RESTART_DELAY_MS = 500;
const MAX_AUTOMATIC_RESTARTS = 1;

function defaultSchedule(callback, delay) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

function isOwnedPortFile(record, child, ownerId) {
  return (
    record !== null &&
    typeof record === "object" &&
    typeof record.url === "string" &&
    record.url.length > 0 &&
    record.pid === child.pid &&
    record.ownerId === ownerId
  );
}

function createDaemonSupervisor({ spawnDaemon, readPortFile, now = Date.now, schedule = defaultSchedule, killProcessGroup }) {
  let lifecycleState = "idle";
  let child = null;
  let readyUrl = null;
  let startPromise = null;
  let stopPromise = null;
  let restartPromise = null;
  let settleRestart = null;
  let cancelRestart = null;
  let cancelReadinessWait = null;
  let automaticRestarts = 0;
  let generation = 0;
  let stopping = false;
  let stopped = false;

  function wait(delay) {
    return new Promise((resolve) => {
      let settled = false;
      const cancel = schedule(() => {
        if (settled) return;
        settled = true;
        cancelReadinessWait = null;
        resolve(true);
      }, delay);
      cancelReadinessWait = () => {
        if (settled) return;
        settled = true;
        cancel();
        cancelReadinessWait = null;
        resolve(false);
      };
    });
  }

  async function waitForReady(targetChild, ownerId, startedAt) {
    while (!stopping && child === targetChild) {
      let record = null;
      try {
        record = await readPortFile();
      } catch {
        // The discovery file may not exist or may be between writes yet.
      }
      if (isOwnedPortFile(record, targetChild, ownerId)) return record.url;
      if (now() - startedAt >= READINESS_TIMEOUT_MS) {
        throw new Error("Timed out waiting for the Dezin daemon");
      }
      if (!(await wait(READINESS_POLL_MS))) break;
    }
    throw new Error(stopping ? "Daemon supervisor is stopping" : "Daemon exited before becoming ready");
  }

  function scheduleAutomaticRestart() {
    if (stopping || stopped || automaticRestarts >= MAX_AUTOMATIC_RESTARTS) {
      lifecycleState = stopping ? "stopping" : "idle";
      return;
    }

    automaticRestarts += 1;
    lifecycleState = "backoff";
    restartPromise = new Promise((resolve, reject) => {
      settleRestart = { resolve, reject };
    });
    // The restart is intentionally fire-and-forget when no window is awaiting it.
    restartPromise.catch(() => {});
    cancelRestart = schedule(async () => {
      cancelRestart = null;
      if (stopping) return;
      try {
        const url = await beginStart();
        settleRestart?.resolve(url);
      } catch (error) {
        settleRestart?.reject(error);
      } finally {
        settleRestart = null;
        restartPromise = null;
      }
    }, RESTART_DELAY_MS);
  }

  function watchChild(targetChild) {
    let ended = false;
    const onUnexpectedExit = () => {
      if (ended) return;
      ended = true;
      if (child !== targetChild) return;
      child = null;
      readyUrl = null;
      if (cancelReadinessWait) cancelReadinessWait();
      scheduleAutomaticRestart();
    };
    targetChild.once("exit", onUnexpectedExit);
  }

  async function start() {
    if (stopping || stopped) throw new Error(stopping ? "Daemon supervisor is stopping" : "Daemon supervisor is stopped");
    lifecycleState = "starting";
    const ownerId = `desktop-${process.pid}-${now()}-${++generation}`;
    const startedAt = now();
    let targetChild;
    try {
      targetChild = await spawnDaemon({ ownerId });
      if (!targetChild || !Number.isInteger(targetChild.pid) || targetChild.pid <= 0) {
        throw new Error("Daemon spawn did not return a valid child process");
      }
      if (stopping) {
        await killProcessGroup(targetChild.pid);
        throw new Error("Daemon supervisor is stopping");
      }
      child = targetChild;
      watchChild(targetChild);
      const url = await waitForReady(targetChild, ownerId, startedAt);
      if (stopping || child !== targetChild) throw new Error("Daemon exited before becoming ready");
      readyUrl = url;
      lifecycleState = "ready";
      return url;
    } catch (error) {
      if (targetChild && child === targetChild) {
        child = null;
        readyUrl = null;
        try {
          await killProcessGroup(targetChild.pid);
        } catch {
          // Preserve the startup error; process termination is best-effort here.
        }
      }
      if (!stopping && lifecycleState === "starting") lifecycleState = "idle";
      throw error;
    }
  }

  function beginStart() {
    if (startPromise) return startPromise;
    const pending = start();
    startPromise = pending;
    pending.then(
      () => {
        if (startPromise === pending) startPromise = null;
      },
      () => {
        if (startPromise === pending) startPromise = null;
      },
    );
    return pending;
  }

  function ensureStarted() {
    if (stopping || lifecycleState === "stopping") {
      return Promise.reject(new Error("Daemon supervisor is stopping"));
    }
    if (stopped) return Promise.reject(new Error("Daemon supervisor is stopped"));
    if (lifecycleState === "ready" && child && readyUrl) return Promise.resolve(readyUrl);
    if (lifecycleState === "backoff" && restartPromise) return restartPromise;
    return beginStart();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (stopped) return Promise.resolve();
    stopped = true;
    stopping = true;
    lifecycleState = "stopping";

    if (cancelRestart) {
      cancelRestart();
      cancelRestart = null;
    }
    if (settleRestart) {
      settleRestart.reject(new Error("Daemon supervisor stopped"));
      settleRestart = null;
      restartPromise = null;
    }
    if (cancelReadinessWait) cancelReadinessWait();

    const pendingStart = startPromise;
    const targetChild = child;
    child = null;
    readyUrl = null;
    let resolveStop;
    let rejectStop;
    const completion = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    stopPromise = completion;
    void (async () => {
      try {
        if (targetChild?.pid) await killProcessGroup(targetChild.pid);
        if (pendingStart) {
          try {
            await pendingStart;
          } catch {
            // A start cancelled by stop is expected to reject.
          }
        }
        resolveStop();
      } catch (error) {
        rejectStop(error);
      } finally {
        lifecycleState = "idle";
        startPromise = null;
        stopping = false;
        if (stopPromise === completion) stopPromise = null;
      }
    })();
    return completion;
  }

  return {
    ensureStarted,
    stop,
    state: () => lifecycleState,
  };
}

async function loadUrlWithRetry(loadUrl, { shouldRetry = () => true } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await loadUrl();
    } catch (error) {
      lastError = error;
      if (attempt === 0 && !shouldRetry(error)) throw error;
    }
  }
  throw lastError;
}

module.exports = { createDaemonSupervisor, loadUrlWithRetry };
