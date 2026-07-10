function handleTaskkillResult({ result, child, logError = console.error }) {
  if (!result?.error && result?.status === 0) return true;

  const reason = result?.error?.message || `taskkill exited with status ${String(result?.status)}`;
  logError(`[daemon] failed to stop process tree: ${reason}; falling back to child.kill()`);
  try {
    if (!child || typeof child.kill !== "function" || child.kill() === false) {
      logError("[daemon] direct child fallback did not signal the daemon");
    }
  } catch (error) {
    logError(`[daemon] direct child fallback failed: ${error && error.message}`);
  }
  return false;
}

module.exports = { handleTaskkillResult };
