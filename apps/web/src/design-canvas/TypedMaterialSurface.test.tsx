import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import type { NodeFocusMotion } from "./node-focus-motion.ts";
import { TextEditor, TypedMaterialSurface } from "./TypedMaterialSurface.tsx";
import { typedMaterialHighlighter, typedMaterialPresentation } from "./typed-material.ts";
import type { DesignNode, DesignNodeVersion } from "./types.ts";

const node: DesignNode = {
  id: "material-readme",
  kind: "document",
  name: "README.md",
  geometry: { x: 40, y: 60, width: 420, height: 280 },
  state: "ready",
  currentVersionId: "version-one",
  selectedVersionId: "version-one",
  versionCount: 1,
  assetId: "asset-one",
  activeJobId: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

function version(fileName: string, mimeType: string): DesignNodeVersion {
  return {
    id: "version-one",
    nodeId: node.id,
    sequence: 1,
    contentKind: "asset",
    assetId: "asset-one",
    mimeType,
    fileName,
    checksum: "checksum",
    bytes: 128,
    contextHash: null,
    jobId: null,
    runnerId: null,
    model: null,
    createdAt: 1,
  };
}

function apiFor(metadata: DesignNodeVersion): DesignCanvasApi {
  return {
    listNodeVersions: vi.fn(async () => [metadata]),
  } as unknown as DesignCanvasApi;
}

function focusMotion(durationMs = 0): NodeFocusMotion {
  return {
    phase: "opening",
    role: "source",
    startX: 0,
    startY: 0,
    shiftX: 0,
    shiftY: 0,
    arcX: 0,
    arcY: 0,
    startScaleX: 1,
    startScaleY: 1,
    scaleX: 1,
    scaleY: 1,
    scale: 1,
    startWidth: 420,
    startHeight: 280,
    layoutWidth: 420,
    layoutHeight: 280,
    durationMs,
    delayMs: 0,
    fadeDurationMs: 0,
  };
}

function mockFileResponse(content: string): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    blob: async () => ({ size: new TextEncoder().encode(content).byteLength, text: async () => content }),
  })));
}

