import type { Project } from "./api.ts";

export function buildProjectAnalysisPrompt(project: Project): string {
  const projectPath = project.projectPath?.trim()
    || `(Dezin did not expose a projectPath for ${project.id})`;
  const gapInstruction = project.sharingan
    ? "2. Identify every required source-fidelity gap between the generated result and the captured source site. Include file, component, or CSS locations for each issue."
    : "2. Identify the highest-impact gaps between the result and the intended direction, prioritized as P0/P1/P2. Include file, component, or CSS locations for each issue.";
  return `Analyze this Dezin-generated project and identify why the design result does not match the intended direction.

Project name: ${project.name}
Project mode: ${project.mode}
Project path: ${projectPath}
Project ID: ${project.id}

Read the source, assets, configuration, and generated output under the project path. Structure your answer as:
1. Describe 5-8 concrete observations about what the project actually renders today.
${gapInstruction}
3. Analyze likely contributing factors: original input prompt, agent/model behavior, Dezin context, design system, generation mode, asset selection, and Quality-check blind spots.
4. Propose improvements that can be verified directly in this project, including concrete code directions.
5. Recommend Dezin product-side improvements to the generation pipeline, prompt structure, Quality checks, or iteration workflow.
6. Design the next test round: which variables to keep fixed, which variables to change, and how to judge whether the improvement is real.

The goal is not only to fix this project. Use it as a Dezin generation-quality sample and extract reusable product improvements.`;
}
