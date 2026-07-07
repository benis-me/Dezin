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
});
