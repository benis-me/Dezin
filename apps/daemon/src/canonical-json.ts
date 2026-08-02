/** Canonical JSON helpers shared by immutable daemon-owned formats. */

export function isWellFormedText(value: string): boolean {
  const native = value as string & { isWellFormed?: () => boolean };
  if (typeof native.isWellFormed === "function") return native.isWellFormed();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

interface CanonicalizeState {
  active: WeakSet<object>;
  visited: number;
}

function canonicalize(
  value: unknown,
  state: CanonicalizeState = { active: new WeakSet<object>(), visited: 0 },
  depth = 0,
): unknown {
  state.visited += 1;
  if (state.visited > 1_000_000 || depth > 256) {
    throw new TypeError("Canonical JSON exceeds its structural limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 16 * 1024 * 1024 || !isWellFormedText(value)) {
      throw new TypeError("Canonical JSON contains invalid or oversized text");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000_000) throw new TypeError("Canonical JSON array is too large");
    if (state.active.has(value)) throw new TypeError("Canonical JSON cannot contain cycles");
    state.active.add(value);
    try {
      return value.map((item) => canonicalize(item === undefined ? null : item, state, depth + 1));
    } finally {
      state.active.delete(value);
    }
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects");
    }
    if (state.active.has(record)) throw new TypeError("Canonical JSON cannot contain cycles");
    state.active.add(record);
    try {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (key.length > 1024 * 1024 || !isWellFormedText(key)) {
          throw new TypeError("Canonical JSON contains an invalid object key");
        }
        if (record[key] !== undefined) result[key] = canonicalize(record[key], state, depth + 1);
      }
      return result;
    } finally {
      state.active.delete(record);
    }
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== "object" || Object.isFrozen(current) || seen.has(current)) return;
    seen.add(current);
    if (ArrayBuffer.isView(current)) return;
    for (const child of Object.values(current as Record<string, unknown>)) freeze(child);
    Object.freeze(current);
  };
  freeze(clone);
  return clone;
}
