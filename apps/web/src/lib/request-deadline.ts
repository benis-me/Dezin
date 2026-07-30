export const REQUEST_DEADLINE_MS = 15_000;

export class RequestDeadlineError extends Error {
  override readonly name = "RequestDeadlineError";
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The request was aborted.", "AbortError");
}

export function withRequestDeadline<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMessage: string,
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = REQUEST_DEADLINE_MS,
): Promise<T> {
  if (parentSignal?.aborted) return Promise.reject(abortError(parentSignal));

  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", forwardAbort, { once: true });

  let rejectOnAbort: ((error: Error) => void) | null = null;
  const aborted = new Promise<T>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const rejectAborted = (): void => rejectOnAbort?.(abortError(controller.signal));
  controller.signal.addEventListener("abort", rejectAborted, { once: true });

  const timer = setTimeout(() => {
    controller.abort(new RequestDeadlineError(timeoutMessage));
  }, timeoutMs);

  let pending: Promise<T>;
  try {
    pending = request(controller.signal);
  } catch (error) {
    pending = Promise.reject(error);
  }

  return Promise.race([pending, aborted]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", rejectAborted);
    rejectOnAbort = null;
  });
}
