import { describe, expect, test } from "vitest";

import {
  displayLanguage,
  typedMaterialHighlighter,
  typedMaterialPresentation,
} from "./typed-material.ts";

describe("typed material presentation", () => {
  test("recognizes Markdown before generic text mime types", () => {
    expect(typedMaterialPresentation("README.md", "text/plain")).toEqual({
      kind: "markdown",
      language: "markdown",
    });
    expect(typedMaterialPresentation("notes", "text/markdown; charset=utf-8")).toEqual({
      kind: "markdown",
      language: "markdown",
    });
  });

  test("maps supported source extensions and mime types to TanStack languages", () => {
    expect(typedMaterialPresentation("Canvas.tsx", "application/octet-stream")).toEqual({ kind: "code", language: "tsx" });
    expect(typedMaterialPresentation("tokens", "application/json")).toEqual({ kind: "code", language: "json" });
    expect(typedMaterialPresentation("Dockerfile", null)).toEqual({ kind: "code", language: "dockerfile" });
    expect(displayLanguage(typedMaterialPresentation("app.py", "text/plain"))).toBe("Python");
  });

  test("keeps unsupported programming languages escaped through plaintext fallback", () => {
    const presentation = typedMaterialPresentation("main.rs", "application/octet-stream");
    expect(presentation).toEqual({ kind: "code", language: "plaintext" });
    const highlighted = typedMaterialHighlighter.highlight("<script>alert('no')</script>", {
      lang: presentation.language ?? undefined,
      lineNumbers: true,
    });
    expect(highlighted.html).toContain("&lt;script&gt;");
    expect(highlighted.html).not.toContain("<script>");
  });

  test("distinguishes editable plain text from binary files", () => {
    expect(typedMaterialPresentation("trace.log", "application/octet-stream")).toEqual({ kind: "text", language: "plaintext" });
    expect(typedMaterialPresentation("brief.pdf", "application/pdf")).toEqual({ kind: "binary", language: null });
  });
});
