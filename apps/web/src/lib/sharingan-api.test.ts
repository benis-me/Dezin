import { describe, it, expect } from "vitest";
import { parseSseBlock } from "./api.ts";

describe("sharingan SSE steps parse", () => {
  it("parses a capture step block", () => {
    expect(parseSseBlock(`data: ${JSON.stringify({ at: 1, kind: "navigate", text: "Navigating" })}`)).toEqual({ at: 1, kind: "navigate", text: "Navigating" });
  });
  it("parses a login-required step", () => {
    expect(parseSseBlock(`data: ${JSON.stringify({ at: 2, kind: "login-required", text: "Sign in" })}`)).toEqual({ at: 2, kind: "login-required", text: "Sign in" });
  });
});
