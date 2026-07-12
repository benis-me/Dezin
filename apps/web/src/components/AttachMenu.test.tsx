import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { AttachMenu } from "./AttachMenu.tsx";
import { ToastProvider } from "./Toast.tsx";

afterEach(cleanup);

test("browser file attachment opens the upload input while folder and code actions stay desktop-only", async () => {
  const user = userEvent.setup();
  const onAttachFile = vi.fn();
  render(
    <ApiProvider client={makeFakeApi()}>
      <ToastProvider>
        <AttachMenu onAttachFile={onAttachFile} onPickPaths={vi.fn()} />
      </ToastProvider>
    </ApiProvider>,
  );

  await user.click(screen.getByLabelText("Add files and context"));
  await user.click(await screen.findByRole("menuitem", { name: "Attach file" }));
  expect(onAttachFile).toHaveBeenCalledOnce();

  await user.click(screen.getByLabelText("Add files and context"));
  await user.click(await screen.findByRole("menuitem", { name: "Attach folder" }));
  expect(onAttachFile).toHaveBeenCalledOnce();
  expect(await screen.findByText("Attach folder is available in the desktop app.")).toBeInTheDocument();

  await user.click(screen.getByLabelText("Add files and context"));
  await user.click(await screen.findByRole("menuitem", { name: "Link local code…" }));
  expect(onAttachFile).toHaveBeenCalledOnce();
  expect(await screen.findByText("Link local code is available in the desktop app.")).toBeInTheDocument();
});

test("file attachment copy can name the upload target", async () => {
  const user = userEvent.setup();
  render(
    <ApiProvider client={makeFakeApi()}>
      <AttachMenu fileActionLabel="Add images to board" onAttachFile={vi.fn()} onPickPaths={vi.fn()} />
    </ApiProvider>,
  );

  await user.click(screen.getByLabelText("Add files and context"));
  expect(await screen.findByRole("menuitem", { name: "Add images to board" })).toBeInTheDocument();
});
