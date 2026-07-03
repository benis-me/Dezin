import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { AgentOutputText } from "./AgentOutputText.tsx";

const streamdownRender = vi.fn();

vi.mock("streamdown", () => ({
  Streamdown: (props: {
    animated?: boolean;
    className?: string;
    components?: Record<string, unknown>;
    controls?: boolean;
    children?: string;
  }) => {
    streamdownRender(props);
    return (
      <div data-testid="streamdown-output" className={props.className}>
        {props.children}
      </div>
    );
  },
}));

beforeEach(() => {
  streamdownRender.mockClear();
});

test("AgentOutputText keeps Streamdown animation off for stable output by default", () => {
  render(<AgentOutputText text="Streaming **markdown**" />);

  expect(screen.getByTestId("streamdown-output")).toHaveTextContent("Streaming **markdown**");
  expect(streamdownRender).toHaveBeenCalledWith(
    expect.objectContaining({
      animated: false,
      isAnimating: false,
      controls: false,
      children: "Streaming **markdown**",
    }),
  );
});

test("AgentOutputText enables Streamdown animation only for in-progress output", () => {
  render(<AgentOutputText text="Streaming output" animate />);

  expect(streamdownRender).toHaveBeenCalledWith(
    expect.objectContaining({
      animated: true,
      isAnimating: true,
      children: "Streaming output",
    }),
  );
});
