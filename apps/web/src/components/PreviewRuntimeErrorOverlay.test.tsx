import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewRuntimeErrorOverlay } from "./PreviewRuntimeErrorOverlay.tsx";

afterEach(cleanup);
const err = (over = {}) => ({ source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "boom", count: 1, at: 1, sig: "s", ...over } as any);

test("renders nothing when there are no errors", () => {
  const { container } = render(<PreviewRuntimeErrorOverlay fatal={null} nonFatal={[]} onFixFatal={vi.fn()} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

test("fatal overlay shows the message and fires onFixFatal", async () => {
  const onFixFatal = vi.fn();
  render(<PreviewRuntimeErrorOverlay fatal={err({ message: "died" })} nonFatal={[]} onFixFatal={onFixFatal} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />);
  expect(screen.getByText("died")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /fix with agent/i }));
  expect(onFixFatal).toHaveBeenCalledTimes(1);
});

test("non-fatal badge shows the count", () => {
  render(<PreviewRuntimeErrorOverlay fatal={null} nonFatal={[err({ kind: "nonfatal", message: "a", sig: "a" }), err({ kind: "nonfatal", message: "b", sig: "b" })]} onFixFatal={vi.fn()} onFixNonFatal={vi.fn()} onReload={vi.fn()} onDismissFatal={vi.fn()} onDismissNonFatal={vi.fn()} />);
  expect(screen.getByText(/2/)).toBeInTheDocument();
});
