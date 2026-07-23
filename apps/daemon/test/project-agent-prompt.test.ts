import assert from "node:assert/strict";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { DesignRegistry } from "../../../packages/design/src/index.ts";
import { buildProjectAgentPrompt } from "../src/run-handler.ts";

const editorialSystem = {
  id: "editorial-proof",
  name: "Editorial Proof",
  category: "Editorial",
  summary: "Evidence-led editorial interfaces",
  designMd: "Use visible provenance, deliberate hierarchy, and restrained evidence bands.",
  tokensCss: ":root { --color-canvas: #f4f0e8; --color-ink: #191a17; }",
  craft: { applies: [] },
};

test("Generation Plan Artifact prompts retain the legacy design quality contract", () => {
  const store = new Store();
  try {
    const project = store.createProject({
      name: "Climate field journal",
      mode: "standard",
      designSystemId: editorialSystem.id,
    });
    const settings = {
      ...store.getSettings(),
      customInstructions: "Keep provenance adjacent to every metric.",
    };
    const result = buildProjectAgentPrompt({
      project,
      settings,
      brief: "Design a dense climate evidence page with calm editorial pacing.",
      designRegistry: new DesignRegistry([editorialSystem]),
      imageGenerationEnabled: true,
    });

    assert.equal(result.designSystemName, editorialSystem.name);
    assert.match(result.systemPrompt, /Active design system — Editorial Proof/);
    assert.match(result.systemPrompt, /--color-canvas: #f4f0e8/);
    assert.match(result.systemPrompt, /Keep provenance adjacent to every metric/);
    assert.match(result.systemPrompt, /real Vite \+ React project/);
    assert.match(result.systemPrompt, /Generated imagery/);
    assert.match(result.systemPrompt, /Design dials/i);
    assert.match(result.systemPrompt, /dezin:frame-change/);
    assert.match(result.systemPrompt, /dezin:frame-consumed/);
    assert.match(result.systemPrompt, /source: "dezin-artifact"/);
    assert.match(result.systemPrompt, /apply the requested initialState and fixture to the rendered DOM before acknowledging/i);
  } finally {
    store.close();
  }
});

test("Sharingan Artifact prompts exclude unrelated brand styling and keep reconstruction rules", () => {
  const store = new Store();
  try {
    const project = store.createProject({
      name: "Captured source",
      mode: "standard",
      designSystemId: editorialSystem.id,
      sharingan: true,
      sourceUrl: "https://example.com/",
    });
    const result = buildProjectAgentPrompt({
      project,
      settings: store.getSettings(),
      brief: "Reconstruct the captured source exactly.",
      designRegistry: new DesignRegistry([editorialSystem]),
      imageGenerationEnabled: true,
      hasExactSharinganCapture: true,
    });

    assert.equal(result.designSystemName, null);
    assert.equal(result.skill, null);
    assert.doesNotMatch(result.systemPrompt, /Editorial Proof/);
    assert.doesNotMatch(result.systemPrompt, /Generated imagery/);
    assert.match(result.systemPrompt, /source-scaffold --stdout/);
    assert.doesNotMatch(result.systemPrompt, /\.sharingan\/source-scaffold\/App\.jsx/);
    assert.match(result.systemPrompt, /\.sharingan\/probe\.mjs source-summary/);
    assert.match(result.systemPrompt, /fidelity/i);
    assert.match(result.systemPrompt, /dezin:frame-change/);
    assert.match(result.systemPrompt, /dezin:frame-consumed/);
  } finally {
    store.close();
  }
});

test("a Sharingan Project does not switch an unlinked Artifact Task into reconstruction mode", () => {
  const store = new Store();
  try {
    const project = store.createProject({
      name: "Mixed design workspace",
      mode: "standard",
      designSystemId: editorialSystem.id,
      sharingan: true,
      sourceUrl: "https://legacy-project-source.example/",
    });
    const result = buildProjectAgentPrompt({
      project,
      settings: store.getSettings(),
      brief: "Design a new evidence-led landing page.",
      designRegistry: new DesignRegistry([editorialSystem]),
      imageGenerationEnabled: true,
      hasExactSharinganCapture: false,
    });

    assert.equal(result.designSystemName, editorialSystem.name);
    assert.match(result.systemPrompt, /Active design system — Editorial Proof/);
    assert.match(result.systemPrompt, /Generated imagery/);
    assert.doesNotMatch(result.systemPrompt, /source-scaffold --stdout/);
  } finally {
    store.close();
  }
});

test("an exact linked Capture switches a non-Sharingan Project Artifact Task into reconstruction mode", () => {
  const store = new Store();
  try {
    const project = store.createProject({
      name: "Mixed design workspace",
      mode: "standard",
      designSystemId: editorialSystem.id,
      sharingan: false,
    });
    const result = buildProjectAgentPrompt({
      project,
      settings: store.getSettings(),
      brief: "Reconstruct the exact linked Capture Revision.",
      designRegistry: new DesignRegistry([editorialSystem]),
      imageGenerationEnabled: true,
      hasExactSharinganCapture: true,
    });

    assert.equal(result.designSystemName, null);
    assert.equal(result.skill, null);
    assert.doesNotMatch(result.systemPrompt, /Editorial Proof|Generated imagery/);
    assert.match(result.systemPrompt, /source-scaffold --stdout/);
    assert.match(result.systemPrompt, /fidelity/i);
  } finally {
    store.close();
  }
});
