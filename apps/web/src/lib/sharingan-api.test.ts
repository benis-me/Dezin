import { describe, it, expect } from "vitest";
import { parseSseBlock, consumeSseJson, createApiClient } from "./api.ts";

describe("sharingan SSE steps parse", () => {
  it("parses a capture step block", () => {
    expect(parseSseBlock(`data: ${JSON.stringify({ at: 1, kind: "navigate", text: "Navigating" })}`)).toEqual({ at: 1, kind: "navigate", text: "Navigating" });
  });
  it("parses a login-required step", () => {
    expect(parseSseBlock(`data: ${JSON.stringify({ at: 2, kind: "login-required", text: "Sign in" })}`)).toEqual({ at: 2, kind: "login-required", text: "Sign in" });
  });
});

describe("consumeSseJson end-of-stream handling", () => {
  it("consumeSseJson yields a final block not terminated by a blank line", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ at: 1, kind: "done", text: "x" })}`));
        c.close();
      },
    });
    const res = new Response(body, { status: 200 });
    const out: any[] = [];
    for await (const ev of consumeSseJson<any>(res)) out.push(ev);
    expect(out).toEqual([{ at: 1, kind: "done", text: "x" }]);
  });
});

describe("Sharingan cancellation API", () => {
  it("POSTs to the encoded project cancellation endpoint and propagates daemon failures", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const api = createApiClient({
      baseUrl: "http://daemon.test",
      fetchImpl: async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await api.cancelSharingan("project/one");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("http://daemon.test/api/sharingan/project%2Fone/cancel");
    expect(calls[0]?.init?.method).toBe("POST");

    const failing = createApiClient({ fetchImpl: async () => new Response("release failed", { status: 500 }) });
    await expect(failing.cancelSharingan("p1")).rejects.toThrow("release failed");
  });
});
