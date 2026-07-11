import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { test, expect, afterEach, vi } from "vitest";
import { Button, Badge, Tabs, Dialog, Card, Picker } from "./index.ts";

afterEach(cleanup);

test("Button renders its variant/size and forwards onClick", () => {
  const onClick = vi.fn();
  render(
    <Button variant="secondary" size="lg" onClick={onClick}>
      Go
    </Button>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(onClick).toHaveBeenCalledOnce();
});

test("Tabs reports the chosen value", () => {
  const onChange = vi.fn();
  render(
    <Tabs
      aria-label="Views"
      value="a"
      onChange={onChange}
      items={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ]}
    />,
  );
  expect(screen.getByRole("tab", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
  expect(onChange).toHaveBeenCalledWith("b");
});

test("Tabs uses roving focus for ArrowLeft/Right/Home/End", () => {
  function Harness() {
    const [value, setValue] = useState("a");
    return (
      <Tabs
        aria-label="Views"
        value={value}
        onChange={setValue}
        items={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
          { value: "c", label: "Gamma" },
        ]}
      />
    );
  }
  render(<Harness />);
  const alpha = screen.getByRole("tab", { name: "Alpha" });
  const beta = screen.getByRole("tab", { name: "Beta" });
  const gamma = screen.getByRole("tab", { name: "Gamma" });
  expect(alpha).toHaveAttribute("tabindex", "0");
  expect(beta).toHaveAttribute("tabindex", "-1");

  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowRight" });
  expect(beta).toHaveFocus();
  expect(beta).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(beta, { key: "End" });
  expect(gamma).toHaveFocus();
  fireEvent.keyDown(gamma, { key: "Home" });
  expect(alpha).toHaveFocus();
  fireEvent.keyDown(alpha, { key: "ArrowLeft" });
  expect(gamma).toHaveFocus();
});

test("Badge renders its content", () => {
  render(<Badge variant="default">New</Badge>);
  expect(screen.getByText("New")).toBeInTheDocument();
});

test("Picker (shadcn Select) opens and reports the chosen value", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <Picker
      ariaLabel="Type"
      value="a"
      onChange={onChange}
      options={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ]}
    />,
  );
  expect(screen.queryByRole("option", { name: "Beta" })).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "Type" }));
  await user.click(screen.getByRole("option", { name: "Beta" }));
  expect(onChange).toHaveBeenCalledWith("b");
});

test("Card renders its children", () => {
  render(<Card>body</Card>);
  expect(screen.getByText("body")).toBeInTheDocument();
});

test("Dialog shows when open and hides when closed", () => {
  const onClose = vi.fn();
  const { rerender } = render(
    <Dialog open label="Demo" onClose={onClose}>
      <p>panel</p>
    </Dialog>,
  );
  expect(screen.getByRole("dialog", { name: "Demo" })).toBeInTheDocument();
  expect(screen.getByText("panel")).toBeInTheDocument();
  rerender(
    <Dialog open={false} label="Demo" onClose={onClose}>
      <p>panel</p>
    </Dialog>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
