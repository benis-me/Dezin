import { render, cleanup } from "@testing-library/react";
import { test, expect, afterEach } from "vitest";
import { CodeView } from "./WorkspaceScreen.tsx";

afterEach(cleanup);

test("CodeView highlights a small file but renders a large file as plain text", () => {
  const small = render(<CodeView name="a.css" text={`const x = 1; /* c */`} />);
  // a keyword like "const" is wrapped in a colored span for small files
  expect(small.container.querySelector("code span")).toBeTruthy();

  const big = "const x = 1;\n".repeat(20000); // ~240KB, > 100KB threshold
  const large = render(<CodeView name="dom.json" text={big} />);
  expect(large.container.querySelector("code span")).toBeNull();
  expect(large.container.textContent?.includes("const x = 1;")).toBe(true);
});
