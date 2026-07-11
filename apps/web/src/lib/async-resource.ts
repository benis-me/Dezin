export type ResourceState<T> =
  | { status: "idle" | "loading"; data: null; error: null }
  | { status: "refreshing" | "ready"; data: T; error: null }
  | { status: "error"; data: T | null; error: Error };

export function idleResource<T>(): ResourceState<T> {
  return { status: "idle", data: null, error: null };
}

export function readyResource<T>(data: T): ResourceState<T> {
  return { status: "ready", data, error: null };
}

export function beginResourceLoad<T>(current: ResourceState<T>): ResourceState<T> {
  return current.data === null
    ? { status: "loading", data: null, error: null }
    : { status: "refreshing", data: current.data, error: null };
}

export function resolveResource<T>(data: T): ResourceState<T> {
  return readyResource(data);
}

export function rejectResource<T>(current: ResourceState<T>, reason: unknown): ResourceState<T> {
  const error = reason instanceof Error ? reason : new Error(String(reason || "Request failed"));
  return { status: "error", data: current.data, error };
}
