import "@testing-library/jest-dom";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

const memoryStorage = createMemoryStorage();

function installMemoryStorage(target: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, "localStorage");
  if (descriptor && !descriptor.get && descriptor.value !== undefined) return;
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: memoryStorage,
  });
}

installMemoryStorage(globalThis);

// jsdom polyfills for Radix UI primitives (shadcn) used in tests.
if (typeof window !== "undefined") {
  installMemoryStorage(window);
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  window.scrollTo = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!window.matchMedia) {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
}
