import { expect, test, vi } from "vitest";
import { designExportPath, revealDesignExport } from "./design-export.ts";

test("Design Export paths stay beneath the authoritative Project root", () => {
  expect(designExportPath("/Users/ben/Design Project/", "export-ready-1"))
    .toBe("/Users/ben/Design Project/design/exports/export-ready-1");
  expect(designExportPath("C:\\Design\\Project", "export-ready-1"))
    .toBe("C:\\Design\\Project\\design\\exports\\export-ready-1");
  for (const injected of ["../escape", "export-../../escape", "export-a/b", "export-a%2Fb", "not-an-export"]) {
    expect(designExportPath("/safe/project", injected)).toBeNull();
  }
});

test("Design Export reveal opens a safe native path and falls back to copying in a browser", async () => {
  const openPath = vi.fn(async () => true);
  const writeClipboard = vi.fn(async () => {});
  await expect(revealDesignExport({
    projectPath: "/safe/project",
    exportId: "export-ready-1",
    openPath,
    writeClipboard,
  })).resolves.toBe("revealed");
  expect(openPath).toHaveBeenCalledWith("/safe/project/design/exports/export-ready-1");
  expect(writeClipboard).not.toHaveBeenCalled();

  await expect(revealDesignExport({
    projectPath: "/safe/project",
    exportId: "export-ready-2",
    writeClipboard,
  })).resolves.toBe("copied");
  expect(writeClipboard).toHaveBeenCalledWith("/safe/project/design/exports/export-ready-2");
});

test("an injected Export identity never reaches native or clipboard capabilities", async () => {
  const openPath = vi.fn(async () => true);
  const writeClipboard = vi.fn(async () => {});
  await expect(revealDesignExport({
    projectPath: "/safe/project",
    exportId: "export-../../escape",
    openPath,
    writeClipboard,
  })).resolves.toBe("unavailable");
  expect(openPath).not.toHaveBeenCalled();
  expect(writeClipboard).not.toHaveBeenCalled();
});
