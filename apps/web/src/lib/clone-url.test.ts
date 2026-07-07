import { describe, it, expect } from "vitest";
import { isCloneUrl } from "./clone-url.ts";

describe("isCloneUrl", () => {
  it("accepts http and https URLs (trimmed)", () => {
    expect(isCloneUrl("https://example.com")).toBe(true);
    expect(isCloneUrl("http://example.com/path?q=1")).toBe(true);
    expect(isCloneUrl("  https://example.com  ")).toBe(true);
  });
  it("rejects empty, schemeless, and non-http schemes", () => {
    expect(isCloneUrl("")).toBe(false);
    expect(isCloneUrl("example.com")).toBe(false);
    expect(isCloneUrl("ftp://example.com")).toBe(false);
    expect(isCloneUrl("not a url")).toBe(false);
  });
});
