import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApiProvider } from "../lib/api-context.tsx";
import { ToastProvider } from "../components/Toast.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { SharinganTab } from "./SharinganTab.tsx";

function renderTab(over = {}) {
  const api = makeFakeApi({
    sharinganStatus: async () => ({ phase: "login-required", steps: 1, pages: [] }),
    streamSharinganEvents: async function* () {
      yield { at: 1, kind: "navigate", text: "Navigating to example.com" };
      yield { at: 2, kind: "login-required", text: "This page needs a login." };
    },
    ...over,
  });
  render(<ApiProvider client={api}><ToastProvider><SharinganTab projectId="p1" sourceUrl="https://example.com" /></ToastProvider></ApiProvider>);
  return api;
}

describe("SharinganTab", () => {
  it("streams the work-log", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText(/Navigating to example.com/)).toBeInTheDocument());
  });

  it("shows the login prompt with Open-the-browser + Continue", async () => {
    const focusSharingan = vi.fn(async () => {});
    const continueSharingan = vi.fn(async () => {});
    renderTab({ focusSharingan, continueSharingan });
    fireEvent.click(await screen.findByRole("button", { name: /open the browser/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue/i }));
    await waitFor(() => expect(focusSharingan).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(continueSharingan).toHaveBeenCalledWith("p1"));
  });

  it("auto-starts capture when idle", async () => {
    const startSharingan = vi.fn(async () => {});
    renderTab({ startSharingan, sharinganStatus: async () => ({ phase: "idle", steps: 0, pages: [] }) });
    await waitFor(() => expect(startSharingan).toHaveBeenCalledWith("p1", "https://example.com"));
  });

  it("renders captured-page results with a screenshot", async () => {
    renderTab({
      sharinganStatus: async () => ({ phase: "captured", steps: 3, pages: [{ url: "https://example.com/", title: "Home", screenshots: { desktop: "home/shot-desktop.png" } }] }),
      streamSharinganEvents: async function* () { yield { at: 9, kind: "done", text: "Capture complete" }; },
    });
    const img = await screen.findByAltText(/Home/i);
    expect(img.getAttribute("src")).toContain("home/shot-desktop.png");
  });

  it("renders a screenshot thumbnail inline in the work-log for steps that carry a shot", async () => {
    renderTab({
      sharinganStatus: async () => ({ phase: "capturing", steps: 1, pages: [] }),
      streamSharinganEvents: async function* () {
        yield { at: 1, kind: "screenshot", text: "Captured desktop (1440px)", shot: "home/shot-desktop.png" };
      },
    });
    const img = await screen.findByAltText(/Captured desktop/i);
    expect(img.getAttribute("src")).toContain("home/shot-desktop.png");
  });

  it("renders daemon status errors as an alert and offers Retry", async () => {
    const startSharingan = vi.fn(async () => {});
    renderTab({
      startSharingan,
      sharinganStatus: async () => ({ phase: "error", steps: 1, pages: [], error: "Chrome failed to launch" }),
      streamSharinganEvents: async function* () {},
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Chrome failed to launch");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(startSharingan).toHaveBeenCalledWith("p1", "https://example.com"));
    expect(screen.queryByText(/Capture cancelled/i)).not.toBeInTheDocument();
  });

  it("surfaces non-abort event-stream failures instead of swallowing them", async () => {
    let attempts = 0;
    const streamSharinganEvents = vi.fn(async function* () {
      attempts += 1;
      if (attempts === 1) throw new Error("capture stream disconnected");
      yield { at: 2, kind: "dom" as const, text: "stream reconnected" };
    });
    renderTab({
      sharinganStatus: async () => ({ phase: "capturing", steps: 0, pages: [] }),
      streamSharinganEvents,
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("capture stream disconnected");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByText("stream reconnected")).toBeInTheDocument();
    expect(streamSharinganEvents).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("waits for cancel acknowledgement and refreshed status before showing cancelled", async () => {
    let acknowledge!: () => void;
    const cancelSharingan = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    let statusCalls = 0;
    const sharinganStatus = vi.fn(async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { phase: "capturing", steps: 3, pages: [] }
        : { phase: "cancelled", steps: 0, pages: [] };
    });
    renderTab({
      cancelSharingan,
      sharinganStatus,
      streamSharinganEvents: async function* () {},
    });

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelSharingan).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(sharinganStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Capture cancelled/i)).not.toBeInTheDocument();

    acknowledge();
    expect(await screen.findByText(/Capture cancelled/i)).toBeInTheDocument();
    expect(sharinganStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders a persisted cancelled status distinctly from failure", async () => {
    const startSharingan = vi.fn(async () => {});
    const streamSharinganEvents = vi.fn(async function* () {});
    renderTab({
      startSharingan,
      sharinganStatus: async () => ({ phase: "cancelled", steps: 0, pages: [] }),
      streamSharinganEvents,
    });

    expect(await screen.findByText(/Capture cancelled/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(startSharingan).toHaveBeenCalledWith("p1", "https://example.com"));
    await waitFor(() => expect(streamSharinganEvents).toHaveBeenCalledTimes(2));
  });

  it("keeps only the newest 500 streamed work-log entries", async () => {
    renderTab({
      sharinganStatus: async () => ({ phase: "capturing", steps: 0, pages: [] }),
      streamSharinganEvents: async function* () {
        for (let index = 0; index < 505; index += 1) yield { at: index, kind: "dom" as const, text: `step ${index}` };
      },
    });

    await screen.findByText("step 504");
    await waitFor(() => expect(screen.queryByText("step 0")).not.toBeInTheDocument());
    expect(screen.getAllByRole("listitem")).toHaveLength(500);
  });
});
