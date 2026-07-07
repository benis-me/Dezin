import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { highlightToReact } from "./highlight-lite.tsx";

describe("highlightToReact", () => {
  test("preserves the exact source text (highlighting must never alter content)", () => {
    const code = `const a = "hi"; // note\n#fff 12px`;
    const { container } = render(
      <pre>
        <code>{highlightToReact(code)}</code>
      </pre>,
    );
    expect(container.querySelector("code")?.textContent).toBe(code);
  });

  test("tokenizes keywords, strings, comments, and numbers into spans", () => {
    const { container } = render(
      <pre>
        <code>{highlightToReact(`const x = "s"; // c`)}</code>
      </pre>,
    );
    const texts = Array.from(container.querySelectorAll("span")).map((s) => s.textContent);
    expect(texts).toContain("const");
    expect(texts).toContain('"s"');
    expect(texts).toContain("// c");
  });

  test("handles empty input without throwing", () => {
    const { container } = render(
      <pre>
        <code>{highlightToReact("")}</code>
      </pre>,
    );
    expect(container.querySelector("code")?.textContent).toBe("");
  });
});