describe("TypedMaterialSurface", () => {
  beforeEach(() => mockFileResponse("# Canvas notes\n\nExact **Markdown** content."));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("uses the same safe Markdown surface on the canvas", async () => {
    render(
      <TypedMaterialSurface
        api={apiFor(version("README.md", "text/markdown"))}
        projectId="project-one"
        node={node}
        versionId="version-one"
        url="/exact/readme"
        focusMotion={null}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Canvas notes" })).toBeInTheDocument();
    expect(screen.getByText("Markdown", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("renders code with TanStack Highlight and reveals an editor after focus flight", async () => {
    mockFileResponse("export const answer: number = 42\nconsole.log(answer)\n");
    const codeNode = { ...node, id: "material-code", kind: "file" as const, name: "answer.ts" };
    const append = vi.fn(async (_nodeId: string, _file: File): Promise<void> => undefined);
    const { container, rerender } = render(
      <TypedMaterialSurface
        api={apiFor({ ...version("answer.ts", "text/typescript"), nodeId: codeNode.id })}
        projectId="project-one"
        node={codeNode}
        versionId="version-one"
        url="/exact/code"
        focusMotion={null}
        onAppendMaterialVersion={append}
      />,
    );

    await waitFor(() => expect(container.querySelector(".th-code--ts")).not.toBeNull());
    expect(container.querySelector(".th-keyword")).toHaveTextContent("export");
    const viewerHighlight = container.querySelector(".design-typed-material__highlight");
    expect(viewerHighlight?.querySelector('.th-line[data-line="1"]')).toHaveTextContent("export const answer");
    expect(viewerHighlight?.querySelector('.th-line[data-line="2"]')).toHaveTextContent("console.log(answer)");

    rerender(
      <TypedMaterialSurface
        api={apiFor({ ...version("answer.ts", "text/typescript"), nodeId: codeNode.id })}
        projectId="project-one"
        node={codeNode}
        versionId="version-one"
        url="/exact/code"
        focusMotion={focusMotion()}
        onAppendMaterialVersion={append}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Edit answer.ts" });
    expect(editor).toHaveValue("export const answer: number = 42\nconsole.log(answer)\n");
    const editorHighlight = container.querySelector(".design-typed-material__editor-highlight");
    expect(editorHighlight).not.toBeNull();
    expect(editorHighlight?.querySelector(".th-keyword")).toHaveTextContent("export");
    expect(editorHighlight?.querySelector('.th-line[data-line="1"]')).toHaveTextContent("export const answer");
    expect(editorHighlight?.querySelector('.th-line[data-line="2"]')).toHaveTextContent("console.log(answer)");
    expect(editor).toHaveAttribute("data-syntax-highlighted", "true");
    await userEvent.type(editor, "// saved");
    await userEvent.click(screen.getByRole("button", { name: "Save revision" }));
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toBe(codeNode.id);
    expect(append.mock.calls[0]?.[1]).toMatchObject({ name: "answer.ts", type: "text/typescript" });
  });

  test.each([
    { fileName: "large.ts", mimeType: "text/typescript", marker: "export const safe = '<script>blocked</script>'" },
    { fileName: "large.md", mimeType: "text/markdown", marker: "# <script>blocked</script>" },
  ])("large $fileName stays editable without rich synchronous rendering", async ({ fileName, mimeType, marker }) => {
    const content = `${marker}\n${"plain text\n".repeat(7_000)}`;
    mockFileResponse(content);
    const largeNode = { ...node, id: `large-${fileName}`, kind: "file" as const, name: fileName };
    const metadata = {
      ...version(fileName, mimeType),
      nodeId: largeNode.id,
      bytes: new TextEncoder().encode(content).byteLength,
    };
    const highlight = vi.spyOn(typedMaterialHighlighter, "highlight");
    highlight.mockClear();
    const { container } = render(
      <TypedMaterialSurface
        api={apiFor(metadata)}
        projectId="project-large"
        node={largeNode}
        versionId="version-one"
        url={`/exact/${fileName}`}
        focusMotion={focusMotion()}
        onAppendMaterialVersion={vi.fn(async () => undefined)}
      />,
    );

    await screen.findByText(/rich rendering paused for canvas performance/i);
    expect(container.querySelector(".design-typed-material")).toHaveAttribute("data-rich-rendering", "paused");
    expect(container.querySelector(".design-typed-material__lightweight script")).toBeNull();
    expect(container.querySelector(".design-typed-material__lightweight code")).toHaveTextContent("<script>blocked</script>");
    expect(highlight).not.toHaveBeenCalled();
    const editor = await screen.findByRole("textbox", { name: `Edit ${fileName}` });
    expect(editor).toHaveValue(content);
    highlight.mockRestore();
  });

  test("keeps the same visible code lines while entering and leaving the editor", async () => {
    mockFileResponse("one\ntwo\nthree\nfour\nfive\nsix\n");
    const codeNode = { ...node, id: "material-scroll", kind: "file" as const, name: "scroll.ts" };
    const metadata = { ...version("scroll.ts", "text/typescript"), nodeId: codeNode.id };
    const { container, rerender } = render(
      <TypedMaterialSurface
        api={apiFor(metadata)}
        projectId="project-scroll"
        node={codeNode}
        versionId="version-one"
        url="/exact/scroll"
        focusMotion={null}
      />,
    );

    await waitFor(() => expect(container.querySelector(".design-typed-material__highlight")).not.toBeNull());
    const viewer = container.querySelector<HTMLDivElement>(".design-typed-material__viewer");
    expect(viewer).not.toBeNull();
    viewer!.scrollTop = 48;
    viewer!.scrollLeft = 11;

    rerender(
      <TypedMaterialSurface
        api={apiFor(metadata)}
        projectId="project-scroll"
        node={codeNode}
        versionId="version-one"
        url="/exact/scroll"
        focusMotion={focusMotion()}
      />,
    );

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Edit scroll.ts" });
    expect(editor.scrollTop).toBe(48);
    expect(editor.scrollLeft).toBe(11);

    editor.scrollTop = 96;
    editor.scrollLeft = 23;
    fireEvent.scroll(editor);
    expect(viewer!.scrollTop).toBe(96);
    expect(viewer!.scrollLeft).toBe(23);

    rerender(
      <TypedMaterialSurface
        api={apiFor(metadata)}
        projectId="project-scroll"
        node={codeNode}
        versionId="version-one"
        url="/exact/scroll"
        focusMotion={{ ...focusMotion(), phase: "closing" }}
      />,
    );

    await waitFor(() => expect(container.querySelector(".design-typed-material")).not.toHaveAttribute("data-editor-visible"));
    expect(viewer!.scrollTop).toBe(96);
    expect(viewer!.scrollLeft).toBe(23);
  });

  test("a new exact version identity discards an unsaved draft before it can be saved", async () => {
    const append = vi.fn(async (_file: File): Promise<void> => undefined);
    const firstDescriptor = {
      fileName: "first.ts",
      mimeType: "text/typescript",
      bytes: 24,
      presentation: typedMaterialPresentation("first.ts", "text/typescript"),
    };
    const secondDescriptor = {
      fileName: "second.ts",
      mimeType: "text/typescript",
      bytes: 24,
      presentation: typedMaterialPresentation("second.ts", "text/typescript"),
    };
    const { rerender } = render(
      <TextEditor
        key="version-a"
        descriptor={firstDescriptor}
        content="export const version = 'A'"
        active
        onAppendMaterialVersion={append}
      />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Edit first.ts" }), " // dirty");

    rerender(
      <TextEditor
        key="version-b"
        descriptor={secondDescriptor}
        content="export const version = 'B'"
        active
        onAppendMaterialVersion={append}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Edit second.ts" })).toHaveValue("export const version = 'B'");
    expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
    expect(append).not.toHaveBeenCalled();
  });
});
