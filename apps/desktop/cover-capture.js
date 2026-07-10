function createCoverCaptureController({ BrowserWindow, existsSync, writeFileSync, wait, logError }) {
  const tasks = new Map();

  const isCurrent = (task) => !task.cancelled && tasks.get(task.id) === task;
  const cleanup = (task) => {
    if (task.cleaned) return;
    task.cleaned = true;
    if (tasks.get(task.id) === task) tasks.delete(task.id);
    const view = task.view;
    task.view = null;
    if (!view) return;
    try {
      if (typeof view.isDestroyed !== "function" || !view.isDestroyed()) view.destroy();
    } catch {
      /* best-effort cleanup */
    }
  };

  async function capture(id, htmlPath, outPath) {
    if (!Number.isSafeInteger(id) || tasks.has(id) || !existsSync(htmlPath)) return false;
    const task = { id, cancelled: false, cleaned: false, view: null };
    tasks.set(id, task);
    try {
      task.view = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        useContentSize: true,
        webPreferences: { sandbox: true, paintWhenInitiallyHidden: true, backgroundThrottling: false, offscreen: false },
      });
      if (!isCurrent(task)) return false;
      await task.view.loadFile(htmlPath);
      if (!isCurrent(task)) return false;
      await wait(500);
      if (!isCurrent(task)) return false;
      const image = await task.view.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 800 });
      if (!isCurrent(task)) return false;
      const png = image.toPNG();
      if (!isCurrent(task) || !png || png.length < 256) return false;
      writeFileSync(outPath, png);
      return true;
    } catch (error) {
      if (!task.cancelled) logError(error);
      return false;
    } finally {
      cleanup(task);
    }
  }

  function cancel(id) {
    const task = tasks.get(id);
    if (!task) return false;
    task.cancelled = true;
    cleanup(task);
    return true;
  }

  function cancelAll() {
    for (const id of [...tasks.keys()]) cancel(id);
  }

  return { capture, cancel, cancelAll };
}

module.exports = { createCoverCaptureController };
