import { render } from "@testing-library/react";
import { expect, test } from "vitest";

import { NodeGenerationStatus, NodeWorkingPlaceholder } from "./DesignCanvasNode.tsx";

const PARTICLE_PROPERTIES = [
  "--generation-particle-delay",
  "--generation-particle-duration",
  "--generation-particle-size",
  "--generation-particle-opacity",
  "--generation-particle-x-1",
  "--generation-particle-y-1",
] as const;

function particleSignature(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".design-canvas-node__generation-particle"))
    .map((particle) => particle.getAttribute("style") ?? "");
}

test("generation particles are stable for one job and distinct for the next job", () => {
  const { container, rerender } = render(
    <NodeWorkingPlaceholder state="generating" label="Page" generationSeed="job-alpha" />,
  );
  const firstSignature = particleSignature(container);
  const firstParticle = container.querySelector(".design-canvas-node__generation-particle");

  expect(firstSignature).toHaveLength(14);
  for (const property of PARTICLE_PROPERTIES) {
    const values = Array.from(container.querySelectorAll<HTMLElement>(".design-canvas-node__generation-particle"))
      .map((particle) => particle.style.getPropertyValue(property));
    expect(values.every(Boolean), `${property} should be set on every particle`).toBe(true);
    expect(new Set(values).size, `${property} should vary within one field`).toBeGreaterThan(1);
  }

  rerender(<NodeWorkingPlaceholder state="generating" label="Page" generationSeed="job-alpha" />);
  expect(particleSignature(container)).toEqual(firstSignature);
  expect(container.querySelector(".design-canvas-node__generation-particle")).toBe(firstParticle);

  rerender(<NodeWorkingPlaceholder state="generating" label="Page" generationSeed="job-beta" />);
  expect(particleSignature(container)).not.toEqual(firstSignature);
  expect(container.querySelector(".design-canvas-node__generation-particle")).not.toBe(firstParticle);
});

test("the compact next-version status uses a smaller deterministic particle field", () => {
  const { container, rerender } = render(
    <NodeGenerationStatus state="generating" generationSeed="job-alpha" />,
  );
  const firstSignature = particleSignature(container);

  expect(firstSignature).toHaveLength(7);
  rerender(<NodeGenerationStatus state="generating" generationSeed="job-alpha" />);
  expect(particleSignature(container)).toEqual(firstSignature);
  rerender(<NodeGenerationStatus state="generating" generationSeed="job-beta" />);
  expect(particleSignature(container)).not.toEqual(firstSignature);
});

test("offscreen generation keeps a lightweight static constellation", () => {
  const { container, rerender } = render(
    <NodeWorkingPlaceholder state="generating" label="Page" generationSeed="job-alpha" motionActive={false} />,
  );

  expect(container.querySelector("[data-generation-motion='paused']")).toBeInTheDocument();
  expect(particleSignature(container)).toHaveLength(4);

  rerender(<NodeGenerationStatus state="validating" generationSeed="job-alpha" motionActive={false} />);
  expect(container.querySelector("[data-generation-motion='paused']")).toBeInTheDocument();
  expect(particleSignature(container)).toHaveLength(3);
});
