/**
 * A tiny module-level handoff for the initial brief: HomeScreen creates a project
 * and navigates to its workspace; the workspace picks up the brief on mount and
 * kicks off the first run. Keeps the flow simple without query params or a store.
 */

let pending: string | null = null;

export function setPendingBrief(brief: string): void {
  pending = brief;
}

export function takePendingBrief(): string | null {
  const b = pending;
  pending = null;
  return b;
}

/** Reference images (e.g. a dropped screenshot) handed to the new project's first run. */
export interface PendingImage {
  name: string;
  /** base64 (no data: prefix). */
  base64: string;
}

let pendingImages: PendingImage[] = [];

export function setPendingImages(images: PendingImage[]): void {
  pendingImages = images;
}

export function takePendingImages(): PendingImage[] {
  const i = pendingImages;
  pendingImages = [];
  return i;
}

/** Agent + model chosen on the home composer, used for the new project's first run. */
let pendingAgent: string | null = null;
let pendingModel: string | null = null;

export function setPendingAgent(command: string, model?: string): void {
  pendingAgent = command;
  pendingModel = model ?? null;
}

export function takePendingAgent(): string | null {
  const a = pendingAgent;
  pendingAgent = null;
  return a;
}

export function takePendingModel(): string | null {
  const m = pendingModel;
  pendingModel = null;
  return m;
}

/** Other projects referenced on the home composer — their artifact is uploaded as a
 *  read-only reference on the new project's first run so the agent reads the real design. */
export interface PendingRef {
  /** Source project name, used to label the uploaded reference file. */
  name: string;
  /** index.html of the referenced project, base64 (no data: prefix). */
  base64: string;
}

let pendingRefs: PendingRef[] = [];

export function setPendingRefs(refs: PendingRef[]): void {
  pendingRefs = refs;
}

export function takePendingRefs(): PendingRef[] {
  const r = pendingRefs;
  pendingRefs = [];
  return r;
}
