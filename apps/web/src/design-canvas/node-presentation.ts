import type { DesignNodeKind, DesignNodeState } from "./types.ts";

export type DesignNodePresentationMode =
  | "web"
  | "component"
  | "system"
  | "research"
  | "tokens"
  | "document"
  | "layout"
  | "knowledge"
  | "media"
  | "typed-file";

interface DesignNodePresentation {
  mode: DesignNodePresentationMode;
  creating: string;
  updating: string;
  validating: string;
  detail: string;
}

const PRESENTATIONS: Record<DesignNodeKind, DesignNodePresentation> = {
  page: {
    mode: "web",
    creating: "Building a responsive page",
    updating: "Updating the page",
    validating: "Checking the page preview",
    detail: "The Agent is composing the page hierarchy, content, interactions, and responsive states.",
  },
  component: {
    mode: "component",
    creating: "Shaping a reusable component",
    updating: "Updating component states",
    validating: "Checking component states",
    detail: "The Agent is defining the component, variants, interaction states, and usage specimen.",
  },
  "design-system": {
    mode: "system",
    creating: "Defining a design system",
    updating: "Updating the design system",
    validating: "Checking system consistency",
    detail: "The Agent is organizing visual rules, primitives, patterns, and representative components.",
  },
  research: {
    mode: "research",
    creating: "Synthesizing research",
    updating: "Updating the research synthesis",
    validating: "Checking evidence and findings",
    detail: "The Agent is structuring evidence, gaps, findings, decisions, and design implications.",
  },
  "design-tokens": {
    mode: "tokens",
    creating: "Deriving design tokens",
    updating: "Updating the token reference",
    validating: "Checking token relationships",
    detail: "The Agent is organizing color, typography, spacing, effect, and motion values into a coherent reference.",
  },
  "design-document": {
    mode: "document",
    creating: "Writing design direction",
    updating: "Updating the design direction",
    validating: "Checking the design specification",
    detail: "The Agent is documenting rationale, durable rules, decisions, and implementation guidance.",
  },
  layout: {
    mode: "layout",
    creating: "Composing a responsive layout",
    updating: "Updating layout rules",
    validating: "Checking responsive layout",
    detail: "The Agent is defining regions, grids, spacing, breakpoints, and composition behavior.",
  },
  knowledge: {
    mode: "knowledge",
    creating: "Structuring project knowledge",
    updating: "Updating project knowledge",
    validating: "Checking knowledge structure",
    detail: "The Agent is organizing facts, constraints, terminology, relationships, and open questions.",
  },
  image: {
    mode: "media",
    creating: "Analyzing the image",
    updating: "Updating the image analysis",
    validating: "Checking image analysis",
    detail: "The Agent is reading the exact image revision and relating its visual evidence to the Canvas.",
  },
  video: {
    mode: "media",
    creating: "Analyzing the video",
    updating: "Updating the video analysis",
    validating: "Checking video analysis",
    detail: "The Agent is reading the exact video revision and relating its motion evidence to the Canvas.",
  },
  document: {
    mode: "typed-file",
    creating: "Reading the document",
    updating: "Updating the document analysis",
    validating: "Checking document analysis",
    detail: "The Agent is reading the exact document revision and extracting useful project context.",
  },
  file: {
    mode: "typed-file",
    creating: "Inspecting the file",
    updating: "Updating the file analysis",
    validating: "Checking file analysis",
    detail: "The Agent is inspecting the exact file revision and extracting useful project context.",
  },
};

export function designNodePresentation(kind: DesignNodeKind): DesignNodePresentation {
  return PRESENTATIONS[kind];
}

export function designNodeGenerationCopy(
  kind: DesignNodeKind,
  state: DesignNodeState,
  updating: boolean,
): { title: string; detail: string } {
  const presentation = designNodePresentation(kind);
  if (state === "queued") {
    return {
      title: "Waiting to begin",
      detail: `${presentation.creating} is next in the Agent queue.`,
    };
  }
  if (state === "validating") {
    return {
      title: presentation.validating,
      detail: "Dezin is verifying the exact result before it becomes an immutable revision.",
    };
  }
  return {
    title: updating ? presentation.updating : presentation.creating,
    detail: presentation.detail,
  };
}
