import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewRuntimeErrorOverlay } from "./PreviewRuntimeErrorOverlay.tsx";

afterEach(cleanup);
const err = (over = {}) => ({ source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "boom", count: 1, at: 1, sig: "s", ...over } as any);

function setup(over: { fatal?: ReturnType<typeof err> | null; nonFatal?: ReturnType<typeof err>[] } = {}) {
  const cb = { onFixFatal: vi.fn(), onFixNonFatal: vi.fn(), onReload: vi.fn(), onDismissFatal: vi.fn(), onDismissNonFatal: vi.fn() };
  render(<PreviewRuntimeErrorOverlay fatal={over.fatal ?? null} nonFatal={over.nonFatal ?? []} {...cb} />);
  return cb;
}

test("renders nothing when there are no errors", () => {
  const { container } = render(
    <PreviewRuntimeErrorOverlay fatal={null} nonFatal={[]} onFixFatal={vi.fn()} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />,
  );
  expect(container).toBeEmptyDOMElement();
});

test("fatal: shows the message and wires Fix / Reload / Dismiss to the right callbacks", async () => {
  const cb = setup({ fatal: err({ message: "died" }) });
  expect(screen.getByText("died")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /fix with agent/i }));
  await userEvent.click(screen.getByRole("button", { name: /reload/i }));
  await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  expect(cb.onFixFatal).toHaveBeenCalledTimes(1);
  expect(cb.onReload).toHaveBeenCalledTimes(1);
  expect(cb.onDismissFatal).toHaveBeenCalledTimes(1);
});

test("non-fatal: shows the count and wires Fix / per-item Dismiss", async () => {
  const cb = setup({ nonFatal: [err({ kind: "nonfatal", message: "a", sig: "sa" }), err({ kind: "nonfatal", message: "b", sig: "sb" })] });
  expect(screen.getByText(/2 console errors/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /fix with agent/i }));
  expect(cb.onFixNonFatal).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getAllByRole("button", { name: /dismiss/i })[0]);
  expect(cb.onDismissNonFatal).toHaveBeenCalledWith("sa");
});

test("does not mask the preview: the outer wrapper is pointer-events-none", () => {
  const { container } = render(
    <PreviewRuntimeErrorOverlay fatal={err()} nonFatal={[]} onFixFatal={vi.fn()} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />,
  );
  expect(container.firstChild).toHaveClass("pointer-events-none");
});
