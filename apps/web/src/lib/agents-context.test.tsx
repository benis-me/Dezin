import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ApiProvider } from "./api-context.tsx";
import { AgentsProvider, useAgents } from "./agents-context.tsx";
import { createApiClient, type AgentInfo, type FetchLike } from "./api.ts";

const LAST_GOOD: AgentInfo = {
  id: "codex",
  command: "codex",
  available: true,
  availability: "ready",
  version: "1",
  models: ["gpt-5.4-mini"],
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function AgentState() {
  const state = useAgents();
  return (
    <>
      <span data-testid="agent">{state.agents[0]?.command ?? "none"}</span>
      <span data-testid="loading">{String(state.loading)}</span>
      <span data-testid="scanning">{String(state.scanning)}</span>
      <span data-testid="status">{state.status || "idle"}</span>
      <span data-testid="error">{state.error ?? "none"}</span>
      <button type="button" onClick={() => void state.rescan()}>Rescan</button>
      <button type="button" onClick={() => void state.reload()}>Reload</button>
    </>
  );
}

test("an initial availability failure stays explicit and a stable reload recovers", async () => {
  let available = false;
  const api = createApiClient({
    fetchImpl: async (url) => {
      if (!url.endsWith("/api/agents")) throw new Error("unexpected request");
      if (!available) throw new Error("daemon restarted");
      return jsonResponse([LAST_GOOD]);
    },
  });

  render(
    <ApiProvider client={api}>
      <AgentsProvider>
        <AgentState />
      </AgentsProvider>
    </ApiProvider>,
  );

  expect(await screen.findByTestId("error")).toHaveTextContent(
    "Agent availability couldn't be checked. Use Rescan agents to try again.",
  );
  expect(screen.getByTestId("agent")).toHaveTextContent("none");

  available = true;
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));

  expect(await screen.findByTestId("agent")).toHaveTextContent("codex");
  expect(screen.getByTestId("error")).toHaveTextContent("none");
});

test("a stalled scan exits, keeps the last-good list, and can recover through Rescan", async () => {
  vi.useFakeTimers();
  try {
    let recover = false;
    let streamRequests = 0;
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith("/api/agents")) return jsonResponse([LAST_GOOD]);
      if (url.endsWith("/api/agents/rescan")) return new Promise<Response>(() => {});
      streamRequests += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (recover) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: "done", agents: [{ ...LAST_GOOD, version: "2" }] })}\n\n`,
            ));
            controller.close();
          } else {
            controller.enqueue(encoder.encode(
              'data: {"type":"progress","id":"codex","label":"Codex","phase":"probe"}\n\n',
            ));
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const api = createApiClient({ fetchImpl });

    render(
      <ApiProvider client={api}>
        <AgentsProvider>
          <AgentState />
        </AgentsProvider>
      </ApiProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("agent")).toHaveTextContent("codex");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");

    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("scanning")).toHaveTextContent("true");
    expect(screen.getByTestId("status")).toHaveTextContent("Scanning Codex…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTestId("scanning")).toHaveTextContent("false");
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(screen.getByTestId("error")).toHaveTextContent(
      "Agent scan stopped before it completed. Use Rescan agents to try again.",
    );
    expect(screen.getByTestId("agent")).toHaveTextContent("codex");

    recover = true;
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("scanning")).toHaveTextContent("false");
    expect(screen.getByTestId("error")).toHaveTextContent("none");
    expect(streamRequests).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
